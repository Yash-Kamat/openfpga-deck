import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { lintCst, missingSemicolon, parseNextpnrLog, parsePackLog, parseYosysLog, portBit } from '../../build/diagnostics';

// Messages below are copied from real runs of the OSS CAD Suite 2026-08-28 tools.
const project = {
	yaml: '# fpga.yaml\nname: demo\nboard: tang-nano-20k\ntop: nope\n',
	csts: [
		{
			path: 'constraints/top.cst',
			text: '// demo\n\nIO_LOC "clk" 4\nIO_LOC "led[5]" 15;\nIO_LOC "led[0]" 15;\nIO_LOC "x" 999;\nIO_LOC "hdmi_hpd" 26;\n',
		},
	],
};

describe('parseYosysLog', () => {
	it('places file:line errors and warnings, and unlocated errors on fpga.yaml', () => {
		const log = [
			'src/syntax.v:3: ERROR: syntax error, unexpected TOK_ENDMODULE',
			'src/undecl.v:2: Warning: Identifier `\\c\' is implicitly declared.',
			'Warning: Wire top.\\b is used but has no driver.',
			'Warning: Replacing memory \\tmds_internal with list of registers. See src/dvi-example.sv:182',
			"ERROR: Module `nope' not found!",
			"ERROR: Module `\\sub' referenced in module `\\top' in cell `\\u' is not part of the design.",
		].join('\n');
		assert.deepEqual(parseYosysLog(log, project), [
			{ file: 'src/syntax.v', line: 3, severity: 'error', message: 'syntax error, unexpected TOK_ENDMODULE' },
			{ file: 'src/undecl.v', line: 2, severity: 'warning', message: "Identifier `\\c' is implicitly declared." },
			{
				file: 'src/dvi-example.sv',
				line: 182,
				severity: 'warning',
				message: 'Replacing memory \\tmds_internal with list of registers. See src/dvi-example.sv:182',
			},
			{ file: 'fpga.yaml', line: 4, severity: 'error', message: "Module `nope' not found!" },
			{
				file: 'fpga.yaml',
				line: 1,
				severity: 'error',
				message: "Module `\\sub' referenced in module `\\top' in cell `\\u' is not part of the design.",
			},
		]);
	});
});

describe('parseNextpnrLog', () => {
	it('traces pin errors back to the .cst line', () => {
		const log = [
			'Warning: Invalid constraint: IO_LOC "clk" 4',
			'ERROR: Pin 999 not found (pin# style)',
			"ERROR: Can't place led_OBUF_O_5 at X0Y46/IOBA because it's already taken by led_OBUF_O",
			'ERROR: Unconstrained IO:clk_IBUF_I',
		].join('\n');
		const d = parseNextpnrLog(log, project).map((x) => [x.file, x.line, x.message]);
		assert.deepEqual(d, [
			['constraints/top.cst', 3, 'nextpnr could not read this constraint (a missing ";"?).'],
			['constraints/top.cst', 6, 'This FPGA package has no pin 999.'],
			['constraints/top.cst', 4, 'led[5] and led are on the same pin.'],
			['constraints/top.cst', 1, 'clk has no pin (IO_LOC); nextpnr does not pick one itself.'],
		]);
	});

	it('names the port in a gowin_pack IO exception', () => {
		const log =
			'Exception: IO_TYPE conflict: X5Y54/IOBB (hdmi_hpd_IBUF_I) is trying to set LVCMOS33 but X23Y54/IOBA (tmds_clk_p_OBUF_O) already set LVDS25';
		const [d] = parsePackLog(log, project);
		assert.equal(d.file, 'constraints/top.cst');
		assert.equal(d.line, 7);
	});

	it('puts anything else on fpga.yaml', () => {
		assert.deepEqual(parseNextpnrLog('ERROR: Max frequency failed', project), [
			{ file: 'fpga.yaml', line: 1, severity: 'error', message: 'Max frequency failed' },
		]);
	});
});

describe('portBit', () => {
	it('maps IO cell names to port bits', () => {
		assert.equal(portBit('led_OBUF_O_5'), 'led[5]');
		assert.equal(portBit('clk_IBUF_I'), 'clk');
		assert.equal(portBit('hdmi_hpd_IBUF_I'), 'hdmi_hpd');
		assert.equal(portBit('sda_IOBUF_IO'), 'sda');
		assert.equal(portBit('not_a_cell'), undefined);
	});
});

describe('missing ";" hint', () => {
	const blink = ['module top (', '    input clk', ');', '', '    reg [24:0] counter = 25\'d0', '', '    always @(posedge clk)', '        counter <= counter + 1;', 'endmodule'].join('\n');

	it('points at the last code line before the error when it lacks a ";"', () => {
		assert.equal(missingSemicolon(blink, 7), 5);
		const log = 'src/top.v:7: ERROR: syntax error, unexpected TOK_ALWAYS';
		const d = parseYosysLog(log, { ...project, hdl: { 'src/top.v': blink } });
		assert.deepEqual(d.map((x) => [x.line, x.severity]), [[7, 'error'], [5, 'warning']]);
	});

	it('stays quiet when the previous line may end without one', () => {
		assert.equal(missingSemicolon(blink, 8), undefined); // after "always @(...)"
		assert.equal(missingSemicolon(blink, 5), undefined); // after ");"
		assert.equal(missingSemicolon('if (a) begin\n  x = 1;', 2), undefined);
		assert.equal(missingSemicolon('`define W 8\nwire x;', 2), undefined);
	});
});

describe('lintCst', () => {
	const locs = new Set(['4', '15', '16']);
	it('flags unreadable lines, unknown pins and pins used twice', () => {
		const text = ['// x', 'IO_LOC "clk" 4', 'IO_LOC "a" 999;', 'IO_LOC "b" 15;', 'IO_LOC "c" 15;', 'IO_PORT "a" IO_TYPE=LVCMOS33;', 'IO_LOC oops;'].join('\n');
		const d = lintCst('c.cst', text, locs, 'Demo').map((x) => [x.line, x.severity, x.message]);
		assert.deepEqual(d, [
			[2, 'error', 'Missing ";" at the end of this constraint.'],
			[3, 'warning', 'Pin 999 is not listed in the Demo board file.'],
			[5, 'error', 'c and b are both on pin 15.'],
			[4, 'error', 'c and b are both on pin 15.'],
			[7, 'error', 'This constraint cannot be read (expected IO_LOC "name" pin; or IO_PORT "name" KEY=VALUE;).'],
		]);
	});

	it('accepts a clean file', () => {
		assert.deepEqual(lintCst('c.cst', 'IO_LOC "clk" 4;\nIO_PORT "clk" IO_TYPE=LVCMOS33 PULL_MODE=UP;\n', locs, 'Demo'), []);
	});
});
