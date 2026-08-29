import * as path from 'node:path';
import * as vscode from 'vscode';
import { loadBoardRegistry } from './boards/registry';
import { registerProjectUi } from './project/ui';
import { registerToolchainUi } from './toolchain/ui';

/**
 * Called by VS Code when an activation event fires (here: `onStartupFinished`,
 * shortly after the window opens). Everything the extension needs to register
 * — commands, status bar items, output channels — happens here.
 */
export function activate(context: vscode.ExtensionContext): void {
	// A single output channel for everything the extension reports. VS Code
	// shows it in the "Output" panel under the name "OpenFPGA Deck". Unlike a
	// notification it keeps a scrollback, which is what we want for build logs
	// and validation reports.
	const output = vscode.window.createOutputChannel('OpenFPGA Deck');
	context.subscriptions.push(output);

	// Board definitions shipped with the extension (boards/**/*.yaml).
	const boards = loadBoardRegistry(path.join(context.extensionPath, 'boards'));
	for (const err of boards.errors) {
		output.appendLine(`Board definition problem in ${err.file}: ${err.message}`);
	}

	// Each module registers its own commands, status-bar items and watchers,
	// pushing them onto context.subscriptions for automatic disposal.
	registerProjectUi(context, output, boards);
	registerToolchainUi(context, output);
}

/**
 * Called by VS Code when the extension is deactivated (window closed,
 * extension disabled, VS Code shutting down). We have nothing manual to
 * clean up yet — context.subscriptions handles the registrations — but this
 * hook stays in place for later phases (e.g. killing any running build
 * subprocess on shutdown).
 */
export function deactivate(): void {
	// Intentionally empty for now.
}
