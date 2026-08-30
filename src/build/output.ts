/**
 * Formatting and noise-filtering for what the pipeline shows in the
 * "OpenFPGA Deck" output channel.
 *
 * The channel is a curated view: a rule + header per stage, the command
 * being run, and a ✓/✗ result line. Known-harmless tool chatter (e.g.
 * Project Apicula's "Numpy is not available, performance will be degraded"
 * warnings from gowin_pack) is dropped here — the complete, unfiltered
 * output always still lands in the per-stage log file under `build/logs/`.
 *
 * A plain output channel is monochrome by design; the structure below is
 * what carries readability. (VS Code's "log" language id was tried for
 * colour and rejected: its generic lexer paints every number and
 * identifier, so nextpnr/yosys output turns into confetti.)
 */

/** Lines that carry no signal for the user and are hidden from the channel. */
const NOISE_PATTERNS: readonly RegExp[] = [
	/UserWarning:\s+\S+ is not available, performance will be degraded/i,
	/^\s*warnings\.warn\(/,
];

export function isNoise(line: string): boolean {
	return NOISE_PATTERNS.some((re) => re.test(line));
}

const PERCENT_RE = /(\d{1,3})(?:\.\d+)?%/;

/**
 * A stateful per-run filter for the output channel: drops {@link isNoise}
 * lines outright, and thins `openFPGALoader`'s carriage-return progress bars
 * down to one line per 10 % (plus the final 100 %). The log file is never
 * filtered.
 */
export function makeLineFilter(): (line: string) => boolean {
	let lastBucket = -1;
	return (line) => {
		if (isNoise(line)) {
			return false;
		}
		const match = PERCENT_RE.exec(line);
		if (!match) {
			lastBucket = -1;
			return true;
		}
		const percent = Number(match[1]);
		const bucket = Math.floor(percent / 10);
		if (percent >= 100 || bucket !== lastBucket) {
			lastBucket = bucket;
			return true;
		}
		return false;
	};
}

/** A full-width rule + name to separate pipeline stages in the channel. */
export function stageHeader(name: string): string {
	const label = ` ${name} `;
	const bar = '─'.repeat(Math.max(4, 60 - label.length));
	return `\n──${label}${bar}\n`;
}

export function commandLine(tool: string, args: readonly string[]): string {
	return `  $ ${tool} ${args.join(' ')}\n\n`;
}

export function successLine(message: string): string {
	return `\n✓ ${message}\n`;
}

export function failureLine(message: string): string {
	return `\n✗ ${message}\n`;
}
