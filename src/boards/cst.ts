/**
 * Parse and generate Gowin physical-constraint (`.cst`) files.
 *
 * We handle the two statements the nextpnr-himbaechel / Apicula flow needs:
 *
 *   IO_LOC  "signal" <loc> [exclusive];
 *   IO_PORT "signal" KEY = VALUE  KEY=VALUE ... ;
 *
 * per the Gowin syntax (SUG935 Appendix A): `<loc>` is a pin number ("4"), a
 * differential pair / alternative list ("33,34"), or a ball name ("H11");
 * attribute `=` may be surrounded by spaces; `//` starts a line comment.
 * Statements we do not model (`INS_LOC`, `GROUP`, `CLOCK_LOC`, …) are kept in
 * `unrecognized` so callers can warn.
 */

export interface CstConstraint {
	readonly signal: string;
	/** Value from `IO_LOC`, if the signal had one. */
	readonly loc?: string;
	/** The `exclusive` keyword was present on the `IO_LOC` line. */
	readonly exclusive?: boolean;
	/** Attributes from `IO_PORT`, e.g. `{ IO_TYPE: 'LVCMOS33', PULL_MODE: 'UP' }`. */
	readonly attributes: Readonly<Record<string, string>>;
}

export interface ParsedCst {
	readonly constraints: readonly CstConstraint[];
	/** Non-comment lines the parser did not understand. */
	readonly unrecognized: readonly string[];
}

const IO_LOC_RE = /^IO_LOC\s+"([^"]+)"\s+([^;]+);/i;
const IO_PORT_RE = /^IO_PORT\s+"([^"]+)"\s+([^;]+);/i;
const TRAILING_EXCLUSIVE_RE = /\s+exclusive\s*$/i;
const ATTRIBUTE_RE = /([A-Za-z_]\w*)\s*=\s*(\S+)/g;

function stripComment(line: string): string {
	const at = line.indexOf('//');
	return (at === -1 ? line : line.slice(0, at)).trim();
}

export function parseCst(text: string): ParsedCst {
	const locs = new Map<string, string>();
	const exclusives = new Set<string>();
	const attrs = new Map<string, Record<string, string>>();
	const order: string[] = [];
	const unrecognized: string[] = [];

	const see = (signal: string): void => {
		if (!order.includes(signal)) {
			order.push(signal);
		}
	};

	for (const rawLine of text.split(/\r?\n/)) {
		const line = stripComment(rawLine);
		if (line === '') {
			continue;
		}

		const locMatch = IO_LOC_RE.exec(line);
		if (locMatch) {
			const signal = locMatch[1];
			let value = locMatch[2].trim();
			if (TRAILING_EXCLUSIVE_RE.test(value)) {
				exclusives.add(signal);
				value = value.replace(TRAILING_EXCLUSIVE_RE, '').trim();
			}
			locs.set(signal, value.replace(/\s+/g, ''));
			see(signal);
			continue;
		}

		const portMatch = IO_PORT_RE.exec(line);
		if (portMatch) {
			const signal = portMatch[1];
			const parsed: Record<string, string> = {};
			for (const attr of portMatch[2].matchAll(ATTRIBUTE_RE)) {
				parsed[attr[1].toUpperCase()] = attr[2];
			}
			attrs.set(signal, { ...attrs.get(signal), ...parsed });
			see(signal);
			continue;
		}

		unrecognized.push(line);
	}

	const constraints = order.map((signal) => ({
		signal,
		loc: locs.get(signal),
		exclusive: exclusives.has(signal),
		attributes: attrs.get(signal) ?? {},
	}));
	return { constraints, unrecognized };
}

export interface SerializeCstOptions {
	/** Header comment lines (without the leading `//`). */
	readonly header?: readonly string[];
}

export function serializeCst(
	constraints: readonly CstConstraint[],
	options: SerializeCstOptions = {},
): string {
	const lines: string[] = [];
	for (const line of options.header ?? []) {
		lines.push(`// ${line}`);
	}
	if (lines.length > 0) {
		lines.push('');
	}

	for (const c of constraints) {
		if (c.loc !== undefined) {
			lines.push(`IO_LOC "${c.signal}" ${c.loc}${c.exclusive ? ' exclusive' : ''};`);
		}
		const attrs = Object.entries(c.attributes);
		if (attrs.length > 0) {
			const rendered = attrs.map(([k, v]) => `${k}=${v}`).join(' ');
			lines.push(`IO_PORT "${c.signal}" ${rendered};`);
		}
	}

	return lines.join('\n') + '\n';
}
