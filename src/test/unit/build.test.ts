import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { validateBoard, type Board } from '../../boards/schema';
import type { FpgaProject } from '../../project/schema';
import { buildDirs, buildLayout } from '../../build/layout';
import { planYosys } from '../../build/yosys';
import { planNextpnr } from '../../build/nextpnr';
import { planGowinPack } from '../../build/gowinPack';
import { runStep, type ProcessResult, type ProcessSpec } from '../../build/runStep';
import { acquireBuildLock, isBuildRunning, releaseBuildLock } from '../../build/lock';
import { synthesize, type SynthesizeIo } from '../../build/synthesize';
import { placeAndRoute } from '../../build/placeAndRoute';
import { packBitstream } from '../../build/pack';
import { formatPnrReport, parsePnrReport } from '../../build/pnrReport';
import { isNoise, makeLineFilter } from '../../build/output';
import { parseDetect, planProgram } from '../../build/openFpgaLoader';
import { detectBoard, program } from '../../build/program';

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
			'--freq',
			'27',
			'--json',
			'build/yosys/top.json',
			'--write',
			'build/pnr/top.pnr.json',
			'--report',
			'build/reports/pnr.json',
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

	it('omits --freq when the board declares no clock', () => {
		const b = validateBoard({
			id: 'noclk',
			name: 'No Clock',
			fpga: { part: 'X', family: 'GW2A-18C' },
			synth: { family: 'gw2a' },
			programmer: { board: 'x' },
			defaults: {},
			pins: {},
		});
		assert.ok(b.ok);
		if (b.ok) {
			const result = planNextpnr(project(['src/top.v']), b.board, ROOT);
			assert.ok(result.ok);
			if (result.ok) {
				assert.equal(result.plan.args.includes('--freq'), false);
			}
		}
	});
});

describe('planGowinPack', () => {
	it('builds -d <family> -o <name>.fs <pnr netlist>', () => {
		const result = planGowinPack(project(['src/top.v']), board(), ROOT);
		assert.equal(result.ok, true);
		if (!result.ok) {
			return;
		}
		assert.deepEqual(result.plan.args, [
			'-d',
			'GW2A-18C',
			'-o',
			'build/bitstream/blinky.fs',
			'build/pnr/top.pnr.json',
		]);
		assert.equal(result.plan.bitstreamPath, path.join(ROOT, 'build', 'bitstream', 'blinky.fs'));
	});
});

describe('parsePnrReport', () => {
	it('reads utilisation and fmax, tolerating key variants', () => {
		const report = parsePnrReport(
			JSON.stringify({
				utilization: { LUT4: { used: 4, available: 20736 }, DFF: { used: 25, available: 20736 } },
				fmax: { clk: { achieved: 439.37, constraint: 27 } },
			}),
		);
		assert.ok(report);
		assert.equal(report.resources.length, 2);
		assert.equal(report.fmax[0].clock, 'clk');
		assert.equal(report.fmax[0].achievedMhz, 439.37);
		const lines = formatPnrReport(report);
		assert.ok(lines.some((l) => /LUT4\s+4 \/ 20736/.test(l)));
		assert.ok(lines.some((l) => /Fmax clk: 439\.37 MHz \(target 27\.00 MHz\)/.test(l)));
	});

	it('returns undefined for non-JSON', () => {
		assert.equal(parsePnrReport('not json at all'), undefined);
	});
});

describe('isNoise', () => {
	it('matches the apycula performance warnings only', () => {
		assert.equal(isNoise('UserWarning: Numpy is not available, performance will be degraded'), true);
		assert.equal(isNoise('  warnings.warn("Msgspec is not available, performance will be degraded.")'), true);
		assert.equal(isNoise('Info: Device utilisation:'), false);
		assert.equal(isNoise('ERROR: constraint file not found'), false);
	});
});

describe('makeLineFilter', () => {
	it('thins progress-bar lines to one per 10% plus the final 100%', () => {
		const keep = makeLineFilter();
		const shown = [2, 4, 9, 11, 19, 45, 46, 99, 100]
			.map((p) => `Writing: [==] ${p}.00%`)
			.filter(keep);
		assert.deepEqual(shown, [
			'Writing: [==] 2.00%',
			'Writing: [==] 11.00%',
			'Writing: [==] 45.00%',
			'Writing: [==] 99.00%',
			'Writing: [==] 100.00%',
		]);
	});

	it('always keeps non-progress, non-noise lines', () => {
		const keep = makeLineFilter();
		assert.equal(keep('Erasing flash'), true);
		assert.equal(keep('Done'), true);
	});
});

describe('planProgram', () => {
	it('SRAM: -b <board> <bitstream>', () => {
		const result = planProgram(project(['src/top.v']), board(), ROOT, 'sram');
		assert.ok(result.ok);
		if (result.ok) {
			assert.deepEqual(result.plan.args, ['-b', 'demo', 'build/bitstream/blinky.fs']);
		}
	});

	it('flash: adds -f', () => {
		const result = planProgram(project(['src/top.v']), board(), ROOT, 'flash');
		assert.ok(result.ok);
		if (result.ok) {
			assert.deepEqual(result.plan.args, ['-b', 'demo', '-f', 'build/bitstream/blinky.fs']);
		}
	});
});

