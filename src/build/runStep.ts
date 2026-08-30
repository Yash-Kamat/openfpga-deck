/**
 * Run one pipeline stage as a child process.
 *
 * Subprocess policy (binding across the whole project): spawn an executable
 * with an argument array, never a shell string, never `shell: true`.
 *
 * The actual spawning is injected as a {@link ProcessRunner} so the
 * result-handling logic — exit code, cancellation, spawn failure, log
 * capture — is unit-tested without starting real processes. The real runner
 * lives in nodeProcess.ts.
 *
 * Channel output is line-buffered so noise filtering (see output.ts) can work
 * a line at a time; the log file always gets the raw, unfiltered stream.
 */

import { commandLine, makeLineFilter, stageHeader } from './output';

export interface ProcessSpec {
	readonly exe: string;
	readonly args: readonly string[];
	readonly cwd: string;
	/** Combined stdout + stderr, delivered as it arrives. */
	readonly onChunk: (text: string) => void;
	readonly signal?: AbortSignal;
}

export interface ProcessResult {
	/** Exit code, or `null` when the process was killed by a signal. */
	readonly code: number | null;
	/** Signal name when the process was killed, else `null`. */
	readonly signal: string | null;
	/** Set only when the process could not be started at all (e.g. ENOENT). */
	readonly spawnError?: string;
}

export type ProcessRunner = (spec: ProcessSpec) => Promise<ProcessResult>;

export interface StepSpec {
	/** Human name of the stage, e.g. "Synthesis". */
	readonly name: string;
	/** Tool name for the command echo, e.g. "yosys". */
	readonly tool: string;
	readonly exe: string;
	readonly args: readonly string[];
	readonly cwd: string;
	/** Absolute path of the log file to write the raw output to. */
	readonly logFile: string;
	/** Friendly (project-relative) label for the log file, used in messages. */
	readonly logLabel: string;
	readonly signal?: AbortSignal;
}

export interface StepIo {
	readonly run: ProcessRunner;
	/** Stream text to the user (output channel). */
	readonly write: (text: string) => void;
	readonly writeFile: (file: string, text: string) => Promise<void>;
}

export interface StepOutcome {
	readonly ok: boolean;
	readonly canceled: boolean;
	readonly code: number | null;
	readonly logFile: string;
	readonly summary: string;
}

export async function runStep(step: StepSpec, io: StepIo): Promise<StepOutcome> {
	io.write(stageHeader(step.name));
	io.write(commandLine(step.tool, step.args));

	let captured = '';
	let pending = '';
	const keep = makeLineFilter();
	const emit = (line: string): void => {
		if (keep(line)) {
			io.write(`${line}\n`);
		}
	};

	const result = await io.run({
		exe: step.exe,
		args: step.args,
		cwd: step.cwd,
		signal: step.signal,
		onChunk: (text) => {
			captured += text;
			pending += text;
			// Split on CR too: openFPGALoader draws progress bars with \r.
			const lines = pending.split(/\r\n|[\r\n]/);
			pending = lines.pop() ?? '';
			for (const line of lines) {
				emit(line);
			}
		},
	});
	if (pending !== '') {
		emit(pending);
	}

	await io.writeFile(step.logFile, captured).catch(() => undefined);

	if (result.spawnError !== undefined) {
		return {
			ok: false,
			canceled: false,
			code: null,
			logFile: step.logFile,
			summary: `${step.tool} could not be started: ${result.spawnError}`,
		};
	}

	if (step.signal?.aborted === true || result.signal !== null) {
		return {
			ok: false,
			canceled: true,
			code: result.code,
			logFile: step.logFile,
			summary: `${step.name} was cancelled.`,
		};
	}

	if (result.code === 0) {
		return {
			ok: true,
			canceled: false,
			code: 0,
			logFile: step.logFile,
			summary: `${step.name} completed.`,
		};
	}

	return {
		ok: false,
		canceled: false,
		code: result.code,
		logFile: step.logFile,
		summary: `${step.tool} exited with code ${result.code} — see ${step.logLabel}.`,
	};
}
