/**
 * Read the toolchain settings and run discovery. Shared by the toolchain UI
 * and the build pipeline so both resolve "the active toolchain" identically.
 */

import * as os from 'node:os';
import * as vscode from 'vscode';
import { discover, type DiscoverOptions, type DiscoverResult } from './discovery';
import { nodeToolchainHost } from './nodeHost';

const SETTING_PATH = 'openfpga.toolchain.path';
const SETTING_INSTALL_DIR = 'openfpga.toolchain.installDir';

export function toolchainDiscoverOptions(): DiscoverOptions {
	const cfg = vscode.workspace.getConfiguration();
	return {
		configuredPath: cfg.get<string>(SETTING_PATH) ?? '',
		installDir: cfg.get<string>(SETTING_INSTALL_DIR) ?? '',
		pathEnv: process.env.PATH ?? '',
		homeDir: os.homedir(),
	};
}

export function resolveToolchain(): DiscoverResult {
	return discover(toolchainDiscoverOptions(), nodeToolchainHost);
}
