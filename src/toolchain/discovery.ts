/**
 * Discover and validate an existing OSS CAD Suite installation.
 *
 * OSS CAD Suite is not "installed" in any system sense — it is a
 * self-contained directory (`oss-cad-suite/`) holding `bin/`, `lib/`, and an
 * `environment` script. This module's job is purely to *locate* such a
 * directory, confirm it has the executables our pipeline needs, and read
 * their versions. Downloading one is a separate concern (Phase 3b).
 *
 * All filesystem and subprocess access goes through an injected
 * {@link ToolchainHost} so the logic is unit-testable without touching disk
 * or spawning anything.
 */

import * as path from 'node:path';

export type ToolId = 'yosys' | 'nextpnr-himbaechel' | 'gowin_pack' | 'openFPGALoader';

/** Executables that must be present for a toolchain to be considered usable. */
export const REQUIRED_TOOLS: readonly ToolId[] = [
	'yosys',
	'nextpnr-himbaechel',
	'gowin_pack',
	'openFPGALoader',
];

export interface ToolInfo {
	readonly id: ToolId;
	/** Absolute path to the executable. */
	readonly path: string;
	/** Version parsed from the tool's own output, when we can read one. */
	readonly version?: string;
}

export interface Toolchain {
	/** The `oss-cad-suite` directory. */
	readonly root: string;
	/** `<root>/bin`. */
	readonly binDir: string;
	readonly tools: Readonly<Record<ToolId, ToolInfo>>;
}

export interface ProbeResult {
	readonly stdout: string;
	readonly stderr: string;
	/** Set when the process could not be spawned at all (e.g. ENOENT). */
	readonly error?: string;
}

/** The slice of the outside world discovery needs. */
export interface ToolchainHost {
	fileExists(absolutePath: string): boolean;
	probeVersion(exePath: string, args: readonly string[]): ProbeResult;
}

const EXE_SUFFIX = process.platform === 'win32' ? '.exe' : '';

function exeName(id: ToolId): string {
	return id + EXE_SUFFIX;
}

/**
 * How to ask each tool for its version. Commands and output shapes were
 * confirmed against a real OSS CAD Suite build:
 *   yosys --version              -> "Yosys 0.68+136 (git sha1 ...)"
 *   nextpnr-himbaechel --version -> "... (Version nextpnr-0.11.1-18-gdec04b3b)"  [stderr]
 *   openFPGALoader --Version     -> "openFPGALoader v1.1.1"   [capital V]
 * gowin_pack has no version flag, so it is omitted here (presence-checked only).
 */
const VERSION_PROBES: Partial<Record<ToolId, { args: readonly string[]; extract: RegExp }>> = {
	yosys: { args: ['--version'], extract: /Yosys\s+(\S+)/ },
	'nextpnr-himbaechel': { args: ['--version'], extract: /Version\s+(nextpnr-[^\s)]+)/ },
	openFPGALoader: { args: ['--Version'], extract: /openFPGALoader\s+(\S+)/ },
};

export type ValidateResult =
	| { readonly ok: true; readonly toolchain: Toolchain }
	| { readonly ok: false; readonly reason: string };

/**
 * Given a path the user (or a search) points at, work out the real
 * `oss-cad-suite` root. Accepts the root itself, its parent (a directory that
 * *contains* `oss-cad-suite/`), or a `bin/` directory.
 */
function resolveToolchainRoot(candidate: string, host: ToolchainHost): string | undefined {
	const tries = [candidate, path.join(candidate, 'oss-cad-suite')];
	if (path.basename(candidate) === 'bin') {
		tries.push(path.dirname(candidate));
	}
	for (const root of tries) {
		if (host.fileExists(path.join(root, 'bin', exeName('yosys')))) {
			return root;
		}
	}
	return undefined;
}

export function validateToolchainAt(candidate: string, host: ToolchainHost): ValidateResult {
	const root = resolveToolchainRoot(candidate, host);
	if (root === undefined) {
		return {
			ok: false,
			reason: `No OSS CAD Suite found at "${candidate}" — expected a "bin" directory containing ${exeName('yosys')}.`,
		};
	}

	const binDir = path.join(root, 'bin');
	const missing: ToolId[] = [];
	const tools: Partial<Record<ToolId, ToolInfo>> = {};

	for (const id of REQUIRED_TOOLS) {
		const exe = path.join(binDir, exeName(id));
		if (!host.fileExists(exe)) {
			missing.push(id);
			continue;
		}
		tools[id] = { id, path: exe, version: probeVersion(id, exe, host) };
	}

	if (missing.length > 0) {
		return {
			ok: false,
			reason: `OSS CAD Suite at "${root}" is missing required tool(s): ${missing.join(', ')}.`,
		};
	}

	return { ok: true, toolchain: { root, binDir, tools: tools as Record<ToolId, ToolInfo> } };
}

