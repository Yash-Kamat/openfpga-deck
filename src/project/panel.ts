/**
 * The Project Settings panel: one webview for creating a project (empty
 * folder, "Initialize Project") and editing it later (gear in the status
 * bar, "Project Settings").
 *
 * The page (media/panel.js) only draws the form and reports what the user
 * did; everything that touches disk, yosys or the board data happens here,
 * and every message from the page is checked before it is used. What a Save
 * writes is decided by the pure planner in panelModel.ts.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { parseCst } from '../boards/cst';
import type { BoardRegistry } from '../boards/registry';
import type { Board, PortDirection } from '../boards/schema';
import { nodeProcessRunner } from '../build/nodeProcess';
import { resolveToolchain } from '../toolchain/resolve';
import { isInsideRoot, loadProject, PROJECT_FILE_NAME } from './loader';
import { planProjectSave, type SaveRequest, type Starter } from './panelModel';
import { mappingFromCst, planPinConstraints, portsFromBoardSignals, type PinMapping } from './pinmap';
import { readTopPorts, type TopPort } from './ports';
import { blinkSignals, canBlink, type HdlLanguage } from './scaffold';

const HDL_FILTER = { 'HDL sources': ['v', 'sv', 'vh', 'svh'] };
const PREVIEW_SCHEME = 'openfpga-preview';
const DIRS: readonly PortDirection[] = ['input', 'output', 'inout'];

let current: ProjectPanel | undefined;

/** Open (or bring forward) the panel for the first workspace folder. */
export function openProjectPanel(context: vscode.ExtensionContext, boards: BoardRegistry): void {
	const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!root) {
		vscode.window.showErrorMessage('OpenFPGA Deck: open a folder first.');
		return;
	}
	if (current) {
		current.panel.reveal();
		return;
	}
	current = new ProjectPanel(context, boards, root);
}

/** Shows the proposed `.cst` in a diff before it is written. */
export function registerPreviewProvider(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.workspace.registerTextDocumentContentProvider(PREVIEW_SCHEME, {
			provideTextDocumentContent: (uri) => previews.get(uri.path) ?? '',
		}),
	);
}
const previews = new Map<string, string>();

class ProjectPanel {
	readonly panel: vscode.WebviewPanel;
	/** yosys port reads run one at a time: they share build/yosys/ports.json. */
	private portQueue: Promise<void> = Promise.resolve();

	constructor(
		context: vscode.ExtensionContext,
		private readonly boards: BoardRegistry,
		private readonly root: string,
	) {
		const media = vscode.Uri.joinPath(context.extensionUri, 'media');
		this.panel = vscode.window.createWebviewPanel(
			'openfpga.projectSettings',
			'OpenFPGA Project',
			vscode.ViewColumn.Active,
			{ enableScripts: true, localResourceRoots: [media], retainContextWhenHidden: true },
		);
		this.panel.webview.html = html(this.panel.webview, media);
		this.panel.onDidDispose(() => {
			current = undefined;
		});
		this.panel.webview.onDidReceiveMessage((msg: unknown) => {
			this.handle(msg).catch((err: unknown) => {
				vscode.window.showErrorMessage(`OpenFPGA Deck: ${err instanceof Error ? err.message : String(err)}`);
			});
		});
	}

	private post(message: Record<string, unknown>): void {
		void this.panel.webview.postMessage(message);
	}

	private board(id: unknown): Board {
		const board = typeof id === 'string' ? this.boards.get(id) : undefined;
		if (!board) {
			throw new Error(`Unknown board "${String(id)}".`);
		}
		return board;
	}

