/**
 * The `build/` directory layout, shared by every pipeline stage.
 *
 * One predictable tree per project so a stage always knows where the
 * previous stage put its output and where its own logs go:
 *
 *   build/
 *     yosys/       synthesis netlist + the generated yosys script
 *     pnr/         place-and-route output
 *     bitstream/   the packed bitstream
 *     logs/        one <stage>.log per stage (raw tool output)
 *     reports/     parsed, human-facing summaries
 *
 * Pure path arithmetic — nothing here touches the disk.
 */

import * as path from 'node:path';

export const BUILD_DIRNAME = 'build';

export interface BuildLayout {
	/** `<projectRoot>/build`. */
	readonly dir: string;
	readonly netlistDir: string;
	readonly pnrDir: string;
	readonly bitstreamDir: string;
	readonly logDir: string;
	readonly reportDir: string;
}

export function buildLayout(projectRoot: string): BuildLayout {
	const dir = path.join(projectRoot, BUILD_DIRNAME);
	return {
		dir,
		netlistDir: path.join(dir, 'yosys'),
		pnrDir: path.join(dir, 'pnr'),
		bitstreamDir: path.join(dir, 'bitstream'),
		logDir: path.join(dir, 'logs'),
		reportDir: path.join(dir, 'reports'),
	};
}

/** Every subdirectory of `build/`, for an up-front `mkdir -p`. */
export function buildDirs(layout: BuildLayout): readonly string[] {
	return [layout.netlistDir, layout.pnrDir, layout.bitstreamDir, layout.logDir, layout.reportDir];
}
