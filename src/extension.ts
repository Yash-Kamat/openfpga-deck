import * as vscode from 'vscode';

/**
 * Called by VS Code once, the first time an activation event for this
 * extension fires (here: the first time the user runs one of our commands).
 * Everything the extension needs to register — commands, status bar items,
 * output channels, etc. — happens here.
 */
export function activate(context: vscode.ExtensionContext): void {
	const helloCommand = vscode.commands.registerCommand('openfpga.hello', () => {
		vscode.window.showInformationMessage('OpenFPGA Deck is alive.');
	});

	// context.subscriptions is VS Code's cleanup list: everything pushed here
	// is automatically disposed when the extension deactivates, so we don't
	// leak listeners/commands across reloads.
	context.subscriptions.push(helloCommand);
}

/**
 * Called by VS Code when the extension is deactivated (window closed,
 * extension disabled, VS Code shutting down). We have nothing manual to
 * clean up yet — context.subscriptions handles the command registration —
 * but this hook stays in place for later phases (e.g. killing any running
 * build subprocess on shutdown).
 */
export function deactivate(): void {
	// Intentionally empty for now.
}
