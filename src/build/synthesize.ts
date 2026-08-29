/**
 * The synthesis stage end to end: plan the yosys run, lay out `build/`, write
 * the script, run yosys, and confirm a netlist came out.
 *
 * Every side effect (mkdir, writeFile, spawn, streaming output) is injected
 * through {@link SynthesizeIo}, so the whole flow is unit-tested with no
 * disk, no VS Code and no real yosys. nodeProcess.ts / the command layer
 * supply the real implementations.
 */

import * as path from 'node:path';
import type { Board } from '../boards/schema';
import type { FpgaProject } from '../project/schema';
import { buildLayout } from './layout';
import { runStep, type ProcessRunner } from './runStep';
import { planYosys } from './yosys';

export interface SynthesizeRequest {
	readonly project: FpgaProject;
	readonly board: Board;
	/** Absolute path to the directory containing `fpga.yaml`. */
	readonly projectRoot: string;
	/** Absolute path to the `yosys` executable. */
	readonly yosysExe: string;
}

export interface SynthesizeIo {
	readonly run: ProcessRunner;
	readonly mkdirp: (dir: string) => Promise<void>;
	readonly writeFile: (file: string, text: string) => Promise<void>;
	readonly write: (text: string) => void;
	/** Optional: check the netlist actually exists after a clean exit. */
	readonly exists?: (file: string) => Promise<boolean>;
	/** Optional: delete a stale netlist before the run. */
	readonly remove?: (file: string) => Promise<void>;
	readonly signal?: AbortSignal;
}

export interface SynthesizeResult {
	readonly ok: boolean;
	readonly canceled: boolean;
	readonly netlistPath?: string;
	readonly logFile: string;
	readonly summary: string;
}

export async function synthesize(
	req: SynthesizeRequest,
	io: SynthesizeIo,
): Promise<SynthesizeResult> {
	const layout = buildLayout(req.projectRoot);
	const logFile = path.join(layout.logDir, 'synthesis.log');

	const planned = planYosys(req.project, req.board, req.projectRoot, layout);
	if (!planned.ok) {
		return { ok: false, canceled: false, logFile, summary: planned.errors.join(' ') };
	}
	const plan = planned.plan;

	await io.mkdirp(layout.netlistDir);
	await io.mkdirp(layout.logDir);
	await io.writeFile(plan.scriptPath, plan.scriptText);
	if (io.remove) {
		await io.remove(plan.netlistPath).catch(() => undefined);
	}

	io.write(`Synthesis — ${req.project.top} for ${req.board.name}\n`);
	io.write(`  script:  ${plan.scriptRelPath}\n`);
	io.write(`  netlist: ${plan.netlistRelPath}\n`);

	const outcome = await runStep(
		{
			name: 'Synthesis',
			tool: 'yosys',
			exe: req.yosysExe,
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

	if (io.exists && !(await io.exists(plan.netlistPath))) {
		return {
			ok: false,
			canceled: false,
			logFile,
			summary: `yosys exited cleanly but wrote no netlist at ${plan.netlistRelPath}.`,
		};
	}

	return {
		ok: true,
		canceled: false,
		netlistPath: plan.netlistPath,
		logFile,
		summary: `Synthesis complete — ${plan.netlistRelPath}`,
	};
}

function toUnix(p: string): string {
	return p.split(path.sep).join('/');
}
