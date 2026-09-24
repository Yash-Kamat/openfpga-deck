/**
 * The pure half of the Project Settings panel: what a Save writes.
 *
 * The panel (panel.ts) collects the user's choices and the files already on
 * disk; this module turns them into the list of files to write and says
 * whether the `.cst` would change, so the panel can ask before overwriting.
 * No filesystem, no VS Code.
 */

import { parseDocument } from 'yaml';
import { parseCst, serializeCst, type CstConstraint } from '../boards/cst';
import type { Board } from '../boards/schema';
import { planPinConstraints, type MappingIssue, type PinMapping } from './pinmap';
import type { TopPort } from './ports';
import {
	planScaffold,
	projectYaml,
	topModuleSource,
	validateModuleName,
	validateProjectName,
	type HdlLanguage,
} from './scaffold';

/**
 * How a new project gets its top module: the blink example, an empty module
 * generated from the pins the user picks, or HDL files the user adds.
 * An existing project is always `hdl`.
 */
export type Starter = 'blink' | 'pins' | 'hdl';

export interface SaveRequest {
	readonly mode: 'create' | 'edit';
	readonly name: string;
	readonly top: string;
	readonly language: HdlLanguage;
	readonly starter: Starter;
	/** Project-relative HDL sources (already inside the project). */
	readonly sources: readonly string[];
	/** `pins`: the ports the user defined; `hdl`: the ports yosys read. */
	readonly ports: readonly TopPort[];
	readonly mapping: PinMapping;
}

export interface ExistingFiles {
	/** Current `fpga.yaml` text (edit mode). */
	readonly yamlText?: string;
	/** Project-relative path of the `.cst` to write, and its current text if it exists. */
	readonly cstPath: string;
	readonly cstText?: string;
}

export interface SaveFile {
	/** Project-relative, POSIX separators. */
	readonly path: string;
	readonly content: string;
}

export type SavePlan =
	| { readonly ok: false; readonly errors: readonly string[]; readonly issues: readonly MappingIssue[] }
	| {
			readonly ok: true;
			readonly files: readonly SaveFile[];
			/** The `.cst` exists and its text would change. */
			readonly cstChanged: boolean;
			readonly issues: readonly MappingIssue[];
	  };

export function planProjectSave(req: SaveRequest, board: Board, existing: ExistingFiles): SavePlan {
	const errors: string[] = [];
	const nameError = validateProjectName(req.name);
	if (nameError) {
		errors.push(`Project name: ${nameError}`);
	}
	const topError = validateModuleName(req.top);
	if (topError) {
		errors.push(`Top module: ${topError}`);
	}
	if (req.starter === 'hdl' && req.sources.length === 0) {
		errors.push('Add at least one HDL source file.');
	} else if (req.starter === 'hdl' && req.ports.length === 0) {
		// Usually yosys could not read the ports; saving would empty the .cst.
		errors.push(`No ports were read from "${req.top}", so the .cst is left alone.`);
	}
	if (req.mode === 'create' && req.starter === 'pins') {
		const seen = new Set<string>();
		for (const { name } of req.ports) {
			if (validateModuleName(name)) {
				errors.push(`Port "${name}" is not a valid HDL name.`);
			} else if (seen.has(name)) {
				errors.push(`Two ports are called "${name}".`);
			}
			seen.add(name);
		}
	}
	if (errors.length > 0) {
		return { ok: false, errors, issues: [] };
	}

	if (req.mode === 'create' && req.starter === 'blink') {
		const plan = planScaffold({ name: req.name, top: req.top, language: req.language, design: 'blink', board });
		return { ok: true, files: plan.files, cstChanged: false, issues: [] };
	}

	const { constraints, issues } = planPinConstraints(req.ports, req.mapping, board);
	if (issues.some((i) => i.severity === 'error')) {
		return { ok: false, errors: ['Fix the pin conflicts marked in red.'], issues };
	}
	const cstText = cstSource(req.name, board, constraints, existing.cstText);
	const cstChanged = existing.cstText !== undefined && existing.cstText !== cstText;
	const cstFile = { path: existing.cstPath, content: cstText };

	if (req.mode === 'edit') {
		const yaml = parseDocument(existing.yamlText ?? '');
		yaml.set('name', req.name);
		yaml.set('board', board.id);
		yaml.set('top', req.top);
		yaml.set('sources', [...req.sources]);
		const constraints = yaml.get('constraints');
		const listed = (constraints as { toJSON?: () => unknown } | undefined)?.toJSON?.();
		if (!Array.isArray(listed) || !listed.includes(existing.cstPath)) {
			// A .cst the build does not know about would be written for nothing.
			yaml.set('constraints', [...(Array.isArray(listed) ? listed : []), existing.cstPath]);
		}
		return { ok: true, files: [{ path: 'fpga.yaml', content: yaml.toString() }, cstFile], cstChanged, issues };
	}

	const files: SaveFile[] = [];
	const sources = [...req.sources];
	if (req.starter === 'pins') {
		const hdlPath = `src/${req.top}.${req.language === 'verilog' ? 'v' : 'sv'}`;
		files.push({ path: hdlPath, content: topModuleSource(req, req.ports) });
		if (!sources.includes(hdlPath)) {
			sources.unshift(hdlPath);
		}
	}
	files.push(
		{ path: 'fpga.yaml', content: projectYaml(req.name, board.id, req.top, sources, existing.cstPath) },
		cstFile,
		{ path: '.gitignore', content: '/build/\n' },
	);
	return { ok: true, files, cstChanged, issues };
}

