import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseCst } from '../../boards/cst';
import { validateBoard, type Board } from '../../boards/schema';
import {
	canBlink,
	planScaffold,
	validateModuleName,
	validateProjectName,
} from '../../project/scaffold';

function board(pins: Record<string, { loc: string }>): Board {
	const result = validateBoard({
		id: 'demo',
		name: 'Demo Board',
		fpga: { part: 'GW2AR-LV18QN88C8/I7', family: 'GW2A-18C' },
		synth: { family: 'gw2a' },
		programmer: { board: 'demo' },
		defaults: { iostd: 'LVCMOS33' },
		clocks: [{ signal: 'clk', mhz: 27 }],
		pins,
	});
	if (!result.ok) {
		throw new Error(result.errors.map((e) => e.message).join('; '));
	}
	return result.board;
}

const withLeds = board({
	clk: { loc: '4' },
	'led[0]': { loc: '15' },
	'led[1]': { loc: '16' },
	'led[2]': { loc: '17' },
});

describe('name validators', () => {
	it('accept good names and reject bad ones', () => {
		assert.equal(validateProjectName('blink-1'), undefined);
		assert.ok(validateProjectName('has space'));
		assert.equal(validateModuleName('top_module$1'), undefined);
		assert.ok(validateModuleName('1bad'));
	});
});

describe('canBlink', () => {
	it('needs a clk pin and at least one led pin', () => {
		assert.equal(canBlink(withLeds), true);
		assert.equal(canBlink(board({ clk: { loc: '4' } })), false);
		assert.equal(canBlink(board({ 'led[0]': { loc: '15' } })), false);
	});
});

describe('planScaffold (blink)', () => {
	const plan = planScaffold({
		name: 'blinky',
		top: 'top',
		language: 'systemverilog',
		design: 'blink',
		board: withLeds,
	});
	const file = (p: string): string => {
		const f = plan.files.find((x) => x.path === p);
		assert.ok(f, `expected file ${p}`);
		return f.content;
	};

	it('lays out the standard project files and dirs', () => {
		assert.deepEqual([...plan.dirs].sort(), ['build', 'constraints', 'src']);
		assert.deepEqual(
			plan.files.map((f) => f.path).sort(),
			['.gitignore', 'constraints/top.cst', 'fpga.yaml', 'src/top.sv'].sort(),
		);
	});

	it('writes an fpga.yaml that points at the generated files', () => {
		const yaml = file('fpga.yaml');
		assert.match(yaml, /name: blinky/);
		assert.match(yaml, /board: demo/);
		assert.match(yaml, /top: top/);
		assert.match(yaml, /- src\/top\.sv/);
		assert.match(yaml, /- constraints\/top\.cst/);
	});

	it('generates a SystemVerilog blink sized to the board LED count', () => {
		const sv = file('src/top.sv');
		assert.match(sv, /module top \(/);
		assert.match(sv, /output logic \[2:0\] led/);
		assert.match(sv, /always_ff @\(posedge clk\)/);
		assert.match(sv, /~counter\[/);
	});

	it('constrains clk and every LED with resolved attributes', () => {
		const { constraints } = parseCst(file('constraints/top.cst'));
		const signals = constraints.map((c) => c.signal);
		assert.deepEqual(signals, ['clk', 'led[0]', 'led[1]', 'led[2]']);
		assert.equal(constraints.find((c) => c.signal === 'led[0]')?.loc, '15');
		assert.equal(constraints.find((c) => c.signal === 'clk')?.attributes.IO_TYPE, 'LVCMOS33');
	});
});

describe('planScaffold (variants)', () => {
	it('emits Verilog with reg/wire instead of logic', () => {
		const plan = planScaffold({
			name: 'p',
			top: 'main',
			language: 'verilog',
			design: 'blink',
			board: withLeds,
		});
		const v = plan.files.find((f) => f.path === 'src/main.v');
		assert.ok(v);
		assert.doesNotMatch(v.content, /\blogic\b/);
		assert.match(v.content, /reg \[\d+:0\] counter/);
	});

	it('falls back to an empty module and clk-only constraints', () => {
		const plan = planScaffold({
			name: 'p',
			top: 'top',
			language: 'systemverilog',
			design: 'empty',
			board: withLeds,
		});
		const sv = plan.files.find((f) => f.path === 'src/top.sv')?.content ?? '';
		assert.doesNotMatch(sv, /led/);
		assert.match(sv, /Add your logic here/);
		const { constraints } = parseCst(plan.files.find((f) => f.path === 'constraints/top.cst')!.content);
		assert.deepEqual(constraints.map((c) => c.signal), ['clk']);
	});
});
