/**
 * The place-and-route stage end to end: plan the nextpnr-himbaechel run,
 * confirm the synthesis netlist is present, run nextpnr, and confirm a
 * placed-and-routed netlist came out.
 *
 * Every side effect is injected through {@link PipelineIo}, so the whole flow
 * is unit-tested with no disk, no VS Code and no real nextpnr.
 */

import * as path from 'node:path';
import type { Board } from '../boards/schema';
import type { FpgaProject } from '../project/schema';
import { buildLayout } from './layout';
import { planNextpnr } from './nextpnr';
import { formatPnrReport, parsePnrReport } from './pnrReport';
import { runStep } from './runStep';
import type { PipelineIo } from './synthesize';

export interface PlaceAndRouteRequest {
	readonly project: FpgaProject;
	readonly board: Board;
	readonly projectRoot: string;
	/** Absolute path to the `nextpnr-himbaechel` executable. */
	readonly nextpnrExe: string;
}

export interface PlaceAndRouteResult {
	readonly ok: boolean;
	readonly canceled: boolean;
	readonly pnrJsonPath?: string;
	readonly logFile: string;
	readonly summary: string;
}

export async function placeAndRoute(
	req: PlaceAndRouteRequest,
	io: PipelineIo,
): Promise<PlaceAndRouteResult> {
	const layout = buildLayout(req.projectRoot);
	const logFile = path.join(layout.logDir, 'pnr.log');

	const planned = planNextpnr(req.project, req.board, req.projectRoot, layout);
	if (!planned.ok) {
		return { ok: false, canceled: false, logFile, summary: planned.errors.join(' ') };
	}
	const plan = planned.plan;

	if (io.exists && !(await io.exists(plan.netlistInPath))) {
		return {
			ok: false,
			canceled: false,
			logFile,
			summary: `No synthesis netlist at ${plan.netlistInRelPath} — run Synthesize first.`,
		};
	}

	await io.mkdirp(layout.pnrDir);
	await io.mkdirp(layout.logDir);
	await io.mkdirp(layout.reportDir);
	if (io.remove) {
		await io.remove(plan.pnrJsonPath).catch(() => undefined);
	}

	const outcome = await runStep(
		{
			name: 'Place & route',
			tool: 'nextpnr-himbaechel',
			exe: req.nextpnrExe,
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

	if (io.exists && !(await io.exists(plan.pnrJsonPath))) {
		return {
			ok: false,
			canceled: false,
			logFile,
			summary: `nextpnr exited cleanly but wrote no netlist at ${plan.pnrJsonRelPath}.`,
		};
	}

	if (io.readFile) {
		const summary = await io
			.readFile(plan.reportPath)
			.then(parsePnrReport)
			.catch(() => undefined);
		if (summary) {
			io.write('\n');
			for (const line of formatPnrReport(summary)) {
				io.write(`${line}\n`);
			}
		}
	}

	return {
		ok: true,
		canceled: false,
		pnrJsonPath: plan.pnrJsonPath,
		logFile,
		summary: `Place & route complete — ${plan.pnrJsonRelPath}`,
	};
}

function toUnix(p: string): string {
	return p.split(path.sep).join('/');
}
