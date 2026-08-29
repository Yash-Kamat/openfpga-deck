import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { validateBoard, type Board } from '../../boards/schema';
import type { FpgaProject } from '../../project/schema';
import { buildDirs, buildLayout } from '../../build/layout';
import { planYosys } from '../../build/yosys';
import { planNextpnr } from '../../build/nextpnr';
import { runStep, type ProcessResult, type ProcessSpec } from '../../build/runStep';
import { acquireBuildLock, isBuildRunning, releaseBuildLock } from '../../build/lock';
import { synthesize, type SynthesizeIo } from '../../build/synthesize';
import { placeAndRoute } from '../../build/placeAndRoute';

const ROOT = '/home/dev/blinky';

function board(): Board {
	const result = validateBoard({
		id: 'demo',
		name: 'Demo Board',
		fpga: { part: 'GW2AR-LV18QN88C8/I7', family: 'GW2A-18C' },
		synth: { family: 'gw2a' },
		programmer: { board: 'demo' },
		defaults: { iostd: 'LVCMOS33' },
		clocks: [{ signal: 'clk', mhz: 27 }],
		pins: { clk: { loc: '4' } },
	});
	if (!result.ok) {
		throw new Error(result.errors.map((e) => e.message).join('; '));
	}
	return result.board;
}

function project(sources: string[]): FpgaProject {
	return {
		name: 'blinky',
		board: 'demo',
		top: 'top',
		sources,
		constraints: ['constraints/top.cst'],
	};
}

describe('buildLayout', () => {
	it('places every stage under <root>/build', () => {
		const layout = buildLayout(ROOT);
		assert.equal(layout.dir, path.join(ROOT, 'build'));
		assert.equal(layout.netlistDir, path.join(ROOT, 'build', 'yosys'));
		assert.equal(layout.logDir, path.join(ROOT, 'build', 'logs'));
		assert.ok(buildDirs(layout).every((d) => d.startsWith(layout.dir + path.sep)));
	});
});

describe('planYosys', () => {
	it('emits one read line per source with the right SV flag', () => {
		const result = planYosys(project(['src/top.v', 'src/pll.sv']), board(), ROOT);
		assert.equal(result.ok, true);
		if (!result.ok) {
			return;
		}
		assert.match(result.plan.scriptText, /^read_verilog src\/top\.v$/m);
		assert.match(result.plan.scriptText, /^read_verilog -sv src\/pll\.sv$/m);
		assert.match(result.plan.scriptText, /^synth_gowin -top top -json build\/yosys\/top\.json$/m);
	});

	it('drives yosys with the script path relative to the project root', () => {
		const result = planYosys(project(['src/top.v']), board(), ROOT);
		assert.ok(result.ok);
		if (result.ok) {
			assert.deepEqual(result.plan.args, ['-s', 'build/yosys/synth.ys']);
			assert.equal(result.plan.netlistPath, path.join(ROOT, 'build', 'yosys', 'top.json'));
			assert.equal(result.plan.netlistRelPath, 'build/yosys/top.json');
		}
	});

	it('rejects a VHDL source with a helpful message', () => {
		const result = planYosys(project(['src/top.vhd']), board(), ROOT);
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.match(result.errors[0], /VHDL/);
		}
	});

	it('rejects a project with no synthesizable sources', () => {
		const result = planYosys(project([]), board(), ROOT);
		assert.equal(result.ok, false);
	});
});

describe('planNextpnr', () => {
	it('builds the device / family / cst / json / write argument array', () => {
		const result = planNextpnr(project(['src/top.v']), board(), ROOT);
		assert.equal(result.ok, true);
		if (!result.ok) {
			return;
		}
		assert.deepEqual(result.plan.args, [
			'--device',
			'GW2AR-LV18QN88C8/I7',
			'--vopt',
			'family=GW2A-18C',
			'--vopt',
			'cst=constraints/top.cst',
			'--json',
			'build/yosys/top.json',
			'--write',
			'build/pnr/top.pnr.json',
		]);
		assert.equal(result.plan.pnrJsonPath, path.join(ROOT, 'build', 'pnr', 'top.pnr.json'));
	});

	it('emits one --vopt cst= per .cst and ignores non-.cst constraints', () => {
		const p: FpgaProject = {
			...project(['src/top.v']),
			constraints: ['constraints/a.cst', 'constraints/notes.txt', 'constraints/b.cst'],
		};
		const result = planNextpnr(p, board(), ROOT);
		assert.ok(result.ok);
		if (result.ok) {
			const csts = result.plan.args.filter((a) => a.startsWith('cst='));
			assert.deepEqual(csts, ['cst=constraints/a.cst', 'cst=constraints/b.cst']);
		}
	});

	it('fails when the project has no .cst constraint', () => {
		const p: FpgaProject = { ...project(['src/top.v']), constraints: ['constraints/pins.txt'] };
		const result = planNextpnr(p, board(), ROOT);
		assert.equal(result.ok, false);
	});
});

