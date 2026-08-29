/**
 * The IO side of installing OSS CAD Suite: talk to the GitHub API, stream the
 * download while hashing it, and extract it safely.
 *
 * Security posture:
 *  - downloads only from the URL {@link isAllowedDownloadUrl} accepts;
 *  - the SHA-256 is computed as bytes arrive, so the caller can compare it to
 *    GitHub's published asset digest (or record it for trust-on-first-use);
 *  - extraction shells out to the system `tar` with an argument array (never a
 *    shell string) and only after every archive entry has been checked by
 *    {@link isSafeArchiveEntry}.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
	isAllowedDownloadUrl,
	isSafeArchiveEntry,
	parseReleaseInfo,
	RELEASES_API_LATEST,
	releasesApiByTag,
	type ReleaseInfo,
} from './releases';

const USER_AGENT = 'openfpga-deck-vscode-extension';

export interface DownloadProgress {
	readonly received: number;
	readonly total: number;
}

export async function fetchReleaseInfo(
	which: string,
	signal?: AbortSignal,
): Promise<ReleaseInfo> {
	const url = which === 'latest' ? RELEASES_API_LATEST : releasesApiByTag(which);
	const res = await fetch(url, {
		signal,
		headers: { accept: 'application/vnd.github+json', 'user-agent': USER_AGENT },
	});
	if (res.status === 404) {
		throw new Error(`No OSS CAD Suite release found for "${which}".`);
	}
	if (!res.ok) {
		throw new Error(`GitHub API returned HTTP ${res.status} for ${url}.`);
	}
	const info = parseReleaseInfo(await res.json());
	if (!info) {
		throw new Error('Could not understand the GitHub release response.');
	}
	return info;
}

/**
 * Stream `url` into `destFile`, reporting progress. Returns the lower-case hex
 * SHA-256 of everything written.
 */
export async function downloadFile(
	url: string,
	destFile: string,
	onProgress: (progress: DownloadProgress) => void,
	signal?: AbortSignal,
): Promise<string> {
	if (!isAllowedDownloadUrl(url)) {
		throw new Error(`Refusing to download from a URL outside github.com/YosysHQ: ${url}`);
	}
	const res = await fetch(url, { signal, headers: { 'user-agent': USER_AGENT } });
	if (!res.ok || !res.body) {
		throw new Error(`Download failed: HTTP ${res.status}.`);
	}

	const total = Number(res.headers.get('content-length')) || 0;
	const hash = createHash('sha256');
	let received = 0;
	const meter = new Transform({
		transform(chunk, _encoding, callback) {
			hash.update(chunk);
			received += chunk.length;
			onProgress({ received, total });
			callback(null, chunk);
		},
	});

	await pipeline(
		Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
		meter,
		createWriteStream(destFile),
		{ signal },
	);
	return hash.digest('hex');
}

/** Lower-case hex SHA-256 of a file already on disk. */
export function sha256File(file: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const hash = createHash('sha256');
		const stream = createReadStream(file);
		stream.on('error', reject);
		stream.on('data', (chunk) => hash.update(chunk));
		stream.on('end', () => resolve(hash.digest('hex')));
	});
}

/**
 * Extract `tgz` into `destDir`, stripping the single top-level folder the
 * OSS CAD Suite tarball wraps everything in (so `destDir` ends up containing
 * `bin/`, `lib/`, `environment` directly). Throws if any archive entry has an
 * unsafe path, if the archive is not wrapped in exactly one top folder, or if
 * the system `tar` is missing.
 */
export async function extractArchive(tgz: string, destDir: string): Promise<void> {
	const entries = (await runTar(['-tf', tgz]))
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.length > 0);

	const unsafe = entries.filter((entry) => !isSafeArchiveEntry(entry));
	if (unsafe.length > 0) {
		throw new Error(
			`Archive contains unsafe path(s); refusing to extract: ${unsafe.slice(0, 3).join(', ')}`,
		);
	}

	const topLevel = new Set(entries.map((entry) => entry.split(/[/\\]/)[0]));
	if (topLevel.size !== 1) {
		throw new Error(
			`Expected the archive to contain a single top-level folder; found: ${[...topLevel].join(', ')}`,
		);
	}

	await fs.mkdir(destDir, { recursive: true });
	await runTar(['-xf', tgz, '--strip-components=1', '-C', destDir]);
}

function runTar(args: readonly string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn('tar', [...args], { shell: false, windowsHide: true });
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
		child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
		child.on('error', (err: NodeJS.ErrnoException) => {
			reject(
				err.code === 'ENOENT'
					? new Error(
							"System 'tar' was not found. Install it (or extract OSS CAD Suite manually and use \"Select Toolchain\").",
						)
					: err,
			);
		});
		child.on('close', (code) => {
			if (code === 0) {
				resolve(stdout);
			} else {
				reject(new Error(`tar exited with code ${code}: ${stderr.trim()}`));
			}
		});
	});
}
