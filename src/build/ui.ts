/**
 * VS Code surface for the build pipeline: "Synthesize", "Place and Route",
 * "Pack Bitstream", "Build", "Program", "Build and Program" and
 * "Detect Board".
 *
 * The stages — yosys → nextpnr-himbaechel → gowin_pack → openFPGALoader —
 * are modelled as an ordered list. A stage command runs its target stage
 * plus any earlier stage whose output is missing; "Build" / "Build and
 * Program" run every stage unconditionally. This layer only does VS Code
 * things; the work is the injected-IO flows in synthesize.ts /
 * placeAndRoute.ts / pack.ts / program.ts.
 */

import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Board } from '../boards/schema';
import type { BoardRegistry } from '../boards/registry';
import { loadProject, PROJECT_FILE_NAME } from '../project/loader';
import type { FpgaProject } from '../project/schema';
import type { Toolchain } from '../toolchain/discovery';
import { resolveToolchain } from '../toolchain/resolve';
import { buildLayout } from './layout';
import { acquireBuildLock, releaseBuildLock } from './lock';
import { nodeProcessRunner } from './nodeProcess';
import type { ProgramTarget } from './openFpgaLoader';
import { failureLine, successLine } from './output';
import { packBitstream } from './pack';
import { placeAndRoute } from './placeAndRoute';
import { backupFlash, detectBoard, program, programFile } from './program';
import { synthesize, type PipelineIo } from './synthesize';

interface ProgramSpec {
	readonly target: ProgramTarget;
	readonly backup: boolean;
	/** Absolute path of a user-chosen file to write; when set, the build stages are skipped. */
	readonly fromFile?: string;
}

/** The AbortController of the build in progress, so a status-bar button can cancel it. */
let activeBuild: AbortController | undefined;
/** Set by registerBuildUi so the run functions can refresh the status bar. */
let refreshStatusBar: () => void = () => {};

export function registerBuildUi(
	context: vscode.ExtensionContext,
	output: vscode.OutputChannel,
	boards: BoardRegistry,
): void {
	const run =
		(title: string, target: number, forceAll = false) =>
		(): Promise<void> =>
			runPipeline(output, boards, title, target, forceAll);

	context.subscriptions.push(
		vscode.commands.registerCommand('openfpga.synthesize', run('synthesizing', 0, true)),
		vscode.commands.registerCommand('openfpga.placeAndRoute', run('place & route', 1)),
		vscode.commands.registerCommand('openfpga.packBitstream', run('packing bitstream', 2)),
		vscode.commands.registerCommand('openfpga.build', run('building', 2, true)),
		vscode.commands.registerCommand('openfpga.program', () =>
			runProgram(output, boards, 'programming', false),
		),
		vscode.commands.registerCommand('openfpga.buildAndProgram', () =>
			runProgram(output, boards, 'build & program', true),
		),
		vscode.commands.registerCommand('openfpga.detectBoard', () => runDetect(output, boards)),
		vscode.commands.registerCommand('openfpga.writeFileToBoard', () =>
			runWriteFile(output, boards),
		),
		vscode.commands.registerCommand('openfpga.cancelBuild', () => activeBuild?.abort()),
		vscode.commands.registerCommand('openfpga.buildMenu', () => showBuildMenu()),
	);

	registerBuildStatusBar(context);
}

/** A compact icon cluster for the build actions; visible only in an OpenFPGA project. */
function registerBuildStatusBar(context: vscode.ExtensionContext): void {
	const make = (priority: number, text: string, command: string, tooltip: string) => {
		const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, priority);
		item.text = text;
		item.command = command;
		item.tooltip = tooltip;
		context.subscriptions.push(item);
		return item;
	};

	const buttons = [
		make(88, '$(zap)', 'openfpga.build', 'OpenFPGA Deck: Build'),
		make(87, '$(rocket)', 'openfpga.buildAndProgram', 'OpenFPGA Deck: Build and Program'),
		make(86, '$(plug)', 'openfpga.detectBoard', 'OpenFPGA Deck: Detect Board'),
		make(85, '$(ellipsis)', 'openfpga.buildMenu', 'OpenFPGA Deck: build actions…'),
	];
	const cancel = make(84, '$(stop) Cancel', 'openfpga.cancelBuild', 'OpenFPGA Deck: cancel the running build');
	cancel.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');

	const inProject = (): boolean => {
		const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		return root !== undefined && existsSync(path.join(root, PROJECT_FILE_NAME));
	};

	refreshStatusBar = (): void => {
		const show = inProject();
		for (const b of buttons) {
			show ? b.show() : b.hide();
		}
		show && activeBuild !== undefined ? cancel.show() : cancel.hide();
	};

	const watcher = vscode.workspace.createFileSystemWatcher(`**/${PROJECT_FILE_NAME}`);
	context.subscriptions.push(
		watcher,
		watcher.onDidCreate(refreshStatusBar),
		watcher.onDidDelete(refreshStatusBar),
	);
	refreshStatusBar();
}