describe('build lock', () => {
	it('admits one holder at a time', () => {
		assert.equal(acquireBuildLock(), true);
		assert.equal(isBuildRunning(), true);
		assert.equal(acquireBuildLock(), false);
		releaseBuildLock();
		assert.equal(isBuildRunning(), false);
		assert.equal(acquireBuildLock(), true);
		releaseBuildLock();
	});
});

/** A fake ProcessRunner scripted with a fixed result and optional output. */
function fakeRunner(
	result: ProcessResult,
	output = '',
): { run: (s: ProcessSpec) => Promise<ProcessResult>; calls: ProcessSpec[] } {
	const calls: ProcessSpec[] = [];
	return {
		calls,
		run: async (spec) => {
			calls.push(spec);
			if (output) {
				spec.onChunk(output);
			}
			return result;
		},
	};
}

describe('runStep', () => {
	const base = {
		name: 'Synthesis',
		tool: 'yosys',
		exe: '/opt/oss/bin/yosys',
		args: ['-s', 'build/yosys/synth.ys'],
		cwd: ROOT,
		logFile: '/home/dev/blinky/build/logs/synthesis.log',
		logLabel: 'build/logs/synthesis.log',
	};

	it('captures output to the log file and reports success on exit 0', async () => {
		const runner = fakeRunner({ code: 0, signal: null }, 'Yosys 0.68\n... done\n');
		const written: Record<string, string> = {};
		const outcome = await runStep(base, {
			run: runner.run,
			write: () => {},
			writeFile: async (f, t) => {
				written[f] = t;
			},
		});
		assert.equal(outcome.ok, true);
		assert.equal(written[base.logFile], 'Yosys 0.68\n... done\n');
		assert.equal(runner.calls[0].args[1], 'build/yosys/synth.ys');
	});

	it('fails with the exit code and log label on a non-zero exit', async () => {
		const runner = fakeRunner({ code: 2, signal: null });
		const outcome = await runStep(base, {
			run: runner.run,
			write: () => {},
			writeFile: async () => {},
		});
		assert.equal(outcome.ok, false);
		assert.equal(outcome.canceled, false);
		assert.match(outcome.summary, /code 2/);
		assert.match(outcome.summary, /build\/logs\/synthesis\.log/);
	});

	it('reports a spawn failure distinctly', async () => {
		const runner = fakeRunner({ code: null, signal: null, spawnError: 'not found: /opt/oss/bin/yosys' });
		const outcome = await runStep(base, {
			run: runner.run,
			write: () => {},
			writeFile: async () => {},
		});
		assert.equal(outcome.ok, false);
		assert.match(outcome.summary, /could not be started/);
	});

	it('marks a signal-killed process as cancelled', async () => {
		const runner = fakeRunner({ code: null, signal: 'SIGTERM' });
		const outcome = await runStep(base, {
			run: runner.run,
			write: () => {},
			writeFile: async () => {},
		});
		assert.equal(outcome.canceled, true);
		assert.equal(outcome.ok, false);
	});
});

