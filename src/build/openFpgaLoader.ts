/**
 * Turn a validated project + board into an openFPGALoader run: load the
 * packed bitstream (`build/bitstream/<name>.fs`) onto the board, either into
 * volatile SRAM or the persistent SPI flash.
 *
 * Pure — no filesystem, no VS Code.
 */

import * as path from 'node:path';
import type { Board } from '../boards/schema';
import type { FpgaProject } from '../project/schema';
import { buildLayout, type BuildLayout } from './layout';

export type ProgramTarget = 'sram' | 'flash';

export interface ProgramPlan {
	readonly target: ProgramTarget;
	/** Absolute path of the bitstream this run loads. */
	readonly bitstreamPath: string;
	readonly bitstreamRelPath: string;
	readonly args: readonly string[];
}

export type ProgramPlanResult =
	| { readonly ok: true; readonly plan: ProgramPlan }
	| { readonly ok: false; readonly errors: readonly string[] };

export function planProgram(
	project: FpgaProject,
	board: Board,
	projectRoot: string,
	target: ProgramTarget,
	layout: BuildLayout = buildLayout(projectRoot),
): ProgramPlanResult {
	if (board.programmer.tool !== 'openFPGALoader') {
		return {
			ok: false,
			errors: [`Board "${board.id}" uses programmer "${board.programmer.tool}", which is not supported yet.`],
		};
	}
	if (!board.programmer.board) {
		return { ok: false, errors: [`Board "${board.id}" has no programmer.board for "openFPGALoader -b".`] };
	}

	const bitstreamPath = path.join(layout.bitstreamDir, `${project.name}.fs`);
	const bitstreamRelPath = toUnix(path.relative(projectRoot, bitstreamPath));

	const args = ['-b', board.programmer.board];
	if (target === 'flash') {
		args.push('-f');
	}
	args.push(bitstreamRelPath);

	return { ok: true, plan: { target, bitstreamPath, bitstreamRelPath, args } };
}

/** Arguments for the `--detect` preflight (no bitstream needed). */
export function detectArgs(board: Board): readonly string[] {
	return ['-b', board.programmer.board, '--detect'];
}

/**
 * Arguments to write an arbitrary file the user pointed at — a `.fs`
 * bitstream or a `.bin` flash image (e.g. a backup being restored). The path
 * is passed through as given (it may be outside the project).
 */
export function programFileArgs(
	board: Board,
	filePath: string,
	target: ProgramTarget,
): readonly string[] {
	const args = ['-b', board.programmer.board];
	if (target === 'flash') {
		args.push('-f');
	}
	args.push(filePath);
	return args;
}

/**
 * Arguments to dump the whole SPI flash to `destRelPath` (relative to the
 * project root). `sizeBytes` comes from `board.programmer.flashSize`.
 */
export function dumpFlashArgs(
	board: Board,
	destRelPath: string,
	sizeBytes: number,
): readonly string[] {
	return [
		'-b',
		board.programmer.board,
		'--dump-flash',
		'--file-size',
		`0x${sizeBytes.toString(16)}`,
		destRelPath,
	];
}

/** Pull the chip identity out of `openFPGALoader --detect` output, if present. */
export function parseDetect(text: string): string | undefined {
	const idcode = /idcode\s+(0x[0-9a-f]+)/i.exec(text)?.[1];
	const model = /\bmodel\s+(\S.*\S)/i.exec(text)?.[1];
	if (model && idcode) {
		return `${model} (idcode ${idcode})`;
	}
	return model ?? (idcode ? `idcode ${idcode}` : undefined);
}

function toUnix(p: string): string {
	return p.split(path.sep).join('/');
}
