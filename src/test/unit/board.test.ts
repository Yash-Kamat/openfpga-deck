import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { pinAttributes, validateBoard } from '../../boards/schema';
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

	it('rejects a pin without a loc', () => {
		const result = validateBoard({ ...VALID, pins: { clk: { iostd: 'LVCMOS33' } } });
		assert.equal(result.ok, false);
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
		assert.equal(tn20k?.pins['led[0]'].loc, '15');
	});
});
