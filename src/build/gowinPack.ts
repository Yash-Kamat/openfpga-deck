/**
 * Turn a validated project + board into a `gowin_pack` run: read the
 * placed-and-routed netlist (`build/pnr/<top>.pnr.json`) and write the Gowin
 * bitstream (`build/bitstream/<name>.fs`) for openFPGALoader (Phase 8).
 *
 * Pure — no filesystem, no VS Code.
 */

import * as path from 'node:path';
import type { Board } from '../boards/schema';
import type { FpgaProject } from '../project/schema';
import { buildLayout, type BuildLayout } from './layout';

export interface GowinPackPlan {
	/** Absolute path of the P&R netlist this run reads. */
	readonly pnrJsonPath: string;
	readonly pnrJsonRelPath: string;
	/** Absolute path of the `.fs` bitstream this run writes. */
	readonly bitstreamPath: string;
	readonly bitstreamRelPath: string;
	readonly args: readonly string[];
}

export type GowinPackPlanResult =
	| { readonly ok: true; readonly plan: GowinPackPlan }
	| { readonly ok: false; readonly errors: readonly string[] };

export function planGowinPack(
	project: FpgaProject,
	board: Board,
	projectRoot: string,
	layout: BuildLayout = buildLayout(projectRoot),
): GowinPackPlanResult {
	if (!board.fpga.family) {
		return {
			ok: false,
			errors: [`Board "${board.id}" has no fpga.family for gowin_pack's "-d".`],
		};
	}

	const pnrJsonPath = path.join(layout.pnrDir, `${project.top}.pnr.json`);
	const bitstreamPath = path.join(layout.bitstreamDir, `${project.name}.fs`);
	const pnrJsonRelPath = toUnix(path.relative(projectRoot, pnrJsonPath));
	const bitstreamRelPath = toUnix(path.relative(projectRoot, bitstreamPath));

	return {
		ok: true,
		plan: {
			pnrJsonPath,
			pnrJsonRelPath,
			bitstreamPath,
			bitstreamRelPath,
			args: ['-d', board.fpga.family, '-o', bitstreamRelPath, pnrJsonRelPath],
		},
	};
}

function toUnix(p: string): string {
	return p.split(path.sep).join('/');
}
