/**
 * Turn a validated project + board into a nextpnr-himbaechel place-and-route
 * run. Consumes the synthesis netlist (`build/yosys/<top>.json`) and the
 * project's Gowin `.cst` constraints; produces a placed-and-routed netlist at
 * `build/pnr/<top>.pnr.json` for gowin_pack (Phase 7).
 *
 * Pure — no filesystem, no VS Code.
 */

import * as path from 'node:path';
import type { Board } from '../boards/schema';
import type { FpgaProject } from '../project/schema';
import { buildLayout, type BuildLayout } from './layout';

const CST_RE = /\.cst$/i;

export interface NextpnrPlan {
	/** Absolute path of the synthesis netlist this run reads. */
	readonly netlistInPath: string;
	readonly netlistInRelPath: string;
	/** Absolute path of the placed-and-routed netlist this run writes. */
	readonly pnrJsonPath: string;
	readonly pnrJsonRelPath: string;
	readonly args: readonly string[];
}

export type NextpnrPlanResult =
	| { readonly ok: true; readonly plan: NextpnrPlan }
	| { readonly ok: false; readonly errors: readonly string[] };

export function planNextpnr(
	project: FpgaProject,
	board: Board,
	projectRoot: string,
	layout: BuildLayout = buildLayout(projectRoot),
): NextpnrPlanResult {
	const errors: string[] = [];

	const cstFiles = project.constraints.filter((c) => CST_RE.test(c));
	if (cstFiles.length === 0) {
		errors.push(
			'Place & route needs a Gowin .cst constraint file; fpga.yaml lists none.',
		);
	}
	if (!board.fpga.family) {
		errors.push(`Board "${board.id}" has no fpga.family for nextpnr's "--vopt family=".`);
	}
	if (errors.length > 0) {
		return { ok: false, errors };
	}

	const netlistInPath = path.join(layout.netlistDir, `${project.top}.json`);
	const pnrJsonPath = path.join(layout.pnrDir, `${project.top}.pnr.json`);
	const netlistInRelPath = toUnix(path.relative(projectRoot, netlistInPath));
	const pnrJsonRelPath = toUnix(path.relative(projectRoot, pnrJsonPath));

	const args = ['--device', board.fpga.part, '--vopt', `family=${board.fpga.family}`];
	for (const cst of cstFiles) {
		args.push('--vopt', `cst=${toUnix(cst)}`);
	}
	args.push('--json', netlistInRelPath, '--write', pnrJsonRelPath);

	return {
		ok: true,
		plan: { netlistInPath, netlistInRelPath, pnrJsonPath, pnrJsonRelPath, args },
	};
}

function toUnix(p: string): string {
	return p.split(path.sep).join('/');
}
