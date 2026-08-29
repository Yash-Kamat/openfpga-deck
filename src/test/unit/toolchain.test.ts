import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import {
	discover,
	expandHome,
	findAllToolchains,
	validateToolchainAt,
	type ProbeResult,
	type ToolchainHost,
} from '../../toolchain/discovery';

function toolchainFiles(root: string): string[] {
	const bin = path.join(root, 'bin');
	return [
		path.join(bin, 'yosys'),
		path.join(bin, 'nextpnr-himbaechel'),
		path.join(bin, 'gowin_pack'),
		path.join(bin, 'openFPGALoader'),
	];
}

function makeHost(
	files: string[],
	probes: Record<string, ProbeResult> = {},
	dirs: Record<string, string[]> = {},
): ToolchainHost {
	const set = new Set(files);
	return {
		fileExists: (p) => set.has(p),
		listDir: (d) => dirs[d] ?? [],
		probeVersion: (exe) => probes[exe] ?? { stdout: '', stderr: '' },
	};
}

// Version output shapes taken verbatim from a real OSS CAD Suite build.
function realisticProbes(root: string): Record<string, ProbeResult> {
	const bin = path.join(root, 'bin');
	return {
		[path.join(bin, 'yosys')]: {
			stdout: 'Yosys 0.68+136 (git sha1 c30457480-dirty, Release, Clang 21.1.8)\n',
			stderr: '',
		},
		[path.join(bin, 'nextpnr-himbaechel')]: {
			stdout: '',
			stderr:
				'"nextpnr-himbaechel" -- Next Generation Place and Route (Version nextpnr-0.11.1-18-gdec04b3b)\n',
		},
		[path.join(bin, 'openFPGALoader')]: { stdout: 'openFPGALoader v1.1.1\n', stderr: '' },
	};
}

describe('validateToolchainAt', () => {
	const root = '/opt/oss-cad-suite';

	it('accepts a complete installation and extracts versions', () => {
		const result = validateToolchainAt(root, makeHost(toolchainFiles(root), realisticProbes(root)));
		assert.equal(result.ok, true);
		if (result.ok) {
			assert.equal(result.toolchain.root, root);
			assert.equal(result.toolchain.binDir, path.join(root, 'bin'));
			assert.equal(result.toolchain.tools.yosys.version, '0.68+136');
			assert.equal(
				result.toolchain.tools['nextpnr-himbaechel'].version,
				'nextpnr-0.11.1-18-gdec04b3b',
			);
			assert.equal(result.toolchain.tools.openFPGALoader.version, 'v1.1.1');
			assert.equal(result.toolchain.tools.gowin_pack.version, undefined);
			assert.equal(result.toolchain.tools.gowin_pack.path, path.join(root, 'bin', 'gowin_pack'));
		}
	});

	it('resolves when pointed at the parent directory', () => {
		const real = '/home/u/fpga-toolchain/oss-cad-suite';
		const result = validateToolchainAt(
			'/home/u/fpga-toolchain',
			makeHost(toolchainFiles(real)),
		);
		assert.equal(result.ok, true);
		if (result.ok) {
			assert.equal(result.toolchain.root, real);
		}
	});

	it('resolves when pointed at the bin directory', () => {
		const result = validateToolchainAt(
			path.join(root, 'bin'),
			makeHost(toolchainFiles(root)),
		);
		assert.equal(result.ok, true);
	});

	it('rejects an installation missing a required tool', () => {
		const files = toolchainFiles(root).filter((f) => !f.endsWith('openFPGALoader'));
		const result = validateToolchainAt(root, makeHost(files));
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.match(result.reason, /openFPGALoader/);
		}
	});

	it('rejects a path with nothing there', () => {
		const result = validateToolchainAt('/nowhere', makeHost([]));
		assert.equal(result.ok, false);
	});
});

describe('discover', () => {
	const root = '/opt/oss-cad-suite';

	it('uses the configured path and reports source "setting"', () => {
		const result = discover(
			{ configuredPath: root },
			makeHost(toolchainFiles(root), realisticProbes(root)),
		);
		assert.equal(result.ok, true);
		if (result.ok) {
			assert.equal(result.source, 'setting');
		}
	});

	it('fails loudly when the configured path is wrong (no fallback)', () => {
		const result = discover(
			{ configuredPath: '/bad', conventionalRoots: [root] },
			makeHost(toolchainFiles(root)),
		);
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.match(result.reason, /Configured toolchain path is invalid/);
		}
	});

	it('finds yosys on PATH and reports source "path"', () => {
		const result = discover(
			{ pathEnv: `/usr/bin${path.delimiter}${path.join(root, 'bin')}` },
			makeHost(toolchainFiles(root)),
		);
		assert.equal(result.ok, true);
		if (result.ok) {
			assert.equal(result.source, 'path');
			assert.equal(result.toolchain.root, root);
		}
	});

	it('falls back to a conventional location', () => {
		const result = discover(
			{ conventionalRoots: ['/opt/missing', root] },
			makeHost(toolchainFiles(root)),
		);
		assert.equal(result.ok, true);
		if (result.ok) {
			assert.equal(result.source, 'conventional');
		}
	});

	it('reports every location it searched on failure', () => {
		const result = discover({ conventionalRoots: ['/a', '/b'] }, makeHost([]));
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.deepEqual(result.searched, ['/a', '/b']);
		}
	});
});

describe('findAllToolchains', () => {
	it('deduplicates a toolchain reachable via several routes', () => {
		const root = '/opt/oss-cad-suite';
		const host = makeHost(toolchainFiles(root));
		const found = findAllToolchains(
			{
				configuredPath: root,
				pathEnv: path.join(root, 'bin'),
				conventionalRoots: [root],
			},
			host,
		);
		assert.equal(found.length, 1);
		assert.equal(found[0].root, root);
	});

	it('lists tag-named managed installs, newest first', () => {
		const parent = '/home/u/fpga-toolchain';
		const older = path.join(parent, 'oss-cad-suite-2026-06-29');
		const newer = path.join(parent, 'oss-cad-suite-2026-08-28');
		const host = makeHost([...toolchainFiles(older), ...toolchainFiles(newer)], {}, {
			[parent]: ['oss-cad-suite-2026-06-29', 'oss-cad-suite-2026-08-28', 'downloads'],
		});

		const found = findAllToolchains({ installDir: parent, homeDir: '/home/u' }, host);
		assert.deepEqual(
			found.map((tc) => tc.tag),
			['2026-08-28', '2026-06-29'],
		);
		assert.equal(found[0].root, newer);
	});
});

describe('release-tag folder names', () => {
	it('are exposed as toolchain.tag', () => {
		const root = '/x/oss-cad-suite-2026-08-28';
		const result = validateToolchainAt(root, makeHost(toolchainFiles(root)));
		assert.equal(result.ok && result.toolchain.tag, '2026-08-28');
	});

	it('leave tag undefined for an un-suffixed folder', () => {
		const root = '/x/oss-cad-suite';
		const result = validateToolchainAt(root, makeHost(toolchainFiles(root)));
		assert.equal(result.ok && result.toolchain.tag, undefined);
	});
});

describe('expandHome', () => {
	it('expands a leading ~ and leaves other paths alone', () => {
		assert.equal(expandHome('~/fpga-toolchain', '/home/u'), path.join('/home/u', 'fpga-toolchain'));
		assert.equal(expandHome('~', '/home/u'), '/home/u');
		assert.equal(expandHome('/opt/x', '/home/u'), '/opt/x');
		assert.equal(expandHome('relative/path', '/home/u'), 'relative/path');
	});
});
