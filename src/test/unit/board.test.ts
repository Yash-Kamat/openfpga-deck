import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { configModesFor, pinAttributes, validateBoard } from '../../boards/schema';
import { loadBoardRegistry, nodeBoardFsHost, type BoardFsHost } from '../../boards/registry';

const VALID = {
	id: 'demo-board',
	name: 'Demo Board',
	fpga: { part: 'GW2AR-LV18QN88C8/I7', family: 'GW2A-18C' },
	synth: { family: 'gw2a' },
	programmer: { board: 'demoboard' },
	pins: { clk: { loc: '4', iostd: 'LVCMOS33' } },
};

describe('validateBoard', () => {
	it('accepts a well-formed board and defaults programmer.defaultTarget to sram', () => {
		const result = validateBoard(VALID);
		assert.equal(result.ok, true);
		if (result.ok) {
			assert.equal(result.board.programmer.defaultTarget, 'sram');
			assert.equal(result.board.pins.clk.loc, '4');
			assert.equal(result.board.clocks.length, 0);
		}
	});

	it('rejects a missing fpga section', () => {
		const { fpga, ...rest } = VALID;
		void fpga;
		const result = validateBoard(rest);
		assert.equal(result.ok, false);
	});

	it('rejects a bad id', () => {
		const result = validateBoard({ ...VALID, id: 'Demo Board' });
		assert.equal(result.ok, false);
	});

	it('rejects an unknown defaultTarget', () => {
		const result = validateBoard({
			...VALID,
			programmer: { board: 'x', defaultTarget: 'nvram' },
		});
		assert.equal(result.ok, false);
	});

	it('parses programmer.flashSize (hex or decimal) and rejects nonsense', () => {
		const hex = validateBoard({ ...VALID, programmer: { board: 'x', flashSize: 0x800000 } });
		assert.ok(hex.ok && hex.board.programmer.flashSize === 8388608);

		const str = validateBoard({ ...VALID, programmer: { board: 'x', flashSize: '4194304' } });
		assert.ok(str.ok && str.board.programmer.flashSize === 4194304);

		assert.ok(validateBoard(VALID).ok); // absent → fine
		assert.equal(validateBoard({ ...VALID, programmer: { board: 'x', flashSize: 'lots' } }).ok, false);
	});

	it('rejects a pin without a loc', () => {
		const result = validateBoard({ ...VALID, pins: { clk: { iostd: 'LVCMOS33' } } });
		assert.equal(result.ok, false);
	});
});

describe('pin groups, headers and config pins', () => {
	const result = validateBoard({
		...VALID,
		pins: { i2s_din: { loc: '54', group: 'Audio', note: 'SSPI pin.' }, tx: { loc: '33,34' } },
		headers: { J5: ['5V', 'GND', 76] },
		configPins: { sspi: ['52', '54'], mspi: ['60'] },
	});

	it('keeps group, note and headers (as strings)', () => {
		assert.ok(result.ok);
		if (result.ok) {
			assert.equal(result.board.pins.i2s_din.group, 'Audio');
			assert.equal(result.board.pins.i2s_din.note, 'SSPI pin.');
			assert.deepEqual(result.board.headers.J5, ['5V', 'GND', '76']);
		}
	});

	it('reports which config modes a set of locs needs, splitting pairs', () => {
		assert.ok(result.ok);
		if (result.ok) {
			assert.deepEqual([...configModesFor(result.board, ['4', '15'])], []);
			assert.deepEqual([...configModesFor(result.board, ['54'])], ['sspi']);
			assert.deepEqual([...configModesFor(result.board, ['59, 60', '52'])], ['sspi', 'mspi']);
		}
	});

	it('keeps a pin direction and rejects an unknown one', () => {
		const ok = validateBoard({ ...VALID, pins: { led: { loc: '15', dir: 'output' } } });
		assert.ok(ok.ok && ok.board.pins.led.dir === 'output');
		assert.equal(validateBoard({ ...VALID, pins: { led: { loc: '15', dir: 'out' } } }).ok, false);
	});

	it('rejects an unknown config pin mode', () => {
		assert.equal(validateBoard({ ...VALID, configPins: { jtag: ['5'] } }).ok, false);
	});
});

