/**
 * Locate, read, parse and validate a project's `fpga.yaml`.
 *
 * This is the filesystem-aware layer that sits on top of the pure structural
 * checks in schema.ts. It also enforces one security rule up front: every
 * path listed in the project file must be relative and must stay inside the
 * project root. We never follow an absolute path or a `../` escape out of the
 * workspace, even just to check whether a file exists.
 *
 * All filesystem access goes through an injected {@link ProjectFsHost} so the
 * logic can be unit-tested with in-memory fakes and no disk.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseDocument } from 'yaml';
import { validateConfig, type ConfigIssue, type FpgaProject } from './schema';

export const PROJECT_FILE_NAME = 'fpga.yaml';

export interface LoadedProject {
	readonly project: FpgaProject;
	/** Absolute path to the directory containing `fpga.yaml`. */
	readonly root: string;
	/** Absolute path to the `fpga.yaml` file itself. */
	readonly configPath: string;
	readonly warnings: ConfigIssue[];
}

export type LoadProjectResult =
	| { readonly ok: true; readonly value: LoadedProject }
	| {
			readonly ok: false;
			/** Set once we know the file exists; `undefined` if it was never found. */
			readonly configPath: string | undefined;
			readonly errors: ConfigIssue[];
			readonly warnings: ConfigIssue[];
	  };

/** The slice of the filesystem the loader needs. */
export interface ProjectFsHost {
	fileExists(absolutePath: string): boolean;
	readTextFile(absolutePath: string): string;
}

const nodeFsHost: ProjectFsHost = {
	fileExists(absolutePath: string): boolean {
		try {
			return fs.statSync(absolutePath).isFile();
		} catch {
			return false;
		}
	},
	readTextFile(absolutePath: string): string {
		return fs.readFileSync(absolutePath, 'utf8');
	},
};

export function loadProject(
	root: string,
	host: ProjectFsHost = nodeFsHost,
	knownBoardIds?: readonly string[],
): LoadProjectResult {
	const configPath = path.join(root, PROJECT_FILE_NAME);

	if (!host.fileExists(configPath)) {
		return {
			ok: false,
			configPath: undefined,
			errors: [{ message: `No ${PROJECT_FILE_NAME} found in ${root}.` }],
			warnings: [],
		};
	}

	let text: string;
	try {
		text = host.readTextFile(configPath);
	} catch (err) {
		return {
			ok: false,
			configPath,
			errors: [{ message: `Could not read ${PROJECT_FILE_NAME}: ${errorMessage(err)}` }],
			warnings: [],
		};
	}

	const doc = parseDocument(text, { prettyErrors: true, uniqueKeys: true });
	if (doc.errors.length > 0) {
		return {
			ok: false,
			configPath,
			errors: doc.errors.map((e) => ({
				message: e.message,
				line: e.linePos?.[0]?.line,
				column: e.linePos?.[0]?.col,
			})),
			warnings: [],
		};
	}

	const validation = validateConfig(doc.toJS());
	if (!validation.ok) {
		return { ok: false, configPath, errors: validation.errors, warnings: validation.warnings };
	}

	const pathErrors: ConfigIssue[] = [];
	checkPaths(root, validation.project.sources, 'Source', host, pathErrors);
	checkPaths(root, validation.project.constraints, 'Constraint', host, pathErrors);
	if (pathErrors.length > 0) {
		return { ok: false, configPath, errors: pathErrors, warnings: validation.warnings };
	}

	const warnings = [...validation.warnings];
	if (knownBoardIds && knownBoardIds.length > 0 && !knownBoardIds.includes(validation.project.board)) {
		warnings.push({
			message: `Board "${validation.project.board}" is not in the registry. Known boards: ${knownBoardIds.join(', ')}.`,
		});
	}

	return {
		ok: true,
		value: {
			project: validation.project,
			root,
			configPath,
			warnings,
		},
	};
}

function checkPaths(
	root: string,
	relativePaths: readonly string[],
	label: string,
	host: ProjectFsHost,
	out: ConfigIssue[],
): void {
	for (const rel of relativePaths) {
		if (!isInsideRoot(root, rel)) {
			out.push({
				message: `${label} path "${rel}" must be relative and stay inside the project directory.`,
			});
			continue;
		}
		if (!host.fileExists(path.resolve(root, rel))) {
			out.push({ message: `${label} file not found: ${rel}` });
		}
	}
}

/** True only if `rel` is a relative path that resolves to a location at or below `root`. */
function isInsideRoot(root: string, rel: string): boolean {
	if (path.isAbsolute(rel)) {
		return false;
	}
	const resolved = path.resolve(root, rel);
	const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
	return resolved === root || resolved.startsWith(rootWithSep);
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
