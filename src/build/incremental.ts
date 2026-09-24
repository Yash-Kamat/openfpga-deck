/**
 * When a build stage can be skipped: its output exists and is at least as
 * new as every input. A missing input makes the stage run, so the stage
 * itself reports what is missing.
 *
 * ponytail: `include`d HDL files are not inputs (only fpga.yaml's sources);
 * editing only an include needs Clean or an explicit Synthesize.
 */
export function isUpToDate(
	outputMtime: number | undefined,
	inputMtimes: readonly (number | undefined)[],
): boolean {
	return (
		outputMtime !== undefined &&
		inputMtimes.every((m) => m !== undefined && m <= outputMtime)
	);
}
