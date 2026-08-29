/**
 * Discover and validate OSS CAD Suite installations.
 *
 * OSS CAD Suite is not "installed" in any system sense — it is a
 * self-contained directory holding `bin/`, `lib/`, and an `environment`
 * script. This module locates such directories, confirms they hold the
 * executables our pipeline needs, and reads their versions. Downloading is a
 * separate concern (install.ts / installCommand.ts).
 *
 * The extension can manage several releases side by side under a parent
 * "toolchains directory" (default `~/fpga-toolchain/`), each in its own
 * tag-named folder (`oss-cad-suite-2026-08-28/`). Discovery scans that parent
 * so every downloaded release shows up automatically.
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

/** Folder-name prefix the extension uses (and scans for) for managed installs. */
export const MANAGED_DIR_PREFIX = 'oss-cad-suite';

export interface ToolInfo {
	readonly id: ToolId;
	/** Absolute path to the executable. */
	readonly path: string;
	/** Version parsed from the tool's own output, when we can read one. */
	readonly version?: string;
}

export interface Toolchain {
	/** The toolchain root (the directory that contains `bin/`). */
	readonly root: string;
	/** `<root>/bin`. */
	readonly binDir: string;
	/** Release tag, when the folder name carries one (`oss-cad-suite-2026-08-28`). */
	readonly tag?: string;
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
	/** Immediate subdirectory names of `dir`, or `[]` if it is not a directory. */
	listDir(dir: string): string[];
	probeVersion(exePath: string, args: readonly string[]): ProbeResult;
}

const EXE_SUFFIX = process.platform === 'win32' ? '.exe' : '';

function exeName(id: ToolId): string {
	return id + EXE_SUFFIX;
}

/** Expand a leading `~` to the user's home directory. */
export function expandHome(p: string, home: string): string {
	if (p === '~') {
		return home;
	}
	if (p.startsWith('~/') || p.startsWith('~\\')) {
		return path.join(home, p.slice(2));
	}
	return p;
}

const TAG_RE = /^\d{4}-\d{2}-\d{2}$/;

function tagFromRoot(root: string): string | undefined {
	const base = path.basename(root);
	const suffix = base.startsWith(`${MANAGED_DIR_PREFIX}-`)
		? base.slice(MANAGED_DIR_PREFIX.length + 1)
		: undefined;
	return suffix && TAG_RE.test(suffix) ? suffix : undefined;
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
 * Given a path the user (or a search) points at, work out the real toolchain
 * root. Accepts the root itself, its parent (a directory that *contains*
 * `oss-cad-suite/`), or a `bin/` directory.
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

	return {
		ok: true,
		toolchain: { root, binDir, tag: tagFromRoot(root), tools: tools as Record<ToolId, ToolInfo> },
	};
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

export type ToolchainSource = 'setting' | 'path' | 'managed' | 'conventional';

export interface DiscoverOptions {
	/** The `openfpga.toolchain.path` setting, if any. */
	readonly configuredPath?: string;
	/** The `openfpga.toolchain.installDir` setting — parent of managed installs. */
	readonly installDir?: string;
	/** The value of `process.env.PATH`. */
	readonly pathEnv?: string;
	/** The user's home directory. */
	readonly homeDir?: string;
	/** Overrides the built-in single-directory conventional locations (tests). */
	readonly conventionalRoots?: readonly string[];
}

export type DiscoverResult =
	| { readonly ok: true; readonly toolchain: Toolchain; readonly source: ToolchainSource }
	| { readonly ok: false; readonly reason: string; readonly searched: readonly string[] };

export function discover(opts: DiscoverOptions, host: ToolchainHost): DiscoverResult {
	// An explicit setting is authoritative. If it is wrong we say so rather
	// than silently falling back to something else on the machine.
	const configured = opts.configuredPath?.trim();
	if (configured) {
		const result = validateToolchainAt(configured, host);
		return result.ok
			? { ok: true, toolchain: result.toolchain, source: 'setting' }
			: {
					ok: false,
					reason: `Configured toolchain path is invalid. ${result.reason}`,
					searched: [configured],
				};
	}

	const searched: string[] = [];
	for (const { root, source } of autoCandidates(opts, host)) {
		searched.push(root);
		const result = validateToolchainAt(root, host);
		if (result.ok) {
			return { ok: true, toolchain: result.toolchain, source };
		}
	}
	return { ok: false, reason: 'No OSS CAD Suite installation found.', searched };
}

/**
 * Every valid toolchain we can find, newest managed release first, for
 * presenting a choice in the UI. Deduplicated by resolved root.
 */
export function findAllToolchains(opts: DiscoverOptions, host: ToolchainHost): Toolchain[] {
	const roots: string[] = [];
	const configured = opts.configuredPath?.trim();
	if (configured) {
		roots.push(configured);
	}
	for (const c of autoCandidates(opts, host)) {
		roots.push(c.root);
	}

	const found: Toolchain[] = [];
	const seen = new Set<string>();
	for (const candidate of roots) {
		const result = validateToolchainAt(candidate, host);
		if (result.ok && !seen.has(result.toolchain.root)) {
			seen.add(result.toolchain.root);
			found.push(result.toolchain);
		}
	}
	return found;
}

/** Candidate roots in search order, excluding the explicit `configuredPath`. */
function autoCandidates(
	opts: DiscoverOptions,
	host: ToolchainHost,
): Array<{ root: string; source: ToolchainSource }> {
	const out: Array<{ root: string; source: ToolchainSource }> = [];
	for (const root of pathEnvRoots(opts.pathEnv, host)) {
		out.push({ root, source: 'path' });
	}
	for (const parent of managedParents(opts)) {
		for (const root of managedRoots(parent, host)) {
			out.push({ root, source: 'managed' });
		}
	}
	for (const root of conventionalRoots(opts)) {
		out.push({ root, source: 'conventional' });
	}
	return out;
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

/** Parent directories that may hold tag-named managed installs. */
function managedParents(opts: DiscoverOptions): string[] {
	const home = opts.homeDir?.trim();
	const parents = new Set<string>();
	const installDir = opts.installDir?.trim();
	if (installDir && home) {
		parents.add(expandHome(installDir, home));
	} else if (installDir) {
		parents.add(installDir);
	}
	if (home) {
		parents.add(path.join(home, 'fpga-toolchain'));
	}
	return [...parents];
}

/** `oss-cad-suite*` subdirectories of `parent`, newest tag first. */
function managedRoots(parent: string, host: ToolchainHost): string[] {
	return host
		.listDir(parent)
		.filter((name) => name === MANAGED_DIR_PREFIX || name.startsWith(`${MANAGED_DIR_PREFIX}-`))
		.sort((a, b) => b.localeCompare(a))
		.map((name) => path.join(parent, name));
}

function conventionalRoots(opts: DiscoverOptions): string[] {
	if (opts.conventionalRoots) {
		return [...opts.conventionalRoots];
	}
	const roots = ['/opt/oss-cad-suite', '/usr/local/oss-cad-suite'];
	const home = opts.homeDir?.trim();
	if (home) {
		roots.unshift(path.join(home, 'oss-cad-suite'));
	}
	return roots;
}
