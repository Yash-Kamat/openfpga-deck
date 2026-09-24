import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { validateBoard, type Board } from '../../boards/schema';
import { mappingFromCst, planPinConstraints, portsFromBoardSignals } from '../../project/pinmap';
import { parsePorts, planPortQuery, portBitNames, readTopPorts, type TopPort } from '../../project/ports';
import type { FpgaProject } from '../../project/schema';
import { topModuleSource } from '../../project/scaffold';

const ROOT = path.join(path.sep, 'proj');

function board(): Board {
	const result = validateBoard({
		id: 'demo',
		name: 'Demo Board',
		fpga: { part: 'GW2AR-LV18QN88C8/I7', family: 'GW2A-18C' },
		synth: { family: 'gw2a' },
		programmer: { board: 'demo' },
		defaults: { iostd: 'LVCMOS33' },
		pins: {
			clk: { loc: '4', dir: 'input' },
			'led[0]': { loc: '15', dir: 'output' },
			'led[1]': { loc: '16', dir: 'output' },
			'led[2]': { loc: '17', dir: 'output' },
			btn: { loc: '88', dir: 'input' },
			tmds_clk_p: { loc: '33', iostd: 'LVDS25', dir: 'output' },
			lcd_g4: { loc: '33', dir: 'output' },
			gpio: { loc: '71' },
		},
	});
	if (!result.ok) {
		throw new Error(result.errors.map((e) => e.message).join('; '));
	}
	return result.board;
}

const project: FpgaProject = {
	name: 'demo',
	board: 'demo',
	top: 'top',
	sources: ['src/top.v', 'src/tx.sv'],
	constraints: ['constraints/top.cst'],
};

const port = (name: string, dir: TopPort['dir'], width = 1, offset = 0): TopPort => ({
	name,
	dir,
	width,
	offset,
});

const YOSYS_JSON = JSON.stringify({
	modules: {
		top: {
			ports: {
				clk: { direction: 'input', bits: [2] },
				led: { direction: 'output', bits: [3, 4, 5] },
				d: { direction: 'inout', offset: 4, upto: 1, bits: [6, 7] },
			},
		},
	},
});

describe('top-module ports', () => {
	it('parses yosys JSON in declaration order', () => {
		assert.deepEqual(parsePorts(YOSYS_JSON, 'top'), [
			port('clk', 'input'),
			port('led', 'output', 3),
			port('d', 'inout', 2, 4),
		]);
		assert.throws(() => parsePorts(YOSYS_JSON, 'other'), /no module "other"/);
	});

	it('names every port bit the way a .cst does', () => {
		assert.deepEqual(portBitNames(port('clk', 'input')), ['clk']);
		assert.deepEqual(portBitNames(port('d', 'inout', 2, 4)), ['d[4]', 'd[5]']);
	});

	it('plans a yosys script that reads the sources and writes only the top', () => {
		const planned = planPortQuery(project, ROOT);
		assert.ok(planned.ok);
		if (planned.ok) {
			const text = planned.plan.scriptText;
			assert.match(text, /read_verilog -lib -specify \+\/gowin\/cells_sim\.v/);
			assert.match(text, /read_verilog src\/top\.v\nread_verilog -sv src\/tx\.sv/);
			assert.match(text, /hierarchy -top top\nselect top\nproc\nwrite_json -selected -noscopeinfo build\/yosys\/ports\.json/);
			assert.deepEqual(planned.plan.args, ['-q', '-s', 'build/yosys/ports.ys']);
		}
	});

	it('runs yosys and returns the ports, or its ERROR line', async () => {
		const io = (code: number, output = '') => ({
			run: async (spec: { onChunk: (t: string) => void }) => {
				spec.onChunk(output);
				return { code, signal: null };
			},
			mkdirp: async () => undefined,
			writeFile: async () => undefined,
			readFile: async () => YOSYS_JSON,
		});
		const ok = await readTopPorts(project, ROOT, 'yosys', io(0));
		assert.ok(ok.ok && ok.ports.length === 3);
		const bad = await readTopPorts(project, ROOT, 'yosys', io(1, 'Warning: x\nERROR: syntax error\n'));
		assert.deepEqual(bad, { ok: false, error: 'ERROR: syntax error' });
	});
});