async function showBuildMenu(): Promise<void> {
	const items: Array<vscode.QuickPickItem & { command: string }> = [
		{ label: '$(zap) Build', description: 'synth → P&R → pack', command: 'openfpga.build' },
		{ label: '$(rocket) Build and Program', command: 'openfpga.buildAndProgram' },
		{ label: '$(server-process) Synthesize', command: 'openfpga.synthesize' },
		{ label: '$(circuit-board) Place and Route', command: 'openfpga.placeAndRoute' },
		{ label: '$(package) Pack Bitstream', command: 'openfpga.packBitstream' },
		{ label: '$(rocket) Program', command: 'openfpga.program' },
		{ label: '$(plug) Detect Board', command: 'openfpga.detectBoard' },
		{ label: '$(file-binary) Write File to Board', command: 'openfpga.writeFileToBoard' },
	];
	const pick = await vscode.window.showQuickPick(items, { title: 'OpenFPGA Deck' });
	if (pick) {
		await vscode.commands.executeCommand(pick.command);
	}
}

interface Prepared {
	readonly root: string;
	readonly project: FpgaProject;
	readonly board: Board;
	readonly toolchain: Toolchain;
}

interface StageResult {
	readonly ok: boolean;
	readonly canceled: boolean;
	readonly summary: string;
}

interface Stage {
	/** Progress-notification message while this stage runs. */
	readonly message: string;
	/** Absolute path of the file this stage produces; absent = always runs. */
	readonly output?: string;
	run(io: PipelineIo): Promise<StageResult>;
}

/** Shared front half of every build command; shows its own error messages. */
async function prepare(
	output: vscode.OutputChannel,
	boards: BoardRegistry,
): Promise<Prepared | undefined> {
	const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!root) {
		vscode.window.showErrorMessage('OpenFPGA Deck: open a project folder first.');
		return undefined;
	}

	const loaded = loadProject(root, undefined, boards.ids());
	if (!loaded.ok) {
		output.clear();
		output.show(true);
		output.appendLine('Cannot build — fpga.yaml is not valid:');
		for (const issue of loaded.errors) {
			output.appendLine(`  - ${issue.message}`);
		}
		vscode.window.showErrorMessage(
			'OpenFPGA Deck: fix the errors in fpga.yaml first (see the output).',
		);
		return undefined;
	}

	const board = boards.get(loaded.value.project.board);
	if (!board) {
		vscode.window.showErrorMessage(
			`OpenFPGA Deck: board "${loaded.value.project.board}" is not in the registry.`,
		);
		return undefined;
	}

	const resolved = resolveToolchain();
	if (!resolved.ok) {
		const pick = await vscode.window.showErrorMessage(
			`OpenFPGA Deck: no usable OSS CAD Suite. ${resolved.reason}`,
			'Select Toolchain…',
			'Download…',
		);
		if (pick === 'Select Toolchain…') {
			await vscode.commands.executeCommand('openfpga.selectToolchain');
		} else if (pick === 'Download…') {
			await vscode.commands.executeCommand('openfpga.downloadToolchain');
		}
		return undefined;
	}

	return {
		root: loaded.value.root,
		project: loaded.value.project,
		board,
		toolchain: resolved.toolchain,
	};
}

