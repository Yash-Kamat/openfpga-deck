/**
 * The real {@link ToolchainHost}: filesystem checks via `node:fs` and version
 * probes via `child_process.spawnSync`.
 *
 * Subprocess policy (binding across the whole project): always spawn an
 * executable with an argument array, never a shell string, never `shell: true`.
 * Version probes are read-only, short, and time-boxed.
 */

import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import type { ProbeResult, ToolchainHost } from './discovery';

const PROBE_TIMEOUT_MS = 5000;

export const nodeToolchainHost: ToolchainHost = {
	fileExists(absolutePath: string): boolean {
		try {
			return fs.statSync(absolutePath).isFile();
		} catch {
			return false;
		}
	},

	listDir(dir: string): string[] {
		try {
			return fs
				.readdirSync(dir, { withFileTypes: true })
				.filter((entry) => entry.isDirectory())
				.map((entry) => entry.name);
		} catch {
			return [];
		}
	},

	probeVersion(exePath: string, args: readonly string[]): ProbeResult {
		const result = spawnSync(exePath, [...args], {
			timeout: PROBE_TIMEOUT_MS,
			encoding: 'utf8',
			shell: false,
			windowsHide: true,
		});
		if (result.error) {
			return { stdout: '', stderr: '', error: result.error.message };
		}
		return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
	},
};
