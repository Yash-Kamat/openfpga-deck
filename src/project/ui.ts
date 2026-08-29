/**
 * VS Code surface for the project system: the `Validate Project` command, a
 * status-bar indicator of the current `fpga.yaml` state, and a watcher that
 * keeps the indicator fresh as project files change.
 */

import * as vscode from 'vscode';
import { loadProject, PROJECT_FILE_NAME, type LoadProjectResult } from './loader';
import type { ConfigIssue } from './schema';
import type { BoardRegistry } from '../boards/registry';

/** File extensions whose saving should re-check the project. */
const PROJECT_FILE_RE = /\.(sv|svh|v|vh|vhd|vhdl|cst|ya?ml)$/i;

export function registerProjectUi(
	context: vscode.ExtensionContext,
	output: vscode.OutputChannel,
	boards: BoardRegistry,
): void {
	const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 89);
	status.command = 'openfpga.validateProject';
	context.subscriptions.push(status);

	const projectRoot = (): string | undefined =>
		vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

	const refresh = (): void => {
		const root = projectRoot();
		if (!root) {
			status.hide();
			return;
		}
		const result = loadProject(root, undefined, boards.ids());
		if (!result.ok && result.configPath === undefined) {
			// No fpga.yaml in this workspace — nothing to validate.
			status.hide();
			return;
		}
		applyStatus(status, result);
		status.show();
	};

	const watcher = vscode.workspace.createFileSystemWatcher(`**/${PROJECT_FILE_NAME}`);
	context.subscriptions.push(
		watcher,
		watcher.onDidCreate(refresh),
		watcher.onDidDelete(refresh),
		watcher.onDidChange(refresh),
		vscode.workspace.onDidSaveTextDocument((doc) => {
			if (PROJECT_FILE_RE.test(doc.fileName)) {
				refresh();
			}
		}),
		vscode.commands.registerCommand('openfpga.validateProject', () => {
			runValidate(output, boards);
			refresh();
		}),
	);

	refresh();
}

function applyStatus(status: vscode.StatusBarItem, result: LoadProjectResult): void {
	if (result.ok) {
		const warnings = result.value.warnings.length;
		status.text = warnings > 0 ? '$(warning)' : '$(check)';
		status.tooltip =
			warnings > 0
				? `OpenFPGA Deck: project valid, ${warnings} warning(s) — click to review`
				: 'OpenFPGA Deck: fpga.yaml is valid — click to re-validate';
		status.backgroundColor = warnings
			? new vscode.ThemeColor('statusBarItem.warningBackground')
			: undefined;
		return;
	}
	status.text = '$(error)';
	status.tooltip = `OpenFPGA Deck: ${result.errors.length} error(s) in fpga.yaml — click for details`;
	status.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
}

function runValidate(output: vscode.OutputChannel, boards: BoardRegistry): void {
	const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!root) {
		vscode.window.showErrorMessage('OpenFPGA Deck: open a folder before validating a project.');
		return;
	}

	const result = loadProject(root, undefined, boards.ids());

	output.clear();
	output.show(true);
	output.appendLine(`Validating ${PROJECT_FILE_NAME} in ${root}`);
	output.appendLine('');

	if (result.ok) {
		const p = result.value.project;
		const board = boards.get(p.board);
		output.appendLine('Project file is valid.');
		output.appendLine(`  name:        ${p.name}`);
		output.appendLine(`  board:       ${p.board}${board ? ` (${board.name}, ${board.fpga.part})` : ''}`);
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
