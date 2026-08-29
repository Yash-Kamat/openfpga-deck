/**
 * Load every board definition shipped under `boards/` into a registry keyed
 * by board id. Filesystem access is injected so the logic is unit-testable.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseDocument } from 'yaml';
import { validateBoard, type Board } from './schema';

export interface BoardFsHost {
	/** Absolute paths of every `*.yaml` / `*.yml` file below `dir` (recursive). */
	listBoardFiles(dir: string): string[];
	readTextFile(absolutePath: string): string;
}

export const nodeBoardFsHost: BoardFsHost = {
	listBoardFiles(dir: string): string[] {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { recursive: true, withFileTypes: true });
		} catch {
			return [];
		}
		return entries
			.filter((e) => e.isFile() && /\.ya?ml$/i.test(e.name))
			.map((e) => path.join(e.parentPath, e.name));
	},
	readTextFile(absolutePath: string): string {
		return fs.readFileSync(absolutePath, 'utf8');
	},
};

export interface BoardLoadError {
	readonly file: string;
	readonly message: string;
}

export interface BoardRegistry {
	readonly boards: ReadonlyMap<string, Board>;
	readonly errors: readonly BoardLoadError[];
	get(id: string): Board | undefined;
	ids(): string[];
	list(): Board[];
}

export function loadBoardRegistry(
	boardsDir: string,
	host: BoardFsHost = nodeBoardFsHost,
): BoardRegistry {
	const boards = new Map<string, Board>();
	const errors: BoardLoadError[] = [];

	for (const file of host.listBoardFiles(boardsDir)) {
		let raw: unknown;
		try {
			const doc = parseDocument(host.readTextFile(file), { prettyErrors: true });
			if (doc.errors.length > 0) {
				errors.push({ file, message: doc.errors[0].message });
				continue;
			}
			raw = doc.toJS();
		} catch (err) {
			errors.push({ file, message: err instanceof Error ? err.message : String(err) });
			continue;
		}

		const result = validateBoard(raw);
		if (!result.ok) {
			errors.push({ file, message: result.errors.map((e) => e.message).join('; ') });
			continue;
		}
		if (boards.has(result.board.id)) {
			errors.push({ file, message: `Duplicate board id "${result.board.id}".` });
			continue;
		}
		boards.set(result.board.id, result.board);
	}

	return {
		boards,
		errors,
		get: (id) => boards.get(id),
		ids: () => [...boards.keys()].sort(),
		list: () => [...boards.values()].sort((a, b) => a.name.localeCompare(b.name)),
	};
}
