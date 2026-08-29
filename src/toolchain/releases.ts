/**
 * Pure logic for locating OSS CAD Suite release artefacts on GitHub.
 *
 * OSS CAD Suite is distributed only as dated GitHub Releases from
 * github.com/YosysHQ/oss-cad-suite-build. There is no separate mirror and no
 * upstream-published checksum file. Everything here is side-effect free so it
 * can be unit-tested; the actual downloading lives in install.ts.
 */

import * as path from 'node:path';

export type PlatformId =
	| 'linux-x64'
	| 'linux-arm64'
	| 'darwin-x64'
	| 'darwin-arm64'
	| 'windows-x64';

/** The one host and path prefix we will ever download a toolchain from. */
export const DOWNLOAD_HOST = 'github.com';
export const DOWNLOAD_PATH_PREFIX = '/YosysHQ/oss-cad-suite-build/releases/download/';

export const RELEASES_API_LATEST =
	'https://api.github.com/repos/YosysHQ/oss-cad-suite-build/releases/latest';

export function releasesApiByTag(tag: string): string {
	return `https://api.github.com/repos/YosysHQ/oss-cad-suite-build/releases/tags/${encodeURIComponent(tag)}`;
}

/** Map the running platform to an OSS CAD Suite artefact id, or undefined if unsupported. */
export function detectPlatform(
	platform: NodeJS.Platform = process.platform,
	arch: string = process.arch,
): PlatformId | undefined {
	switch (`${platform}-${arch}`) {
		case 'linux-x64':
			return 'linux-x64';
		case 'linux-arm64':
			return 'linux-arm64';
		case 'darwin-x64':
			return 'darwin-x64';
		case 'darwin-arm64':
			return 'darwin-arm64';
		case 'win32-x64':
			return 'windows-x64';
		default:
			return undefined;
	}
}

/** Release tags look like `2026-06-29`. */
export function tagLooksValid(tag: string): boolean {
	return /^\d{4}-\d{2}-\d{2}$/.test(tag.trim());
}

/**
 * The asset filename for a tag + platform.
 *
 * Note the deliberate mismatch: the release *tag* is `2026-06-29` but the
 * date embedded in the *filename* has no dashes (`20260629`). This is a known
 * upstream quirk (oss-cad-suite-build issue #15); building the URL naively
 * from the tag alone produces a 404.
 */
export function assetName(tag: string, platform: PlatformId): string {
	const datePart = tag.trim().replace(/-/g, '');
	return `oss-cad-suite-${platform}-${datePart}.tgz`;
}

export function downloadUrl(tag: string, platform: PlatformId): string {
	return `https://${DOWNLOAD_HOST}${DOWNLOAD_PATH_PREFIX}${encodeURIComponent(tag.trim())}/${assetName(tag, platform)}`;
}

/** Guards every toolchain download: HTTPS, the one host, the releases path. */
export function isAllowedDownloadUrl(url: string): boolean {
	try {
		const u = new URL(url);
		return (
			u.protocol === 'https:' &&
			u.host === DOWNLOAD_HOST &&
			u.pathname.startsWith(DOWNLOAD_PATH_PREFIX)
		);
	} catch {
		return false;
	}
}

/**
 * Reject archive members that would write outside the extraction directory:
 * absolute paths, Windows drive paths, or any `..` segment.
 */
export function isSafeArchiveEntry(name: string): boolean {
	const trimmed = name.trim();
	if (trimmed === '' || path.isAbsolute(trimmed)) {
		return false;
	}
	if (/^[a-zA-Z]:[\\/]/.test(trimmed)) {
		return false;
	}
	return !trimmed.split(/[\\/]/).includes('..');
}

export interface ReleaseAsset {
	readonly name: string;
	/** Lower-case hex SHA-256, when GitHub returned an asset `digest`. */
	readonly sha256?: string;
}

export interface ReleaseInfo {
	readonly tag: string;
	readonly assets: readonly ReleaseAsset[];
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

/** Parse the subset we need out of a GitHub release API response. */
export function parseReleaseInfo(json: unknown): ReleaseInfo | undefined {
	if (!isObject(json) || typeof json.tag_name !== 'string') {
		return undefined;
	}
	const rawAssets = Array.isArray(json.assets) ? json.assets : [];
	const assets: ReleaseAsset[] = [];
	for (const asset of rawAssets) {
		if (!isObject(asset) || typeof asset.name !== 'string') {
			continue;
		}
		let sha256: string | undefined;
		if (typeof asset.digest === 'string') {
			const match = /^sha256:([0-9a-f]{64})$/i.exec(asset.digest);
			if (match) {
				sha256 = match[1].toLowerCase();
			}
		}
		assets.push({ name: asset.name, sha256 });
	}
	return { tag: json.tag_name, assets };
}

export function findAsset(info: ReleaseInfo, name: string): ReleaseAsset | undefined {
	return info.assets.find((a) => a.name === name);
}
