/**
 * "Initialize Project": a guided QuickPick sequence that scaffolds a new
 * OpenFPGA Deck project into the open folder. Also offers to run itself when
 * an empty folder is opened.
 *
 * The wizard only asks questions; the files come from the pure planner in
 * scaffold.ts. Nothing existing is overwritten — a file that is already
 * there is left alone and reported.
 */

import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as vscode from 'vscode';
import type { BoardRegistry } from '../boards/registry';
import {
	canBlink,
	planScaffold,
	validateModuleName,
	validateProjectName,
	type HdlLanguage,
	type StarterDesign,
} from './scaffold';
import { PROJECT_FILE_NAME } from './loader';

export async function initProjectCommand(
	output: vscode.OutputChannel,
	boards: BoardRegistry,
): Promise<void> {
	const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!root) {
		vscode.window.showErrorMessage('OpenFPGA Deck: open a folder before initializing a project.');
		return;
	}

	const configPath = path.join(root, PROJECT_FILE_NAME);
	if (await pathExists(configPath)) {
		const pick = await vscode.window.showWarningMessage(
			`This folder already has an ${PROJECT_FILE_NAME}.`,
			'Open it',
		);
		if (pick === 'Open it') {
			await openInEditor(configPath);
		}
		return;
	}

	if (boards.list().length === 0) {
		vscode.window.showErrorMessage('OpenFPGA Deck: no board definitions are available.');
		return;
	}

	const name = await vscode.window.showInputBox({
		title: 'New project — name',
		value: path.basename(root),
		validateInput: validateProjectName,
	});
	if (name === undefined) {
		return;
	}

	const boardPick = await vscode.window.showQuickPick(
		boards.list().map((b) => ({ label: b.name, description: b.fpga.part, id: b.id })),
		{ title: 'New project — target board' },
	);
	if (!boardPick) {
		return;
	}
	const board = boards.get(boardPick.id);
	if (!board) {
		return;
	}

	const top = await vscode.window.showInputBox({
		title: 'New project — top module name',
		value: 'top',
		validateInput: validateModuleName,
	});
	if (top === undefined) {
		return;
	}

	const langPick = await vscode.window.showQuickPick(
		[
			{ label: 'Verilog', description: '.v', value: 'verilog' as HdlLanguage },
			{ label: 'SystemVerilog', description: '.sv', value: 'systemverilog' as HdlLanguage },
		],
		{ title: 'New project — HDL language' },
	);
	if (!langPick) {
		return;
	}

	const designItems: Array<vscode.QuickPickItem & { value: StarterDesign }> = [];
	if (canBlink(board)) {
		designItems.push({ label: 'Blink the on-board LEDs', value: 'blink' });
	}
	designItems.push({ label: 'Empty top module', value: 'empty' });
	const designPick = await vscode.window.showQuickPick(designItems, {
		title: 'New project — starter design',
	});
	if (!designPick) {
		return;
	}

	const plan = planScaffold({
		name: name.trim(),
		top: top.trim(),
		language: langPick.value,
		design: designPick.value,
		board,
	});

	const confirm = await vscode.window.showInformationMessage(
		`Create OpenFPGA project "${name.trim()}" for ${board.name}?`,
		{ modal: true, detail: plan.files.map((f) => `  ${f.path}`).join('\n') },
		'Create',
	);
	if (confirm !== 'Create') {
		return;
	}

	output.clear();
	output.show(true);
	for (const dir of plan.dirs) {
		await fs.mkdir(path.join(root, dir), { recursive: true });
	}
	for (const file of plan.files) {
		const abs = path.join(root, ...file.path.split('/'));
		if (await pathExists(abs)) {
			output.appendLine(`kept existing  ${file.path}`);
			continue;
		}
		await fs.mkdir(path.dirname(abs), { recursive: true });
		await fs.writeFile(abs, file.content, 'utf8');
		output.appendLine(`created        ${file.path}`);
	}

	await openInEditor(configPath);
	vscode.window.showInformationMessage(`OpenFPGA Deck: project "${name.trim()}" created.`);
}

/** Folders where the init offer was declined this session (re-offered next window). */
const declinedThisSession = new Set<string>();

/**
 * When an empty folder is opened, offer to initialize. A "Not now" is
 * respected for the rest of the session but the offer returns in a fresh
 * window. The extension only runs in trusted folders, so this never fires
 * before the folder is trusted.
 */
export async function offerInitForEmptyFolder(): Promise<void> {
	const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!root || declinedThisSession.has(root)) {
		return;
	}
	if (await pathExists(path.join(root, PROJECT_FILE_NAME))) {
		return;
	}
	const entries = await fs.readdir(root).catch(() => [] as string[]);
	if (entries.some((entry) => !entry.startsWith('.'))) {
		return; // only offer in an otherwise-empty folder
	}

	const pick = await vscode.window.showInformationMessage(
		'This folder is empty. Initialize an OpenFPGA Deck project?',
		'Initialize',
		'Not now',
	);
	if (pick === 'Initialize') {
		await vscode.commands.executeCommand('openfpga.initProject');
	} else {
		declinedThisSession.add(root);
	}
}

async function openInEditor(filePath: string): Promise<void> {
	const doc = await vscode.workspace.openTextDocument(filePath);
	await vscode.window.showTextDocument(doc);
}

async function pathExists(p: string): Promise<boolean> {
	try {
		await fs.access(p);
		return true;
	} catch {
		return false;
	}
}
