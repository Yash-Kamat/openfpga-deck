/**
 * VS Code surface for the build pipeline: the "Synthesize" and "Place and
 * Route" commands.
 *
 * This layer only does VS Code things — load the project, resolve the
 * toolchain, show progress, report the result. The actual work is the
 * injected-IO flow in synthesize.ts / placeAndRoute.ts, so everything here
 * stays thin. Place & route runs synthesis first when the netlist is missing.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Board } from '../boards/schema';
import type { BoardRegistry } from '../boards/registry';
import { loadProject } from '../project/loader';
import type { FpgaProject } from '../project/schema';
import { resolveToolchain } from '../toolchain/resolve';
import type { Toolchain } from '../toolchain/discovery';
import { buildLayout } from './layout';
import { acquireBuildLock, releaseBuildLock } from './lock';
import { nodeProcessRunner } from './nodeProcess';
import { placeAndRoute } from './placeAndRoute';
import { synthesize, type PipelineIo } from './synthesize';

export function registerBuildUi(
	context: vscode.ExtensionContext,
	output: vscode.OutputChannel,
	boards: BoardRegistry,
): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('openfpga.synthesize', () => runSynthesize(output, boards)),
		vscode.commands.registerCommand('openfpga.placeAndRoute', () =>
			runPlaceAndRoute(output, boards),
		),
	);
}

interface Prepared {
	readonly root: string;
	readonly project: FpgaProject;
	readonly board: Board;
	readonly toolchain: Toolchain;
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

	return { root: loaded.value.root, project: loaded.value.project, board, toolchain: resolved.toolchain };
}

function makeIo(signal: AbortSignal, output: vscode.OutputChannel): PipelineIo {
	return {
		run: nodeProcessRunner,
		mkdirp: async (dir) => {
			await fs.mkdir(dir, { recursive: true });
		},
		writeFile: (file, text) => fs.writeFile(file, text, 'utf8'),
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

async function runSynthesize(output: vscode.OutputChannel, boards: BoardRegistry): Promise<void> {
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
			{
				location: vscode.ProgressLocation.Notification,
				cancellable: true,
				title: 'OpenFPGA Deck: synthesizing',
			},
			async (_progress, token) => {
				const controller = new AbortController();
				token.onCancellationRequested(() => controller.abort());
				return synthesize(
					{
						project: ctx.project,
						board: ctx.board,
						projectRoot: ctx.root,
						yosysExe: ctx.toolchain.tools.yosys.path,
					},
					makeIo(controller.signal, output),
				);
			},
		);
		report(output, result);
	} finally {
		releaseBuildLock();
	}
}

async function runPlaceAndRoute(
	output: vscode.OutputChannel,
	boards: BoardRegistry,
): Promise<void> {
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
			{
				location: vscode.ProgressLocation.Notification,
				cancellable: true,
				title: 'OpenFPGA Deck: place & route',
			},
			async (progress, token) => {
				const controller = new AbortController();
				token.onCancellationRequested(() => controller.abort());
				const io = makeIo(controller.signal, output);

				const netlist = path.join(buildLayout(ctx.root).netlistDir, `${ctx.project.top}.json`);
				if (!(await pathExists(netlist))) {
					progress.report({ message: 'synthesizing first…' });
					const synth = await synthesize(
						{
							project: ctx.project,
							board: ctx.board,
							projectRoot: ctx.root,
							yosysExe: ctx.toolchain.tools.yosys.path,
						},
						io,
					);
					if (!synth.ok) {
						return synth;
					}
				}

				progress.report({ message: 'placing & routing…' });
				return placeAndRoute(
					{
						project: ctx.project,
						board: ctx.board,
						projectRoot: ctx.root,
						nextpnrExe: ctx.toolchain.tools['nextpnr-himbaechel'].path,
					},
					io,
				);
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

function report(
	output: vscode.OutputChannel,
	result: { ok: boolean; canceled: boolean; summary: string },
): void {
	output.appendLine('');
	output.appendLine(result.summary);
	if (result.ok) {
		vscode.window.showInformationMessage(`OpenFPGA Deck: ${result.summary}`);
	} else if (result.canceled) {
		vscode.window.showInformationMessage('OpenFPGA Deck: build cancelled.');
	} else {
		vscode.window.showErrorMessage(`OpenFPGA Deck: ${result.summary}`);
	}
}
