/**
 * VS Code surface for the toolchain module: a status-bar indicator and the
 * "Verify Toolchain" / "Select Toolchain" commands.
 *
 * The toolchain path is stored in the `openfpga.toolchain.path` *setting*,
 * not in `fpga.yaml`, because it is machine-specific. The setting is declared
 * with `machine-overridable` scope so a workspace (which may come from an
 * untrusted cloned repo) cannot point the extension at an arbitrary
 * executable — only user/machine settings can set it. "Select Toolchain"
 * therefore always writes to the Global (user) target.
 */

import * as os from 'node:os';
import * as vscode from 'vscode';
import {
	discover,
	findAllToolchains,
	REQUIRED_TOOLS,
	validateToolchainAt,
	type DiscoverOptions,
	type DiscoverResult,
	type Toolchain,
	type ToolchainSource,
} from './discovery';
import { nodeToolchainHost } from './nodeHost';

const SETTING_PATH = 'openfpga.toolchain.path';

function currentOptions(): DiscoverOptions {
	return {
		configuredPath: vscode.workspace.getConfiguration().get<string>(SETTING_PATH) ?? '',
		pathEnv: process.env.PATH ?? '',
		homeDir: os.homedir(),
	};
}

export function registerToolchainUi(
	context: vscode.ExtensionContext,
	output: vscode.OutputChannel,
): void {
	const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
	status.command = 'openfpga.verifyToolchain';
	context.subscriptions.push(status);

	const refresh = (): void => {
		const result = discover(currentOptions(), nodeToolchainHost);
		if (result.ok) {
			status.text = '$(circuit-board) OSS CAD Suite';
			status.tooltip = `OpenFPGA Deck: OSS CAD Suite at ${result.toolchain.root}`;
			status.backgroundColor = undefined;
		} else {
			status.text = '$(warning) No toolchain';
			status.tooltip = `OpenFPGA Deck: ${result.reason} — click to verify`;
			status.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
		}
		status.show();
	};

	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('openfpga.toolchain')) {
				refresh();
			}
		}),
		vscode.commands.registerCommand('openfpga.verifyToolchain', () => {
			reportToolchain(output, discover(currentOptions(), nodeToolchainHost));
			refresh();
		}),
		vscode.commands.registerCommand('openfpga.selectToolchain', async () => {
			await selectToolchain(output);
			refresh();
		}),
	);

	refresh();
}

function reportToolchain(output: vscode.OutputChannel, result: DiscoverResult): void {
	output.clear();
	output.show(true);

	if (!result.ok) {
		output.appendLine('No usable OSS CAD Suite installation found.');
		output.appendLine(`Reason: ${result.reason}`);
		if (result.searched.length > 0) {
			output.appendLine('');
			output.appendLine('Locations checked:');
			for (const loc of result.searched) {
				output.appendLine(`  - ${loc}`);
			}
		}
		output.appendLine('');
		output.appendLine('Run "OpenFPGA Deck: Select Toolchain" to choose one.');
		vscode.window.showWarningMessage('OpenFPGA Deck: no OSS CAD Suite found. See the OpenFPGA Deck output.');
		return;
	}

	const { toolchain, source } = result;
	output.appendLine(`OSS CAD Suite found (via ${sourceLabel(source)}).`);
	output.appendLine(`  root: ${toolchain.root}`);
	output.appendLine('');
	output.appendLine('Tools:');
	for (const id of REQUIRED_TOOLS) {
		const tool = toolchain.tools[id];
		output.appendLine(`  ${id.padEnd(20)} ${tool.version ?? '(version unknown)'}`);
		output.appendLine(`  ${' '.repeat(20)} ${tool.path}`);
	}
	vscode.window.showInformationMessage('OpenFPGA Deck: OSS CAD Suite verified.');
}

async function selectToolchain(output: vscode.OutputChannel): Promise<void> {
	const options = currentOptions();
	const found = findAllToolchains(options, nodeToolchainHost);

	type Item = vscode.QuickPickItem & { root?: string; action?: 'browse' };
	const items: Item[] = found.map((tc) => ({
		label: `$(circuit-board) ${tc.root}`,
		description: describeVersions(tc),
		root: tc.root,
	}));
	items.push({
		label: '$(folder-opened) Enter a path manually…',
		description: 'Point at an oss-cad-suite folder',
		action: 'browse',
	});

	const picked = await vscode.window.showQuickPick(items, {
		title: 'Select OSS CAD Suite toolchain',
		placeHolder: found.length > 0 ? 'Detected installations' : 'No installations detected',
	});
	if (!picked) {
		return;
	}

	let chosenRoot: string | undefined = picked.root;
	if (picked.action === 'browse') {
		chosenRoot = await promptForPath();
	}
	if (!chosenRoot) {
		return;
	}

	await vscode.workspace
		.getConfiguration()
		.update(SETTING_PATH, chosenRoot, vscode.ConfigurationTarget.Global);
	output.appendLine(`Toolchain set to: ${chosenRoot}`);
	vscode.window.showInformationMessage(`OpenFPGA Deck: toolchain set to ${chosenRoot}`);
}

async function promptForPath(): Promise<string | undefined> {
	const entered = await vscode.window.showInputBox({
		title: 'OSS CAD Suite path',
		prompt: 'Absolute path to the oss-cad-suite folder (or a folder that contains it)',
		validateInput: (value) => {
			if (!value.trim()) {
				return 'Enter a path.';
			}
			const result = validateToolchainAt(value.trim(), nodeToolchainHost);
			return result.ok ? undefined : result.reason;
		},
	});
	return entered?.trim() || undefined;
}

function describeVersions(tc: Toolchain): string {
	const yosys = tc.tools.yosys.version;
	const pnr = tc.tools['nextpnr-himbaechel'].version;
	const parts: string[] = [];
	if (yosys) {
		parts.push(`yosys ${yosys}`);
	}
	if (pnr) {
		parts.push(pnr);
	}
	return parts.join(' · ');
}

function sourceLabel(source: ToolchainSource): string {
	switch (source) {
		case 'setting':
			return 'the openfpga.toolchain.path setting';
		case 'path':
			return 'PATH';
		case 'conventional':
			return 'a conventional install location';
	}
}
