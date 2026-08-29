/**
 * VS Code surface for the toolchain module: a status-bar indicator and the
 * "Verify Toolchain" / "Select Toolchain" commands.
 *
 * The indicator is two adjacent status-bar items so the icon and the text
 * can do different things: the `$(circuit-board)` icon verifies the current
 * toolchain, the "OSS CAD Suite <tag>" text opens the installed-version
 * picker. Both are shown only when the workspace is an actual OpenFPGA
 * project (an `fpga.yaml` at its root) and hidden everywhere else.
 *
 * The toolchain path is stored in the `openfpga.toolchain.path` *setting*,
 * not in `fpga.yaml`, because it is machine-specific. The setting is declared
 * with `machine-overridable` scope so a workspace (which may come from an
 * untrusted cloned repo) cannot point the extension at an arbitrary
 * executable — only user/machine settings can set it. "Select Toolchain"
 * therefore always writes to the Global (user) target.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { PROJECT_FILE_NAME } from '../project/loader';
import {
	discover,
	expandHome,
	findAllToolchains,
	REQUIRED_TOOLS,
	validateToolchainAt,
	type DiscoverOptions,
	type DiscoverResult,
	type Toolchain,
	type ToolchainSource,
} from './discovery';
import { nodeToolchainHost } from './nodeHost';
import { downloadToolchainCommand } from './installCommand';

const SETTING_PATH = 'openfpga.toolchain.path';
const SETTING_INSTALL_DIR = 'openfpga.toolchain.installDir';

function currentOptions(): DiscoverOptions {
	const cfg = vscode.workspace.getConfiguration();
	return {
		configuredPath: cfg.get<string>(SETTING_PATH) ?? '',
		installDir: cfg.get<string>(SETTING_INSTALL_DIR) ?? '',
		pathEnv: process.env.PATH ?? '',
		homeDir: os.homedir(),
	};
}

function activePath(): string {
	return (vscode.workspace.getConfiguration().get<string>(SETTING_PATH) ?? '').trim();
}

export function registerToolchainUi(
	context: vscode.ExtensionContext,
	output: vscode.OutputChannel,
): void {
	// Icon (verify) sits just left of the text (switch version); adjacent
	// priorities keep them together and left of the project indicator (89).
	const iconItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 91);
	iconItem.command = 'openfpga.verifyToolchain';
	const textItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
	textItem.command = 'openfpga.selectToolchain';
	context.subscriptions.push(iconItem, textItem);

	const isProjectFolder = (): boolean => {
		const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		return root !== undefined && fs.existsSync(path.join(root, PROJECT_FILE_NAME));
	};

	const refresh = (): void => {
		if (!isProjectFolder()) {
			iconItem.hide();
			textItem.hide();
			return;
		}
		const result = discover(currentOptions(), nodeToolchainHost);
		if (result.ok) {
			const tag = result.toolchain.tag;
			iconItem.text = '$(circuit-board)';
			iconItem.tooltip = `OpenFPGA Deck: OSS CAD Suite at ${result.toolchain.root} — click to verify`;
			iconItem.backgroundColor = undefined;
			textItem.text = tag ? `OSS CAD Suite ${tag}` : 'OSS CAD Suite';
			textItem.tooltip = 'OpenFPGA Deck: click to switch toolchain version';
			textItem.backgroundColor = undefined;
		} else {
			iconItem.text = '$(warning)';
			iconItem.tooltip = `OpenFPGA Deck: ${result.reason} — click to verify`;
			iconItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
			textItem.text = 'No toolchain';
			textItem.tooltip = 'OpenFPGA Deck: click to select or download a toolchain';
			textItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
		}
		iconItem.show();
		textItem.show();
	};

	const watcher = vscode.workspace.createFileSystemWatcher(`**/${PROJECT_FILE_NAME}`);
	context.subscriptions.push(
		watcher,
		watcher.onDidCreate(refresh),
		watcher.onDidDelete(refresh),
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('openfpga.toolchain')) {
				refresh();
			}
		}),
		vscode.commands.registerCommand('openfpga.verifyToolchain', async () => {
			await reportToolchain(output, discover(currentOptions(), nodeToolchainHost));
			refresh();
		}),
		vscode.commands.registerCommand('openfpga.selectToolchain', async () => {
			await selectToolchain(output);
			refresh();
		}),
		vscode.commands.registerCommand('openfpga.downloadToolchain', async () => {
			await downloadToolchainCommand(context, output);
			refresh();
		}),
	);

	refresh();
}

async function reportToolchain(
	output: vscode.OutputChannel,
	result: DiscoverResult,
): Promise<void> {
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
		const pick = await vscode.window.showWarningMessage(
			'OpenFPGA Deck: no OSS CAD Suite found.',
			'Download…',
			'Select Existing…',
		);
		if (pick === 'Download…') {
			await vscode.commands.executeCommand('openfpga.downloadToolchain');
		} else if (pick === 'Select Existing…') {
			await vscode.commands.executeCommand('openfpga.selectToolchain');
		}
		return;
	}

	const { toolchain, source } = result;
	output.appendLine(`OSS CAD Suite found (via ${sourceLabel(source)}).`);
	if (toolchain.tag) {
		output.appendLine(`  release: ${toolchain.tag}`);
	}
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
	const found = findAllToolchains(currentOptions(), nodeToolchainHost);
	const active = activePath();

	type Item = vscode.QuickPickItem & { root?: string; action?: 'browse' | 'download' };
	const items: Item[] = found.map((tc) => ({
		label: `$(circuit-board) ${tc.tag ?? path.basename(tc.root)}`,
		description: [describeVersions(tc), tc.root === active ? '• active' : ''].filter(Boolean).join('  '),
		detail: tc.root,
		root: tc.root,
	}));
	items.push(
		{
			label: '$(folder-opened) Choose a folder…',
			description: 'Point at an existing oss-cad-suite folder',
			action: 'browse',
		},
		{
			label: '$(cloud-download) Download a new one…',
			description: 'Fetch OSS CAD Suite from GitHub',
			action: 'download',
		},
	);

	const picked = await vscode.window.showQuickPick(items, {
		title: 'Select OSS CAD Suite toolchain',
		placeHolder: found.length > 0 ? 'Detected installations' : 'No installations detected',
	});
	if (!picked) {
		return;
	}

	if (picked.action === 'download') {
		await vscode.commands.executeCommand('openfpga.downloadToolchain');
		return;
	}

	const chosenRoot = picked.action === 'browse' ? await promptForPath() : picked.root;
	if (!chosenRoot) {
		return;
	}

	await vscode.workspace
		.getConfiguration()
		.update(SETTING_PATH, chosenRoot, vscode.ConfigurationTarget.Global);
	output.appendLine(`Active toolchain set to: ${chosenRoot}`);
	vscode.window.showInformationMessage(`OpenFPGA Deck: active toolchain set to ${chosenRoot}`);
}

async function promptForPath(): Promise<string | undefined> {
	const picked = await vscode.window.showOpenDialog({
		canSelectFiles: false,
		canSelectFolders: true,
		canSelectMany: false,
		openLabel: 'Use this toolchain',
		title: 'Select an oss-cad-suite folder (or one that contains it)',
	});
	if (!picked || picked.length === 0) {
		return undefined;
	}
	const chosen = expandHome(picked[0].fsPath, os.homedir());
	const result = validateToolchainAt(chosen, nodeToolchainHost);
	if (!result.ok) {
		vscode.window.showErrorMessage(`OpenFPGA Deck: not a usable OSS CAD Suite folder. ${result.reason}`);
		return undefined;
	}
	return result.toolchain.root;
}

function describeVersions(tc: Toolchain): string {
	const parts = [tc.tools.yosys.version && `yosys ${tc.tools.yosys.version}`, tc.tools['nextpnr-himbaechel'].version];
	return parts.filter(Boolean).join(' · ');
}

function sourceLabel(source: ToolchainSource): string {
	switch (source) {
		case 'setting':
			return 'the openfpga.toolchain.path setting';
		case 'path':
			return 'PATH';
		case 'managed':
			return 'the OpenFPGA Deck toolchains folder';
		case 'conventional':
			return 'a conventional install location';
	}
}
