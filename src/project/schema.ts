/**
 * The `fpga.yaml` project file: type definition and pure structural
 * validation.
 *
 * "Structural" means everything that can be checked from the parsed YAML
 * value alone — required keys, types, non-empty lists. Anything that needs
 * to touch the filesystem (do the listed source files actually exist?)
 * lives in loader.ts, not here, so this module stays trivially unit-testable
 * with plain objects.
 */

/** A validated OpenFPGA Deck project. */
export interface FpgaProject {
	/** Design name. Used as the stem for generated artefacts (e.g. `blink.fs`). */
	readonly name: string;
	/** Board id, resolved against the board registry in a later phase. */
	readonly board: string;
	/** Top-level HDL module name. */
	readonly top: string;
	/** HDL source files, as paths relative to the project root. */
	readonly sources: readonly string[];
	/** Constraint files (`.cst` for Gowin), as paths relative to the project root. */
	readonly constraints: readonly string[];
}

/** A single problem found while validating a project file. */
export interface ConfigIssue {
	readonly message: string;
	/** 1-based line in `fpga.yaml`, when the source of the issue can be located. */
	readonly line?: number;
	/** 1-based column in `fpga.yaml`, when known. */
	readonly column?: number;
}

export type ConfigValidation =
	| { readonly ok: true; readonly project: FpgaProject; readonly warnings: ConfigIssue[] }
	| { readonly ok: false; readonly errors: ConfigIssue[]; readonly warnings: ConfigIssue[] };

/** Top-level keys the current schema understands. Anything else → warning. */
const KNOWN_KEYS: ReadonlySet<string> = new Set([
	'name',
	'board',
	'top',
	'sources',
	'constraints',
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate an already-parsed `fpga.yaml` value.
 *
 * @param raw The value produced by parsing the YAML document. `undefined` or
 *   `null` here means the file was empty.
 */
export function validateConfig(raw: unknown): ConfigValidation {
	const errors: ConfigIssue[] = [];
	const warnings: ConfigIssue[] = [];

	if (raw === undefined || raw === null) {
		return { ok: false, errors: [{ message: 'fpga.yaml is empty.' }], warnings };
	}
	if (!isPlainObject(raw)) {
		return {
			ok: false,
			errors: [{ message: 'fpga.yaml must contain a mapping of keys at the top level.' }],
			warnings,
		};
	}

	for (const key of Object.keys(raw)) {
		if (!KNOWN_KEYS.has(key)) {
			warnings.push({
				message: `Unknown key "${key}" — ignored by this version of OpenFPGA Deck.`,
			});
		}
	}

	const name = requireString(raw, 'name', errors);
	const board = requireString(raw, 'board', errors);
	const top = requireString(raw, 'top', errors);
	const sources = requireStringList(raw, 'sources', errors);
	const constraints = requireStringList(raw, 'constraints', errors);

	if (errors.length > 0) {
		return { ok: false, errors, warnings };
	}

	return {
		ok: true,
		project: {
			name: name as string,
			board: board as string,
			top: top as string,
			sources: sources as string[],
			constraints: constraints as string[],
		},
		warnings,
	};
}

function requireString(
	obj: Record<string, unknown>,
	key: string,
	errors: ConfigIssue[],
): string | undefined {
	const value = obj[key];
	if (value === undefined) {
		errors.push({ message: `Missing required key "${key}".` });
		return undefined;
	}
	if (typeof value !== 'string' || value.trim() === '') {
		errors.push({ message: `Key "${key}" must be a non-empty string.` });
		return undefined;
	}
	return value;
}

function requireStringList(
	obj: Record<string, unknown>,
	key: string,
	errors: ConfigIssue[],
): string[] | undefined {
	const value = obj[key];
	if (value === undefined) {
		errors.push({ message: `Missing required key "${key}".` });
		return undefined;
	}
	if (!Array.isArray(value)) {
		errors.push({ message: `Key "${key}" must be a list.` });
		return undefined;
	}
	if (value.length === 0) {
		errors.push({ message: `Key "${key}" must list at least one entry.` });
		return undefined;
	}
	const out: string[] = [];
	for (let i = 0; i < value.length; i++) {
		const entry = value[i];
		if (typeof entry !== 'string' || entry.trim() === '') {
			errors.push({ message: `Entry ${i + 1} of "${key}" must be a non-empty string.` });
			continue;
		}
		out.push(entry);
	}
	return errors.length > 0 ? undefined : out;
}
