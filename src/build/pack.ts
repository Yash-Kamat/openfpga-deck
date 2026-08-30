/**
 * The bitstream-packing stage end to end: plan the `gowin_pack` run, confirm
 * the P&R netlist is present, run gowin_pack, and confirm a `.fs` bitstream
 * came out.
 *
 * Every side effect is injected through {@link PipelineIo}.
 */

import * as path from 'node:path';
import type { Board } from '../boards/schema';
import type { FpgaProject } from '../project/schema';
import { planGowinPack } from './gowinPack';
import { buildLayout } from './layout';
import { runStep } from './runStep';
import type { PipelineIo } from './synthesize';

export interface PackRequest {
	readonly project: FpgaProject;
	readonly board: Board;
	readonly projectRoot: string;
	/** Absolute path to the `gowin_pack` executable. */
	readonly gowinPackExe: string;
}

export interface PackResult {
	readonly ok: boolean;
	readonly canceled: boolean;
	readonly bitstreamPath?: string;
	readonly logFile: string;
	readonly summary: string;
}

export async function packBitstream(req: PackRequest, io: PipelineIo): Promise<PackResult> {
	const layout = buildLayout(req.projectRoot);
	const logFile = path.join(layout.logDir, 'pack.log');

	const planned = planGowinPack(req.project, req.board, req.projectRoot, layout);
	if (!planned.ok) {
		return { ok: false, canceled: false, logFile, summary: planned.errors.join(' ') };
	}
	const plan = planned.plan;

	if (io.exists && !(await io.exists(plan.pnrJsonPath))) {
		return {
			ok: false,
			canceled: false,
			logFile,
			summary: `No P&R netlist at ${plan.pnrJsonRelPath} — run Place and Route first.`,
		};
	}

	await io.mkdirp(layout.bitstreamDir);
	await io.mkdirp(layout.logDir);
	if (io.remove) {
		await io.remove(plan.bitstreamPath).catch(() => undefined);
	}

	const outcome = await runStep(
		{
			name: 'Pack bitstream',
			tool: 'gowin_pack',
			exe: req.gowinPackExe,
			args: plan.args,
			cwd: req.projectRoot,
			logFile,
			logLabel: toUnix(path.relative(req.projectRoot, logFile)),
			signal: io.signal,
		},
		{ run: io.run, write: io.write, writeFile: io.writeFile },
	);

	if (!outcome.ok) {
		return { ok: false, canceled: outcome.canceled, logFile, summary: outcome.summary };
	}

	if (io.exists && !(await io.exists(plan.bitstreamPath))) {
		return {
			ok: false,
			canceled: false,
			logFile,
			summary: `gowin_pack exited cleanly but wrote no bitstream at ${plan.bitstreamRelPath}.`,
		};
	}

	return {
		ok: true,
		canceled: false,
		bitstreamPath: plan.bitstreamPath,
		logFile,
		summary: `Bitstream ready — ${plan.bitstreamRelPath}`,
	};
}

function toUnix(p: string): string {
	return p.split(path.sep).join('/');
}
