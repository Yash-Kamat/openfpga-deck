/**
 * Turn yosys / nextpnr / gowin_pack log text into located problems for the
 * Problems panel.
 *
 * Best effort, not a full parser: yosys usually says `file:line:`; nextpnr
 * and gowin_pack talk about pins and IO cells, so those messages are traced
 * back to the `.cst` line that constrains the port. Errors that cannot be
 * placed anywhere better go on `fpga.yaml`, so every error is visible in the
 * Problems panel; unlocated warnings stay in the output only (there are many).
 *
 * Pure — no filesystem, no VS Code.
 */

export type DiagnosticSeverity = 'error' | 'warning';

export interface ToolDiagnostic {
	/** Project-relative path, POSIX separators. */
	readonly file: string;
	/** 1-based. */
	readonly line: number;
	readonly severity: DiagnosticSeverity;
	readonly message: string;
}

export interface ProjectText {
	/** `fpga.yaml` contents. */
	readonly yaml: string;
	/** Each `.cst` with its project-relative path. */
	readonly csts: readonly { readonly path: string; readonly text: string }[];
	/** HDL sources by project-relative path, for the missing-";" hint. */
	readonly hdl?: Readonly<Record<string, string>>;
}

const PROJECT_FILE = 'fpga.yaml';

// `src/top.v:3: ERROR: syntax error` / `src/top.v:2: Warning: ...`
const YOSYS_LOCATED_RE = /^(.+?\.(?:s?v|vh|svh)):(\d+): (ERROR|Warning): (.*)$/i;
// `... at src/top.v:4.5-4.9` / `... See src/top.v:182` inside a message.
const YOSYS_AT_RE = /\b(?:at|See) (\S+?\.(?:s?v|vh|svh)):(\d+)/i;
const ERROR_RE = /^ERROR: (.*)$/;

export function parseYosysLog(log: string, project: ProjectText): ToolDiagnostic[] {
	const out: ToolDiagnostic[] = [];
	for (const raw of log.split(/\r?\n/)) {
		const line = raw.trim();
		const located = YOSYS_LOCATED_RE.exec(line);
		if (located) {
			const [file, at] = [located[1], Number(located[2])];
			out.push({ file, line: at, severity: /error/i.test(located[3]) ? 'error' : 'warning', message: located[4] });
			const hint = /^syntax error, unexpected/.test(located[4]) ? missingSemicolon(project.hdl?.[file], at) : undefined;
			if (hint !== undefined) {
				out.push({ file, line: hint, severity: 'warning', message: `Missing ";" at the end of this line? (yosys noticed it at line ${at}.)` });
			}
			continue;
		}
		const at = /^Warning: /.test(line) ? YOSYS_AT_RE.exec(line) : null;
		if (at) {
			out.push({ file: at[1], line: Number(at[2]), severity: 'warning', message: line.slice(9) });
			continue;
		}
		const error = ERROR_RE.exec(line);
		if (error) {
			// "Module `nope' not found!" is almost always a wrong `top:`.
			const onTop = /^Module `[^']*' not found/.test(error[1]);
			out.push({ file: PROJECT_FILE, line: yamlLine(project.yaml, onTop ? 'top' : ''), severity: 'error', message: error[1] });
		}
	}
	return dedupe(out);
}

/** Words and characters a Verilog line may legitimately end with, no ";" needed. */
const NO_SEMICOLON_END = /(?:[;,({[:]|\)|\*\/|\b(?:begin|end|else|endcase|endmodule|endfunction|endtask|endgenerate|generate|fork|join))$/;

/**
 * The parser reports a missing ";" at the next token, often a line or two
 * later. Returns the last code line before `errorLine` when it lacks one.
 */
export function missingSemicolon(text: string | undefined, errorLine: number): number | undefined {
	if (text === undefined) {
		return undefined;
	}
	const lines = text.split(/\r?\n/);
	for (let i = errorLine - 2; i >= 0; i--) {
		const code = lines[i].replace(/\/\/.*$/, '').trim();
		if (code === '') {
			continue;
		}
		return code.startsWith('`') || NO_SEMICOLON_END.test(code) ? undefined : i + 1;
	}
	return undefined;
}

/**
 * Check a `.cst` without running nextpnr, so its mistakes show up even when
 * synthesis fails first: unreadable lines, pins the board file does not
 * list, and pins used twice.
 */
export function lintCst(path: string, text: string, boardLocs: ReadonlySet<string>, boardName: string): ToolDiagnostic[] {
	const out: ToolDiagnostic[] = [];
	const owners = new Map<string, { signal: string; line: number }>();
	text.split(/\r?\n/).forEach((raw, i) => {
		const line = i + 1;
		const code = raw.replace(/\/\/.*$/, '').trim();
		if (!/^IO_(LOC|PORT)\b/i.test(code)) {
			return;
		}
		if (!code.includes(';')) {
			out.push({ file: path, line, severity: 'error', message: 'Missing ";" at the end of this constraint.' });
			return;
		}
		const loc = /^IO_LOC\s+"([^"]+)"\s+([^;]+);/i.exec(code);
		if (!loc) {
			if (!/^IO_PORT\s+"[^"]+"\s+[^;]+;/i.test(code)) {
				out.push({ file: path, line, severity: 'error', message: 'This constraint cannot be read (expected IO_LOC "name" pin; or IO_PORT "name" KEY=VALUE;).' });
			}
			return;
		}
		const signal = loc[1];
		for (const pin of loc[2].replace(/\s+exclusive\s*$/i, '').split(',').map((p) => p.trim())) {
			if (boardLocs.size > 0 && !boardLocs.has(pin)) {
				out.push({ file: path, line, severity: 'warning', message: `Pin ${pin} is not listed in the ${boardName} board file.` });
			}
			const owner = owners.get(pin);
			if (owner && owner.signal !== signal) {
				const message = `${signal} and ${owner.signal} are both on pin ${pin}.`;
				out.push({ file: path, line, severity: 'error', message }, { file: path, line: owner.line, severity: 'error', message });
			} else {
				owners.set(pin, { signal, line });
			}
		}
	});
	return out;
}