/**
 * The new `.cst` text. A pin line that is unchanged from the existing file
 * keeps that file's attributes, so hand-added ones (DRIVE, SLEW_RATE, …)
 * survive. Pins already in the file keep their place and new ones go last,
 * so a small change gives a small diff. The file's header comment and
 * statements we don't parse (CLOCK_LOC, …) are carried over. When nothing
 * changed, the existing text is returned as is.
 */
function cstSource(
	name: string,
	board: Board,
	constraints: readonly CstConstraint[],
	existingText: string | undefined,
): string {
	const parsed = parseCst(existingText ?? '');
	const old = new Map(parsed.constraints.map((c) => [c.signal, c]));
	const position = new Map(parsed.constraints.map((c, i) => [c.signal, i]));
	const mapped = new Set(constraints.map((c) => c.signal));
	const merged = [
		...constraints.map((c) => {
			const prev = old.get(c.signal);
			return prev && prev.loc === c.loc ? { ...c, attributes: { ...c.attributes, ...prev.attributes } } : c;
		}),
		// Lines the panel cannot show (no IO_LOC, or a pin the board file does
		// not list) are kept as they are unless the user mapped that signal.
		...parsed.constraints.filter((c) => !mapped.has(c.signal) && !onBoard(board, c.loc)),
	].sort((a, b) => (position.get(a.signal) ?? Infinity) - (position.get(b.signal) ?? Infinity));
	if (existingText !== undefined && sameConstraints(merged, parsed.constraints)) {
		return existingText;
	}
	const header = leadingComments(existingText ?? '');
	const text = serializeCst(merged, {
		header: header.length
			? header
			: [`${name} — physical constraints for ${board.name}`, 'Generated by OpenFPGA Deck.'],
	});
	if (parsed.unrecognized.length === 0) {
		return text;
	}
	return `${text}\n// Kept from the previous file:\n${parsed.unrecognized.join('\n')}\n`;
}

function onBoard(board: Board, loc: string | undefined): boolean {
	return loc !== undefined && Object.values(board.pins).some((p) => p.loc === loc);
}

/** The `//` comment block at the top of a file, without the slashes. */
function leadingComments(text: string): string[] {
	const out: string[] = [];
	for (const line of text.split(/\r?\n/)) {
		const m = /^\s*\/\/ ?(.*)$/.exec(line);
		if (!m) {
			break;
		}
		out.push(m[1]);
	}
	return out;
}

function sameConstraints(a: readonly CstConstraint[], b: readonly CstConstraint[]): boolean {
	const key = (list: readonly CstConstraint[]): string =>
		JSON.stringify(
			list
				.map((c) => [c.signal, c.loc ?? '', Object.entries(c.attributes).sort()])
				.sort((x, y) => String(x[0]).localeCompare(String(y[0]))),
		);
	return key(a) === key(b);
}
