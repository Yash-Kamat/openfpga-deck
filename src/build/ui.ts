/**
 * VS Code surface for the build pipeline. Phase 5b wires up one command,
 * "Synthesize", which runs Yosys over the project sources.
 *
 * This layer only does VS Code things — load the project, resolve the
 * toolchain, show progress, report the result. The actual work is the
 * injected-IO flow in synthesize.ts, so everything here is thin.
 */

import * as fs from 'node:fs/promises';
import * as vscode from 'vscode';
import type { BoardRegistry } from '../boards/registry';
import { loadProject } from '../project/loader';
import { resolveToolchain } from '../toolchain/resolve';
import { acquireBuildLock, releaseBuildLock } from './lock';
import { nodeProcessRunner } from './nodeProcess';
import { synthesize, type SynthesizeIo } from './synthesize';

export function registerBuildUi(
	context: vscode.ExtensionContext,
	output: vscode.OutputChannel,
	boards: BoardRegistry,
): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('openfpga.synthesize', () => runSynthesize(output, boards)),
	);
}

async function runSynthesize(output: vscode.OutputChannel, boards: BoardRegistry): Promise<void> {
	const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!root) {
		vscode.window.showErrorMessage('OpenFPGA Deck: open a project folder before synthesizing.');
		return;
	}

	const loaded = loadProject(root, undefined, boards.ids());
	if (!loaded.ok) {
		output.clear();
		output.show(true);
		output.appendLine('Cannot synthesize — fpga.yaml is not valid:');
		for (const issue of loaded.errors) {
			output.appendLine(`  - ${issue.message}`);
		}
		vscode.window.showErrorMessage(
			'OpenFPGA Deck: fix the errors in fpga.yaml before synthesizing (see the output).',
		);
		return;
	}

	const project = loaded.value.project;
	const board = boards.get(project.board);
	if (!board) {
		vscode.window.showErrorMessage(
			`OpenFPGA Deck: board "${project.board}" is not in the registry, so the synth family is unknown.`,
		);
		return;
	}

	const toolchain = resolveToolchain();
	if (!toolchain.ok) {
		const pick = await vscode.window.showErrorMessage(
			`OpenFPGA Deck: no usable OSS CAD Suite. ${toolchain.reason}`,
			'Select Toolchain…',
			'Download…',
		);
		if (pick === 'Select Toolchain…') {
			await vscode.commands.executeCommand('openfpga.selectToolchain');
		} else if (pick === 'Download…') {
			await vscode.commands.executeCommand('openfpga.downloadToolchain');
		}
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
				const io: SynthesizeIo = {
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
					signal: controller.signal,
				};
				return synthesize(
					{
						project,
						board,
						projectRoot: loaded.value.root,
						yosysExe: toolchain.toolchain.tools.yosys.path,
					},
					io,
				);
			},
		);

		output.appendLine('');
		output.appendLine(result.summary);

		if (result.ok) {
			vscode.window.showInformationMessage(`OpenFPGA Deck: ${result.summary}`);
		} else if (result.canceled) {
			vscode.window.showInformationMessage('OpenFPGA Deck: synthesis cancelled.');
		} else {
			vscode.window.showErrorMessage(`OpenFPGA Deck: ${result.summary}`);
		}
	} finally {
		releaseBuildLock();
	}
}
