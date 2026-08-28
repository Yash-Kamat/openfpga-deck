import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig } from '../../src/project/schema';

const valid = {
	name: 'blink',
	board: 'tang-nano-20k',
	top: 'top',
	sources: ['src/top.sv'],
	constraints: ['constraints/top.cst'],
};

describe('validateConfig', () => {
	it('accepts a well-formed config', () => {
		const result = validateConfig(valid);
		assert.equal(result.ok, true);
		if (result.ok) {
			assert.equal(result.project.name, 'blink');
			assert.deepEqual(result.project.sources, ['src/top.sv']);
			assert.equal(result.warnings.length, 0);
		}
	});

	it('rejects an empty document', () => {
		const result = validateConfig(null);
		assert.equal(result.ok, false);
	});

	it('rejects a non-mapping top level', () => {
		const result = validateConfig(['a', 'b']);
		assert.equal(result.ok, false);
	});

	it('reports every missing required key', () => {
		const result = validateConfig({});
		assert.equal(result.ok, false);
		if (!result.ok) {
			const messages = result.errors.map((e) => e.message).join('\n');
			for (const key of ['name', 'board', 'top', 'sources', 'constraints']) {
				assert.match(messages, new RegExp(`"${key}"`));
			}
		}
	});

	it('rejects a blank string field', () => {
		const result = validateConfig({ ...valid, name: '   ' });
		assert.equal(result.ok, false);
	});

	it('rejects an empty sources list', () => {
		const result = validateConfig({ ...valid, sources: [] });
		assert.equal(result.ok, false);
	});

	it('rejects a non-list sources value', () => {
		const result = validateConfig({ ...valid, sources: 'src/top.sv' });
		assert.equal(result.ok, false);
	});

	it('rejects a non-string entry inside a list', () => {
		const result = validateConfig({ ...valid, sources: ['src/top.sv', 42] });
		assert.equal(result.ok, false);
	});

	it('warns but still succeeds on an unknown key', () => {
		const result = validateConfig({ ...valid, simulate: true });
		assert.equal(result.ok, true);
		if (result.ok) {
			assert.equal(result.warnings.length, 1);
			assert.match(result.warnings[0].message, /simulate/);
		}
	});
});
