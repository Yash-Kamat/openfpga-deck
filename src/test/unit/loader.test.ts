import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadProject, type ProjectFsHost } from '../../project/loader';

const ROOT = '/proj';

function makeHost(files: Record<string, string>): ProjectFsHost {
	return {
		fileExists: (p) => Object.prototype.hasOwnProperty.call(files, p),
		readTextFile: (p) => {
			if (!Object.prototype.hasOwnProperty.call(files, p)) {
				throw new Error(`ENOENT: ${p}`);
			}
			return files[p];
		},
	};
}

const GOOD_YAML = `
name: blink
board: tang-nano-20k
top: top
sources:
  - src/top.sv
constraints:
  - constraints/top.cst
`;

describe('loadProject', () => {
	it('loads a valid project', () => {
		const host = makeHost({
			'/proj/fpga.yaml': GOOD_YAML,
			'/proj/src/top.sv': '',
			'/proj/constraints/top.cst': '',
		});
		const result = loadProject(ROOT, host);
		assert.equal(result.ok, true);
		if (result.ok) {
			assert.equal(result.value.project.name, 'blink');
			assert.equal(result.value.configPath, '/proj/fpga.yaml');
			assert.equal(result.value.root, ROOT);
		}
	});

	it('fails when fpga.yaml is absent', () => {
		const result = loadProject(ROOT, makeHost({}));
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.equal(result.configPath, undefined);
		}
	});

	it('reports a YAML syntax error with a line number', () => {
		const host = makeHost({ '/proj/fpga.yaml': 'name: blink\n  bad: : :\n' });
		const result = loadProject(ROOT, host);
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.ok(result.errors.length > 0);
			assert.equal(typeof result.errors[0].line, 'number');
		}
	});

	it('passes structural validation errors through', () => {
		const host = makeHost({ '/proj/fpga.yaml': 'name: blink\n' });
		const result = loadProject(ROOT, host);
		assert.equal(result.ok, false);
		if (!result.ok) {
			const messages = result.errors.map((e) => e.message).join('\n');
			assert.match(messages, /"board"/);
		}
	});

	it('reports a missing source file', () => {
		const host = makeHost({
			'/proj/fpga.yaml': GOOD_YAML,
			'/proj/constraints/top.cst': '',
		});
		const result = loadProject(ROOT, host);
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.match(result.errors[0].message, /Source file not found: src\/top\.sv/);
		}
	});

	it('rejects a source path that escapes the project root', () => {
		const yaml = GOOD_YAML.replace('src/top.sv', '../elsewhere/top.sv');
		const host = makeHost({
			'/proj/fpga.yaml': yaml,
			'/elsewhere/top.sv': '',
			'/proj/constraints/top.cst': '',
		});
		const result = loadProject(ROOT, host);
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.match(result.errors[0].message, /stay inside the project directory/);
		}
	});

	it('rejects an absolute source path', () => {
		const yaml = GOOD_YAML.replace('src/top.sv', '/etc/passwd');
		const host = makeHost({
			'/proj/fpga.yaml': yaml,
			'/etc/passwd': '',
			'/proj/constraints/top.cst': '',
		});
		const result = loadProject(ROOT, host);
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.match(result.errors[0].message, /must be relative/);
		}
	});
});