describe('pinAttributes', () => {
	const board = validateBoard({
		...VALID,
		defaults: { iostd: 'LVCMOS33', bankVccio: '3.3', attrs: { SLEW_RATE: 'SLOW' } },
		pins: {
			led: { loc: '15', pull: 'up', drive: 8 },
			btn: { loc: '88', pull: 'down', attrs: { SINGLE_RESISTOR: 'ON' } },
			raw: { loc: '4', iostd: 'LVDS25', bankVccio: '2.5' },
		},
	});

	it('merges board defaults with the pin and maps to Gowin attribute names', () => {
		assert.equal(board.ok, true);
		if (!board.ok) {
			return;
		}
		assert.deepEqual(pinAttributes(board.board, 'led'), {
			IO_TYPE: 'LVCMOS33',
			PULL_MODE: 'UP',
			DRIVE: '8',
			BANK_VCCIO: '3.3',
			SLEW_RATE: 'SLOW',
		});
		assert.deepEqual(pinAttributes(board.board, 'btn'), {
			IO_TYPE: 'LVCMOS33',
			PULL_MODE: 'DOWN',
			BANK_VCCIO: '3.3',
			SLEW_RATE: 'SLOW',
			SINGLE_RESISTOR: 'ON',
		});
		// pin overrides win
		assert.equal(pinAttributes(board.board, 'raw').IO_TYPE, 'LVDS25');
		assert.equal(pinAttributes(board.board, 'raw').BANK_VCCIO, '2.5');
	});

	it('returns nothing for an unknown signal', () => {
		if (board.ok) {
			assert.deepEqual(pinAttributes(board.board, 'nope'), {});
		}
	});
});

function fakeHost(files: Record<string, string>): BoardFsHost {
	return {
		listBoardFiles: () => Object.keys(files),
		readTextFile: (p) => files[p],
	};
}

const toYaml = (o: unknown): string => JSON.stringify(o);

describe('loadBoardRegistry', () => {
	it('loads valid boards and reports bad ones without aborting', () => {
		const registry = loadBoardRegistry('/boards', fakeHost({
			'/boards/a.yaml': toYaml(VALID),
			'/boards/b.yaml': toYaml({ ...VALID, id: 'other', name: 'Other' }),
			'/boards/broken.yaml': toYaml({ id: 'broken' }),
		}));
		assert.deepEqual(registry.ids(), ['demo-board', 'other']);
		assert.equal(registry.errors.length, 1);
		assert.match(registry.errors[0].file, /broken\.yaml/);
	});

	it('flags duplicate ids', () => {
		const registry = loadBoardRegistry('/boards', fakeHost({
			'/boards/a.yaml': toYaml(VALID),
			'/boards/a-copy.yaml': toYaml(VALID),
		}));
		assert.equal(registry.boards.size, 1);
		assert.match(registry.errors[0].message, /Duplicate board id/);
	});
});

describe('shipped board definitions', () => {
	it('the real boards/ directory loads with no errors', () => {
		const boardsDir = path.join(__dirname, '..', '..', '..', 'boards');
		const registry = loadBoardRegistry(boardsDir, nodeBoardFsHost);
		assert.deepEqual(registry.errors, []);
		const tn20k = registry.get('tang-nano-20k');
		assert.ok(tn20k, 'tang-nano-20k board should be present');
		assert.equal(tn20k?.fpga.part, 'GW2AR-LV18QN88C8/I7');
		assert.equal(tn20k?.fpga.family, 'GW2A-18C');
		assert.equal(tn20k?.programmer.board, 'tangnano20k');
		// every header entry is a rail or a loc the board defines
		const locs = new Set(Object.values(tn20k?.pins ?? {}).map((p) => p.loc));
		for (const entry of Object.values(tn20k?.headers ?? {}).flat()) {
			assert.ok(/^(GND|3V3|5V)$/.test(entry) || locs.has(entry), `header entry ${entry}`);
		}
		assert.equal(tn20k?.pins['led[0]'].loc, '15');
	});
});
