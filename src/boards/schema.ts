/**
 * Board definition files (`boards/**\/*.yaml`): types and pure structural
 * validation.
 *
 * A board file describes one physical board: the FPGA part and family strings
 * the toolchain needs, how to program it, and the wiring from named signals
 * to physical pins. The build pipeline reads `fpga` / `synth` / `programmer`;
 * `pins` and `clocks` feed project scaffolding and the IO planner.
 */

export type ProgrammerTarget = 'sram' | 'flash';

/**
 * IO attributes, expressible board-wide (`defaults`) or per pin. They map to
 * Gowin `IO_PORT` attributes: iostd -> IO_TYPE, pull -> PULL_MODE,
 * drive -> DRIVE, bankVccio -> BANK_VCCIO. `attrs` is a verbatim pass-through
 * for anything else (SINGLE_RESISTOR, SLEW_RATE, OPEN_DRAIN, HYSTERESIS, …).
 */
export interface PinAttributes {
	/** IO standard, e.g. "LVCMOS33". */
	readonly iostd?: string;
	/** Pull resistor: "up" | "down" | "none". */
	readonly pull?: string;
	/** Drive strength in mA. */
	readonly drive?: number;
	/** Bank supply voltage, e.g. "3.3". */
	readonly bankVccio?: string;
	/** Raw Gowin IO_PORT attributes, passed through unchanged. */
	readonly attrs?: Readonly<Record<string, string>>;
}

export interface BoardPin extends PinAttributes {
	/** Physical location: a pin number ("4"), a pair ("33,34"), or a ball ("H11"). */
	readonly loc: string;
}

export interface BoardClock {
	readonly signal: string;
	readonly mhz: number;
}

export interface Board {
	readonly id: string;
	readonly name: string;
	readonly vendor?: string;
	readonly fpga: {
		/** nextpnr-himbaechel `--device`. */
		readonly part: string;
		/** nextpnr-himbaechel `--vopt family` and `gowin_pack -d`. */
		readonly family: string;
		readonly package?: string;
	};
	readonly synth: {
		/** yosys `synth_gowin -family <family>`. */
		readonly family: string;
	};
	readonly programmer: {
		readonly tool: string;
		/** openFPGALoader `-b <board>`. */
		readonly board: string;
		readonly defaultTarget: ProgrammerTarget;
		/** SPI flash size in bytes, needed to dump the flash for a backup. */
		readonly flashSize?: number;
	};
	readonly clocks: readonly BoardClock[];
	/** IO attribute defaults applied to every pin unless the pin overrides them. */
	readonly defaults: PinAttributes;
	readonly pins: Readonly<Record<string, BoardPin>>;
}

export interface BoardIssue {
	readonly message: string;
}

export type BoardValidation =
	| { readonly ok: true; readonly board: Board }
	| { readonly ok: false; readonly errors: BoardIssue[] };

const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateBoard(raw: unknown): BoardValidation {
	const errors: BoardIssue[] = [];
	const fail = (message: string): void => {
		errors.push({ message });
	};

	if (!isObject(raw)) {
		return { ok: false, errors: [{ message: 'Board file must be a mapping at the top level.' }] };
	}

	const id = str(raw.id, 'id', fail);
	if (id !== undefined && !ID_RE.test(id)) {
		fail('"id" must be lower-case words separated by single hyphens (e.g. tang-nano-20k).');
	}
	const name = str(raw.name, 'name', fail);

	const fpgaRaw = isObject(raw.fpga) ? raw.fpga : undefined;
	if (!fpgaRaw) {
		fail('Missing "fpga" section.');
	}
	const part = fpgaRaw && str(fpgaRaw.part, 'fpga.part', fail);
	const fpgaFamily = fpgaRaw && str(fpgaRaw.family, 'fpga.family', fail);
	const pkg = fpgaRaw && optionalStr(fpgaRaw.package, 'fpga.package', fail);

	const synthRaw = isObject(raw.synth) ? raw.synth : undefined;
	if (!synthRaw) {
		fail('Missing "synth" section.');
	}
	const synthFamily = synthRaw && str(synthRaw.family, 'synth.family', fail);

	const progRaw = isObject(raw.programmer) ? raw.programmer : undefined;
	if (!progRaw) {
		fail('Missing "programmer" section.');
	}
	const progTool = progRaw && (optionalStr(progRaw.tool, 'programmer.tool', fail) ?? 'openFPGALoader');
	const progBoard = progRaw && str(progRaw.board, 'programmer.board', fail);
	let target: ProgrammerTarget = 'sram';
	if (progRaw && progRaw.defaultTarget !== undefined) {
		if (progRaw.defaultTarget === 'sram' || progRaw.defaultTarget === 'flash') {
			target = progRaw.defaultTarget;
		} else {
			fail('"programmer.defaultTarget" must be "sram" or "flash".');
		}
	}
	let flashSize: number | undefined;
	if (progRaw && progRaw.flashSize !== undefined) {
		const parsed =
			typeof progRaw.flashSize === 'number'
				? progRaw.flashSize
				: typeof progRaw.flashSize === 'string'
					? Number(progRaw.flashSize)
					: NaN;
		if (Number.isInteger(parsed) && parsed > 0) {
			flashSize = parsed;
		} else {
			fail('"programmer.flashSize" must be a positive integer number of bytes (e.g. 0x800000).');
		}
	}

	const clocks = validateClocks(raw.clocks, fail);
	const defaults = isObject(raw.defaults)
		? parsePinAttributes(raw.defaults, 'defaults', fail)
		: {};
	const pins = validatePins(raw.pins, fail);

	if (errors.length > 0) {
		return { ok: false, errors };
	}

	return {
		ok: true,
		board: {
			id: id as string,
			name: name as string,
			vendor: optionalStr(raw.vendor, 'vendor', fail),
			fpga: { part: part as string, family: fpgaFamily as string, package: pkg },
			synth: { family: synthFamily as string },
			programmer: {
				tool: progTool as string,
				board: progBoard as string,
				defaultTarget: target,
				flashSize,
			},
			clocks,
			defaults,
			pins,
		},
	};
}

