/**
 * Work out which dual-purpose configuration pins (SSPI, MSPI) a project's
 * `.cst` constraints use, so place & route and packing can release them as
 * GPIO. Both stages must agree — gowin_pack rejects an SSPI setting that
 * differs from nextpnr's.
 */

import * as path from 'node:path';
import { parseCst } from '../boards/cst';
import { configModesFor, type Board, type ConfigPinMode } from '../boards/schema';
import type { FpgaProject } from '../project/schema';
import type { PipelineIo } from './synthesize';

export async function projectConfigModes(
	project: FpgaProject,
	board: Board,
	projectRoot: string,
	io: Pick<PipelineIo, 'readFile'>,
): Promise<Set<ConfigPinMode>> {
	if (!io.readFile) {
		return new Set();
	}
	const locs: string[] = [];
	for (const cst of project.constraints.filter((c) => /\.cst$/i.test(c))) {
		// An unreadable .cst is reported by nextpnr itself; nothing to add here.
		const text = await io.readFile(path.join(projectRoot, cst)).catch(() => '');
		for (const c of parseCst(text).constraints) {
			if (c.loc) {
				locs.push(c.loc);
			}
		}
	}
	return configModesFor(board, locs);
}
