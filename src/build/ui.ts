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
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Board } from '../boards/schema';
import type { BoardRegistry } from '../boards/registry';
import { loadProject } from '../project/loader';
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
import { detectBoard, program } from './program';
import { synthesize, type PipelineIo } from './synthesize';

const PROGRAM_STAGE = 3;

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
	);
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

function stagesFor(ctx: Prepared, programTarget?: ProgramTarget): Stage[] {
	const layout = buildLayout(ctx.root);
	const tools = ctx.toolchain.tools;
	const common = { project: ctx.project, board: ctx.board, projectRoot: ctx.root };
	const stages: Stage[] = [
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
	];
	if (programTarget) {
		stages.push({
			message: programTarget === 'flash' ? 'writing flash…' : 'loading SRAM…',
			run: (io) =>
				program({ ...common, openFpgaLoaderExe: tools.openFPGALoader.path, target: programTarget }, io),
		});
	}
	return stages;
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
	await runPipeline(output, boards, title, PROGRAM_STAGE, forceAll, ctx, target);
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

async function runDetect(output: vscode.OutputChannel, boards: BoardRegistry): Promise<void> {
	const ctx = await prepare(output, boards);
	if (!ctx) {
		return;
	}
	if (!acquireBuildLock()) {
		vscode.window.showWarningMessage('OpenFPGA Deck: a build is already running.');
		return;
	}
	output.clear();
	output.show(true);
	try {
		const result = await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, cancellable: true, title: 'OpenFPGA Deck: detecting board' },
			async (_progress, token) => {
				const controller = new AbortController();
				token.onCancellationRequested(() => controller.abort());
				return detectBoard(
					{
						project: ctx.project,
						board: ctx.board,
						projectRoot: ctx.root,
						openFpgaLoaderExe: ctx.toolchain.tools.openFPGALoader.path,
					},
					makeIo(controller.signal, output),
				);
			},
		);
		if (result.ok) {
			output.append(successLine(result.summary));
		} else if (!result.canceled) {
			output.append(failureLine(result.summary));
		}
		report(output, result);
	} finally {
		releaseBuildLock();
	}
}

async function runPipeline(
	output: vscode.OutputChannel,
	boards: BoardRegistry,
	title: string,
	targetIndex: number,
	forceAll: boolean,
	prepared?: Prepared,
	programTarget?: ProgramTarget,
): Promise<void> {
	const ctx = prepared ?? (await prepare(output, boards));
	if (!ctx) {
		return;
	}
	if (!acquireBuildLock()) {
		vscode.window.showWarningMessage('OpenFPGA Deck: a build is already running.');
		return;
	}

	output.clear();
	output.show(true);
	try {
		const stages = stagesFor(ctx, programTarget);
		const result = await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				cancellable: true,
				title: `OpenFPGA Deck: ${title}`,
			},
			async (progress, token) => {
				const controller = new AbortController();
				token.onCancellationRequested(() => controller.abort());
				const io = makeIo(controller.signal, output);

				let last: StageResult = { ok: true, canceled: false, summary: 'Nothing to do.' };
				for (let i = 0; i <= targetIndex; i++) {
					const stage = stages[i];
					const isTarget = i === targetIndex;
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
					if (!last.ok) {
						output.append(failureLine(last.summary));
						return last;
					}
					output.append(successLine(last.summary));
				}
				return last;
			},
		);
		report(output, result);
	} finally {
		releaseBuildLock();
	}
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