/**
 * Resolved Gowin `IO_PORT` attributes for a board signal: the board defaults
 * merged with the pin's own attributes (pin wins). Empty if the signal has no
 * pin entry.
 */
export function pinAttributes(board: Board, signal: string): Record<string, string> {
	const pin = board.pins[signal];
	if (!pin) {
		return {};
	}
	const iostd = pin.iostd ?? board.defaults.iostd;
	const pull = pin.pull ?? board.defaults.pull;
	const drive = pin.drive ?? board.defaults.drive;
	const bankVccio = pin.bankVccio ?? board.defaults.bankVccio;

	const out: Record<string, string> = {};
	if (iostd) {
		out.IO_TYPE = iostd;
	}
	if (pull) {
		out.PULL_MODE = pull.toUpperCase();
	}
	if (drive !== undefined) {
		out.DRIVE = String(drive);
	}
	if (bankVccio) {
		out.BANK_VCCIO = bankVccio;
	}
	for (const [key, value] of Object.entries({ ...board.defaults.attrs, ...pin.attrs })) {
		out[key.toUpperCase()] = value;
	}
	return out;
}

function validateClocks(raw: unknown, fail: (m: string) => void): BoardClock[] {
	if (raw === undefined) {
		return [];
	}
	if (!Array.isArray(raw)) {
		fail('"clocks" must be a list.');
		return [];
	}
	const out: BoardClock[] = [];
	for (let i = 0; i < raw.length; i++) {
		const entry = raw[i];
		if (!isObject(entry) || typeof entry.signal !== 'string' || typeof entry.mhz !== 'number') {
			fail(`clocks[${i}] must have a string "signal" and a number "mhz".`);
			continue;
		}
		out.push({ signal: entry.signal, mhz: entry.mhz });
	}
	return out;
}

function validatePins(raw: unknown, fail: (m: string) => void): Record<string, BoardPin> {
	if (raw === undefined) {
		return {};
	}
	if (!isObject(raw)) {
		fail('"pins" must be a mapping of signal name to pin.');
		return {};
	}
	const out: Record<string, BoardPin> = {};
	for (const [signal, value] of Object.entries(raw)) {
		if (!isObject(value) || typeof value.loc !== 'string' || value.loc.trim() === '') {
			fail(`pins."${signal}" must have a non-empty string "loc".`);
			continue;
		}
		out[signal] = { loc: value.loc, ...parsePinAttributes(value, `pins."${signal}"`, fail) };
	}
	return out;
}

function parsePinAttributes(
	raw: Record<string, unknown>,
	where: string,
	fail: (m: string) => void,
): PinAttributes {
	if (raw.drive !== undefined && typeof raw.drive !== 'number') {
		fail(`${where}.drive must be a number.`);
	}
	let attrs: Record<string, string> | undefined;
	if (raw.attrs !== undefined) {
		if (!isObject(raw.attrs)) {
			fail(`${where}.attrs must be a mapping of attribute name to value.`);
		} else {
			attrs = {};
			for (const [key, value] of Object.entries(raw.attrs)) {
				attrs[key] = String(value);
			}
		}
	}
	return {
		iostd: typeof raw.iostd === 'string' ? raw.iostd : undefined,
		pull: typeof raw.pull === 'string' ? raw.pull : undefined,
		drive: typeof raw.drive === 'number' ? raw.drive : undefined,
		bankVccio: raw.bankVccio !== undefined ? String(raw.bankVccio) : undefined,
		attrs,
	};
}

function str(value: unknown, key: string, fail: (m: string) => void): string | undefined {
	if (value === undefined) {
		fail(`Missing "${key}".`);
		return undefined;
	}
	if (typeof value !== 'string' || value.trim() === '') {
		fail(`"${key}" must be a non-empty string.`);
		return undefined;
	}
	return value;
}

function optionalStr(value: unknown, key: string, fail: (m: string) => void): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== 'string' || value.trim() === '') {
		fail(`"${key}" must be a non-empty string when present.`);
		return undefined;
	}
	return value;
}