function stagesFor(ctx: Prepared, programSpec?: ProgramSpec): Stage[] {
	const layout = buildLayout(ctx.root);
	const tools = ctx.toolchain.tools;
	const common = { project: ctx.project, board: ctx.board, projectRoot: ctx.root };
	const openFpgaLoaderExe = tools.openFPGALoader.path;
	const stages: Stage[] = [];

	// Build the bitstream unless we are writing a file the user picked.
	if (!programSpec?.fromFile) {
		stages.push(
			{
				message: 'synthesizing…',
				output: path.join(layout.netlistDir, `${ctx.project.top}.json`),
				run: (io) => synthesize({ ...common, yosysExe: tools.yosys.path }, io),
			},
			{
				message: 'placing & routing…',
				output: path.join(layout.pnrDir, `${ctx.project.top}.pnr.json`),
				run: (io) => placeAndRoute({ ...common, nextpnrExe: tools['nextpnr-himbaechel'].path }, io),
			},
			{
				message: 'packing bitstream…',
				output: path.join(layout.bitstreamDir, `${ctx.project.name}.fs`),
				run: (io) => packBitstream({ ...common, gowinPackExe: tools.gowin_pack.path }, io),
			},
		);
	}

	if (programSpec) {
		if (programSpec.backup) {
			stages.push({
				message: 'backing up flash…',
				run: (io) =>
					backupFlash(
						{ board: ctx.board, projectRoot: ctx.root, openFpgaLoaderExe, stamp: timestamp() },
						io,
					),
			});
		}
		const message = programSpec.target === 'flash' ? 'writing flash…' : 'loading SRAM…';
		stages.push({
			message,
			run: (io) =>
				programSpec.fromFile
					? programFile(
							{
								board: ctx.board,
								projectRoot: ctx.root,
								openFpgaLoaderExe,
								filePath: programSpec.fromFile,
								target: programSpec.target,
							},
							io,
						)
					: program({ ...common, openFpgaLoaderExe, target: programSpec.target }, io),
		});
	}
	return stages;
}

/** Filesystem-safe timestamp for backup filenames. */
function timestamp(): string {
	return new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '');
}

function makeIo(signal: AbortSignal, output: vscode.OutputChannel): PipelineIo {
	return {
		run: nodeProcessRunner,
		mkdirp: async (dir) => {
			await fs.mkdir(dir, { recursive: true });
		},
		writeFile: (file, text) => fs.writeFile(file, text, 'utf8'),
		readFile: (file) => fs.readFile(file, 'utf8'),
		write: (text) => output.append(text),
		exists: (file) =>
			fs
				.access(file)
				.then(() => true)
				.catch(() => false),
		remove: (file) => fs.rm(file, { force: true }),
		signal,
	};
}

async function runProgram(
	output: vscode.OutputChannel,
	boards: BoardRegistry,
	title: string,
	forceAll: boolean,
): Promise<void> {
	const ctx = await prepare(output, boards);
	if (!ctx) {
		return;
	}
	const target = await pickTarget(ctx.board);
	if (!target) {
		return;
	}

	let backup = false;
	if (target === 'flash') {
		const decision = await confirmFlash(ctx.board);
		if (decision === 'cancel') {
			return;
		}
		backup = decision === 'backup';
	}

	await runPipeline(output, boards, title, undefined, forceAll, ctx, { target, backup });
}

async function runWriteFile(output: vscode.OutputChannel, boards: BoardRegistry): Promise<void> {
	const ctx = await prepare(output, boards);
	if (!ctx) {
		return;
	}

	const picked = await vscode.window.showOpenDialog({
		canSelectMany: false,
		openLabel: 'Write to board',
		title: 'Select a bitstream (.fs) or flash image (.bin) to write',
		filters: { 'Bitstream or flash image': ['fs', 'bin'] },
	});
	if (!picked || picked.length === 0) {
		return;
	}
	const filePath = picked[0].fsPath;

	// A raw .bin (e.g. a flash backup) only makes sense written to flash.
	let target: ProgramTarget;
	if (filePath.toLowerCase().endsWith('.bin')) {
		target = 'flash';
	} else {
		const chosen = await pickTarget(ctx.board);
		if (!chosen) {
			return;
		}
		target = chosen;
	}

	let backup = false;
	if (target === 'flash') {
		const decision = await confirmFlash(ctx.board);
		if (decision === 'cancel') {
			return;
		}
		backup = decision === 'backup';
	}

	await runPipeline(output, boards, 'writing to board', undefined, false, ctx, {
		target,
		backup,
		fromFile: filePath,
	});
}

/**
 * Flashing overwrites whatever is on the board (for the Tang Nano 20K, the
 * factory image). Offer a backup first when the board tells us its flash
 * size; otherwise just confirm the overwrite.
 */
async function confirmFlash(board: Board): Promise<'backup' | 'skip' | 'cancel'> {
	if (board.programmer.flashSize) {
		const pick = await vscode.window.showWarningMessage(
			`Writing flash replaces the current contents of ${board.name}.`,
			{
				modal: true,
				detail: 'Back up the current flash to build/backup/ first? This reads the whole chip and takes a minute.',
			},
			'Back Up & Continue',
			'Skip Backup',
		);
		if (pick === 'Back Up & Continue') {
			return 'backup';
		}
		return pick === 'Skip Backup' ? 'skip' : 'cancel';
	}

	const pick = await vscode.window.showWarningMessage(
		`Writing flash replaces the current contents of ${board.name}.`,
		{
			modal: true,
			detail: 'This board definition has no flash size, so OpenFPGA Deck cannot back the flash up first.',
		},
		'Continue',
	);
	return pick === 'Continue' ? 'skip' : 'cancel';
}

