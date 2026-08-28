import * as vscode from 'vscode';
import { loadProject, PROJECT_FILE_NAME } from './project/loader';
import type { ConfigIssue } from './project/schema';

/**
 * Called by VS Code once, the first time an activation event for this
 * extension fires (here: the first time the user runs one of our commands).
 * Everything the extension needs to register — commands, status bar items,
 * output channels, etc. — happens here.
 */
export function activate(context: vscode.ExtensionContext): void {
	// A single output channel for everything the extension reports. VS Code
	// shows it in the "Output" panel under the name "OpenFPGA Deck". Unlike a
	// notification it keeps a scrollback, which is what we want for build logs
	// and validation reports.
	const output = vscode.window.createOutputChannel('OpenFPGA Deck');
	context.subscriptions.push(output);

	const helloCommand = vscode.commands.registerCommand('openfpga.hello', () => {
		vscode.window.showInformationMessage('OpenFPGA Deck is alive.');
	});

	const validateCommand = vscode.commands.registerCommand('openfpga.validateProject', () => {
		validateProjectCommand(output);
	});

	// context.subscriptions is VS Code's cleanup list: everything pushed here
	// is automatically disposed when the extension deactivates, so we don't
	// leak listeners/commands across reloads.
	context.subscriptions.push(helloCommand, validateCommand);
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

function validateProjectCommand(output: vscode.OutputChannel): void {
	const folders = vscode.workspace.workspaceFolders;
	if (!folders || folders.length === 0) {
		vscode.window.showErrorMessage('OpenFPGA Deck: open a folder before validating a project.');
		return;
	}

	// Phase 2 assumes a single-root workspace; multi-root support comes later.
	const root = folders[0].uri.fsPath;
	const result = loadProject(root);

	output.clear();
	output.show(true);
	output.appendLine(`Validating ${PROJECT_FILE_NAME} in ${root}`);
	output.appendLine('');

	if (result.ok) {
		const p = result.value.project;
		output.appendLine('Project file is valid.');
		output.appendLine(`  name:        ${p.name}`);
		output.appendLine(`  board:       ${p.board}`);
		output.appendLine(`  top:         ${p.top}`);
		output.appendLine(`  sources:     ${p.sources.join(', ')}`);
		output.appendLine(`  constraints: ${p.constraints.join(', ')}`);
		appendIssues(output, 'Warnings', result.value.warnings);

		if (result.value.warnings.length > 0) {
			vscode.window.showWarningMessage(
				`OpenFPGA Deck: project valid with ${result.value.warnings.length} warning(s). See the OpenFPGA Deck output.`,
			);
		} else {
			vscode.window.showInformationMessage('OpenFPGA Deck: project file is valid.');
		}
		return;
	}

	appendIssues(output, 'Errors', result.errors);
	appendIssues(output, 'Warnings', result.warnings);
	vscode.window.showErrorMessage(
		`OpenFPGA Deck: project file is invalid (${result.errors.length} error(s)). See the OpenFPGA Deck output.`,
	);
}

function appendIssues(output: vscode.OutputChannel, heading: string, issues: ConfigIssue[]): void {
	if (issues.length === 0) {
		return;
	}
	output.appendLine('');
	output.appendLine(`${heading}:`);
	for (const issue of issues) {
		const where =
			issue.line !== undefined
				? ` (line ${issue.line}${issue.column !== undefined ? `, col ${issue.column}` : ''})`
				: '';
		output.appendLine(`  - ${issue.message}${where}`);
	}
}