	private async handle(raw: unknown): Promise<void> {
		const msg = isRecord(raw) ? raw : {};
		switch (msg.type) {
			case 'ready':
				return this.sendInit();
			case 'board':
				return this.post({ type: 'boardPins', ...boardPins(this.board(msg.board)) });
			case 'generatePorts': {
				const board = this.board(msg.board);
				const signals = strings(msg.signals).filter((s) => board.pins[s] !== undefined);
				const dirs = directions(msg.dirs);
				const names = Object.fromEntries(
					Object.entries(isRecord(msg.names) ? msg.names : {}).filter((e): e is [string, string] => typeof e[1] === 'string'),
				);
				return this.post({ type: 'generated', ...portsFromBoardSignals(board, signals, { dirs, names, ungroup: strings(msg.ungroup) }) });
			}
			case 'blinkPorts': {
				const board = this.board(msg.board);
				return this.post({ type: 'generated', ...portsFromBoardSignals(board, blinkSignals(board)) });
			}
			case 'readPorts': {
				const [top, sources, id] = [str(msg.top), this.safeSources(msg.sources), msg.id];
				this.portQueue = this.portQueue.then(() => this.readPorts(top, sources, id)).catch(() => undefined);
				return this.portQueue;
			}
			case 'openFile': {
				const rel = str(msg.path);
				if (isInsideRoot(this.root, rel)) {
					await vscode.window.showTextDocument(vscode.Uri.file(path.join(this.root, rel)));
				}
				return;
			}
			case 'validate': {
				const { issues } = planPinConstraints(ports(msg.ports), mapping(msg.mapping), this.board(msg.board));
				return this.post({ type: 'issues', issues });
			}
			case 'addFiles':
				return this.post({ type: 'sources', sources: await this.addFiles(this.safeSources(msg.sources)) });
			case 'save':
				return this.save(msg);
		}
	}

	private async sendInit(): Promise<void> {
		const boards = this.boards.list().map((b) => ({ id: b.id, name: b.name, part: b.fpga.part, canBlink: canBlink(b) }));
		const loaded = loadProject(this.root, undefined, this.boards.ids());
		if (!loaded.ok) {
			if (loaded.configPath !== undefined) {
				// fpga.yaml exists but is broken: editing it here could lose data.
				this.post({ type: 'broken', errors: loaded.errors.map((e) => e.message), path: PROJECT_FILE_NAME });
				return;
			}
			this.post({
				type: 'init',
				mode: 'create',
				boards,
				project: { name: path.basename(this.root), board: boards[0]?.id, top: 'top', sources: [] },
				cstPath: 'constraints/top.cst',
			});
			return;
		}
		const { project } = loaded.value;
		const cstPath = project.constraints.find((c) => /\.cst$/i.test(c)) ?? `constraints/${project.top}.cst`;
		const board = this.boards.get(project.board);
		let initialMapping: PinMapping = {};
		let keptAsIs: string[] = [];
		if (board) {
			const { constraints } = parseCst(await fs.readFile(path.join(this.root, cstPath), 'utf8').catch(() => ''));
			const found = mappingFromCst(constraints, board);
			initialMapping = found.mapping;
			keptAsIs = [...found.unmatched, ...constraints.filter((c) => c.loc === undefined).map((c) => c.signal)];
		}
		this.post({
			type: 'init',
			mode: 'edit',
			boards,
			project,
			cstPath,
			otherCsts: project.constraints.filter((c) => c !== cstPath),
			mapping: initialMapping,
			keptAsIs,
		});
	}

	private async readPorts(top: string, sources: string[], id: unknown): Promise<void> {
		this.post({ type: 'modules', modules: await moduleNames(this.root, sources) });
		const toolchain = resolveToolchain();
		if (!toolchain.ok) {
			this.post({ type: 'ports', id, error: 'No toolchain found, so yosys cannot read the ports. See section 4.' });
			return;
		}
		const project = { name: 'ports', board: '', top, sources, constraints: [] };
		const result = await readTopPorts(project, this.root, toolchain.toolchain.tools.yosys.path, {
			run: nodeProcessRunner,
			mkdirp: async (dir) => {
				await fs.mkdir(dir, { recursive: true });
			},
			writeFile: (file, text) => fs.writeFile(file, text, 'utf8'),
			readFile: (file) => fs.readFile(file, 'utf8'),
		});
		this.post(result.ok ? { type: 'ports', id, ports: result.ports } : { type: 'ports', id, error: result.error });
	}

