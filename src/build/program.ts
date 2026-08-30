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
import {
	detectArgs,
	dumpFlashArgs,
	parseDetect,
	planProgram,
	programFileArgs,
	type ProgramTarget,
} from './openFpgaLoader';
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

export interface ProgramFileRequest {
	readonly board: Board;
	readonly projectRoot: string;
	readonly openFpgaLoaderExe: string;
	/** Absolute path to a `.fs` bitstream or `.bin` flash image (may be outside the project). */
	readonly filePath: string;
	readonly target: ProgramTarget;
}

/** Write a user-chosen file to the board (a prebuilt bitstream, or a flash backup being restored). */
export async function programFile(
	req: ProgramFileRequest,
	io: PipelineIo,
): Promise<ProgramResult> {
	const layout = buildLayout(req.projectRoot);
	const logFile = path.join(layout.logDir, 'program.log');
	const name = req.filePath.split(/[\\/]/).pop() ?? req.filePath;

	if (io.exists && !(await io.exists(req.filePath))) {
		return { ok: false, canceled: false, logFile, summary: `File not found: ${req.filePath}` };
	}
	await io.mkdirp(layout.logDir);

	const where = req.target === 'flash' ? 'flash' : 'SRAM';
	let captured = '';
	const outcome = await runStep(
		{
			name: `Write ${name} (${where})`,
			tool: 'openFPGALoader',
			exe: req.openFpgaLoaderExe,
			args: programFileArgs(req.board, req.filePath, req.target),
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
			summary: outcome.canceled ? outcome.summary : hintFor(`Writing ${name} failed`, captured),
		};
	}

	return {
		ok: true,
		canceled: false,
		logFile,
		summary:
			req.target === 'flash'
				? `Wrote ${name} to ${req.board.name} flash — power-cycle to run.`
				: `Loaded ${name} into ${req.board.name} SRAM.`,
	};
}

export interface BackupRequest {
	readonly board: Board;
	readonly projectRoot: string;
	readonly openFpgaLoaderExe: string;
	/** Timestamp stem for the backup file, e.g. "2026-08-30T02-41-05". */
	readonly stamp: string;
}

export interface BackupResult {
	readonly ok: boolean;
	readonly canceled: boolean;
	readonly logFile: string;
	readonly summary: string;
	readonly backupPath?: string;
}

/** Dump the board's SPI flash to `build/backup/flash-<stamp>.bin`. */
export async function backupFlash(req: BackupRequest, io: PipelineIo): Promise<BackupResult> {
	const layout = buildLayout(req.projectRoot);
	const logFile = path.join(layout.logDir, 'backup.log');

	const size = req.board.programmer.flashSize;
	if (!size) {
		return {
			ok: false,
			canceled: false,
			logFile,
			summary: `Board "${req.board.id}" has no programmer.flashSize, so its flash cannot be backed up.`,
		};
	}

	const backupPath = path.join(layout.backupDir, `flash-${req.stamp}.bin`);
	const backupRel = toUnix(path.relative(req.projectRoot, backupPath));
	await io.mkdirp(layout.backupDir);
	await io.mkdirp(layout.logDir);

	let captured = '';
	const outcome = await runStep(
		{
			name: 'Back up flash',
			tool: 'openFPGALoader',
			exe: req.openFpgaLoaderExe,
			args: dumpFlashArgs(req.board, backupRel, size),
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
			summary: outcome.canceled ? outcome.summary : hintFor('Flash backup failed', captured),
		};
	}
	if (io.exists && !(await io.exists(backupPath))) {
		return { ok: false, canceled: false, logFile, summary: `Flash backup wrote no file at ${backupRel}.` };
	}

	return { ok: true, canceled: false, logFile, backupPath, summary: `Flash backed up to ${backupRel}` };
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
