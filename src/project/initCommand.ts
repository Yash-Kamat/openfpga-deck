/**
 * Offer "Initialize Project" (the Project Settings panel in create mode)
 * when an empty folder is opened.
 */

import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as vscode from 'vscode';
import { PROJECT_FILE_NAME } from './loader';

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

async function pathExists(p: string): Promise<boolean> {
	try {
		await fs.access(p);
		return true;
	} catch {
		return false;
	}
}