describe('synthesize', () => {
	function io(
		runResult: ProcessResult,
		opts: { netlistExists?: boolean } = {},
	): SynthesizeIo & { dirs: string[]; files: Record<string, string>; calls: ProcessSpec[] } {
		const dirs: string[] = [];
		const files: Record<string, string> = {};
		const calls: ProcessSpec[] = [];
		return {
			dirs,
			files,
			calls,
			run: async (spec) => {
				calls.push(spec);
				return runResult;
			},
			mkdirp: async (d) => {
				dirs.push(d);
			},
			writeFile: async (f, t) => {
				files[f] = t;
			},
			write: () => {},
			exists: async () => opts.netlistExists ?? true,
		};
	}

	it('writes the script, runs yosys and returns the netlist path', async () => {
		const h = io({ code: 0, signal: null });
		const result = await synthesize(
			{ project: project(['src/top.v']), board: board(), projectRoot: ROOT, yosysExe: '/opt/oss/bin/yosys' },
			h,
		);
		assert.equal(result.ok, true);
		assert.equal(result.netlistPath, path.join(ROOT, 'build', 'yosys', 'top.json'));
		assert.ok(h.dirs.includes(path.join(ROOT, 'build', 'yosys')));
		assert.ok(h.dirs.includes(path.join(ROOT, 'build', 'logs')));
		assert.match(h.files[path.join(ROOT, 'build', 'yosys', 'synth.ys')], /synth_gowin -top top/);
		assert.equal(h.calls[0].exe, '/opt/oss/bin/yosys');
		assert.deepEqual(h.calls[0].args, ['-s', 'build/yosys/synth.ys']);
		assert.equal(h.calls[0].cwd, ROOT);
	});

	it('fails when yosys exits non-zero, without checking for a netlist', async () => {
		const h = io({ code: 1, signal: null });
		const result = await synthesize(
			{ project: project(['src/top.v']), board: board(), projectRoot: ROOT, yosysExe: 'yosys' },
			h,
		);
		assert.equal(result.ok, false);
		assert.match(result.summary, /code 1/);
	});

	it('fails when yosys exits cleanly but produces no netlist', async () => {
		const h = io({ code: 0, signal: null }, { netlistExists: false });
		const result = await synthesize(
			{ project: project(['src/top.v']), board: board(), projectRoot: ROOT, yosysExe: 'yosys' },
			h,
		);
		assert.equal(result.ok, false);
		assert.match(result.summary, /no netlist/);
	});

	it('fails the plan for a VHDL source and never spawns yosys', async () => {
		const h = io({ code: 0, signal: null });
		const result = await synthesize(
			{ project: project(['src/top.vhd']), board: board(), projectRoot: ROOT, yosysExe: 'yosys' },
			h,
		);
		assert.equal(result.ok, false);
		assert.equal(h.calls.length, 0);
	});
});

describe('placeAndRoute', () => {
	function io(
		runResult: ProcessResult,
		opts: { netlistIn?: boolean; pnrOut?: boolean } = {},
	): SynthesizeIo & { dirs: string[]; calls: ProcessSpec[] } {
		const dirs: string[] = [];
		const calls: ProcessSpec[] = [];
		const netlistIn = opts.netlistIn ?? true;
		const pnrOut = opts.pnrOut ?? true;
		return {
			dirs,
			calls,
			run: async (spec) => {
				calls.push(spec);
				return runResult;
			},
			mkdirp: async (d) => {
				dirs.push(d);
			},
			writeFile: async () => {},
			write: () => {},
			exists: async (file) =>
				file.endsWith('top.json') ? netlistIn : file.endsWith('top.pnr.json') ? pnrOut : true,
		};
	}

	const req = {
		project: project(['src/top.v']),
		board: board(),
		projectRoot: ROOT,
		nextpnrExe: '/opt/oss/bin/nextpnr-himbaechel',
	};

	it('runs nextpnr and returns the placed netlist path', async () => {
		const h = io({ code: 0, signal: null });
		const result = await placeAndRoute(req, h);
		assert.equal(result.ok, true);
		assert.equal(result.pnrJsonPath, path.join(ROOT, 'build', 'pnr', 'top.pnr.json'));
		assert.equal(h.calls[0].exe, '/opt/oss/bin/nextpnr-himbaechel');
		assert.equal(h.calls[0].args[0], '--device');
	});

	it('refuses to run when the synthesis netlist is missing', async () => {
		const h = io({ code: 0, signal: null }, { netlistIn: false });
		const result = await placeAndRoute(req, h);
		assert.equal(result.ok, false);
		assert.match(result.summary, /run Synthesize first/);
		assert.equal(h.calls.length, 0);
	});

	it('fails when nextpnr exits cleanly but writes no netlist', async () => {
		const h = io({ code: 0, signal: null }, { pnrOut: false });
		const result = await placeAndRoute(req, h);
		assert.equal(result.ok, false);
		assert.match(result.summary, /no netlist/);
	});
});
