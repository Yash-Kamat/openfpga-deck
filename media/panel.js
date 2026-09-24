// OpenFPGA Deck — Project Settings page. Draws the form and reports what the
// user does to the extension (src/project/panel.ts), which does all the work.
// Plain DOM; every piece of text is set with textContent, never innerHTML.
// @ts-check
(function () {
	// @ts-ignore acquireVsCodeApi is provided by the webview host.
	const vscode = acquireVsCodeApi();
	const app = /** @type {HTMLElement} */ (document.getElementById('app'));

	const S = {
		mode: 'create',
		boards: [],
		board: '',
		name: '',
		top: 'top',
		language: 'verilog',
		starter: 'blink',
		sources: [],
		cstPath: 'constraints/top.cst',
		otherCsts: [],
		boardPins: [],
		ports: [],
		mapping: {},
		issues: [],
		portsError: '',
		readingPorts: false,
		portsRequest: 0,
		keptAsIs: [],
		picked: [],
		dirs: {},
		names: {},
		ungroup: [],
		keys: [],
		modules: [],
		result: null,
		saving: false,
	};

	const post = (msg) => vscode.postMessage(msg);

	/** Build an element: h('div', { class: 'x', onclick: fn }, child, 'text'). */
	function h(tag, attrs, ...children) {
		const el = document.createElement(tag);
		for (const [k, v] of Object.entries(attrs || {})) {
			if (v === undefined || v === false || v === null) continue;
			if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
			else if (k === 'value') el.value = v;
			else el.setAttribute(k, v === true ? '' : String(v));
		}
		for (const c of children.flat()) {
			if (c === null || c === undefined || c === false) continue;
			el.append(typeof c === 'string' ? document.createTextNode(c) : c);
		}
		return el;
	}

	// --- talking to the extension -------------------------------------------

	window.addEventListener('message', (event) => {
		const m = event.data;
		switch (m.type) {
			case 'init':
				Object.assign(S, {
					mode: m.mode,
					boards: m.boards,
					board: m.project.board || (m.boards[0] && m.boards[0].id) || '',
					name: m.project.name,
					top: m.project.top,
					sources: m.project.sources,
					cstPath: m.cstPath,
					otherCsts: m.otherCsts || [],
					mapping: m.mapping || {},
					keptAsIs: m.keptAsIs || [],
					ports: [],
					issues: [],
					picked: [],
					dirs: {},
					names: {},
					ungroup: [],
					keys: [],
					result: null,
				});
				S.starter = m.mode === 'edit' ? 'hdl' : currentBoard() && currentBoard().canBlink ? 'blink' : 'pins';
				post({ type: 'board', board: S.board });
				if (S.mode === 'edit') readPorts();
				else if (S.starter === 'blink') post({ type: 'blinkPorts', board: S.board });
				break;
			case 'broken':
				renderBroken(m.errors, m.path);
				return;
			case 'boardPins':
				S.boardPins = m.pins;
				break;
			case 'generated':
				S.ports = m.ports;
				S.mapping = m.mapping;
				S.keys = m.keys;
				validate();
				break;
			case 'modules':
				S.modules = m.modules;
				break;
			case 'ports':
				if (m.id !== S.portsRequest) return; // an older read finished late
				S.readingPorts = false;
				S.portsError = m.error || '';
				S.ports = m.ports || [];
				validate();
				break;
			case 'issues':
				S.issues = m.issues;
				break;
			case 'sources':
				S.sources = m.sources;
				if (S.starter === 'hdl') readPorts();
				break;
			case 'saveResult':
				S.saving = false;
				S.result = m;
				if (m.issues) S.issues = m.issues;
				break;
		}
		render();
	});

	function currentBoard() {
		return S.boards.find((b) => b.id === S.board);
	}
	function validate() {
		post({ type: 'validate', board: S.board, ports: S.ports, mapping: S.mapping });
	}
	function readPorts() {
		S.portsRequest += 1; // any read still running is now stale
		if (S.sources.length === 0) {
			S.ports = [];
			S.portsError = '';
			S.readingPorts = false;
			return;
		}
		S.readingPorts = true;
		post({ type: 'readPorts', top: S.top.trim(), sources: S.sources, id: S.portsRequest });
	}
	function regenerate() {
		post({ type: 'generatePorts', board: S.board, signals: S.picked, dirs: S.dirs, names: S.names, ungroup: S.ungroup });
	}
	function setStarter(starter) {
		S.starter = starter;
		S.ports = [];
		S.mapping = {};
		S.issues = [];
		S.portsError = '';
		if (starter === 'blink') post({ type: 'blinkPorts', board: S.board });
		if (starter === 'pins') regenerate();
		if (starter === 'hdl') readPorts();
		render();
	}

	/** `.cst` names for each bit of a port, as the extension names them. */
	function bitNames(p) {
		if (p.width === 1 && p.offset === 0) return [p.name];
		return Array.from({ length: p.width }, (_, i) => `${p.name}[${p.offset + i}]`);
	}

	// --- drawing --------------------------------------------------------------

	function render() {
		const focusedId = document.activeElement && document.activeElement.id;
		const scroll = window.scrollY;
		app.replaceChildren(
			h('h1', {}, S.mode === 'create' ? 'New OpenFPGA project' : 'Project settings'),
			basics(),
			sources(),
			pins(),
			saveBar(),
		);
		window.scrollTo(0, scroll);
		if (focusedId) {
			const el = document.getElementById(focusedId);
			if (el) el.focus({ preventScroll: true });
		}
	}

	function section(num, title, ...children) {
		return h('section', {}, h('h2', {}, `${num}. ${title}`), ...children);
	}
	function field(label, control, hint) {
		return h('label', { class: 'field' }, h('span', { class: 'label' }, label), control, hint ? h('span', { class: 'hint' }, hint) : null);
	}

	function basics() {
		const board = h(
			'select',
			{
				id: 'board',
				onchange: (e) => {
					S.board = e.target.value;
					S.picked = [];
					post({ type: 'board', board: S.board });
					if (S.starter === 'blink' && !(currentBoard() && currentBoard().canBlink)) setStarter('pins');
					else setStarter(S.starter);
				},
			},
			S.boards.map((b) => h('option', { value: b.id, selected: b.id === S.board }, `${b.name} (${b.part})`)),
		);
		const children = [
			field('Name', h('input', { id: 'name', value: S.name, oninput: (e) => (S.name = e.target.value) }), 'Letters, digits, - and _. Used for the bitstream file name.'),
			field('Board', board),
			field(
				'Top module',
				h('input', {
					id: 'top',
					list: 'modules',
					value: S.top,
					oninput: (e) => (S.top = e.target.value),
					onchange: () => {
						if (S.starter === 'hdl') readPorts();
						render();
					},
				}),
			),
		];
		if (S.mode === 'create') {
			children.push(
				field(
					'Language',
					h(
						'select',
						{ id: 'language', onchange: (e) => (S.language = e.target.value) },
						h('option', { value: 'verilog', selected: S.language === 'verilog' }, 'Verilog (.v)'),
						h('option', { value: 'systemverilog', selected: S.language === 'systemverilog' }, 'SystemVerilog (.sv)'),
					),
					'For the generated top module.',
				),
			);
			const radio = (value, label, disabled) =>
				h(
					'label',
					{ class: 'radio' + (disabled ? ' disabled' : '') },
					h('input', { type: 'radio', name: 'starter', id: `starter-${value}`, checked: S.starter === value, disabled, onchange: () => setStarter(value) }),
					label,
				);
			const blinkOk = currentBoard() && currentBoard().canBlink;
			children.push(
				h(
					'fieldset',
					{ class: 'starter' },
					h('legend', {}, 'Start from'),
					radio('blink', 'Blink example: blinks the on-board LEDs', !blinkOk),
					radio('pins', 'Pick pins: generates an empty top module with the pins you choose', false),
					radio('hdl', 'My own HDL files: only the .cst is generated', false),
				),
			);
		}
		children.push(h('datalist', { id: 'modules' }, S.modules.map((m) => h('option', { value: m }))));
		return section(1, 'Project', ...children);
	}

	function sources() {
		const ext = S.language === 'verilog' ? 'v' : 'sv';
		const generated =
			S.mode === 'create' && S.starter !== 'hdl'
				? h('p', { class: 'hint' }, `src/${S.top.trim() || 'top'}.${ext} will be generated. Add any other modules it uses here.`)
				: null;
		const list = S.sources.length
			? h(
					'ul',
					{ class: 'files' },
					S.sources.map((s) =>
						h(
							'li',
							{},
							h('span', { class: 'mono' }, s),
							h(
								'button',
								{
									class: 'icon',
									title: `Remove ${s} from the project (the file is not deleted)`,
									'aria-label': `Remove ${s}`,
									onclick: () => {
										S.sources = S.sources.filter((x) => x !== s);
										if (S.starter === 'hdl') readPorts();
										render();
									},
								},
								'✕',
							),
						),
					),
			  )
			: h('p', { class: 'hint' }, 'No source files yet.');
		return section(
			2,
			'Source files',
			generated,
			list,
			h('button', { class: 'secondary', onclick: () => post({ type: 'addFiles', sources: S.sources }) }, 'Add files…'),
			h('p', { class: 'hint' }, 'Files outside the project folder are copied into src/.'),
		);
	}

	function pins() {
		const children = [];
		if (S.otherCsts.length) {
			children.push(h('p', { class: 'hint' }, `Editing ${S.cstPath}. Not shown here: ${S.otherCsts.join(', ')}.`));
		}
		if (S.keptAsIs.length) {
			children.push(h('p', { class: 'hint' }, `Kept as they are in ${S.cstPath} (no pin, or a pin the board file does not list): ${S.keptAsIs.join(', ')}.`));
		}
		if (S.starter === 'hdl') {
			children.push(
				h(
					'div',
					{ class: 'row' },
					h('button', { class: 'secondary', onclick: readPorts, disabled: S.readingPorts || S.sources.length === 0 }, S.readingPorts ? 'Reading ports…' : 'Re-read ports'),
					h('span', { class: 'hint' }, `Ports of "${S.top.trim()}", read from your HDL with yosys.`),
				),
			);
			if (S.portsError) children.push(h('p', { class: 'msg error' }, '⛔ ', S.portsError));
		}
		if (S.starter === 'pins') children.push(pinPicker());
		if (S.starter === 'blink') children.push(h('p', { class: 'hint' }, 'The blink example uses the clock and every LED.'));

		if (S.ports.length) children.push(pinTable());
		else if (!S.portsError) children.push(h('p', { class: 'hint' }, S.starter === 'hdl' ? 'Add your HDL files to see their ports.' : 'No pins yet.'));
		return section(3, 'Pins', ...children);
	}

	function pinPicker() {
		const free = S.boardPins.filter((p) => !S.picked.includes(p.signal));
		const groups = [...new Set(free.map((p) => p.group))];
		const pinSel = h('select', { id: 'add-pin', 'aria-label': 'Board pin to add' }, pinOptions(free, ''));
		const groupSel = h('select', { id: 'add-group', 'aria-label': 'Pin group to add' }, groups.map((g) => h('option', { value: g }, g)));
		return h(
			'div',
			{ class: 'picker' },
			h('div', { class: 'row' }, pinSel, h('button', { class: 'secondary', onclick: () => addPicked([pinSel.value]) }, 'Add pin')),
			h(
				'div',
				{ class: 'row' },
				groupSel,
				h('button', { class: 'secondary', onclick: () => addPicked(free.filter((p) => p.group === groupSel.value).map((p) => p.signal)) }, 'Add whole group'),
			),
		);
	}
	function addPicked(signals) {
		S.picked = [...S.picked, ...signals.filter((s) => s && !S.picked.includes(s))];
		regenerate();
	}

	/** Board pins as <optgroup>s, each option marked with the port already using it. */
	function pinOptions(pinsList, selected, usedBy) {
		const groups = new Map();
		for (const p of pinsList) {
			if (!groups.has(p.group)) groups.set(p.group, []);
			groups.get(p.group).push(p);
		}
		return [...groups].map(([g, list]) =>
			h(
				'optgroup',
				{ label: g },
				list.map((p) => {
					const user = usedBy && usedBy.get(p.loc);
					const suffix = user ? `  (in use by ${user})` : '';
					return h('option', { value: p.signal, selected: p.signal === selected, title: p.note || undefined }, `${p.signal} · pin ${p.loc}${suffix}`);
				}),
			),
		);
	}

	function pinTable() {
		const editable = S.starter === 'hdl';
		const bySignal = new Map(S.boardPins.map((p) => [p.signal, p]));
		const issuesByBit = new Map();
		for (const issue of S.issues) {
			for (const bit of issue.bits) {
				if (!issuesByBit.has(bit)) issuesByBit.set(bit, []);
				issuesByBit.get(bit).push(issue);
			}
		}
		const rows = [];
		S.ports.forEach((port, portIndex) => {
			const key = S.keys[portIndex] || port.name;
			bitNames(port).forEach((bit, i) => {
				const signal = S.mapping[bit] || '';
				const usedBy = new Map();
				for (const [otherBit, otherSignal] of Object.entries(S.mapping)) {
					const pin = bySignal.get(otherSignal);
					if (otherBit !== bit && pin) usedBy.set(pin.loc, otherBit);
				}
				const found = issuesByBit.get(bit) || [];
				const level = found.some((x) => x.severity === 'error') ? 'error' : found.length ? 'warning' : '';
				const select = h(
					'select',
					{
						id: `pin-${bit}`,
						'aria-label': `Board pin for ${bit}`,
						disabled: !editable,
						onchange: (e) => {
							if (e.target.value) S.mapping = { ...S.mapping, [bit]: e.target.value };
							else {
								const next = { ...S.mapping };
								delete next[bit];
								S.mapping = next;
							}
							validate();
						},
					},
					h('option', { value: '' }, '— not connected —'),
					pinOptions(S.boardPins, signal, usedBy),
				);
				rows.push(
					h(
						'tr',
						{ class: level },
						h('td', { class: 'mono' }, S.starter === 'pins' && i === 0 ? nameCell(port, key) : bit),
						h('td', {}, i === 0 ? dirCell(port, key) : ''),
						h('td', {}, select),
						h(
							'td',
							{ class: 'status' },
							found.map((x) => h('div', { class: `msg ${x.severity}` }, x.severity === 'error' ? '⛔ ' : '⚠ ', x.message)),
						),
						h('td', { class: 'actions' }, S.starter === 'pins' && i === 0 ? [groupButton(port, signal), removeButton(port)] : ''),
					),
				);
			});
		});
		const table = h(
			'table',
			{ class: 'pins' },
			h('colgroup', {}, COLUMNS.map((c) => h('col', { 'data-col': c.key }))),
			h('thead', {}, h('tr', {}, COLUMNS.map((c, i) => h('th', {}, c.title, i < COLUMNS.length - 1 ? resizer(i) : null)))),
			h('tbody', {}, rows),
		);
		table.querySelectorAll('col').forEach((col, i) => (col.style.width = `${S.colWidths[COLUMNS[i].key]}px`));
		return h('div', { class: 'table-scroll' }, table);
	}

	// --- resizable columns ------------------------------------------------------
	// Webviews have no built-in resizable table, so: fixed widths per column,
	// a thin handle on each header's right edge (drag to resize, double-click
	// to fit the widest cell), kept in S.colWidths across redraws.

	const COLUMNS = [
		{ key: 'port', title: 'Port' },
		{ key: 'dir', title: 'Direction' },
		{ key: 'pin', title: 'Board pin' },
		{ key: 'status', title: 'Status' },
		{ key: 'actions', title: '' },
	];
	S.colWidths = { port: 170, dir: 110, pin: 260, status: 320, actions: 130 };
	const MIN_WIDTH = 40;

	function resizer(index) {
		const key = COLUMNS[index].key;
		const colOf = (el) => el.closest('table').querySelectorAll('col')[index];
		return h('div', {
			class: 'resizer',
			title: 'Drag to resize, double-click to fit',
			onpointerdown: (e) => {
				e.preventDefault();
				const handle = e.target;
				const col = colOf(handle);
				const startX = e.clientX;
				const startWidth = S.colWidths[key];
				handle.setPointerCapture(e.pointerId);
				handle.onpointermove = (ev) => {
					S.colWidths[key] = Math.max(MIN_WIDTH, startWidth + ev.clientX - startX);
					col.style.width = `${S.colWidths[key]}px`;
				};
				handle.onpointerup = () => {
					handle.onpointermove = null;
					handle.onpointerup = null;
				};
			},
			ondblclick: (e) => {
				const table = e.target.closest('table');
				S.colWidths[key] = Math.max(MIN_WIDTH, fitWidth(table, index));
				colOf(e.target).style.width = `${S.colWidths[key]}px`;
			},
		});
	}

	/** Width of the widest cell in a column, measured with no wrapping. */
	function fitWidth(table, index) {
		table.classList.add('measuring');
		let widest = 0;
		for (const row of table.rows) {
			const cell = row.cells[index];
			if (!cell) continue;
			const range = document.createRange();
			range.selectNodeContents(cell);
			const style = getComputedStyle(cell);
			widest = Math.max(widest, range.getBoundingClientRect().width + parseFloat(style.paddingLeft) + parseFloat(style.paddingRight));
		}
		table.classList.remove('measuring');
		return Math.ceil(widest) + 12;
	}

	function nameCell(port, key) {
		const valid = (v) => /^[A-Za-z_][A-Za-z0-9_$]*$/.test(v.trim());
		const label = port.width > 1 ? `[${port.width - 1}:0]` : '';
		return h(
			'span',
			{ class: 'row tight' },
			h('input', {
				id: `name-${key}`,
				class: 'mono portname' + (valid(port.name) ? '' : ' invalid'),
				value: port.name,
				'aria-label': `Name of port ${key}`,
				title: 'Port name in the generated top module',
				oninput: (e) => e.target.classList.toggle('invalid', !valid(e.target.value)),
				onchange: (e) => {
					S.names = { ...S.names, [key]: e.target.value };
					regenerate();
				},
			}),
			label,
		);
	}

	function dirCell(port, key) {
		if (S.starter !== 'pins') return port.dir;
		return h(
			'select',
			{
				id: `dir-${key}`,
				'aria-label': `Direction of ${port.name}`,
				title: port.width > 1 ? 'A bus has one direction for all its bits.' : undefined,
				onchange: (e) => {
					S.dirs = { ...S.dirs, [key]: e.target.value };
					regenerate();
				},
			},
			['input', 'output', 'inout'].map((d) => h('option', { value: d, selected: d === port.dir }, d)),
		);
	}

	/** Ungroup a bus into single pins, or group them back ("led[3]" → "led"). */
	function groupButton(port, signal) {
		const m = /^(.+)\[\d+\]$/.exec(signal);
		if (!m) return null;
		const base = m[1];
		const toggle = (split) => {
			S.ungroup = split ? [...S.ungroup, base] : S.ungroup.filter((b) => b !== base);
			regenerate();
		};
		if (port.width > 1) {
			return h('button', { class: 'secondary small', title: `Make each ${base} pin its own port`, onclick: () => toggle(true) }, 'Ungroup');
		}
		if (S.ungroup.includes(base)) {
			const indices = S.picked.flatMap((s) => {
				const b = /^(.+)\[(\d+)\]$/.exec(s);
				return b && b[1] === base ? [Number(b[2])] : [];
			});
			// Same rule as the extension: a bus needs every bit from 0 up.
			const canGroup = indices.every((index) => index < indices.length) && !S.picked.includes(base);
			return h(
				'button',
				{
					class: 'secondary small',
					disabled: !canGroup,
					title: canGroup
						? `Put the ${base} pins back into one bus`
						: `Add ${base}[0] to ${base}[${indices.length > 0 ? Math.max(...indices) : 0}] with no gaps to make a bus`,
					onclick: () => toggle(false),
				},
				'Group',
			);
		}
		return null;
	}

	function removeButton(port) {
		return h(
			'button',
			{
				class: 'icon',
				title: `Remove ${port.name}`,
				'aria-label': `Remove ${port.name}`,
				onclick: () => {
					const signals = new Set(bitNames(port).map((b) => S.mapping[b]));
					S.picked = S.picked.filter((s) => !signals.has(s));
					regenerate();
				},
			},
			'✕',
		);
	}

	function saveBar() {
		const errors = S.issues.filter((i) => i.severity === 'error').length;
		const warnings = S.issues.length - errors;
		const summary = [];
		if (errors) summary.push(h('span', { class: 'msg error' }, `⛔ ${errors} pin conflict${errors > 1 ? 's' : ''}; fix them to save.`));
		if (warnings) summary.push(h('span', { class: 'msg warning' }, `⚠ ${warnings} warning${warnings > 1 ? 's' : ''}.`));
		const r = S.result;
		const result = !r
			? null
			: r.ok
			? h('p', { class: 'msg ok' }, '✓ Saved.', r.kept && r.kept.length ? ` Kept existing: ${r.kept.join(', ')}.` : '')
			: h('div', {}, (r.errors || []).map((e) => h('p', { class: 'msg error' }, '⛔ ', e)));
		return h(
			'div',
			{ class: 'savebar' },
			h(
				'button',
				{
					id: 'save',
					disabled: S.saving || errors > 0 || S.readingPorts || (S.starter === 'hdl' && !!S.portsError),
					onclick: () => {
						S.saving = true;
						S.result = null;
						post({
							type: 'save',
							mode: S.mode,
							board: S.board,
							name: S.name,
							top: S.top,
							language: S.language,
							starter: S.starter,
							sources: S.sources,
							ports: S.ports,
							mapping: S.mapping,
							cstPath: S.cstPath,
						});
						render();
					},
				},
				S.mode === 'create' ? 'Create project' : 'Save',
			),
			...summary,
			result,
		);
	}

	function renderBroken(errors, file) {
		app.replaceChildren(
			h('h1', {}, 'Project settings'),
			h('p', { class: 'msg error' }, `⛔ ${file} has errors, so it cannot be edited here without losing data. Fix these, then reopen this panel:`),
			h('ul', {}, errors.map((e) => h('li', {}, e))),
			h('button', { onclick: () => post({ type: 'openFile', path: file }) }, `Open ${file}`),
		);
	}

	post({ type: 'ready' });
})();
