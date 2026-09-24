/**
 * Port → pin mapping: which board signal each top-module port bit connects
 * to, and the `.cst` constraints that follow from it.
 *
 * The `.cst` stays the source of truth: a mapping is generated into one with
 * {@link planPinConstraints} and recovered from one with {@link mappingFromCst}.
 * Pure — no filesystem, no VS Code.
 */

import type { CstConstraint } from '../boards/cst';
import { pinAttributes, type Board, type PortDirection } from '../boards/schema';
import { portBitNames, type TopPort } from './ports';

/** Port bit (`clk`, `led[0]`) → board signal (a key of `board.pins`). */
export type PinMapping = Readonly<Record<string, string>>;

export interface MappingIssue {
	readonly severity: 'error' | 'warning';
	readonly message: string;
}

export interface PinConstraintPlan {
	readonly constraints: CstConstraint[];
	readonly issues: MappingIssue[];
}

export function planPinConstraints(
	ports: readonly TopPort[],
	mapping: PinMapping,
	board: Board,
): PinConstraintPlan {
	const constraints: CstConstraint[] = [];
	const issues: MappingIssue[] = [];
	const error = (message: string): void => {
		issues.push({ severity: 'error', message });
	};
	const warn = (message: string): void => {
		issues.push({ severity: 'warning', message });
	};
	const locOwner = new Map<string, string>();
	const bits = new Set<string>();

	for (const port of ports) {
		for (const bit of portBitNames(port)) {
			bits.add(bit);
			const signal = mapping[bit];
			if (signal === undefined) {
				warn(`${bit} is not mapped to a pin; nextpnr will place it on any free pin.`);
				continue;
			}
			const pin = board.pins[signal];
			if (!pin) {
				error(`${bit} is mapped to "${signal}", which ${board.name} does not have.`);
				continue;
			}
			// Shared pins (HDMI/LCD, …) have different signal names on the same loc.
			for (const loc of pin.loc.split(',').map((l) => l.trim())) {
				const owner = locOwner.get(loc);
				if (owner) {
					error(`${bit} and ${owner} both use pin ${loc}.`);
				}
				locOwner.set(loc, bit);
			}
			if (conflicts(port.dir, pin.dir)) {
				warn(`${bit} is an ${port.dir}, but ${signal} is normally an ${pin.dir}.`);
			}
			constraints.push({ signal: bit, loc: pin.loc, attributes: pinAttributes(board, signal) });
		}
	}

	for (const bit of Object.keys(mapping)) {
		if (!bits.has(bit)) {
			warn(`${bit} is mapped but is not a port of the top module.`);
		}
	}
	return { constraints, issues };
}

function conflicts(port: PortDirection, pin: PortDirection | undefined): boolean {
	return pin !== undefined && port !== 'inout' && pin !== 'inout' && port !== pin;
}

export interface CstMapping {
	readonly mapping: PinMapping;
	/** `.cst` signals whose loc matches no board pin. */
	readonly unmatched: string[];
}

/**
 * Recover the mapping from an existing `.cst`. Where several board signals
 * share a loc, the one whose IO_TYPE matches the `.cst` wins.
 */
export function mappingFromCst(constraints: readonly CstConstraint[], board: Board): CstMapping {
	const mapping: Record<string, string> = {};
	const unmatched: string[] = [];
	for (const c of constraints) {
		if (c.loc === undefined) {
			continue;
		}
		const candidates = Object.keys(board.pins).filter((s) => board.pins[s].loc === c.loc);
		const ioType = c.attributes.IO_TYPE;
		const signal =
			candidates.find((s) => ioType !== undefined && pinAttributes(board, s).IO_TYPE === ioType) ??
			candidates[0];
		if (signal === undefined) {
			unmatched.push(c.signal);
		} else {
			mapping[c.signal] = signal;
		}
	}
	return { mapping, unmatched };
}

const BUS_BIT_RE = /^(.+)\[(\d+)\]$/;

/**
 * Top-module ports for a set of chosen board signals, named after them:
 * `led[0]` … `led[5]` become one `led` bus. A bus with gaps (only `led[1]`
 * and `led[3]`) becomes scalar ports `led_1`, `led_3` instead, so no port
 * bit is left without a pin. `dirs` overrides the board's direction per
 * port; without either, a port is an input (the FPGA then drives nothing).
 */
export function portsFromBoardSignals(
	board: Board,
	signals: readonly string[],
	dirs: Readonly<Record<string, PortDirection>> = {},
): { ports: TopPort[]; mapping: PinMapping } {
	const buses = new Map<string, Map<number, string>>();
	const order: string[] = [];
	for (const signal of signals) {
		const m = BUS_BIT_RE.exec(signal);
		const base = m ? m[1] : signal;
		if (!buses.has(base)) {
			buses.set(base, new Map());
			order.push(base);
		}
		buses.get(base)?.set(m ? Number(m[2]) : -1, signal);
	}

	const ports: TopPort[] = [];
	const mapping: Record<string, string> = {};
	const add = (name: string, signal: string, width: number, bit: (i: number) => string): void => {
		ports.push({ name, dir: dirs[name] ?? board.pins[signal]?.dir ?? 'input', width, offset: 0 });
		for (let i = 0; i < width; i++) {
			mapping[width === 1 ? name : `${name}[${i}]`] = bit(i);
		}
	};

	for (const base of order) {
		const bits = buses.get(base) ?? new Map<number, string>();
		const scalar = bits.get(-1);
		if (scalar !== undefined) {
			add(base, scalar, 1, () => scalar);
		}
		const indices = [...bits.keys()].filter((i) => i >= 0).sort((a, b) => a - b);
		const contiguous = indices.every((index, i) => index === i);
		if (indices.length > 0 && contiguous && scalar === undefined) {
			add(base, bits.get(0) ?? '', indices.length, (i) => bits.get(i) ?? '');
		} else {
			for (const i of indices) {
				const signal = bits.get(i) ?? '';
				add(`${base}_${i}`, signal, 1, () => signal);
			}
		}
	}
	return { ports, mapping };
}