	/** Pick HDL files; ones outside the project are copied into `src/`. */
	private async addFiles(sources: string[]): Promise<string[]> {
		const picked = await vscode.window.showOpenDialog({
			canSelectMany: true,
			defaultUri: vscode.Uri.file(this.root),
			filters: HDL_FILTER,
			openLabel: 'Add to project',
		});
		const out = [...sources];
		for (const uri of picked ?? []) {
			let rel = path.relative(this.root, uri.fsPath);
			if (!isInsideRoot(this.root, rel)) {
				rel = path.join('src', path.basename(uri.fsPath));
				const dest = path.join(this.root, rel);
				if (await exists(dest)) {
					const pick = await vscode.window.showWarningMessage(
						`${toPosix(rel)} already exists in the project.`,
						{ modal: true },
						'Overwrite',
					);
					if (pick !== 'Overwrite') {
						continue;
					}
				}
				await fs.mkdir(path.dirname(dest), { recursive: true });
				await fs.copyFile(uri.fsPath, dest);
			}
			const posix = toPosix(rel);
			if (!out.includes(posix)) {
				out.push(posix);
			}
		}
		return out;
	}

	private async save(msg: Record<string, unknown>): Promise<void> {
		const board = this.board(msg.board);
		const mode = msg.mode === 'edit' ? 'edit' : 'create';
		const starter: Starter = msg.starter === 'blink' || msg.starter === 'pins' ? msg.starter : 'hdl';
		const req: SaveRequest = {
			mode,
			name: str(msg.name).trim(),
			top: str(msg.top).trim(),
			language: msg.language === 'systemverilog' ? 'systemverilog' : ('verilog' as HdlLanguage),
			starter: mode === 'edit' ? 'hdl' : starter,
			sources: this.safeSources(msg.sources),
			ports: ports(msg.ports),
			mapping: mapping(msg.mapping),
		};
		const cstPath = toPosix(str(msg.cstPath));
		if (!isInsideRoot(this.root, cstPath) || !/\.cst$/i.test(cstPath)) {
			throw new Error(`Constraint path "${cstPath}" must be a .cst inside the project.`);
		}
		const read = (rel: string): Promise<string | undefined> =>
			fs.readFile(path.join(this.root, rel), 'utf8').catch(() => undefined);
		const plan = planProjectSave(req, board, {
			yamlText: mode === 'edit' ? await read(PROJECT_FILE_NAME) : undefined,
			cstPath,
			cstText: await read(cstPath),
		});
		if (!plan.ok) {
			this.post({ type: 'saveResult', ok: false, errors: plan.errors, issues: plan.issues });
			return;
		}

		const cstFile = plan.files.find((f) => f.path === cstPath);
		if (plan.cstChanged && cstFile && !(await this.confirmCst(cstPath, cstFile.content))) {
			this.post({ type: 'saveResult', ok: false, errors: ['Save cancelled; nothing was written.'], issues: plan.issues });
			return;
		}

		const kept: string[] = [];
		for (const file of plan.files) {
			const abs = path.join(this.root, ...file.path.split('/'));
			// A new project never overwrites HDL or a .gitignore that is already there.
			if (mode === 'create' && file.path !== cstPath && file.path !== PROJECT_FILE_NAME && (await exists(abs))) {
				kept.push(file.path);
				continue;
			}
			await fs.mkdir(path.dirname(abs), { recursive: true });
			await fs.writeFile(abs, file.content, 'utf8');
		}
		this.post({ type: 'saveResult', ok: true, kept, issues: plan.issues });
		if (mode === 'create') {
			const hdl = plan.files.find((f) => /\.s?v$/.test(f.path));
			if (hdl) {
				await vscode.window.showTextDocument(vscode.Uri.file(path.join(this.root, hdl.path)), {
					viewColumn: vscode.ViewColumn.Beside,
				});
			}
			await this.sendInit();
		}
	}

