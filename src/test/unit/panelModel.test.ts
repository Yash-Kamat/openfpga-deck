import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateBoard, type Board } from '../../boards/schema';
import { planProjectSave, type SaveRequest } from '../../project/panelModel';
import type { TopPort } from '../../project/ports';

function board(): Board {
	const result = validateBoard({
		id: 'demo',
		name: 'Demo Board',
		fpga: { part: 'GW2AR-LV18QN88C8/I7', family: 'GW2A-18C' },
		synth: { family: 'gw2a' },
		programmer: { board: 'demo' },
		defaults: { iostd: 'LVCMOS33' },
		clocks: [{ signal: 'clk', mhz: 27 }],
		pins: {
			clk: { loc: '4', dir: 'input' },
			'led[0]': { loc: '15', dir: 'output' },
			'led[1]': { loc: '16', dir: 'output' },
			btn: { loc: '88', dir: 'input' },
		},
	});
	if (!result.ok) {
		throw new Error(result.errors.map((e) => e.message).join('; '));
	}
	return result.board;
}

const port = (name: string, dir: TopPort['dir'], width = 1): TopPort => ({ name, dir, width, offset: 0 });

const base: SaveRequest = {
	mode: 'create',
	name: 'demo',
	top: 'top',
	language: 'verilog',
	starter: 'pins',
	sources: [],
	ports: [port('clk', 'input'), port('led', 'output', 2)],
	mapping: { clk: 'clk', 'led[0]': 'led[0]', 'led[1]': 'led[1]' },
};
const CST = 'constraints/top.cst';

describe('planProjectSave — create', () => {
	it('generates the top module, fpga.yaml, .cst and .gitignore from picked pins', () => {
		const plan = planProjectSave(base, board(), { cstPath: CST });
		assert.ok(plan.ok);
		if (plan.ok) {
			assert.deepEqual(
				plan.files.map((f) => f.path),
				['src/top.v', 'fpga.yaml', CST, '.gitignore'],
			);
			assert.match(plan.files[0].content, /output \[1:0\] led/);
			assert.match(plan.files[1].content, /sources:\n {2}- src\/top\.v\n/);
			assert.match(plan.files[2].content, /IO_LOC "led\[1\]" 16;/);
			assert.equal(plan.cstChanged, false);
		}
	});

	it('writes no HDL for imported sources, only fpga.yaml + .cst', () => {
		const plan = planProjectSave({ ...base, starter: 'hdl', sources: ['src/cpu.v'] }, board(), { cstPath: CST });
		assert.ok(plan.ok && !plan.files.some((f) => f.path.endsWith('.v')));
	});

	it('uses the blink scaffold for the blink starter', () => {
		const plan = planProjectSave({ ...base, starter: 'blink' }, board(), { cstPath: CST });
		assert.ok(plan.ok && plan.files.some((f) => /counter/.test(f.content)));
	});

	it('rejects invalid or duplicate port names when generating', () => {
		const plan = planProjectSave(
			{ ...base, ports: [port('clk', 'input'), port('1led', 'output'), port('clk', 'output')], mapping: {} },
			board(),
			{ cstPath: CST },
		);
		assert.ok(!plan.ok);
		if (!plan.ok) {
			assert.deepEqual(plan.errors, ['Port "1led" is not a valid HDL name.', 'Two ports are called "clk".']);
		}
	});

	it('rejects bad names, missing sources and pin conflicts', () => {
		const bad = planProjectSave({ ...base, name: '-x', top: '1top' }, board(), { cstPath: CST });
		assert.ok(!bad.ok && bad.errors.length === 2);
		const empty = planProjectSave({ ...base, starter: 'hdl' }, board(), { cstPath: CST });
		assert.ok(!empty.ok && /at least one/.test(empty.errors[0]));
		const clash = planProjectSave(
			{ ...base, mapping: { clk: 'clk', 'led[0]': 'led[0]', 'led[1]': 'led[0]' } },
			board(),
			{ cstPath: CST },
		);
		assert.ok(!clash.ok);
		if (!clash.ok) {
			assert.deepEqual(clash.issues[0].bits, ['led[1]', 'led[0]']);
		}
	});
});

