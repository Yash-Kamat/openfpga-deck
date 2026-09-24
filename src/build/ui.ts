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
import { lintCst, parseNextpnrLog, parsePackLog, parseYosysLog, type ProjectText, type ToolDiagnostic } from './diagnostics';
import { isUpToDate } from './incremental';
import { BUILD_DIRNAME, buildLayout } from './layout';
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
/** Problems-panel entries from the last run of each tool. */
let diagnostics: vscode.DiagnosticCollection | undefined;
const toolDiagnostics = new Map<DiagnosticSource, ToolDiagnostic[]>();
type ToolName = 'yosys' | 'nextpnr' | 'gowin_pack';
type DiagnosticSource = ToolName | 'cst';

export function registerBuildUi(
	context: vscode.ExtensionContext,
	output: vscode.OutputChannel,
	boards: BoardRegistry,
): void {
	// A stage command always runs its own stage; Build skips it too when it is
	// up to date. Earlier stages run only when stale (see incremental.ts).
	const run =
		(title: string, target: number, skipUpToDateTarget = false) =>
		(): Promise<void> =>
			runPipeline(output, boards, title, target, skipUpToDateTarget);

	diagnostics = vscode.languages.createDiagnosticCollection('OpenFPGA Deck');
	context.subscriptions.push(
		diagnostics,
		vscode.commands.registerCommand('openfpga.synthesize', run('synthesizing', 0)),
		vscode.commands.registerCommand('openfpga.placeAndRoute', run('place & route', 1)),
		vscode.commands.registerCommand('openfpga.packBitstream', run('packing bitstream', 2)),
		vscode.commands.registerCommand('openfpga.build', run('building', 2, true)),
		vscode.commands.registerCommand('openfpga.program', () => runProgram(output, boards, 'programming')),
		vscode.commands.registerCommand('openfpga.buildAndProgram', () =>
			runProgram(output, boards, 'build & program'),
		),
		vscode.commands.registerCommand('openfpga.clean', () => runClean(output)),
		// Check a .cst as soon as it is saved, not only when a build reaches nextpnr.
		vscode.workspace.onDidSaveTextDocument((doc) => {
			const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
			if (!root || !/\.cst$/i.test(doc.fileName)) {
				return;
			}
			const loaded = loadProject(root, undefined, boards.ids());
			const board = loaded.ok ? boards.get(loaded.value.project.board) : undefined;
			if (loaded.ok && board) {
				void checkCst({ root, project: loaded.value.project, board });
			}
		}),
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
		{ label: '$(trash) Clean', description: 'delete build/ (keeps flash backups)', command: 'openfpga.clean' },
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
	readonly logFile?: string;
}

interface Stage {
	/** Name for the "up to date" line. */
	readonly name: string;
	/** Progress-notification message while this stage runs. */
	readonly message: string;
	/** Absolute path of the file this stage produces; absent = always runs. */
	readonly output?: string;
	/** Absolute paths whose changes make `output` stale. */
	readonly inputs?: readonly string[];
	/** Whose log feeds the Problems panel. */
	readonly tool?: ToolName;
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
		const abs = (rel: string): string => path.join(ctx.root, rel);
		const yaml = abs(PROJECT_FILE_NAME);
		const netlist = path.join(layout.netlistDir, `${ctx.project.top}.json`);
		const pnr = path.join(layout.pnrDir, `${ctx.project.top}.pnr.json`);
		stages.push(
			{
				name: 'Synthesis',
				message: 'synthesizing…',
				output: netlist,
				inputs: [yaml, ...ctx.project.sources.map(abs)],
				tool: 'yosys',
				run: (io) => synthesize({ ...common, yosysExe: tools.yosys.path }, io),
			},
			{
				name: 'Place & route',
				message: 'placing & routing…',
				output: pnr,
				inputs: [yaml, netlist, ...ctx.project.constraints.map(abs)],
				tool: 'nextpnr',
				run: (io) => placeAndRoute({ ...common, nextpnrExe: tools['nextpnr-himbaechel'].path }, io),
			},
			{
				name: 'Packing',
				message: 'packing bitstream…',
				output: path.join(layout.bitstreamDir, `${ctx.project.name}.fs`),
				inputs: [pnr],
				tool: 'gowin_pack',
				run: (io) => packBitstream({ ...common, gowinPackExe: tools.gowin_pack.path }, io),
			},
		);
	}

	if (programSpec) {
		if (programSpec.backup) {
			stages.push({
				name: 'Flash backup',
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
			name: 'Programming',
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

	await runPipeline(output, boards, title, undefined, false, ctx, { target, backup });
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
	skipUpToDateTarget: boolean,
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
	// Output from a different toolchain version is stale, whatever its date.
	const stampFile = path.join(buildLayout(ctx.root).dir, '.toolchain');
	const sameToolchain = (await fs.readFile(stampFile, 'utf8').catch(() => '')) === ctx.toolchain.root;

	if (!programSpec?.fromFile) {
		await checkCst(ctx);
	}

	await runExclusive(output, title, async (io, progress) => {
		let last: StageResult = { ok: true, canceled: false, summary: 'Everything is up to date.' };
		let ran = false;
		for (let i = 0; i <= target; i++) {
			const stage = stages[i];
			const mayskip = i < target || skipUpToDateTarget;
			if (mayskip && !ran && sameToolchain && (await upToDate(stage))) {
				output.appendLine(`⏭ ${stage.name}: up to date, skipped.`);
				continue;
			}
			progress.report({ message: stage.message });
			last = await stage.run(io);
			ran = true;
			if (stage.tool) {
				await publishDiagnostics(ctx, stage.tool, last.logFile);
			}
			output.append(last.ok ? successLine(last.summary) : failureLine(last.summary));
			if (!last.ok) {
				return last;
			}
			if (stage.tool) {
				await fs.writeFile(stampFile, ctx.toolchain.root, 'utf8').catch(() => undefined);
			}
		}
		return last;
	});
}

async function upToDate(stage: Stage): Promise<boolean> {
	if (!stage.output || !stage.inputs) {
		return false;
	}
	const mtime = (p: string): Promise<number | undefined> =>
		fs.stat(p).then(
			(s) => s.mtimeMs,
			() => undefined,
		);
	return isUpToDate(await mtime(stage.output), await Promise.all(stage.inputs.map(mtime)));
}

const PARSERS: Record<ToolName, (log: string, project: ProjectText) => ToolDiagnostic[]> = {
	yosys: parseYosysLog,
	nextpnr: parseNextpnrLog,
	gowin_pack: parsePackLog,
};

/** Replace one tool's entries in the Problems panel with those from its latest log. */
async function publishDiagnostics(ctx: Prepared, tool: ToolName, logFile: string | undefined): Promise<void> {
	const read = (rel: string): Promise<string> => fs.readFile(path.join(ctx.root, rel), 'utf8').catch(() => '');
	const log = logFile ? await fs.readFile(logFile, 'utf8').catch(() => '') : '';
	const project: ProjectText = {
		yaml: await read(PROJECT_FILE_NAME),
		csts: await readCsts(ctx),
		hdl: tool === 'yosys' ? Object.fromEntries(await Promise.all(ctx.project.sources.map(async (s) => [s, await read(s)]))) : undefined,
	};
	toolDiagnostics.set(tool, PARSERS[tool](log, project));
	showDiagnostics(ctx.root);
}

async function readCsts(ctx: Pick<Prepared, 'root' | 'project'>): Promise<{ path: string; text: string }[]> {
	return Promise.all(
		ctx.project.constraints
			.filter((c) => /\.cst$/i.test(c))
			.map(async (c) => ({ path: c, text: await fs.readFile(path.join(ctx.root, c), 'utf8').catch(() => '') })),
	);
}

/** The .cst checks that need no tools (see lintCst). */
async function checkCst(ctx: Pick<Prepared, 'root' | 'project' | 'board'>): Promise<void> {
	const locs = new Set(Object.values(ctx.board.pins).flatMap((p) => p.loc.split(',').map((l) => l.trim())));
	const found = (await readCsts(ctx)).flatMap((c) => lintCst(c.path, c.text, locs, ctx.board.name));
	toolDiagnostics.set('cst', found);
	showDiagnostics(ctx.root);
}

function showDiagnostics(root: string): void {
	if (!diagnostics) {
		return;
	}
	const byFile = new Map<string, vscode.Diagnostic[]>();
	for (const [tool, list] of toolDiagnostics) {
		for (const d of list) {
			const line = Math.max(0, d.line - 1);
			const diag = new vscode.Diagnostic(
				new vscode.Range(line, 0, line, Number.MAX_SAFE_INTEGER),
				d.message,
				d.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning,
			);
			diag.source = tool === 'cst' ? 'OpenFPGA Deck' : tool;
			const file = path.resolve(root, d.file);
			byFile.set(file, [...(byFile.get(file) ?? []), diag]);
		}
	}
	diagnostics.clear();
	for (const [file, list] of byFile) {
		diagnostics.set(vscode.Uri.file(file), list);
	}
}

/** Delete build/ except build/backup/ (flash dumps cannot be regenerated). */
async function runClean(output: vscode.OutputChannel): Promise<void> {
	const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!root || !existsSync(path.join(root, PROJECT_FILE_NAME))) {
		vscode.window.showErrorMessage('OpenFPGA Deck: open a project folder first.');
		return;
	}
	if (!acquireBuildLock()) {
		vscode.window.showWarningMessage('OpenFPGA Deck: a build is running; cancel it before cleaning.');
		return;
	}
	try {
		const dir = path.join(root, BUILD_DIRNAME);
		const entries = await fs.readdir(dir).catch(() => [] as string[]);
		const removed = entries.filter((e) => e !== 'backup');
		for (const entry of removed) {
			await fs.rm(path.join(dir, entry), { recursive: true, force: true });
		}
		toolDiagnostics.clear();
		showDiagnostics(root);
		const kept = entries.includes('backup') ? ' Flash backups in build/backup/ were kept.' : '';
		output.appendLine(`Clean: removed ${removed.length ? removed.map((e) => `build/${e}`).join(', ') : 'nothing'}.${kept}`);
		vscode.window.showInformationMessage(`OpenFPGA Deck: build output removed.${kept}`);
	} finally {
		releaseBuildLock();
	}
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