// nextpnr / gowin_pack name IO cells after the port: clk_IBUF_I, led_OBUF_O_5.
const IO_CELL_RE = /\b([A-Za-z_][\w$]*?)_(?:I|O|IO)BUF_[A-Z]+(?:_(\d+))?\b/;

export function parseNextpnrLog(log: string, project: ProjectText): ToolDiagnostic[] {
	const out: ToolDiagnostic[] = [];
	for (const raw of log.split(/\r?\n/)) {
		const line = raw.trim();
		let m: RegExpExecArray | null;
		if ((m = /^Warning: Invalid constraint: (.*)$/.exec(line))) {
			const at = findInCst(project, (l) => l.trim() === m?.[1].trim());
			out.push(at ? { ...at, severity: 'error', message: 'nextpnr could not read this constraint (a missing ";"?).' } : fallback(project, line));
			continue;
		}
		if ((m = /^ERROR: Pin (\S+) not found/.exec(line))) {
			const pin = m[1];
			const at = findInCst(project, (l) => new RegExp(`^\\s*IO_LOC\\s+"[^"]+"\\s+${escape(pin)}\\b`).test(l));
			out.push(at ? { ...at, severity: 'error', message: `This FPGA package has no pin ${pin}.` } : fallback(project, line));
			continue;
		}
		if ((m = /^ERROR: Unconstrained IO:(\S+)/.exec(line))) {
			const bit = portBit(m[1]);
			const cst = project.csts[0];
			out.push({
				file: cst?.path ?? PROJECT_FILE,
				line: 1,
				severity: 'error',
				message: `${bit ?? m[1]} has no pin (IO_LOC); nextpnr does not pick one itself.`,
			});
			continue;
		}
		if ((m = /^ERROR: Can't place (\S+) at .* already taken by (\S+)/.exec(line))) {
			const [a, b] = [portBit(m[1]), portBit(m[2])];
			for (const bit of [a, b]) {
				const at = bit ? findSignal(project, bit) : undefined;
				if (at) {
					out.push({ ...at, severity: 'error', message: `${a} and ${b} are on the same pin.` });
				}
			}
			if (!a || !b) {
				out.push(fallback(project, line));
			}
			continue;
		}
		if ((m = /^(?:ERROR|Exception): (.*)$/.exec(line))) {
			out.push(locateByIoCell(project, m[1]) ?? fallback(project, line));
		}
	}
	return dedupe(out);
}

/** gowin_pack fails with a Python exception; its IO messages name IO cells too. */
export function parsePackLog(log: string, project: ProjectText): ToolDiagnostic[] {
	return parseNextpnrLog(log, project);
}

function locateByIoCell(project: ProjectText, message: string): ToolDiagnostic | undefined {
	const cell = IO_CELL_RE.exec(message);
	const bit = cell ? portBit(cell[0]) : undefined;
	const at = bit ? findSignal(project, bit) : undefined;
	return at ? { ...at, severity: 'error', message } : undefined;
}

/** `led_OBUF_O_5` → `led[5]`, `clk_IBUF_I` → `clk`. */
export function portBit(cell: string): string | undefined {
	const m = IO_CELL_RE.exec(cell);
	if (!m) {
		return undefined;
	}
	return m[2] !== undefined ? `${m[1]}[${m[2]}]` : m[1];
}

function findSignal(project: ProjectText, bit: string): { file: string; line: number } | undefined {
	const quoted = `"${bit}"`;
	return findInCst(project, (l) => /^\s*IO_LOC\b/.test(l) && l.includes(quoted));
}

function findInCst(
	project: ProjectText,
	test: (line: string) => boolean,
): { file: string; line: number } | undefined {
	for (const cst of project.csts) {
		const lines = cst.text.split(/\r?\n/);
		const i = lines.findIndex(test);
		if (i >= 0) {
			return { file: cst.path, line: i + 1 };
		}
	}
	return undefined;
}

function fallback(project: ProjectText, line: string): ToolDiagnostic {
	return { file: PROJECT_FILE, line: yamlLine(project.yaml, ''), severity: 'error', message: line.replace(/^(ERROR|Exception): /, '') };
}

/** 1-based line of `key:` in fpga.yaml, or 1. */
function yamlLine(yaml: string, key: string): number {
	if (!key) {
		return 1;
	}
	const i = yaml.split(/\r?\n/).findIndex((l) => l.startsWith(`${key}:`));
	return i >= 0 ? i + 1 : 1;
}

function escape(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function dedupe(list: ToolDiagnostic[]): ToolDiagnostic[] {
	const seen = new Set<string>();
	return list.filter((d) => {
		const key = `${d.file}:${d.line}:${d.message}`;
		return seen.has(key) ? false : (seen.add(key), true);
	});
}