async function pickTarget(board: Board): Promise<ProgramTarget | undefined> {
	const items: Array<vscode.QuickPickItem & { value: ProgramTarget }> = [
		{ label: 'SRAM', description: 'temporary — cleared on power-off', value: 'sram' },
		{ label: 'Flash', description: 'permanent — survives power-off', value: 'flash' },
	];
	items.sort((a) => (a.value === board.programmer.defaultTarget ? -1 : 0));
	const pick = await vscode.window.showQuickPick(items, {
		title: `Program ${board.name}`,
		placeHolder: 'Where should the bitstream go?',
	});
	return pick?.value;
}

/**
 * Run one exclusive operation: take the build lock, expose its
 * AbortController to the status-bar Cancel button, and report progress in
 * the status bar (Window) rather than a notification toast that would
 * obstruct the Output view.
 */
async function runExclusive(
	output: vscode.OutputChannel,
	title: string,
	task: (
		io: PipelineIo,
		progress: vscode.Progress<{ message?: string }>,
	) => Promise<StageResult>,
): Promise<void> {
	if (!acquireBuildLock()) {
		vscode.window.showWarningMessage('OpenFPGA Deck: a build is already running.');
		return;
	}
	const controller = new AbortController();
	activeBuild = controller;
	refreshStatusBar();

	output.clear();
	output.show(true);
	try {
		const result = await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Window, title: `OpenFPGA Deck: ${title}` },
			(progress, token) => {
				token.onCancellationRequested(() => controller.abort());
				return task(makeIo(controller.signal, output), progress);
			},
		);
		report(output, result);
	} finally {
		activeBuild = undefined;
		refreshStatusBar();
		releaseBuildLock();
	}
}

async function runDetect(output: vscode.OutputChannel, boards: BoardRegistry): Promise<void> {
	const ctx = await prepare(output, boards);
	if (!ctx) {
		return;
	}
	await runExclusive(output, 'detecting board', async (io) => {
		const result = await detectBoard(
			{
				project: ctx.project,
				board: ctx.board,
				projectRoot: ctx.root,
				openFpgaLoaderExe: ctx.toolchain.tools.openFPGALoader.path,
			},
			io,
		);
		if (result.ok) {
			output.append(successLine(result.summary));
		} else if (!result.canceled) {
			output.append(failureLine(result.summary));
		}
		return result;
	});
}

async function runPipeline(
	output: vscode.OutputChannel,
	boards: BoardRegistry,
	title: string,
	targetIndex: number | undefined,
	forceAll: boolean,
	prepared?: Prepared,
	programSpec?: ProgramSpec,
): Promise<void> {
	const ctx = prepared ?? (await prepare(output, boards));
	if (!ctx) {
		return;
	}
	const stages = stagesFor(ctx, programSpec);
	// Program commands run through the last stage; stage commands stop at their
	// explicit index.
	const target = targetIndex ?? stages.length - 1;

	await runExclusive(output, title, async (io, progress) => {
		let last: StageResult = { ok: true, canceled: false, summary: 'Nothing to do.' };
		for (let i = 0; i <= target; i++) {
			const stage = stages[i];
			const isTarget = i === target;
			if (
				!forceAll &&
				!isTarget &&
				stage.output !== undefined &&
				(await pathExists(stage.output))
			) {
				continue;
			}
			progress.report({ message: stage.message });
			last = await stage.run(io);
			output.append(last.ok ? successLine(last.summary) : failureLine(last.summary));
			if (!last.ok) {
				return last;
			}
		}
		return last;
	});
}

function pathExists(p: string): Promise<boolean> {
	return fs
		.access(p)
		.then(() => true)
		.catch(() => false);
}

function report(output: vscode.OutputChannel, result: StageResult): void {
	if (result.ok) {
		vscode.window.showInformationMessage(`OpenFPGA Deck: ${result.summary}`);
	} else if (result.canceled) {
		vscode.window.showInformationMessage('OpenFPGA Deck: build cancelled.');
	} else {
		output.show(true);
		vscode.window.showErrorMessage(`OpenFPGA Deck: ${result.summary}`);
	}
}