describe('planPinConstraints', () => {
	const b = board();

	it('turns a mapping into .cst constraints with the board attributes', () => {
		const { constraints, issues } = planPinConstraints(
			[port('clk', 'input'), port('led', 'output', 2)],
			{ clk: 'clk', 'led[0]': 'led[0]', 'led[1]': 'led[2]' },
			b,
		);
		assert.deepEqual(issues, []);
		assert.deepEqual(
			constraints.map((c) => [c.signal, c.loc, c.attributes.IO_TYPE]),
			[
				['clk', '4', 'LVCMOS33'],
				['led[0]', '15', 'LVCMOS33'],
				['led[1]', '17', 'LVCMOS33'],
			],
		);
	});

	it('reports shared pins, unknown signals, unmapped and stale bits, direction clashes', () => {
		const { issues } = planPinConstraints(
			[port('a', 'output'), port('b', 'output'), port('c', 'output'), port('d', 'input'), port('e', 'input')],
			{ a: 'tmds_clk_p', b: 'lcd_g4', c: 'nope', e: 'led[0]', gone: 'btn' },
			b,
		);
		assert.deepEqual(
			issues.map((i) => i.severity),
			['error', 'error', 'warning', 'warning', 'warning'],
		);
		assert.match(issues[0].message, /b and a both use pin 33/);
		assert.match(issues[1].message, /"nope"/);
		assert.match(issues[2].message, /d is not mapped/);
		assert.match(issues[3].message, /e is an input, but led\[0\] is normally an output/);
		assert.match(issues[4].message, /gone is mapped but is not a port/);
	});
});

describe('mappingFromCst', () => {
	it('recovers board signals by loc, using IO_TYPE to pick among shared pins', () => {
		const { mapping, unmatched } = mappingFromCst(
			[
				{ signal: 'clk', loc: '4', attributes: {} },
				{ signal: 'tx_p', loc: '33', attributes: { IO_TYPE: 'LVDS25' } },
				{ signal: 'g', loc: '33', attributes: { IO_TYPE: 'LVCMOS33' } },
				{ signal: 'x', loc: '99', attributes: {} },
				{ signal: 'noloc', attributes: { IO_TYPE: 'LVCMOS33' } },
			],
			board(),
		);
		assert.deepEqual(mapping, { clk: 'clk', tx_p: 'tmds_clk_p', g: 'lcd_g4' });
		assert.deepEqual(unmatched, ['x']);
	});
});

describe('portsFromBoardSignals', () => {
	it('groups contiguous bus bits and takes directions from the board', () => {
		const { ports, mapping } = portsFromBoardSignals(board(), ['clk', 'led[0]', 'led[1]', 'led[2]', 'gpio']);
		assert.deepEqual(ports, [port('clk', 'input'), port('led', 'output', 3), port('gpio', 'input')]);
		assert.deepEqual(mapping, { clk: 'clk', 'led[0]': 'led[0]', 'led[1]': 'led[1]', 'led[2]': 'led[2]', gpio: 'gpio' });
	});

	it('splits a bus with gaps into scalars and applies direction overrides', () => {
		const { ports, mapping } = portsFromBoardSignals(board(), ['led[0]', 'led[2]', 'gpio'], { gpio: 'inout' });
		assert.deepEqual(ports, [port('led_0', 'output'), port('led_2', 'output'), port('gpio', 'inout')]);
		assert.deepEqual(mapping, { led_0: 'led[0]', led_2: 'led[2]', gpio: 'gpio' });
	});

	it('round-trips: generated ports + mapping give a clean .cst', () => {
		const b = board();
		const { ports, mapping } = portsFromBoardSignals(b, ['clk', 'led[0]', 'led[1]', 'led[2]']);
		assert.deepEqual(planPinConstraints(ports, mapping, b).issues, []);
	});
});

describe('topModuleSource', () => {
	const ports = [port('clk', 'input'), port('led', 'output', 6), port('sda', 'inout')];

	it('writes a Verilog port list', () => {
		const v = topModuleSource({ name: 'demo', top: 'top', language: 'verilog' }, ports);
		assert.match(v, /module top \(\n {4}input {2}clk,\n {4}output \[5:0\] led,\n {4}inout {2}sda\n\);/);
	});

	it('uses logic, and wire for inout, in SystemVerilog', () => {
		const sv = topModuleSource({ name: 'demo', top: 'top', language: 'systemverilog' }, ports);
		assert.match(sv, /input {2}logic clk,\n {4}output logic \[5:0\] led,\n {4}inout {2}wire sda\n/);
	});
});
