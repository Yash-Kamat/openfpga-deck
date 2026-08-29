/**
 * The "Download Toolchain" command.
 *
 * Layout it produces, under the "toolchains directory"
 * (`openfpga.toolchain.installDir`, default `~/fpga-toolchain`):
 *
 *   <installDir>/
 *     oss-cad-suite-2026-08-28/     one folder per release, kept side by side
 *     oss-cad-suite-2026-06-29/
 *     downloads/
 *       oss-cad-suite-linux-x64-20260828.tgz   archives kept by default
 *
 * Nothing existing is deleted or overwritten without an explicit prompt; a
 * present archive with a matching hash is reused instead of re-downloaded.
 *
 * Integrity: after the bytes are in hand we compute the SHA-256 and then
 * either verify it against GitHub's published asset digest, against a hash we
 * recorded from a previous download, or (failing both) show it and ask for
 * confirmation before first use.
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as vscode from 'vscode';
import { expandHome, validateToolchainAt } from './discovery';
import { nodeToolchainHost } from './nodeHost';
import { downloadFile, extractArchive, fetchReleaseInfo, sha256File } from './install';
import {
	assetName,
	detectPlatform,
	downloadUrl,
	findAsset,
	tagLooksValid,
	type PlatformId,
} from './releases';

const SETTING_PATH = 'openfpga.toolchain.path';
const SETTING_INSTALL_DIR = 'openfpga.toolchain.installDir';
const SETTING_KEEP_DOWNLOADS = 'openfpga.toolchain.keepDownloads';

let inProgress = false;

export async function downloadToolchainCommand(
	context: vscode.ExtensionContext,
	output: vscode.OutputChannel,
): Promise<void> {
	if (inProgress) {
		vscode.window.showWarningMessage('OpenFPGA Deck: a toolchain download is already running.');
		return;
	}

	const platform = detectPlatform();
	if (!platform) {
		vscode.window.showErrorMessage(
			`OpenFPGA Deck: OSS CAD Suite has no build for this platform (${process.platform}/${process.arch}).`,
		);
		return;
	}

	const installDir = await resolveInstallDir();
	if (!installDir) {
		return;
	}

	const which = await pickRelease();
	if (!which) {
		return;
	}

	inProgress = true;
	try {
		await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, cancellable: true, title: 'OpenFPGA Deck' },
			async (progress, token) => {
				const controller = new AbortController();
				token.onCancellationRequested(() => controller.abort());
				await runInstall(context, output, {
					which,
					platform,
					installDir,
					progress,
					signal: controller.signal,
				});
			},
		);
	} catch (err) {
		if (isAbort(err)) {
			output.appendLine('Cancelled.');
			vscode.window.showInformationMessage('OpenFPGA Deck: toolchain download cancelled.');
		} else {
			const message = err instanceof Error ? err.message : String(err);
			output.appendLine(`Download failed: ${message}`);
			output.show(true);
			vscode.window.showErrorMessage(`OpenFPGA Deck: toolchain download failed. ${message}`);
		}
	} finally {
		inProgress = false;
	}
}

interface InstallArgs {
	which: string;
	platform: PlatformId;
	installDir: string;
	progress: vscode.Progress<{ message?: string; increment?: number }>;
	signal: AbortSignal;
}

async function runInstall(
	context: vscode.ExtensionContext,
	output: vscode.OutputChannel,
	args: InstallArgs,
): Promise<void> {
	const { which, platform, installDir, progress, signal } = args;

	output.clear();
	output.show(true);
	progress.report({ message: 'Querying GitHub for the release…' });
	const info = await fetchReleaseInfo(which, signal);

	const name = assetName(info.tag, platform);
	const asset = findAsset(info, name);
	if (!asset) {
		throw new Error(`Release ${info.tag} has no ${platform} build (${name}).`);
	}
	const url = downloadUrl(info.tag, platform);
	const versionDir = path.join(installDir, `oss-cad-suite-${info.tag}`);
	const downloadsDir = path.join(installDir, 'downloads');
	const tgzPath = path.join(downloadsDir, name);

	output.appendLine(`Release:   ${info.tag}`);
	output.appendLine(`Asset:     ${name}`);
	output.appendLine(`URL:       ${url}`);
	output.appendLine(`Digest:    ${asset.sha256 ? `sha256:${asset.sha256} (from GitHub)` : 'not provided by GitHub'}`);
	output.appendLine(`Install:   ${versionDir}`);
	output.appendLine('');

	await fs.mkdir(downloadsDir, { recursive: true });

	// Reuse an archive already on disk when its hash checks out.
	let sha256: string;
	const recorded = context.globalState.get<string>(storageKey(platform, info.tag));
	if (await pathExists(tgzPath)) {
		progress.report({ message: 'Checking the existing download…' });
		sha256 = await sha256File(tgzPath);
		const acceptable = asset.sha256 ?? recorded;
		if (acceptable && sha256 === acceptable) {
			output.appendLine('Reusing the archive already in downloads/ (hash matches).');
		} else if (acceptable) {
			const choice = await vscode.window.showWarningMessage(
				`The archive already in downloads/ for ${info.tag} does not match the expected hash.`,
				{ modal: true, detail: `on disk: ${sha256}\nexpected: ${acceptable}` },
				'Re-download',
			);
			if (choice !== 'Re-download') {
				throw new AbortError();
			}
			sha256 = await downloadFile(url, tgzPath, reporter(progress), signal);
		} else {
			// No reference hash at all — fall through to the trust-on-first-use
			// prompt in verifyIntegrity using whatever is on disk.
			output.appendLine('Found an archive in downloads/ with no reference hash to check it against.');
		}
	} else {
		sha256 = await downloadFile(url, tgzPath, reporter(progress), signal);
	}

	await verifyIntegrity(context, output, {
		platform,
		tag: info.tag,
		sha256,
		expected: asset.sha256,
		recorded,
	});

	// Install directory handling — never silently replace.
	let doExtract = true;
	if (await pathExists(versionDir)) {
		const existing = validateToolchainAt(versionDir, nodeToolchainHost);
		const choice = await vscode.window.showWarningMessage(
			`OSS CAD Suite ${info.tag} is already installed.`,
			{
				modal: true,
				detail: existing.ok
					? `${versionDir}\n\nKeep it as-is, or replace it with a fresh extraction?`
					: `${versionDir}\n\nThe existing folder looks incomplete (${existing.reason}).`,
			},
			'Keep existing',
			'Re-extract',
		);
		if (choice === 'Re-extract') {
			await fs.rm(versionDir, { recursive: true, force: true });
		} else if (choice === 'Keep existing') {
			doExtract = false;
		} else {
			throw new AbortError();
		}
	}

	if (doExtract) {
		progress.report({ message: 'Extracting…' });
		await extractArchive(tgzPath, versionDir);
	}

	const validated = validateToolchainAt(versionDir, nodeToolchainHost);
	if (!validated.ok) {
		throw new Error(`The install looks incomplete: ${validated.reason}`);
	}

	if (!keepDownloads()) {
		await fs.rm(tgzPath, { force: true }).catch(() => undefined);
		output.appendLine('Deleted the archive (keepDownloads is off).');
	} else {
		output.appendLine(`Archive kept at ${tgzPath}`);
	}

	output.appendLine(`Installed OSS CAD Suite ${info.tag} at ${versionDir}`);

	await maybeMakeActive(output, versionDir, info.tag);
}

async function maybeMakeActive(
	output: vscode.OutputChannel,
	versionDir: string,
	tag: string,
): Promise<void> {
	const config = vscode.workspace.getConfiguration();
	const current = (config.get<string>(SETTING_PATH) ?? '').trim();
	if (current === versionDir) {
		vscode.window.showInformationMessage(`OpenFPGA Deck: OSS CAD Suite ${tag} installed (already active).`);
		return;
	}

	const choice = await vscode.window.showInformationMessage(
		`OSS CAD Suite ${tag} installed. Make it the active toolchain?`,
		'Make Active',
		'Keep Current',
	);
	if (choice === 'Make Active') {
		await config.update(SETTING_PATH, versionDir, vscode.ConfigurationTarget.Global);
		output.appendLine(`Active toolchain set to ${versionDir}`);
	}
}

async function verifyIntegrity(
	context: vscode.ExtensionContext,
	output: vscode.OutputChannel,
	opts: { platform: string; tag: string; sha256: string; expected?: string; recorded?: string },
): Promise<void> {
	const key = storageKey(opts.platform, opts.tag);

	if (opts.expected) {
		if (opts.sha256 !== opts.expected) {
			throw new Error(
				`Integrity check FAILED against GitHub's digest.\n  expected sha256:${opts.expected}\n  got      sha256:${opts.sha256}`,
			);
		}
		output.appendLine('Integrity: verified against the digest GitHub published for this asset.');
		await context.globalState.update(key, opts.sha256);
		return;
	}

	if (opts.recorded) {
		if (opts.sha256 !== opts.recorded) {
			throw new Error(
				`Integrity check FAILED.\nThis file does not match the copy previously recorded for ${opts.tag}.\n  recorded sha256:${opts.recorded}\n  now      sha256:${opts.sha256}`,
			);
		}
		output.appendLine('Integrity: matches the SHA-256 recorded from an earlier download.');
		return;
	}

	const proceed = await vscode.window.showWarningMessage(
		`Install OSS CAD Suite ${opts.tag}?`,
		{
			modal: true,
			detail:
				`OSS CAD Suite publishes no checksum, and GitHub returned no digest for this asset. ` +
				`It came over HTTPS directly from github.com/YosysHQ.\n\n` +
				`SHA-256: ${opts.sha256}\n\n` +
				`This hash will be saved and re-checked on every future download.`,
		},
		'Install',
	);
	if (proceed !== 'Install') {
		throw new AbortError();
	}
	output.appendLine(`Integrity: recorded SHA-256 ${opts.sha256} (trust-on-first-use).`);
	await context.globalState.update(key, opts.sha256);
}

async function resolveInstallDir(): Promise<string | undefined> {
	const config = vscode.workspace.getConfiguration();
	const setting = (config.get<string>(SETTING_INSTALL_DIR) ?? '').trim();
	if (setting) {
		return expandHome(setting, os.homedir());
	}

	const preset = path.join(os.homedir(), 'fpga-toolchain');
	const pick = await vscode.window.showQuickPick(
		[
			{ label: `$(check) Use ${preset}`, value: 'preset' },
			{ label: '$(folder-opened) Choose another folder…', value: 'browse' },
		],
		{ title: 'Where should OSS CAD Suite installs be kept?', placeHolder: 'This is remembered as a setting.' },
	);
	if (!pick) {
		return undefined;
	}

	let chosen = preset;
	if (pick.value === 'browse') {
		const picked = await vscode.window.showOpenDialog({
			canSelectFiles: false,
			canSelectFolders: true,
			canSelectMany: false,
			openLabel: 'Keep installs here',
		});
		if (!picked || picked.length === 0) {
			return undefined;
		}
		chosen = picked[0].fsPath;
	}

	await config.update(SETTING_INSTALL_DIR, chosen, vscode.ConfigurationTarget.Global);
	return chosen;
}

async function pickRelease(): Promise<string | undefined> {
	const choice = await vscode.window.showQuickPick(
		[
			{ label: '$(cloud-download) Latest release', value: 'latest' },
			{ label: '$(tag) Specific release tag…', value: 'tag' },
		],
		{ title: 'Download OSS CAD Suite', placeHolder: 'Which release?' },
	);
	if (!choice) {
		return undefined;
	}
	if (choice.value === 'latest') {
		return 'latest';
	}
	const entered = await vscode.window.showInputBox({
		title: 'OSS CAD Suite release tag',
		prompt: 'e.g. 2026-06-29 — see github.com/YosysHQ/oss-cad-suite-build/releases',
		validateInput: (v) => (tagLooksValid(v) ? undefined : 'Expected a date tag like 2026-06-29.'),
	});
	return entered?.trim() || undefined;
}

function reporter(
	progress: vscode.Progress<{ message?: string; increment?: number }>,
): (p: { received: number; total: number }) => void {
	let lastPercent = 0;
	return ({ received, total }) => {
		const percent = total > 0 ? (received / total) * 100 : 0;
		progress.report({
			increment: percent - lastPercent,
			message: `Downloading ${mib(received)} / ${total > 0 ? mib(total) : '?'} MiB`,
		});
		lastPercent = percent;
	};
}

function keepDownloads(): boolean {
	return vscode.workspace.getConfiguration().get<boolean>(SETTING_KEEP_DOWNLOADS) ?? true;
}

async function pathExists(p: string): Promise<boolean> {
	try {
		await fs.access(p);
		return true;
	} catch {
		return false;
	}
}

function storageKey(platform: string, tag: string): string {
	return `toolchainSha256:${platform}:${tag}`;
}

function mib(bytes: number): string {
	return (bytes / 1024 / 1024).toFixed(1);
}

class AbortError extends Error {
	constructor() {
		super('Aborted');
		this.name = 'AbortError';
	}
}

function isAbort(err: unknown): boolean {
	return (
		typeof err === 'object' &&
		err !== null &&
		'name' in err &&
		(err.name === 'AbortError' || err.name === 'TimeoutError')
	);
}
