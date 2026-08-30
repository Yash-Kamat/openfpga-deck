/**
 * The programming stage: load the packed bitstream onto the board with
 * openFPGALoader, and a `--detect` preflight.
 *
 * Every side effect is injected through {@link PipelineIo}.
 */

import * as path from 'node:path';
import type { Board } from '../boards/schema';
import type { FpgaProject } from '../project/schema';
import { buildLayout } from './layout';
import { detectArgs, parseDetect, planProgram, type ProgramTarget } from './openFpgaLoader';
import { runStep } from './runStep';
import type { PipelineIo } from './synthesize';

export interface ProgramRequest {
	readonly project: FpgaProject;
	readonly board: Board;
	readonly projectRoot: string;
	/** Absolute path to the `openFPGALoader` executable. */
	readonly openFpgaLoaderExe: string;
	readonly target: ProgramTarget;
}

export interface ProgramResult {
	readonly ok: boolean;
	readonly canceled: boolean;
	readonly logFile: string;
	readonly summary: string;
}

export async function program(req: ProgramRequest, io: PipelineIo): Promise<ProgramResult> {
	const layout = buildLayout(req.projectRoot);
	const logFile = path.join(layout.logDir, 'program.log');

	const planned = planProgram(req.project, req.board, req.projectRoot, req.target, layout);
	if (!planned.ok) {
		return { ok: false, canceled: false, logFile, summary: planned.errors.join(' ') };
	}
	const plan = planned.plan;

	if (io.exists && !(await io.exists(plan.bitstreamPath))) {
		return {
			ok: false,
			canceled: false,
			logFile,
			summary: `No bitstream at ${plan.bitstreamRelPath} — run Build first.`,
		};
	}

	await io.mkdirp(layout.logDir);

	const where = plan.target === 'flash' ? 'flash' : 'SRAM';
	let captured = '';
	const outcome = await runStep(
		{
			name: `Program (${where})`,
			tool: 'openFPGALoader',
			exe: req.openFpgaLoaderExe,
			args: plan.args,
			cwd: req.projectRoot,
			logFile,
			logLabel: toUnix(path.relative(req.projectRoot, logFile)),
			signal: io.signal,
		},
		{
			run: io.run,
			write: (text) => {
				captured += text;
				io.write(text);
			},
			writeFile: io.writeFile,
		},
	);

	if (!outcome.ok) {
		return {
			ok: false,
			canceled: outcome.canceled,
			logFile,
			summary: outcome.canceled ? outcome.summary : hintFor(outcome.summary, captured),
		};
	}

	return {
		ok: true,
		canceled: false,
		logFile,
		summary:
			plan.target === 'flash'
				? `Programmed ${req.board.name} flash — power-cycle to run.`
				: `Programmed ${req.board.name} SRAM — running now (lost on power-off).`,
	};
}

export interface DetectResult {
	readonly ok: boolean;
	readonly canceled: boolean;
	readonly logFile: string;
	readonly summary: string;
}

export async function detectBoard(
	req: Omit<ProgramRequest, 'target'>,
	io: PipelineIo,
): Promise<DetectResult> {
	const layout = buildLayout(req.projectRoot);
	const logFile = path.join(layout.logDir, 'detect.log');
	await io.mkdirp(layout.logDir);

	let captured = '';
	const outcome = await runStep(
		{
			name: 'Detect board',
			tool: 'openFPGALoader',
			exe: req.openFpgaLoaderExe,
			args: detectArgs(req.board),
			cwd: req.projectRoot,
			logFile,
			logLabel: toUnix(path.relative(req.projectRoot, logFile)),
			signal: io.signal,
		},
		{
			run: io.run,
			write: (text) => {
				captured += text;
				io.write(text);
			},
			writeFile: io.writeFile,
		},
	);

	if (!outcome.ok) {
		return {
			ok: false,
			canceled: outcome.canceled,
			logFile,
			summary: outcome.canceled
				? outcome.summary
				: hintFor('No board detected — check the USB cable and that the board is powered.', captured),
		};
	}

	const identity = parseDetect(captured);
	return {
		ok: true,
		canceled: false,
		logFile,
		summary: identity ? `Board detected: ${identity}` : 'Board detected.',
	};
}

/** openFPGALoader's most common failure on Linux is a permissions problem. */
function hintFor(summary: string, output: string): string {
	if (/permission denied|unable to open|no such device|libusb|access denied/i.test(output)) {
		return `${summary} — this looks like a USB permissions problem: install openFPGALoader's udev rules and make sure you are in the "plugdev" group (see the openFPGALoader docs).`;
	}
	return summary;
}

function toUnix(p: string): string {
	return p.split(path.sep).join('/');
}
