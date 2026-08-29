/**
 * The real {@link ProcessRunner}: `child_process.spawn` with an argument
 * array and `shell: false`. stdout and stderr are forwarded as UTF-8 text as
 * they arrive; cancellation sends SIGTERM.
 */

import { spawn } from 'node:child_process';
import type { ProcessRunner } from './runStep';

export const nodeProcessRunner: ProcessRunner = (spec) =>
	new Promise((resolve) => {
		let settled = false;
		const finish = (result: Parameters<typeof resolve>[0]): void => {
			if (!settled) {
				settled = true;
				resolve(result);
			}
		};

		const child = spawn(spec.exe, [...spec.args], {
			cwd: spec.cwd,
			shell: false,
			windowsHide: true,
		});

		const onAbort = (): void => {
			child.kill('SIGTERM');
		};
		if (spec.signal) {
			if (spec.signal.aborted) {
				onAbort();
			} else {
				spec.signal.addEventListener('abort', onAbort, { once: true });
			}
		}
		const cleanup = (): void => spec.signal?.removeEventListener('abort', onAbort);

		child.stdout?.setEncoding('utf8');
		child.stderr?.setEncoding('utf8');
		child.stdout?.on('data', (d: string) => spec.onChunk(d));
		child.stderr?.on('data', (d: string) => spec.onChunk(d));

		child.on('error', (err: NodeJS.ErrnoException) => {
			cleanup();
			finish({
				code: null,
				signal: null,
				spawnError: err.code === 'ENOENT' ? `not found: ${spec.exe}` : err.message,
			});
		});
		child.on('close', (code, signal) => {
			cleanup();
			finish({ code, signal: signal ?? null });
		});
	});