function probeVersion(id: ToolId, exe: string, host: ToolchainHost): string | undefined {
	const spec = VERSION_PROBES[id];
	if (!spec) {
		return undefined;
	}
	const result = host.probeVersion(exe, spec.args);
	if (result.error !== undefined) {
		return undefined;
	}
	return spec.extract.exec(`${result.stdout}\n${result.stderr}`)?.[1];
}

export type ToolchainSource = 'setting' | 'path' | 'conventional';

export interface DiscoverOptions {
	/** The `openfpga.toolchain.path` setting, if any. */
	readonly configuredPath?: string;
	/** The value of `process.env.PATH`. */
	readonly pathEnv?: string;
	/** The user's home directory, for building conventional candidate paths. */
	readonly homeDir?: string;
	/** Overrides the built-in conventional locations (used by tests). */
	readonly conventionalRoots?: readonly string[];
}

export type DiscoverResult =
	| { readonly ok: true; readonly toolchain: Toolchain; readonly source: ToolchainSource }
	| { readonly ok: false; readonly reason: string; readonly searched: readonly string[] };

export function discover(opts: DiscoverOptions, host: ToolchainHost): DiscoverResult {
	const searched: string[] = [];

	// An explicit setting is authoritative. If it is wrong we say so rather
	// than silently falling back to something else on the machine.
	const configured = opts.configuredPath?.trim();
	if (configured) {
		searched.push(configured);
		const result = validateToolchainAt(configured, host);
		return result.ok
			? { ok: true, toolchain: result.toolchain, source: 'setting' }
			: { ok: false, reason: `Configured toolchain path is invalid. ${result.reason}`, searched };
	}

	for (const root of pathEnvRoots(opts.pathEnv, host)) {
		searched.push(root);
		const result = validateToolchainAt(root, host);
		if (result.ok) {
			return { ok: true, toolchain: result.toolchain, source: 'path' };
		}
	}

	for (const root of conventionalRoots(opts)) {
		searched.push(root);
		const result = validateToolchainAt(root, host);
		if (result.ok) {
			return { ok: true, toolchain: result.toolchain, source: 'conventional' };
		}
	}

	return { ok: false, reason: 'No OSS CAD Suite installation found.', searched };
}

/**
 * Every valid toolchain we can find, for presenting a choice in the UI.
 * Deduplicated by resolved root.
 */
export function findAllToolchains(opts: DiscoverOptions, host: ToolchainHost): Toolchain[] {
	const candidates = [
		...(opts.configuredPath?.trim() ? [opts.configuredPath.trim()] : []),
		...pathEnvRoots(opts.pathEnv, host),
		...conventionalRoots(opts),
	];

	const found: Toolchain[] = [];
	const seen = new Set<string>();
	for (const candidate of candidates) {
		const result = validateToolchainAt(candidate, host);
		if (result.ok && !seen.has(result.toolchain.root)) {
			seen.add(result.toolchain.root);
			found.push(result.toolchain);
		}
	}
	return found;
}

/** Roots derived from a `bin/yosys` sitting on PATH. */
function pathEnvRoots(pathEnv: string | undefined, host: ToolchainHost): string[] {
	const roots: string[] = [];
	for (const dir of (pathEnv ?? '').split(path.delimiter)) {
		const trimmed = dir.trim();
		if (trimmed && host.fileExists(path.join(trimmed, exeName('yosys')))) {
			roots.push(path.dirname(trimmed));
		}
	}
	return roots;
}

function conventionalRoots(opts: DiscoverOptions): string[] {
	if (opts.conventionalRoots) {
		return [...opts.conventionalRoots];
	}
	const roots = ['/opt/oss-cad-suite', '/usr/local/oss-cad-suite'];
	const home = opts.homeDir?.trim();
	if (home) {
		roots.unshift(
			path.join(home, 'fpga-toolchain', 'oss-cad-suite'),
			path.join(home, 'oss-cad-suite'),
		);
	}
	return roots;
}