describe('planProjectSave — edit', () => {
	const yamlText = '# my notes\nname: demo\nboard: demo\ntop: top\nsources:\n  - src/top.v\nconstraints:\n  - constraints/top.cst\n';
	const edit: SaveRequest = { ...base, mode: 'edit', starter: 'hdl', sources: ['src/top.v', 'src/uart.v'] };
	const handEdited =
		'// my header\nIO_LOC "clk" 4;\nIO_PORT "clk" IO_TYPE=LVCMOS33;\n' +
		'IO_LOC "led[0]" 15;\nIO_PORT "led[0]" IO_TYPE=LVCMOS33 DRIVE=16;\n' +
		'IO_LOC "led[1]" 16;\nIO_PORT "led[1]" IO_TYPE=LVCMOS33;\nCLOCK_LOC "clk" BUFG;\n';

	it('updates fpga.yaml in place, keeping comments and constraints', () => {
		const plan = planProjectSave(edit, board(), { yamlText, cstPath: CST, cstText: handEdited });
		assert.ok(plan.ok);
		if (plan.ok) {
			const yaml = plan.files[0].content;
			assert.match(yaml, /^# my notes/);
			assert.match(yaml, /- src\/uart\.v/);
			assert.match(yaml, /constraints:\n {2}- constraints\/top\.cst/);
		}
	});

	it('keeps lines it cannot show, and refuses to save with no ports', () => {
		const odd = handEdited + 'IO_LOC "spare" 99;\nIO_PORT "vref" IO_TYPE=LVCMOS18;\n';
		const moved = { ...edit, mapping: { clk: 'btn', 'led[0]': 'led[0]', 'led[1]': 'led[1]' } };
		const plan = planProjectSave(moved, board(), { yamlText, cstPath: CST, cstText: odd });
		assert.ok(plan.ok);
		if (plan.ok) {
			assert.match(plan.files[1].content, /IO_LOC "spare" 99;/);
			assert.match(plan.files[1].content, /IO_PORT "vref" IO_TYPE=LVCMOS18;/);
		}
		const none = planProjectSave({ ...edit, ports: [] }, board(), { yamlText, cstPath: CST, cstText: odd });
		assert.ok(!none.ok && /No ports were read/.test(none.errors[0]));
	});

	it('adds the .cst to constraints when fpga.yaml does not list it', () => {
		const plan = planProjectSave(edit, board(), { yamlText, cstPath: 'constraints/pins.cst' });
		assert.ok(plan.ok && /constraints:\n {2}- constraints\/top\.cst\n {2}- constraints\/pins\.cst/.test(plan.files[0].content));
	});

	it('leaves an unchanged .cst byte-for-byte, hand-added attributes included', () => {
		const plan = planProjectSave(edit, board(), { yamlText, cstPath: CST, cstText: handEdited });
		assert.ok(plan.ok && !plan.cstChanged && plan.files[1].content === handEdited);
	});

	it('flags a changed .cst and keeps attributes and unknown lines of unchanged pins', () => {
		const moved = { ...edit, mapping: { clk: 'btn', 'led[0]': 'led[0]', 'led[1]': 'led[1]' } };
		const plan = planProjectSave(moved, board(), { yamlText, cstPath: CST, cstText: handEdited });
		assert.ok(plan.ok && plan.cstChanged);
		if (plan.ok) {
			const cst = plan.files[1].content;
			assert.match(cst, /IO_LOC "clk" 88;/);
			assert.match(cst, /IO_PORT "led\[0\]" IO_TYPE=LVCMOS33 DRIVE=16;/);
			assert.match(cst, /CLOCK_LOC "clk" BUFG;/);
			// Same header, same order as before: only the clk line differs.
			assert.match(cst, /^\/\/ my header\n\nIO_LOC "clk" 88;\nIO_PORT "clk" [^\n]+\nIO_LOC "led\[0\]" 15;/);
		}
	});
});