	private async confirmCst(cstPath: string, content: string): Promise<boolean> {
		const detail = 'Pins you did not change keep their place and attributes.';
		const pick = await vscode.window.showWarningMessage(
			`Saving will change ${cstPath}.`,
			{ modal: true, detail },
			'Overwrite',
			'Show diff',
		);
		if (pick !== 'Show diff') {
			return pick === 'Overwrite';
		}
		const key = `/${cstPath}`;
		previews.set(key, content);
		await vscode.commands.executeCommand(
			'vscode.diff',
			vscode.Uri.file(path.join(this.root, cstPath)),
			vscode.Uri.from({ scheme: PREVIEW_SCHEME, path: key }),
			`${cstPath}: current ↔ after Save`,
		);
		const again = await vscode.window.showWarningMessage(
			`Overwrite ${cstPath} with the version on the right?`,
			{ modal: true, detail },
			'Overwrite',
		);
		return again === 'Overwrite';
	}

	/** Source paths from the page, kept only if they stay inside the project. */
	private safeSources(raw: unknown): string[] {
		return strings(raw).filter((s) => isInsideRoot(this.root, s));
	}
}

/** Module names declared in the sources, as suggestions for the top module. */
async function moduleNames(root: string, sources: readonly string[]): Promise<string[]> {
	const names = new Set<string>();
	for (const source of sources) {
		const text = await fs.readFile(path.join(root, source), 'utf8').catch(() => '');
		for (const m of text.matchAll(/^\s*module\s+([A-Za-z_][\w$]*)/gm)) {
			names.add(m[1]);
		}
	}
	return [...names].sort();
}

function boardPins(board: Board): Record<string, unknown> {
	return {
		board: board.id,
		pins: Object.entries(board.pins).map(([signal, p]) => ({
			signal,
			loc: p.loc,
			group: p.group ?? 'Other',
			note: p.note ?? '',
			dir: p.dir,
		})),
	};
}

// --- checking what the page sends -------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function str(v: unknown): string {
	return typeof v === 'string' ? v : '';
}
function strings(v: unknown): string[] {
	return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
}
function isDir(v: unknown): v is PortDirection {
	return DIRS.includes(v as PortDirection);
}
function directions(v: unknown): Record<string, PortDirection> {
	const out: Record<string, PortDirection> = {};
	for (const [k, d] of Object.entries(isRecord(v) ? v : {})) {
		if (isDir(d)) {
			out[k] = d;
		}
	}
	return out;
}
function ports(v: unknown): TopPort[] {
	return (Array.isArray(v) ? v : []).filter(isRecord).flatMap((p) => {
		const width = Number(p.width);
		const offset = Number(p.offset ?? 0);
		return typeof p.name === 'string' && /^[^\s";]+$/.test(p.name) && isDir(p.dir) && Number.isInteger(width) && width > 0 && Number.isInteger(offset)
			? [{ name: p.name, dir: p.dir, width, offset }]
			: [];
	});
}
function mapping(v: unknown): PinMapping {
	const out: Record<string, string> = {};
	for (const [k, s] of Object.entries(isRecord(v) ? v : {})) {
		if (typeof s === 'string' && s !== '') {
			out[k] = s;
		}
	}
	return out;
}

async function exists(p: string): Promise<boolean> {
	return fs.access(p).then(
		() => true,
		() => false,
	);
}
function toPosix(p: string): string {
	return p.split(path.sep).join('/');
}

function html(webview: vscode.Webview, media: vscode.Uri): string {
	const nonce = randomBytes(16).toString('base64');
	const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'panel.css'));
	const js = webview.asWebviewUri(vscode.Uri.joinPath(media, 'panel.js'));
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>OpenFPGA Project</title>
</head>
<body>
<main id="app"><p>Loading…</p></main>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
}