describe('parseDetect', () => {
	it('extracts model and idcode from openFPGALoader --detect output', () => {
		const text =
			'Jtag frequency : requested 6.00MHz -> real 6.00MHz\n' +
			'index 0:\n\tidcode 0x81b\n\tmanufacturer Gowin\n\tfamily GW2A\n\tmodel  GW2A(R)-18(C)\n\tirlength 8\n';
		assert.equal(parseDetect(text), 'GW2A(R)-18(C) (idcode 0x81b)');
	});

	it('returns undefined when nothing matched', () => {
		assert.equal(parseDetect('cable not found'), undefined);
	});
});

describe('program / detectBoard', () => {
	function io(
		runResult: ProcessResult,
		output = '',
		opts: { bitstream?: boolean } = {},
	): SynthesizeIo & { calls: ProcessSpec[] } {
		const calls: ProcessSpec[] = [];
		return {
			calls,
			run: async (spec) => {
				calls.push(spec);
				if (output) {
					spec.onChunk(output);
				}
				return runResult;
			},
			mkdirp: async () => {},
			writeFile: async () => {},
			write: () => {},
			exists: async () => opts.bitstream ?? true,
		};
	}

	const base = {
		project: project(['src/top.v']),
		board: board(),
		projectRoot: ROOT,
		openFpgaLoaderExe: '/opt/oss/bin/openFPGALoader',
	};

	it('programs SRAM and reports it is running', async () => {
		const h = io({ code: 0, signal: null });
		const result = await program({ ...base, target: 'sram' }, h);
		assert.equal(result.ok, true);
		assert.match(result.summary, /SRAM/);
		assert.equal(h.calls[0].exe, '/opt/oss/bin/openFPGALoader');
	});

	it('refuses to program without a bitstream', async () => {
		const h = io({ code: 0, signal: null }, '', { bitstream: false });
		const result = await program({ ...base, target: 'flash' }, h);
		assert.equal(result.ok, false);
		assert.match(result.summary, /run Build first/);
		assert.equal(h.calls.length, 0);
	});

	it('adds a udev hint when the tool output looks like a permissions error', async () => {
		const h = io({ code: 1, signal: null }, 'error: unable to open ftdi device: permission denied\n');
		const result = await program({ ...base, target: 'sram' }, h);
		assert.equal(result.ok, false);
		assert.match(result.summary, /udev rules/);
	});

	it('detectBoard reports the chip identity on success', async () => {
		const h = io({ code: 0, signal: null }, 'idcode 0x81b\nmodel  GW2A(R)-18(C)\n');
		const result = await detectBoard(base, h);
		assert.equal(result.ok, true);
		assert.match(result.summary, /GW2A\(R\)-18\(C\)/);
	});

	it('detectBoard fails cleanly when the cable is absent', async () => {
		const h = io({ code: 1, signal: null }, 'JTAG init failed\n');
		const result = await detectBoard(base, h);
		assert.equal(result.ok, false);
		assert.match(result.summary, /check the USB cable/);
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

	it('hides known-noise lines from the channel but keeps them in the log', async () => {
		const noisy =
			'.../apycula/bitmatrix.py:60: UserWarning: Numpy is not available, performance will be degraded.\n' +
			'  warnings.warn("Numpy is not available, performance will be degraded.")\n' +
			'Bitstream generated.\n';
		const runner = fakeRunner({ code: 0, signal: null }, noisy);
		let channel = '';
		let logged = '';
		await runStep(base, {
			run: runner.run,
			write: (t) => {
				channel += t;
			},
			writeFile: async (_f, t) => {
				logged = t;
			},
		});
		assert.doesNotMatch(channel, /performance will be degraded/);
		assert.match(channel, /Bitstream generated\./);
		assert.equal(logged, noisy);
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

describe('packBitstream', () => {
	function io(
		runResult: ProcessResult,
		opts: { pnrIn?: boolean; fsOut?: boolean } = {},
	): SynthesizeIo & { calls: ProcessSpec[] } {
		const calls: ProcessSpec[] = [];
		const pnrIn = opts.pnrIn ?? true;
		const fsOut = opts.fsOut ?? true;
		return {
			calls,
			run: async (spec) => {
				calls.push(spec);
				return runResult;
			},
			mkdirp: async () => {},
			writeFile: async () => {},
			write: () => {},
			exists: async (file) =>
				file.endsWith('.pnr.json') ? pnrIn : file.endsWith('.fs') ? fsOut : true,
		};
	}

	const req = {
		project: project(['src/top.v']),
		board: board(),
		projectRoot: ROOT,
		gowinPackExe: '/opt/oss/bin/gowin_pack',
	};

	it('runs gowin_pack and returns the bitstream path', async () => {
		const h = io({ code: 0, signal: null });
		const result = await packBitstream(req, h);
		assert.equal(result.ok, true);
		assert.equal(result.bitstreamPath, path.join(ROOT, 'build', 'bitstream', 'blinky.fs'));
		assert.equal(h.calls[0].exe, '/opt/oss/bin/gowin_pack');
	});

	it('refuses to run without the P&R netlist', async () => {
		const h = io({ code: 0, signal: null }, { pnrIn: false });
		const result = await packBitstream(req, h);
		assert.equal(result.ok, false);
		assert.match(result.summary, /run Place and Route first/);
		assert.equal(h.calls.length, 0);
	});

	it('fails when gowin_pack writes no bitstream', async () => {
		const h = io({ code: 0, signal: null }, { fsOut: false });
		const result = await packBitstream(req, h);
		assert.equal(result.ok, false);
		assert.match(result.summary, /no bitstream/);
	});
});
