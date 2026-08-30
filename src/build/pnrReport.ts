/**
 * Parse the JSON report `nextpnr --report` writes and render a short
 * human-facing summary (resource use + achieved Fmax).
 *
 * The exact schema has shifted between nextpnr versions, so the parser is
 * deliberately lenient: it pulls what it recognises and returns `undefined`
 * only when the text is not JSON at all. A missing summary is never fatal —
 * the raw report file stays on disk.
 */

export interface ResourceUse {
	readonly name: string;
	readonly used: number;
	readonly available: number;
}

export interface FmaxEntry {
	readonly clock: string;
	readonly achievedMhz: number;
	readonly targetMhz?: number;
}

export interface PnrReport {
	readonly resources: readonly ResourceUse[];
	readonly fmax: readonly FmaxEntry[];
}

export function parsePnrReport(text: string): PnrReport | undefined {
	let root: unknown;
	try {
		root = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!isObject(root)) {
		return undefined;
	}

	const resources: ResourceUse[] = [];
	const utilisation = root.utilization ?? root.utilisation;
	if (isObject(utilisation)) {
		for (const [name, entry] of Object.entries(utilisation)) {
			if (!isObject(entry)) {
				continue;
			}
			const used = num(entry.used);
			const available = num(entry.available ?? entry.total);
			if (used !== undefined && available !== undefined) {
				resources.push({ name, used, available });
			}
		}
	}

	const fmax: FmaxEntry[] = [];
	if (isObject(root.fmax)) {
		for (const [clock, entry] of Object.entries(root.fmax)) {
			if (!isObject(entry)) {
				continue;
			}
			const achieved = num(entry.achieved ?? entry.achieved_mhz);
			if (achieved !== undefined) {
				fmax.push({ clock, achievedMhz: achieved, targetMhz: num(entry.constraint ?? entry.target) });
			}
		}
	}

	return { resources, fmax };
}

/** Lines for the output channel; empty when there is nothing worth showing. */
export function formatPnrReport(report: PnrReport): string[] {
	const lines: string[] = [];
	const used = report.resources.filter((r) => r.used > 0);
	if (used.length > 0) {
		lines.push('Resource utilisation:');
		const width = Math.max(...used.map((r) => r.name.length));
		for (const r of used) {
			const pct = r.available > 0 ? ` (${((r.used / r.available) * 100).toFixed(1)}%)` : '';
			lines.push(`  ${r.name.padEnd(width)}  ${r.used} / ${r.available}${pct}`);
		}
	}
	for (const f of report.fmax) {
		const target = f.targetMhz !== undefined ? ` (target ${f.targetMhz.toFixed(2)} MHz)` : '';
		lines.push(`Fmax ${f.clock}: ${f.achievedMhz.toFixed(2)} MHz${target}`);
	}
	return lines;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function num(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
