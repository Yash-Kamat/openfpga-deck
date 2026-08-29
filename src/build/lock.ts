/**
 * Process-wide single-build guard. The pipeline writes into one shared
 * `build/` tree and drives one toolchain, so only one build may run at a
 * time. Callers acquire before starting and release in a `finally`.
 */

let running = false;

/** Take the lock. Returns `false` if a build is already running. */
export function acquireBuildLock(): boolean {
	if (running) {
		return false;
	}
	running = true;
	return true;
}

export function releaseBuildLock(): void {
	running = false;
}

export function isBuildRunning(): boolean {
	return running;
}
