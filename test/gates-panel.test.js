'use strict';

// The memory gates panel: the editor tab that retires and restores one gate at a time. Ported
// from rampage e5c0ee7 (test/gates-panel.test.js and the apply tests of its extension.test.js)
// and adapted 2026-10-14: AI Acolyte's commands and data directory, per-agent gates (CLAUDE.md and
// AGENTS.md each load their own gates), the compile store, and the corpus watcher that must not
// compile a second time.
//
// Three things are pinned here, each where it can fail on its own. The HTML the extension serves
// (the CSP, and that no memory text is in it at all). The page's own script, run against a DOM
// thin enough to read in one screen, fed gates whose text is hostile markup. And the extension's
// side: what the page may ask for, that every name it sends is checked against a list the
// extension read itself, and the whole apply (list, modal, edit, compile, install) against a real
// block writer in a temp home, with recall.py played in process by a stand-in that keeps its
// documented contract (test/gates-manage.sh holds the real recall.py to it).

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const repoRoot = path.resolve(__dirname, '..');
const rootSrc = path.join(repoRoot, 'src');
const extensionPath = require.resolve('../vscode-extension/extension');
const extensionDir = path.dirname(extensionPath);
const realSetTimeout = global.setTimeout;
const GATES_BEGIN = '<!-- BEGIN permission-wildcarding: memory gates (managed) -->';

function disposable() { return { dispose() {} }; }
function settleOnce() { return new Promise((resolve) => setImmediate(resolve)); }
async function until(condition, what, ms = 5000) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => realSetTimeout(resolve, 5));
  }
}

function purgeProjectModules() {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(rootSrc + path.sep) || key.startsWith(extensionDir + path.sep)) delete require.cache[key];
  }
}

// ── recall.py, played in process ──────────────────────────────────────────────
// The four verbs the panel runs, over the memory folder RECALL_MEMORY_DIR names, to recall.py's
// contract: `--gates-list` prints JSON (state, agents, problem), an edit validates, snapshots
// under ~/.claude/wildcarding/gate-snapshots, rewrites the scope value and prints `snapshot` and
// one `retired`/`restored` line per file, and `--gates-compile` writes gates.generated.md, one
// section per agent once a gate names its agents. `faults` makes one step misbehave.
const AGENTS = ['claude', 'codex'];
function stubRecall(args, env, home, faults) {
  const store = env.RECALL_MEMORY_DIR;
  const fail = (message) => [Object.assign(new Error(`Command failed: recall.py\n${message}`), { code: 1 }), '', `[recall] ${message}\n`];
  const files = () => fs.readdirSync(store).filter((name) => name.endsWith('.md') && name !== 'MEMORY.md').sort();
  const read = (name) => fs.readFileSync(path.join(store, name), 'utf8');
  const front = (text) => (/^---\r?\n([\s\S]*?)\r?\n---/.exec(text) || [])[1] || '';
  const scopeOf = (text) => (/^\s*scope:\s*"?([a-z]+)"?\s*$/m.exec(front(text)) || [])[1] || '';
  const agentsOf = (text) => {
    const line = /^\s*agents:\s*(.*)$/m.exec(front(text));
    if (!line) return { agents: AGENTS, problem: null };
    const names = line[1].trim().replace(/^\[|\]$/g, '').split(',').map((name) => name.trim().toLowerCase()).filter(Boolean);
    if (!names.length) return { agents: AGENTS, problem: null };
    const unknown = names.filter((name) => !AGENTS.includes(name));
    if (unknown.length) return { agents: [], problem: `\`agents:\` names an agent this compiler does not know: ${unknown.join(', ')}` };
    return { agents: AGENTS.filter((agent) => names.includes(agent)), problem: null };
  };
  const blockOf = (text) => {
    const block = /<!-- gate -->([\s\S]*?)<!-- \/gate -->/.exec(text);
    return block ? block[1].trim() : null;
  };
  if (args[0] === '--gates-list') {
    if (faults.list) return faults.list();
    const gates = [];
    for (const file of files()) {
      const text = read(file);
      const scope = scopeOf(text);
      const block = blockOf(text);
      if (block === null || (scope !== 'global' && scope !== 'retired')) continue;
      const { agents, problem } = agentsOf(text);
      const first = block.split(/\r?\n/).find((line) => line.trim()) || '';
      gates.push({ file, scope, state: scope === 'retired' ? 'retired' : problem ? 'excluded' : 'active', agents, problem,
        title: first.replace(/^\s*[-*]\s+/, '').replace(/\*\*/g, '').trim(), text: block, description: '' });
    }
    return [null, JSON.stringify({ store, gates }, null, 2), ''];
  }
  if (/^--gates-(retire|restore)=/.test(args[0])) {
    if (faults.edit) { const answer = faults.edit(args); if (answer) return answer; }
    const wanted = args.map((arg) => {
      const [, verb, name] = /^--gates-(retire|restore)=([\s\S]*)$/.exec(arg);
      return [name.endsWith('.md') ? name : `${name}.md`, verb === 'retire' ? 'global' : 'retired', verb === 'retire' ? 'retired' : 'global'];
    });
    for (const [file, scope] of wanted) {
      if (!fs.existsSync(path.join(store, file)) || scopeOf(read(file)) !== scope) return fail(`refusing to change any gate; ${file} is not scope ${scope}`);
    }
    const ops = [...new Set(wanted.map(([, scope]) => (scope === 'global' ? 'retire' : 'restore')))].join('+');
    const root = env.AI_ACOLYTE_GATE_SNAPSHOT_DIR || path.join(home, '.claude', 'wildcarding', 'gate-snapshots');
    const snapshot = path.join(root, `${new Date().toISOString().replace(/[-:]|\.\d+/g, '')}-${ops}`);
    fs.mkdirSync(snapshot, { recursive: true });
    for (const file of fs.readdirSync(store).filter((name) => name.endsWith('.md'))) fs.copyFileSync(path.join(store, file), path.join(snapshot, file));
    const out = [`snapshot ${snapshot}`];
    for (const [file, , scope] of wanted) {
      fs.writeFileSync(path.join(store, file), read(file).replace(/^(\s*scope:\s*"?)(global|retired)/m, (_, head) => `${head}${scope}`));
      out.push(`${scope === 'retired' ? 'retired' : 'restored'} ${file}`);
    }
    return [null, `${out.join('\r\n')}\r\n`, faults.editWarning || ''];
  }
  if (args[0] === '--gates-compile') {
    if (faults.compile) { const answer = faults.compile(args); if (answer) return answer; }
    const gates = files().map(read).filter((text) => scopeOf(text) === 'global' && blockOf(text) !== null)
      .map((text) => ({ body: blockOf(text), ...agentsOf(text) })).filter((gate) => gate.problem === null);
    const target = path.join(home, '.claude', 'gates.generated.md');
    const installed = fs.existsSync(target) && fs.readFileSync(target, 'utf8').trim();
    if (!gates.length && installed && !args.includes('--gates-allow-empty')) return fail(`refusing to empty ${target}: no gate blocks`);
    const render = (bodies) => {
      if (!bodies.length) return '';
      const body = bodies.join('\n');
      const sha = faults.torn ? '0123456789abcdef' : crypto.createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 16);
      return `<!-- generated by recall.py --gates-compile; sha ${sha} -->\n## Standing gates (${bodies.length} memories, managed)\n\n${body}\n`;
    };
    let text;
    if (gates.every((gate) => gate.agents.length === AGENTS.length)) text = render(gates.map((gate) => gate.body));
    else {
      const sections = AGENTS.map((agent) => render(gates.filter((gate) => gate.agents.includes(agent)).map((gate) => gate.body)));
      text = `<!-- generated by recall.py --gates-compile; per agent: claude ${Buffer.byteLength(sections[0])}, `
        + `codex ${Buffer.byteLength(sections[1])} -->\n${sections.join('')}`;
    }
    fs.writeFileSync(target, text);
    return [null, `compiled ${gates.length} gate(s)\r\n`, ''];
  }
  return fail(`the stand-in has no answer for ${args.join(' ')}`);
}

// A synthetic memory in the shape Claude Code's memory writer emits.
function memoryText({ scope, gate, agents, title }) {
  return '---\nname: a synthetic memory\ndescription: for the panel tests\nmetadata:\n'
    + `  type: feedback\n  scope: ${scope}\n${agents ? `  agents: ${agents}\n` : ''}---\n\nThe body.\n`
    + (gate ? `\n<!-- gate -->\n- **${title || gate}** ${gate}\n<!-- /gate -->\n` : '');
}

const MEMORIES = {
  'feedback_gadget_rule.md': { scope: 'global', gate: 'Never ship a gadget index unrebuilt.' },
  'feedback_widget_rule.md': { scope: 'retired', gate: 'Reset the widget cache first.' },
  'reference_codex_rule.md': { scope: 'global', gate: 'Codex reads the sprocket log first.', agents: '[codex]' },
};

// ── the harness ───────────────────────────────────────────────────────────────
// The extension, under a stubbed vscode, in a temp home holding CLAUDE.md, AGENTS.md and a memory
// store. execFile answers through `respond` (default: the stand-in above) on a later turn. The
// toolbox Python and recall.py are files that exist and are never run.
function harness(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-gates-panel-'));
  const home = path.join(root, 'home');
  const localAppData = path.join(root, 'localappdata');
  const store = path.join(home, '.claude', 'projects', 'proj-alpha', 'memory');
  fs.mkdirSync(store, { recursive: true });
  fs.writeFileSync(path.join(store, 'MEMORY.md'), '# Memory Index\n');
  for (const [file, spec] of Object.entries(options.memories || MEMORIES)) fs.writeFileSync(path.join(store, file), memoryText(spec));
  const claudeMd = path.join(home, '.claude', 'CLAUDE.md');
  fs.writeFileSync(claudeMd, '# Mine\n');
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{}\n');
  const codexHome = path.join(home, '.codex');
  const agentsMd = path.join(codexHome, 'AGENTS.md');
  if (options.codex !== false) {
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(agentsMd, '# Mine\n');
  }
  const python = path.join(localAppData, 'DevToolbox', 'python', '.venv', 'Scripts', 'python.exe');
  if (options.python !== false) {
    fs.mkdirSync(path.dirname(python), { recursive: true });
    fs.writeFileSync(python, '');
  }
  const script = path.join(root, 'checkout', 'memory', 'recall.py');
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, '# stand-in\n');
  // The USER tier: every machine-scoped key is read through inspect().globalValue.
  const settings = { 'memory.recallScript': script, 'gates.enabled': options.gatesOn !== false,
    'guidance.enabled': false, 'autoLearn.enabled': false, ...(options.settings || {}) };

  const spawns = [];
  const panels = [];
  const opened = [];
  const dialogs = [];
  const errors = [];
  const warnings = [];
  const infos = [];
  const logged = [];
  const commands = new Map();
  const watchers = [];
  const bumps = [];   // the 2 s corpus-recompile timers, held for a test to fire
  const faults = { ...(options.faults || {}) };
  let answer = options.answer;
  let respond = options.respond || ((args, env) => stubRecall(args, env, home, faults));

  const vscode = {
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ViewColumn: { Active: -1, Beside: -2 },
    RelativePattern: class RelativePattern { constructor(base, pattern) { this.base = base; this.pattern = pattern; } },
    ThemeColor: class ThemeColor { constructor(id) { this.id = id; } },
    Uri: { file: (fsPath) => ({ fsPath }) },
    commands: {
      registerCommand(id, handler) { commands.set(id, handler); return disposable(); },
      executeCommand: () => Promise.resolve(),
    },
    window: {
      registerWebviewViewProvider: () => disposable(),
      createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
      createOutputChannel: () => ({ appendLine() {}, append() {}, clear() {}, show() {}, dispose() {} }),
      setStatusBarMessage: () => disposable(),
      showErrorMessage(message) { errors.push(String(message)); return Promise.resolve(); },
      showInformationMessage(message) { infos.push(String(message)); return Promise.resolve(); },
      showWarningMessage(message, ...rest) {
        warnings.push(String(message));
        if (rest[0] && typeof rest[0] === 'object') dialogs.push({ message: String(message), options: rest[0], actions: rest.slice(1) });
        const reply = typeof answer === 'function' ? answer(String(message)) : answer;
        return Promise.resolve(reply);
      },
      showTextDocument(uri, opts) { opened.push({ uri, opts }); return Promise.resolve({}); },
      createWebviewPanel(viewType, title, column, panelOptions) {
        const on = {};
        const panel = {
          viewType, title, column, options: panelOptions, posted: [], disposed: false, revealed: 0,
          webview: {
            html: '',
            postMessage(message) { panel.posted.push(message); return Promise.resolve(true); },
            onDidReceiveMessage(cb) { on.message = cb; return disposable(); },
          },
          onDidDispose(cb) { on.dispose = cb; return disposable(); },
          reveal() { panel.revealed += 1; },
          dispose() { if (!panel.disposed) { panel.disposed = true; if (on.dispose) on.dispose(); } },
          send(message) { on.message(message); },
          last(type) { return panel.posted.filter((message) => message.type === type).pop(); },
        };
        panels.push(panel);
        return panel;
      },
    },
    workspace: {
      isTrusted: true,
      workspaceFolders: [{ uri: { fsPath: path.join(root, 'workspace') } }],
      getConfiguration: () => ({
        get: (key, fallback) => (Object.prototype.hasOwnProperty.call(settings, key) ? settings[key] : fallback),
        inspect: (key) => (Object.prototype.hasOwnProperty.call(settings, key) ? { globalValue: settings[key] } : {}),
        update: async (key, value) => { settings[key] = value; },
      }),
      createFileSystemWatcher(pattern) {
        const handlers = { change: [], create: [], delete: [] };
        const watcher = { pattern, handlers, onDidChange(fn) { handlers.change.push(fn); }, onDidCreate(fn) { handlers.create.push(fn); },
          onDidDelete(fn) { handlers.delete.push(fn); }, dispose() {} };
        watchers.push(watcher);
        return watcher;
      },
      onDidChangeConfiguration: () => disposable(),
      onDidChangeWorkspaceFolders: () => disposable(),
    },
  };

  const savedEnv = Object.fromEntries(['HOME', 'USERPROFILE', 'LOCALAPPDATA', 'CODEX_HOME', 'CODEX_TOOLBOX',
    'RECALL_MEMORY_DIR', 'RECALL_MODEL_DIR', 'AI_ACOLYTE_GATE_SNAPSHOT_DIR'].map((key) => [key, process.env[key]]));
  Object.assign(process.env, { HOME: home, USERPROFILE: home, LOCALAPPDATA: localAppData, CODEX_HOME: codexHome });
  for (const key of ['CODEX_TOOLBOX', 'RECALL_MEMORY_DIR', 'RECALL_MODEL_DIR', 'AI_ACOLYTE_GATE_SNAPSHOT_DIR']) delete process.env[key];
  const savedSetTimeout = global.setTimeout;
  global.setTimeout = (fn, ms, ...rest) => {
    // The corpus watcher's recompile is held for the test to fire; everything else runs, unref'd.
    if (ms === 2000) { const entry = { fn, cleared: false }; bumps.push(entry); return entry; }
    const handle = savedSetTimeout(fn, ms, ...rest);
    if (typeof handle?.unref === 'function') handle.unref();
    return handle;
  };
  const savedClearTimeout = global.clearTimeout;
  global.clearTimeout = (handle) => {
    if (handle && bumps.includes(handle)) { handle.cleared = true; return; }
    savedClearTimeout(handle);
  };
  const savedError = console.error;
  console.error = (...args) => { logged.push(args.map(String).join(' ')); };

  const fakeOs = { ...os, homedir: () => home };
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === 'vscode') return vscode;
    if (request === 'os') return fakeOs;
    const fromExtension = parent && parent.filename === extensionPath;
    if (fromExtension && request === 'child_process') {
      const real = originalLoad.call(this, request, parent, isMain);
      return {
        ...real,
        execFile(file, args, execOptions, callback) {
          const spawn = { file, args, options: execOptions, answered: false, killed: false };
          const child = { on() { return child; }, once() { return child; }, kill() { spawn.killed = true; return true; } };
          spawns.push(spawn);
          setImmediate(() => {
            const reply = respond(args.slice(1), execOptions.env || {});
            if (reply) { spawn.answered = true; callback(...reply); }
          });
          return child;
        },
      };
    }
    if (fromExtension && request === './codexMemoryGatesUi') {
      return { createCodexMemoryGatesUi: () => ({ activate() {}, dispose() {}, review() {}, status() { return {}; } }) };
    }
    if (fromExtension && request === './memoryLint') {
      // The compile store, as memoryReport() names it: memory.dir, else the largest store.
      return {
        MemoryLint: class MemoryLint { activate() {} onReconcile() { return disposable(); } },
        memoryReport: () => ({ conf: {}, dir: options.storeDir === undefined ? store : options.storeDir(), report: null }),
        memoryStoreDir: () => (options.storeDir === undefined ? store : options.storeDir()),
        cfg: () => ({ enabled: true, dir: '', lineBudget: 300, totalBudget: 12000, maxLines: 200 }),
        discoverDirs: () => [store],
      };
    }
    if (fromExtension && request.startsWith('./src/')) {
      return originalLoad.call(this, path.join(rootSrc, request.slice('./src/'.length)), parent, isMain);
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  purgeProjectModules();
  const extension = require(extensionPath);
  extension.activate({ subscriptions: [] });

  const app = {
    root, home, store, python, script, settings, spawns, panels, opened, dialogs, errors, warnings, infos, logged,
    claudeMd, agentsMd, faults, bumps, watchers, extension,
    respond(fn) { respond = fn; },
    answer(value) { answer = value; },
    memory: (file) => fs.readFileSync(path.join(store, file), 'utf8'),
    claude: () => fs.readFileSync(claudeMd, 'utf8'),
    codex: () => fs.readFileSync(agentsMd, 'utf8'),
    calls: () => spawns.map((spawn) => spawn.args.slice(1)),
    // Open the panel and, unless told not to, let the page ask for its first list.
    async open({ ready = true } = {}) {
      await commands.get('permission-wildcarding.manageGates')();
      const panel = panels[panels.length - 1];
      if (ready) {
        panel.send({ type: 'ready' });
        await until(() => panel.last('gates'), 'the first list');
      }
      return panel;
    },
    // Send a request and wait for the run to end (busy:false).
    async request(panel, message) {
      const from = panel.posted.length;
      panel.send(message);
      await until(() => panels.some((p) => p.posted.slice(p === panel ? from : 0).some((m) => m.type === 'busy' && m.busy === false)),
        `the end of ${message.type}`);
    },
    // The *.md watcher of the store, fired as VS Code fires it for `file`.
    fireCorpus(file) {
      for (const watcher of watchers) {
        if (watcher.pattern?.pattern !== '*.md') continue;
        for (const fn of watcher.handlers.change) fn({ fsPath: path.join(store, file) });
      }
    },
    async dispose() {
      try { await extension.deactivate(); } catch { /* best effort */ }
      Module._load = originalLoad;
      global.setTimeout = savedSetTimeout;
      global.clearTimeout = savedClearTimeout;
      console.error = savedError;
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      purgeProjectModules();
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
  return app;
}

// ── the page's own script, against a thin DOM ─────────────────────────────────

// Every element the script creates or finds is recorded, and innerHTML is a setter that records
// what it was handed, so "nothing parsed memory text as HTML" is a fact about the run rather than
// about the source. textContent clears children, as the real one does. Focus is modelled where
// the page depends on it: focus() moves it to an enabled, attached element and fires `focusin` on
// the document; disabling the focused control, or taking it out of the document (a relist empties
// the list), leaves the page body focused.
function fakeDom() {
  const byId = new Map();
  const created = [];
  const innerHTML = [];
  const documentListeners = {};
  let focused = null;
  const make = (tag, inDocument = false) => {
    const listeners = {};
    const attributes = {};
    let text = '';
    let disabled = false;
    const element = {
      tag: String(tag).toLowerCase(), children: [], parent: null, dataset: {}, style: {}, className: '', title: '',
      hidden: false, checked: false, type: '', value: '', id: '',
      get disabled() { return disabled; },
      set disabled(value) { disabled = !!value; if (disabled && focused === element) focused = null; },
      get isConnected() { let node = element; while (node.parent) node = node.parent; return node === element ? inDocument : node.isConnected; },
      get textContent() { return text + element.children.map((child) => child.textContent).join(''); },
      set textContent(value) {
        text = String(value);
        for (const child of element.children) child.parent = null;
        element.children.length = 0;
      },
      get innerHTML() { return ''; },
      set innerHTML(value) { innerHTML.push(String(value)); },
      setAttribute(name, value) { attributes[name] = String(value); },
      getAttribute(name) { return attributes[name]; },
      appendChild(child) { child.parent = element; element.children.push(child); return child; },
      addEventListener(name, callback) { (listeners[name] || (listeners[name] = [])).push(callback); },
      fire(name) { for (const callback of listeners[name] || []) callback({ preventDefault() {} }); },
      click() { if (!element.disabled) element.fire('click'); },
      focus() {
        if (element.disabled || element.hidden || !element.isConnected) return;
        focused = element;
        for (const callback of documentListeners.focusin || []) callback({ target: element });
      },
    };
    return element;
  };
  const body = make('body', true);
  const document = {
    body,
    get activeElement() { return focused && focused.isConnected ? focused : body; },
    getElementById(id) {
      if (!byId.has(id)) byId.set(id, make('#' + id, true));
      return byId.get(id);
    },
    createElement(tag) { const element = make(tag); created.push(element); return element; },
    addEventListener(name, callback) { (documentListeners[name] || (documentListeners[name] = [])).push(callback); },
  };
  return { document, byId, created, innerHTML };
}

function scriptOf(html) {
  const opening = html.indexOf('<script nonce=');
  return html.slice(html.indexOf('>', opening) + 1, html.indexOf('</script>', opening));
}

function runPage(html, state = {}) {
  const dom = fakeDom();
  const posted = [];
  const listeners = {};
  let saved = state;
  const api = { getState: () => saved, setState: (value) => { saved = value; }, postMessage: (payload) => posted.push(payload) };
  const win = { addEventListener(name, callback) { (listeners[name] || (listeners[name] = [])).push(callback); } };
  // eslint-disable-next-line no-new-func
  new Function('acquireVsCodeApi', 'document', 'window', scriptOf(html))(() => api, dom.document, win);
  const el = (id) => dom.byId.get(id);
  // The rows, in order: each the checkbox, the file-name button and the whole row element.
  const rows = () => el('list').children.map((node) => {
    const [box, body] = node.children;
    const [head] = body.children;
    return { node, box, file: head.children[0], head, body, tags: head.children.slice(1).map((child) => child.textContent) };
  });
  return {
    dom, posted, el, rows,
    get state() { return saved; },
    deliver(data) { for (const callback of listeners.message || []) callback({ data }); },
  };
}

// Markup in every field a memory supplies. Any of it parsed as HTML would run or load something.
const HOSTILE = '<script>window.pwned = 1</script><img src=x onerror="window.pwned = 2">';
const hostileList = () => [null, JSON.stringify({ store: '/s', gates: [
  { file: 'feedback_gadget_rule.md', scope: 'global', state: 'active', agents: ['claude', 'codex'], problem: null,
    title: 'Never ship a gadget index unrebuilt.', text: '- Never ship a gadget index unrebuilt.', description: 'A standing order' },
  { file: 'feedback_widget_rule.md', scope: 'retired', state: 'retired', agents: ['codex'], problem: null,
    title: `Reset the widget cache ${HOSTILE}`, text: `- Reset the widget cache ${HOSTILE}\n  Second line.`, description: `Why ${HOSTILE}` },
  { file: 'feedback_unknown.md', scope: 'global', state: 'excluded', agents: [], problem: '`agents:` names an agent this compiler does not know: gemini',
    title: 'Unknown agent.', text: '- Unknown agent.', description: '' },
] }), ''];

test('the panel is served under a nonce CSP with one script, and holds no memory text of its own', async () => {
  const app = harness();
  try {
    const panel = await app.open();
    const html = panel.webview.html;
    const csp = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/)[1];
    const nonce = csp.match(/script-src 'nonce-([0-9a-f]{32})'$/)[1];
    assert.equal(csp, `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'`);
    assert.equal(html.split('<script').length - 1, 1, 'one script element');
    assert.ok(html.includes(`<script nonce="${nonce}">`), 'and it carries the nonce the policy names');
    assert.doesNotMatch(html, /<script[^>]*\ssrc=|unsafe-eval|https?:\/\//);
    // The list arrives by postMessage, so not one byte a memory supplies is in the document.
    for (const spec of Object.values(MEMORIES)) assert.ok(!html.includes(spec.gate), spec.gate);
    for (const file of Object.keys(MEMORIES)) assert.ok(!html.includes(file), file);
    assert.match(html, /<title>AI Acolyte: memory gates<\/title>/);
    // The template literal's own rules, held for the script it serves.
    const script = scriptOf(html);
    assert.equal(/[`\\]|\$\{/.test(script), false, 'no backtick, backslash or dollar-brace in the page script');
    // The page says what it acts on: both instruction files, and the one store that compiles.
    assert.match(html, /CLAUDE\.md and\s+AGENTS\.md/);
    assert.match(html, /Only the store below compiles: memory\.dir when it is set, else the store\s+with the most memory files/);

    panel.dispose();
    const again = await app.open({ ready: false });
    assert.notEqual(again.webview.html.match(/nonce-([0-9a-f]+)/)[1], nonce, 'a fresh nonce per panel');
  } finally { await app.dispose(); }
});

test('a gate whose text holds <script> and <img onerror> renders as inert text', async () => {
  const app = harness({ respond: (args) => (args[0] === '--gates-list' ? hostileList() : [new Error('unexpected'), '', '']) });
  try {
    const panel = await app.open();
    const page = runPage(panel.webview.html);
    assert.deepEqual(page.posted, [{ type: 'ready' }], 'the page asks for its list');
    page.deliver(panel.last('gates'));
    assert.deepEqual(page.dom.innerHTML, [], 'nothing on the page assigned innerHTML');
    const tags = [...new Set(page.dom.created.map((element) => element.tag))].sort();
    assert.deepEqual(tags, ['b', 'button', 'details', 'div', 'input', 'pre', 'span', 'summary'],
      'only the elements the page builds itself, none parsed out of a memory');
    const hostile = page.rows()[1];
    assert.ok(hostile.node.textContent.includes(HOSTILE), 'the markup is shown, character for character');
    const pre = page.dom.created.find((element) => element.tag === 'pre' && element.textContent.includes('Second line.'));
    assert.equal(pre.textContent, `- Reset the widget cache ${HOSTILE}\n  Second line.`, 'the whole gate text, folded under its title');
    // And the source agrees: no HTML-parsing sink anywhere in the page's script.
    assert.doesNotMatch(scriptOf(panel.webview.html),
      /\.(?:innerHTML|outerHTML)\b|insertAdjacentHTML\s*\(|document\.write|\beval\s*\(|new Function|srcdoc/);
  } finally { await app.dispose(); }
});

test('the page lists every gate with its state and agents, and Apply counts what changed', async () => {
  const app = harness({ respond: (args) => (args[0] === '--gates-list' ? hostileList() : [new Error('unexpected'), '', '']) });
  try {
    const panel = await app.open();
    const page = runPage(panel.webview.html);
    page.deliver(panel.last('gates'));
    const [gadget, widget, unknown] = page.rows();
    assert.equal(page.el('counts').textContent, '1 active, 1 retired, 1 left out · CLAUDE.md loads 1, AGENTS.md loads 1');
    assert.equal(page.el('store').textContent, 'Memory store (the one that compiles): /s');
    assert.deepEqual([gadget.box.checked, widget.box.checked, unknown.box.checked], [true, false, true],
      'checked means scope: global, which a gate left out for its agents: still is');
    assert.equal(gadget.file.textContent, 'feedback_gadget_rule.md');
    assert.deepEqual(gadget.tags.filter(Boolean), []);
    assert.deepEqual(widget.tags.filter(Boolean), ['retired', 'codex only'], 'a retired Codex-only gate says both');
    assert.deepEqual(unknown.tags.filter(Boolean), ['left out for every agent: `agents:` names an agent this compiler does not know: gemini']);
    assert.equal(page.el('apply').disabled, true, 'nothing changed yet');
    assert.equal(page.el('apply').textContent, 'Apply changes');
    assert.equal(page.el('finish').disabled, false, 'Compile and install is always there');

    gadget.box.checked = false;
    gadget.box.fire('change');
    assert.equal(page.el('apply').textContent, 'Retire 1, restore 0');
    assert.ok(gadget.head.children.some((child) => child.textContent === 'will retire'));
    widget.box.checked = true;
    widget.box.fire('change');
    assert.equal(page.el('apply').textContent, 'Retire 1, restore 1');
    widget.box.checked = false;
    widget.box.fire('change');
    assert.equal(page.el('apply').textContent, 'Retire 1, restore 0', 'back to the listed state is no change');

    page.el('revert').click();
    assert.equal(gadget.box.checked, true, 'Revert puts the box back');
    assert.equal(page.el('apply').disabled, true);

    widget.box.checked = true;
    widget.box.fire('change');
    page.el('apply').click();
    assert.deepEqual(page.posted.slice(1), [{ type: 'apply', store: '/s', retire: [], restore: ['feedback_widget_rule.md'] }],
      'the names, and the store the page was shown');
    assert.equal(page.el('apply').disabled, true, 'busy from the click, so a double click cannot send twice');
    assert.equal(page.el('finish').disabled, true);
    page.el('apply').click();
    assert.equal(page.posted.length, 2);
    page.deliver({ type: 'busy', busy: false });
    page.deliver({ type: 'result', ok: false, text: 'something failed' });
    assert.equal(page.el('notice').textContent, 'something failed');
    assert.equal(page.el('notice').className, 'notice error');
    page.el('finish').click();
    assert.deepEqual(page.posted.pop(), { type: 'finish', store: '/s' });
    page.deliver({ type: 'busy', busy: false });
    gadget.file.click();
    assert.deepEqual(page.posted.pop(), { type: 'openMemory', file: 'feedback_gadget_rule.md' });
  } finally { await app.dispose(); }
});

test('the filter narrows the list, and a change survives the page being rebuilt', async () => {
  const app = harness({ respond: (args) => (args[0] === '--gates-list' ? hostileList() : [new Error('unexpected'), '', '']) });
  try {
    const panel = await app.open();
    const page = runPage(panel.webview.html);
    page.deliver(panel.last('gates'));
    page.el('filter').value = 'WIDGET';
    page.el('filter').fire('input');
    assert.deepEqual(page.rows().map((row) => row.node.hidden), [true, false, true], 'case-blind, over name and text');
    page.el('filter').value = 'codex only';
    page.el('filter').fire('input');
    assert.deepEqual(page.rows().map((row) => row.node.hidden), [true, false, true], 'and over the agents note');
    page.el('filter').value = 'nothing like this';
    page.el('filter').fire('input');
    assert.equal(page.el('nomatch').hidden, false);
    page.el('filter').value = '';
    page.el('filter').fire('input');
    const [gadget] = page.rows();
    gadget.box.checked = false;
    gadget.box.fire('change');
    // VS Code rebuilds a hidden panel's page from scratch; its state comes back from getState.
    const rebuilt = runPage(panel.webview.html, page.state);
    rebuilt.deliver(panel.last('gates'));
    assert.equal(rebuilt.rows()[0].box.checked, false, 'the pending retire is still there');
    assert.equal(rebuilt.el('apply').textContent, 'Retire 1, restore 0');
    // An apply that went through lists the new state, and the pending change drops out.
    const listed = panel.last('gates');
    rebuilt.deliver({ ...listed, gates: [{ ...listed.gates[0], state: 'retired' }, ...listed.gates.slice(1)] });
    assert.equal(rebuilt.el('apply').textContent, 'Apply changes');
  } finally { await app.dispose(); }
});

test('with no toolbox Python the panel says so, shows no checkboxes, and spawns nothing', async () => {
  const app = harness({ python: false });
  try {
    const panel = await app.open();
    const message = panel.last('gates');
    assert.equal(message.gates, null);
    assert.match(message.unavailable, /^The toolbox Python is needed to list the gates, and there is none at .*python\.exe\./);
    assert.equal(app.spawns.length, 0);
    const page = runPage(panel.webview.html);
    page.deliver(message);
    assert.equal(page.el('list').children.length, 0, 'no checkboxes');
    assert.equal(page.el('toolbar').hidden, true, 'no filter');
    assert.equal(page.el('actions').hidden, true, 'and no Apply');
    assert.equal(page.el('notice').textContent, message.unavailable);
  } finally { await app.dispose(); }
});

test('a failed list and a list that is not JSON each reach the panel as a sentence', async () => {
  const app = harness({ respond: () => [Object.assign(new Error('exit 1'), { code: 1 }), '', '[recall] cannot read feedback_x.md'] });
  try {
    const failed = (await app.open()).last('gates');
    assert.equal(failed.gates, null);
    assert.equal(failed.error, 'recall.py --gates-list failed: [recall] cannot read feedback_x.md');
    app.respond(() => [null, 'not json', '']);
    const panel = app.panels[0];
    panel.send({ type: 'ready' });
    await until(() => panel.posted.filter((m) => m.type === 'gates').length === 2, 'the second list');
    assert.match(panel.last('gates').error, /^recall\.py --gates-list did not print JSON/);
  } finally { await app.dispose(); }
});

test('the list steps run the toolbox Python on recall.py, pinned to the compile store', async () => {
  const app = harness();
  try {
    await app.open();
    const [list] = app.spawns;
    assert.equal(list.file, app.python, 'the toolbox Python, never one on PATH');
    assert.deepEqual(list.args, [app.script, '--gates-list'], 'the recall.py the user tier names');
    assert.equal(list.options.env.RECALL_MEMORY_DIR, app.store, 'the store memoryReport names, which is the one that compiles');
    assert.equal(list.options.env.RECALL_REEXEC, '1');
    // MUTATION: drop the RECALL_MEMORY_DIR pin from gateCompileEnv and this fails: recall.py would
    // pick a store by its own discovery, which can be another one than the compile reads.
  } finally { await app.dispose(); }
});

test('the extension sends the page only the fields it renders, each made safe to show', async () => {
  const rlo = String.fromCharCode(0x202e);
  const app = harness({ respond: () => [null, JSON.stringify({ store: '/s', gates: [
    { file: `feedback_${rlo}a.md`, scope: 'global', state: 'active', agents: ['codex'], problem: null,
      title: `t${rlo}`, text: `x\r\ny${rlo}`, description: `d${rlo}`, extra: '<b>no</b>' },
  ], other: 1 }), 'a warning about another store'] });
  try {
    const message = (await app.open()).last('gates');
    assert.deepEqual(message.gates, [{ file: `feedback_${rlo}a.md`, label: 'feedback_?a.md', state: 'active', agents: ['codex'],
      only: 'codex only', problem: '', title: 't?', text: 'x\ny?', description: 'd?' }]);
    assert.equal(message.warning, 'a warning about another store', 'a successful list\'s stderr is passed on');
    assert.equal(message.off, '', 'gates.enabled is on, so gates are on, with nothing installed yet');
    // MUTATION: send gate.title unfiltered (drop forDisplay) and the deepEqual fails on the RLO.
  } finally { await app.dispose(); }
});

// ── the arms ──────────────────────────────────────────────────────────────────

test('openMemory opens only a name the last list held, and only as a bare name', async () => {
  const app = harness();
  try {
    const panel = await app.open({ ready: false });
    panel.send({ type: 'openMemory', file: 'feedback_gadget_rule.md' });
    assert.deepEqual(app.opened, [], 'before any list, nothing is a listed name');
    panel.send({ type: 'ready' });
    await until(() => panel.last('gates'), 'the list');
    panel.send({ type: 'openMemory', file: 'feedback_gadget_rule.md' });
    assert.equal(app.opened.length, 1);
    assert.equal(app.opened[0].uri.fsPath, path.join(app.store, 'feedback_gadget_rule.md'));
    assert.equal(app.opened[0].opts.viewColumn, -2, 'beside the panel');
    for (const file of ['project_alpha.md', 'MEMORY.md', '../feedback_gadget_rule.md', `${app.store}${path.sep}feedback_gadget_rule.md`,
      'sub/feedback_gadget_rule.md', 'feedback_gadget_rule', 7, null, { file: 'feedback_gadget_rule.md' }]) {
      panel.send({ type: 'openMemory', file });
    }
    assert.equal(app.opened.length, 1, 'nothing else was opened');
    assert.equal(app.logged.filter((line) => /not a listed gate memory, so nothing was opened/.test(line)).length, 10);
  } finally { await app.dispose(); }
});

// recall.py lists names from os.listdir, so a path never reaches the list from it. A configured
// memory.recallScript is any script at all, though, and its list is no more trusted than the
// page: a listed name that is a path still opens nothing.
test('openMemory refuses a listed name that is a path, whatever printed the list', async () => {
  const escape = path.join('..', '..', 'CLAUDE.md');
  const app = harness({ respond: () => [null, JSON.stringify({ store: '/s', gates: [
    { file: escape, scope: 'global', state: 'active', agents: ['claude', 'codex'], problem: null, title: 't', text: 'x', description: '' },
  ] }), ''] });
  try {
    const panel = await app.open();
    assert.equal(panel.last('gates').gates[0].file, escape, 'precondition: the list does name it');
    panel.send({ type: 'openMemory', file: escape });
    assert.deepEqual(app.opened, []);
    // MUTATION: drop the path.basename test in openListedMemory and this opens ../../CLAUDE.md.
  } finally { await app.dispose(); }
});

test('a message from a panel that was closed is ignored, even an apply', async () => {
  const app = harness({ answer: 'Apply' });
  try {
    const old = await app.open();
    old.dispose();
    await app.open();
    const before = app.spawns.length;
    old.send({ type: 'apply', store: app.store, retire: ['feedback_gadget_rule.md'], restore: [] });
    old.send({ type: 'ready' });
    await settleOnce();
    await settleOnce();
    assert.equal(app.spawns.length, before, 'the closed panel started nothing');
    assert.deepEqual(app.dialogs, []);
  } finally { await app.dispose(); }
});

test('the panel can ask for four things, and nothing else reaches a spawn, a command or a file', async () => {
  const app = harness();
  try {
    const panel = await app.open();
    const before = app.spawns.length;
    for (const msg of [{ type: 'refresh' }, { type: 'toggleGates' }, { type: 'permission-wildcarding.manageGates' },
      { type: 'executeCommand', command: 'workbench.action.reloadWindow' }, { type: 'compile' }, null, 'apply', 42]) {
      assert.doesNotThrow(() => panel.send(msg));
    }
    await settleOnce();
    assert.equal(app.spawns.length, before);
    assert.deepEqual([...app.errors, ...app.warnings, ...app.opened], []);
  } finally { await app.dispose(); }
});

test('an apply naming anything the fresh list does not hold is refused, and nothing is edited', async () => {
  const app = harness({ answer: 'Apply' });
  try {
    const panel = await app.open();
    const refusals = [
      [{ retire: ['project_alpha.md'], restore: [] }, /project_alpha\.md is not in the gate list recall\.py printed\. Refused: nothing was changed\.$/],
      // planGateChanges would add the .md and accept it; the page only ever sends listed names.
      [{ retire: ['feedback_gadget_rule'], restore: [] }, /feedback_gadget_rule is not in the gate list/],
      [{ retire: ['../feedback_gadget_rule.md'], restore: [] }, /\.\.\/feedback_gadget_rule\.md is not in the gate list/],
      [{ retire: ['feedback_gadget_rule.md', 'reference_x.md', 'reference_y.md'], restore: [] }, /reference_x\.md, reference_y\.md are not in the gate list/],
      [{ retire: ['feedback_widget_rule.md'], restore: [] }, /feedback_widget_rule\.md is already retired\. Refused: nothing was changed\./],
      [{ retire: [], restore: ['feedback_gadget_rule.md'] }, /feedback_gadget_rule\.md is already active/],
      [{ retire: ['feedback_gadget_rule.md'], restore: ['feedback_gadget_rule.md'] }, /named both to retire and to restore/],
      [{ retire: [], restore: [] }, /nothing to retire or restore/],
    ];
    for (const [request, expected] of refusals) {
      app.errors.length = 0;
      await app.request(panel, { type: 'apply', store: app.store, ...request });
      assert.equal(app.errors.length, 1, JSON.stringify(request));
      assert.match(app.errors[0], expected);
      assert.equal(panel.last('result').ok, false);
    }
    assert.deepEqual(app.calls().filter((args) => args[0] !== '--gates-list'), [], 'no edit, no compile');
    assert.deepEqual(app.dialogs, [], 'and no modal');
  } finally { await app.dispose(); }
});

test('a request that is not two lists of names and a store is refused before anything runs', async () => {
  const app = harness({ answer: 'Apply' });
  try {
    const panel = await app.open();
    const listed = app.spawns.length;
    const bad = [
      { type: 'apply', retire: 'feedback_gadget_rule.md', restore: [], store: app.store },
      { type: 'apply', retire: ['feedback_gadget_rule.md'], store: app.store },
      { type: 'apply', retire: [7], restore: [], store: app.store },
      { type: 'apply', retire: [''], restore: [], store: app.store },
      { type: 'apply', retire: ['x'.repeat(256)], restore: [], store: app.store },
      { type: 'apply', retire: Array.from({ length: 1001 }, () => 'feedback_gadget_rule.md'), restore: [], store: app.store },
      { type: 'apply', retire: ['feedback_gadget_rule.md'], restore: [] },
      { type: 'apply', retire: ['feedback_gadget_rule.md'], restore: [], store: 7 },
      { type: 'finish' },
    ];
    for (const request of bad) await app.request(panel, request);
    assert.equal(app.errors.length, bad.length);
    for (const error of app.errors) assert.match(error, /the gates panel sent a request AI Acolyte cannot read\. Refused: nothing was changed\./);
    assert.equal(app.spawns.length, listed, 'not even a list');
    assert.deepEqual(app.dialogs, []);
  } finally { await app.dispose(); }
});

// ── the apply, end to end ─────────────────────────────────────────────────────

const sectionOf = (text) => text.slice(text.indexOf(GATES_BEGIN));

test('retiring one gate: a fresh list, a modal, the edit, the compile, then the install, in that order', async () => {
  const app = harness({ answer: 'Apply', memories: {
    'feedback_gadget_rule.md': { scope: 'global', gate: 'Never ship a gadget index unrebuilt.' },
    'feedback_spare_rule.md': { scope: 'global', gate: 'Keep a spare sprocket.' },
  } });
  try {
    // Installed first, through the same panel, so both files hold both gates.
    const panel = await app.open();
    await app.request(panel, { type: 'finish', store: app.store });
    assert.ok(app.claude().includes('Never ship a gadget') && app.codex().includes('Never ship a gadget'), 'precondition');
    const before = app.memory('feedback_gadget_rule.md');
    const spawnsBefore = app.spawns.length;

    await app.request(panel, { type: 'apply', store: app.store, retire: ['feedback_gadget_rule.md'], restore: [] });
    assert.deepEqual(app.calls().slice(spawnsBefore), [['--gates-list'], ['--gates-retire=feedback_gadget_rule.md'], ['--gates-compile'], ['--gates-list']],
      'list, edit, compile, then the fresh list the panel is shown');
    const [dialog] = app.dialogs;
    assert.equal(dialog.message, 'Retire 1 gate?');
    assert.deepEqual(dialog.actions, ['Apply']);
    assert.equal(dialog.options.modal, true);
    assert.match(dialog.options.detail, /^Retire 1 gate: feedback_gadget_rule\.md\nA snapshot of the memory folder is taken first\.\nFrom the next session:\n {2}CLAUDE\.md: 1 gate will load \(2 now\)\.\n {2}AGENTS\.md: 1 gate will load \(2 now\)\./);
    assert.match(dialog.options.detail, /\n\nMemory store: .*proj-alpha.memory\nOnly this store compiles/);
    assert.equal(app.memory('feedback_gadget_rule.md'), before.replace('scope: global', 'scope: retired'));
    for (const text of [app.claude(), app.codex()]) {
      assert.ok(!text.includes('Never ship a gadget') && text.includes('Keep a spare sprocket'), 'retired from both, the other kept');
    }
    const result = panel.last('result');
    assert.equal(result.ok, true);
    assert.match(result.text, /^retired feedback_gadget_rule\.md\. CLAUDE\.md loads 1 gate from the next session; AGENTS\.md loads 1 gate from the next session\. Snapshot of the memory folder: .*gate-snapshots.*retire\.$/);
    assert.equal(app.infos.length, 2, 'one toast for the install, one for the retire');
    assert.ok(!fs.existsSync(path.join(app.home, '.claude', 'wildcarding', `pending-gates.${process.pid}.json`)),
      'the pending record is removed once the user is told');
  } finally { await app.dispose(); }
});

test('retiring a Codex-only gate changes AGENTS.md alone, and the modal says CLAUDE.md is not changed', async () => {
  const app = harness({ answer: 'Apply' });
  try {
    const panel = await app.open();
    await app.request(panel, { type: 'finish', store: app.store });
    assert.ok(app.codex().includes('Codex reads the sprocket') && !app.claude().includes('Codex reads the sprocket'), 'precondition');
    const claudeBytes = fs.readFileSync(app.claudeMd);
    const claudeMtime = fs.statSync(app.claudeMd).mtimeMs;
    const memoryBefore = app.memory('reference_codex_rule.md');

    await app.request(panel, { type: 'apply', store: app.store, retire: ['reference_codex_rule.md'], restore: [] });
    assert.match(app.dialogs[0].options.detail, /\n {2}CLAUDE\.md: not changed by this, 1 gate \(1 now\)\.\n {2}AGENTS\.md: 1 gate will load \(2 now\)\./);
    assert.ok(fs.readFileSync(app.claudeMd).equals(claudeBytes), 'CLAUDE.md is byte for byte what it was');
    assert.equal(fs.statSync(app.claudeMd).mtimeMs, claudeMtime, 'and was not rewritten');
    assert.ok(!app.codex().includes('Codex reads the sprocket') && app.codex().includes('Never ship a gadget'));
    assert.equal(app.memory('reference_codex_rule.md'), memoryBefore.replace('scope: global', 'scope: retired'),
      'the agents: line survives, so a restore returns it to Codex alone');

    await app.request(panel, { type: 'apply', store: app.store, retire: [], restore: ['reference_codex_rule.md'] });
    assert.ok(fs.readFileSync(app.claudeMd).equals(claudeBytes), 'the restore does not reach CLAUDE.md either');
    assert.ok(app.codex().includes('Codex reads the sprocket'));
    // MUTATION: in describePlan, word every agent from plan.activeAfter and the first match fails.
  } finally { await app.dispose(); }
});

test('retiring every gate removes the blocks; with the setting still on, a restore installs them again', async () => {
  const app = harness({ answer: 'Apply', memories: { 'feedback_gadget_rule.md': { scope: 'global', gate: 'Never ship a gadget index unrebuilt.' } } });
  try {
    const panel = await app.open();
    await app.request(panel, { type: 'finish', store: app.store });
    assert.ok(app.claude().includes(GATES_BEGIN), 'precondition');
    const from = app.spawns.length;
    await app.request(panel, { type: 'apply', store: app.store, retire: ['feedback_gadget_rule.md'], restore: [] });
    assert.deepEqual(app.calls().slice(from, from + 3), [['--gates-list'], ['--gates-retire=feedback_gadget_rule.md'], ['--gates-compile', '--gates-allow-empty']]);
    assert.match(app.dialogs[0].options.detail, /CLAUDE\.md: no gates will load \(1 now\), and its gates block is removed\./);
    assert.equal(app.claude(), '# Mine\n', 'the block is gone and the user text is as it was');
    assert.equal(app.codex(), '# Mine\n');
    assert.match(panel.last('result').text, /CLAUDE\.md loads no gate from the next session, and its gates block was removed/);
    assert.equal(app.settings['gates.enabled'], true, 'the setting is never changed');

    await app.request(panel, { type: 'apply', store: app.store, retire: [], restore: ['feedback_gadget_rule.md'] });
    assert.ok(app.claude().includes('Never ship a gadget') && app.codex().includes('Never ship a gadget'), 'installed again');
  } finally { await app.dispose(); }
});

test('a dismissed confirmation edits nothing, records nothing and raises nothing', async () => {
  const app = harness({ answer: undefined });
  try {
    const panel = await app.open();
    const before = app.memory('feedback_gadget_rule.md');
    await app.request(panel, { type: 'apply', store: app.store, retire: ['feedback_gadget_rule.md'], restore: [] });
    assert.equal(app.dialogs.length, 1);
    assert.deepEqual(app.calls().filter((args) => args[0] !== '--gates-list'), []);
    assert.equal(app.memory('feedback_gadget_rule.md'), before);
    assert.deepEqual([...app.errors, ...app.infos], []);
    assert.ok(!fs.existsSync(path.join(app.home, '.claude', 'wildcarding', `pending-gates.${process.pid}.json`)));
  } finally { await app.dispose(); }
});

test('an edit recall.py refused is reported as nothing changed, and nothing is compiled', async () => {
  const app = harness({ answer: 'Apply', faults: { edit: () => [Object.assign(new Error('exit 1'), { code: 1 }), '',
    '[recall] refusing to change any gate; nothing was written:\r\n  feedback_gadget_rule.md: has 2 hard links\r\n'] } });
  try {
    const panel = await app.open();
    await app.request(panel, { type: 'apply', store: app.store, retire: ['feedback_gadget_rule.md'], restore: [] });
    assert.equal(app.errors.length, 1);
    assert.equal(app.errors[0], 'ai-acolyte: recall.py refused the edit ([recall] refusing to change any gate; nothing was written:\n'
      + '  feedback_gadget_rule.md: has 2 hard links). Refused: nothing was changed.', 'CRLF reaches the toast as plain lines');
    assert.deepEqual(app.calls().filter((args) => args[0] === '--gates-compile'), []);
  } finally { await app.dispose(); }
});

test('a compile that fails after the edit says the memories were changed, installs nothing, and Compile and install finishes it', async () => {
  const app = harness({ answer: 'Apply' });
  try {
    const panel = await app.open();
    await app.request(panel, { type: 'finish', store: app.store });
    const installed = app.claude();
    app.faults.compile = () => [Object.assign(new Error('exit 1'), { code: 1 }), '', '[recall] could not write gates.generated.md.'];
    await app.request(panel, { type: 'apply', store: app.store, retire: ['feedback_gadget_rule.md'], restore: [] });
    const [error] = app.errors;
    assert.match(error, /^ai-acolyte: the memories WERE changed \(retired feedback_gadget_rule\.md\), but the compile failed: \[recall\] could not write gates\.generated\.md\. The memory folder was snapshotted first, to .*gate-snapshots.*\. Click Compile and install in the gates panel to finish: it compiles what the memories now hold, and installs it while memory gates are on\.$/);
    assert.doesNotMatch(error, /wildcard-perms|nothing was changed/, 'the panel names its own way to finish, and never claims nothing changed');
    assert.match(app.memory('feedback_gadget_rule.md'), /scope: retired/, 'the edit stands');
    assert.equal(app.claude(), installed, 'nothing was installed after the failed compile');

    // The advice it gives works.
    delete app.faults.compile;
    await app.request(panel, { type: 'finish', store: app.store });
    assert.ok(!app.claude().includes('Never ship a gadget') && !app.codex().includes('Never ship a gadget'));
    assert.match(panel.last('result').text, /^Compiled 1 gate\. CLAUDE\.md loads no gate from the next session, and its gates block was removed; AGENTS\.md loads 1 gate/);
    // MUTATION: report the compile failure through refused() and the first match fails on
    // "Refused: nothing was changed", which is false here.
  } finally { await app.dispose(); }
});

test('an install that fails after the compile says the memories were changed too', async () => {
  const app = harness({ answer: 'Apply' });
  try {
    const panel = await app.open();
    await app.request(panel, { type: 'finish', store: app.store });
    const installed = app.claude();
    app.faults.torn = true;
    await app.request(panel, { type: 'apply', store: app.store, retire: ['feedback_gadget_rule.md'], restore: [] });
    assert.match(app.errors[0], /^ai-acolyte: the memories WERE changed \(retired feedback_gadget_rule\.md\), but the install failed: all: .*does not match the sha in its own header/);
    assert.match(app.errors[0], /Click Compile and install in the gates panel to finish/);
    assert.equal(app.claude(), installed);
  } finally { await app.dispose(); }
});

// Switched-off gates stay off (the recorded decision): the extension's gates are on exactly when
// gates.enabled is, and a retire or restore never changes it.
test('with gates.enabled off, a retire edits and compiles, installs nothing, and leaves the setting off', async () => {
  const app = harness({ answer: 'Apply', gatesOn: false });
  try {
    const panel = await app.open();
    assert.equal(panel.last('gates').off, 'Memory gates are switched off (permissionWildcarding.gates.enabled)');
    const from = app.spawns.length;
    await app.request(panel, { type: 'apply', store: app.store, retire: ['feedback_gadget_rule.md'], restore: [] });
    assert.deepEqual(app.calls().slice(from, from + 3), [['--gates-list'], ['--gates-retire=feedback_gadget_rule.md'], ['--gates-compile']]);
    assert.match(app.dialogs[0].options.detail, /Gates are switched off, so nothing is installed and no gates load now\. The change takes effect when gates are turned on: CLAUDE\.md will load 0 gates, AGENTS\.md will load 1 gate\./);
    assert.match(app.dialogs[0].options.detail, /\n\nMemory gates are switched off \(permissionWildcarding\.gates\.enabled\)\./);
    assert.equal(app.claude(), '# Mine\n');
    assert.equal(app.codex(), '# Mine\n');
    assert.equal(app.settings['gates.enabled'], false, 'still off');
    assert.match(panel.last('result').text, /^retired feedback_gadget_rule\.md\. Memory gates are switched off \(permissionWildcarding\.gates\.enabled\), so nothing was installed: the change takes effect when gates are turned on\./);
    assert.match(fs.readFileSync(path.join(app.home, '.claude', 'gates.generated.md'), 'utf8'), /Codex reads the sprocket/, 'compiled for when they are');
    // MUTATION: read gatesOn as true in gatesSwitch and CLAUDE.md gains a block.
  } finally { await app.dispose(); }
});

test('gates switched off while the modal is open stay off: the install reads the setting for itself', async () => {
  const app = harness({ answer: () => { app.settings['gates.enabled'] = false; return 'Apply'; } });
  try {
    const panel = await app.open();
    await app.request(panel, { type: 'apply', store: app.store, retire: ['feedback_gadget_rule.md'], restore: [] });
    assert.equal(app.claude(), '# Mine\n', 'nothing installed: the setting went off before the install');
    assert.match(panel.last('result').text, /so nothing was installed/);
  } finally { await app.dispose(); }
});

// The corpus watcher fires for the memory the edit rewrote, and gatesCorpusBump would compile the
// same memories again two seconds later. This host's own write is skipped; a later edit is not.
test('the corpus watcher does not compile a second time for the apply\'s own edit, and still compiles for the next one', async () => {
  const app = harness({ answer: 'Apply' });
  try {
    const panel = await app.open();
    await app.request(panel, { type: 'finish', store: app.store });
    // One event lands while recall.py is still writing the memory, as a watcher can deliver it.
    app.faults.edit = () => { app.fireCorpus('feedback_gadget_rule.md'); return null; };
    await app.request(panel, { type: 'apply', store: app.store, retire: ['feedback_gadget_rule.md'], restore: [] });
    delete app.faults.edit;
    assert.equal(app.bumps.filter((bump) => !bump.cleared).length, 0, 'an event during the edit arms nothing either');
    const compiles = () => app.calls().filter((args) => args[0] === '--gates-compile').length;
    const before = compiles();
    // What VS Code delivers for the edit's own write, late, after the apply has finished.
    app.fireCorpus('feedback_gadget_rule.md');
    assert.equal(app.bumps.filter((bump) => !bump.cleared).length, 0, 'no recompile is armed for the apply\'s own write');
    for (const bump of app.bumps) if (!bump.cleared) bump.fn();
    await settleOnce();
    assert.equal(compiles(), before, 'and nothing compiles a second time');

    // A real edit of the same memory afterwards is compiled as before.
    fs.appendFileSync(path.join(app.store, 'feedback_gadget_rule.md'), '\nEdited by hand.\n');
    app.fireCorpus('feedback_gadget_rule.md');
    const armed = app.bumps.filter((bump) => !bump.cleared);
    assert.equal(armed.length, 1, 'a later edit arms the recompile');
    armed[0].fn();
    await until(() => compiles() === before + 1 && app.spawns.every((spawn) => spawn.answered), 'the watcher\'s compile');
    await settleOnce();
    // MUTATION: drop the `isOwnGateEdit` early return in gatesCorpusBump and the first assertion
    // fails: the apply's own write arms a second compile of the same memories.
  } finally { await app.dispose(); }
});

test('an apply formed on one store is refused when the store that compiles is now another', async () => {
  let dir = null;
  const app = harness({ answer: 'Apply', storeDir: () => dir });
  try {
    dir = app.store;
    const panel = await app.open();
    const other = path.join(app.home, '.claude', 'projects', 'proj-beta', 'memory');
    fs.mkdirSync(other, { recursive: true });
    for (const [file, spec] of Object.entries(MEMORIES)) fs.writeFileSync(path.join(other, file), memoryText(spec));
    dir = other;
    await app.request(panel, { type: 'apply', store: app.store, retire: ['feedback_gadget_rule.md'], restore: [] });
    assert.match(app.errors[0], /^ai-acolyte: the store that compiles changed since the panel listed it: it showed .*proj-alpha.memory, and recall\.py now reads .*proj-beta.memory\. Refused: nothing was changed\.$/);
    assert.match(app.memory('feedback_gadget_rule.md'), /scope: global/);
    assert.match(fs.readFileSync(path.join(other, 'feedback_gadget_rule.md'), 'utf8'), /scope: global/, 'neither store was edited');
    assert.deepEqual(app.calls().filter((args) => args[0] !== '--gates-list'), []);
  } finally { await app.dispose(); }
});

test('a second apply while one is running is not started, and the asking page is told', async () => {
  let release;
  // Only the confirmation is held; the "already running" warning answers at once.
  const app = harness({ answer: (message) => (/^Retire /.test(message)
    ? new Promise((resolve) => { release = () => resolve('Apply'); }) : undefined) });
  try {
    const panel = await app.open();
    panel.send({ type: 'apply', store: app.store, retire: ['feedback_gadget_rule.md'], restore: [] });
    await until(() => app.dialogs.length === 1, 'the first modal');
    panel.send({ type: 'apply', store: app.store, retire: ['reference_codex_rule.md'], restore: [] });
    await until(() => app.warnings.some((w) => /already running/.test(w)), 'the refusal');
    assert.equal(panel.last('result').text, 'a gate change is already running, so this one was not started. This panel is listed again when that one ends.');
    release();
    await until(() => panel.last('busy') && panel.last('busy').busy === false, 'the first run');
    assert.match(app.memory('feedback_gadget_rule.md'), /scope: retired/);
    assert.match(app.memory('reference_codex_rule.md'), /scope: global/, 'the second was never started');
  } finally { await app.dispose(); }
});

test('a reload during the edit lets recall.py finish, compiles nothing, and the next activation says how to finish', async () => {
  const app = harness({ answer: 'Apply' });
  try {
    const panel = await app.open();
    // The edit never answers while the host is up: the reload lands while recall.py runs.
    const held = [];
    app.respond((args, env) => {
      if (/^--gates-retire=/.test(args[0])) { held.push(args); return null; }
      return stubRecall(args, env, app.home, {});
    });
    panel.send({ type: 'apply', store: app.store, retire: ['feedback_gadget_rule.md'], restore: [] });
    await until(() => held.length === 1, 'the edit');
    const pending = path.join(app.home, '.claude', 'wildcarding', `pending-gates.${process.pid}.json`);
    assert.ok(fs.existsSync(pending), 'the change is written down before the edit');
    const record = JSON.parse(fs.readFileSync(pending, 'utf8'));
    assert.deepEqual([record.retire, record.restore, record.gatesOn, record.store], [['feedback_gadget_rule.md'], [], true, app.store]);
    const editSpawn = app.spawns[app.spawns.length - 1];
    assert.deepEqual(editSpawn.args.slice(1), ['--gates-retire=feedback_gadget_rule.md']);
    await app.extension.deactivate();
    assert.ok(panel.disposed, 'the panel closes with the host');
    assert.equal(app.calls().filter((args) => args[0] === '--gates-compile').length, 0, 'nothing compiled after the reload');
    assert.ok(fs.existsSync(pending), 'the record stays for the next activation');
    // The edit was never tracked, so the teardown did not kill it part way (runRecallStep), and
    // the list before it was, as every other child is.
    assert.equal(editSpawn.killed, false, 'recall.py is left to finish or put its own work back');
    // MUTATION: track the edit like every other step (trackChild whatever `finish` says) and
    // deactivate kills it: this assertion fails.
    // The next activation in the same process reports it once and removes it.
    app.extension.activate({ subscriptions: [] });
    const report = app.warnings.find((warning) => /a memory gate change \(retire feedback_gadget_rule\.md\) started at/.test(warning));
    assert.ok(report, app.warnings.join('\n'));
    assert.match(report, /so the memories may have been changed while CLAUDE\.md and AGENTS\.md were not\..*Run "AI Acolyte: Manage memory gates…" to see what the memories hold now, and click Compile and install to finish\.$/);
    assert.ok(!fs.existsSync(pending), 'reported once');
    // The command it names is one the palette has, by its exact title.
    const titles = require('../vscode-extension/package.json').contributes.commands.map((entry) => entry.title);
    assert.ok(titles.includes(report.match(/Run "([^"]+)"/)[1]), 'the report names a contributed palette title');
  } finally { await app.dispose(); }
});

test('activation reports a record left by a host that is gone, and leaves one whose host still runs', async () => {
  const app = harness();
  try {
    const dir = path.join(app.home, '.claude', 'wildcarding');
    fs.mkdirSync(dir, { recursive: true });
    // A pid that cannot be running: past Linux's pid_max ceiling, and not a multiple of 4, which
    // every Windows pid is.
    const gone = path.join(dir, 'pending-gates.2147483646.json');
    fs.writeFileSync(gone, JSON.stringify({ at: new Date().toISOString(), retire: ['a.md'], restore: [] }));
    const live = path.join(dir, `pending-gates.${process.ppid}.json`);
    fs.writeFileSync(live, JSON.stringify({ at: new Date().toISOString(), retire: ['b.md'], restore: [] }));
    await app.extension.deactivate();
    app.warnings.length = 0;
    app.extension.activate({ subscriptions: [] });
    assert.equal(app.warnings.filter((warning) => /a memory gate change \(retire a\.md\)/.test(warning)).length, 1);
    assert.equal(app.warnings.filter((warning) => /retire b\.md/.test(warning)).length, 0, 'another window\'s change, still running');
    assert.ok(!fs.existsSync(gone));
    assert.ok(fs.existsSync(live));
  } finally { await app.dispose(); }
});

test('a name or title with hidden characters shows them as ?, and the page still posts the real name', async () => {
  const rlo = String.fromCharCode(0x202e);
  const pdf = String.fromCharCode(0x202c);
  const zwsp = String.fromCharCode(0x200b);
  const spoof = `feedback_${rlo}elur_ytefas${pdf}.md`;
  const app = harness({ answer: 'Apply', respond: (args) => (args[0] === '--gates-list' ? [null, JSON.stringify({ store: '/s', gates: [
    { file: 'feedback_safety_rule.md', scope: 'global', state: 'active', agents: ['claude', 'codex'], problem: null, title: 'Safety rule', text: '- Safety rule', description: '' },
    { file: spoof, scope: 'global', state: 'active', agents: ['claude', 'codex'], problem: null, title: `Safety${zwsp} rule`, text: `- Safety rule\n\t${rlo}detail`, description: `Why${rlo}` },
  ] }), ''] : [new Error('unexpected'), '', '']) });
  try {
    const panel = await app.open();
    const page = runPage(panel.webview.html);
    page.deliver(panel.last('gates'));
    const [real, posing] = page.rows();
    assert.equal(real.file.textContent, 'feedback_safety_rule.md');
    assert.equal(posing.file.textContent, 'feedback_?elur_ytefas?.md', 'the two no longer read the same');
    assert.ok(posing.tags.includes('hidden characters in the name'));
    assert.ok(!real.tags.includes('hidden characters in the name'));
    const pre = page.dom.created.filter((element) => element.tag === 'pre').map((element) => element.textContent);
    assert.equal(pre[1], '- Safety rule\n\t?detail', 'gate text keeps its line breaks and tabs');
    const shown = page.dom.created.map((element) => element.textContent).join('');
    assert.equal(shown.includes(rlo) || shown.includes(pdf) || shown.includes(zwsp), false, 'no hidden character is rendered');
    posing.file.click();
    assert.deepEqual(page.posted.pop(), { type: 'openMemory', file: spoof }, 'the real name opens the real file');
    posing.box.checked = false;
    posing.box.fire('change');
    page.el('apply').click();
    assert.deepEqual(page.posted.pop(), { type: 'apply', store: '/s', retire: [spoof], restore: [] });
    // And a refusal that repeats a name the page sent shows it neutralised.
    await app.request(panel, { type: 'apply', store: '/s', retire: [`feedback_${rlo}dm.lanif.md`], restore: [] });
    assert.match(app.errors.at(-1), /^ai-acolyte: feedback_\?dm\.lanif\.md is not in the gate list recall\.py printed\. Refused: nothing was changed\.$/);
    assert.equal(panel.last('result').text.includes(rlo), false, 'nor in the panel');
  } finally { await app.dispose(); }
});

test('a listed name cannot add a line to the confirmation, or reorder it', async () => {
  const forged = `feedback_a${String.fromCharCode(10)}Restore 9 gates: everything${String.fromCharCode(0x202e)}.md`;
  const app = harness({ respond: (args) => (args[0] === '--gates-list' ? [null, JSON.stringify({ store: '/s', gates: [
    { file: forged, scope: 'global', state: 'active', agents: ['claude', 'codex'], problem: null, title: 't', text: '- t', description: '' },
  ] }), ''] : [new Error('unexpected'), '', '']) });
  try {
    const panel = await app.open();
    await app.request(panel, { type: 'apply', store: '/s', retire: [forged], restore: [] });
    const { detail } = app.dialogs[0].options;
    assert.ok(detail.includes('Retire 1 gate: feedback_a?Restore 9 gates: everything?.md'), detail);
    assert.equal(detail.split(String.fromCharCode(10)).some((line) => line.startsWith('Restore 9 gates')), false,
      'no line of the confirmation comes from a file name');
  } finally { await app.dispose(); }
});

test('keyboard focus survives a relist, and lands on the outcome after Apply rather than on the page body', async () => {
  const app = harness();
  try {
    const panel = await app.open();
    const page = runPage(panel.webview.html);
    const { document } = page.dom;
    page.deliver(panel.last('gates'));
    const box = page.rows()[1].box;
    box.focus();
    assert.equal(document.activeElement, box);
    page.deliver(panel.last('gates'));
    const rebuilt = page.rows()[1].box;
    assert.notEqual(rebuilt, box, 'precondition: the row was rebuilt');
    assert.equal(document.activeElement, rebuilt, 'the same gate\'s checkbox has the focus again');
    const first = page.rows()[0];
    first.box.checked = false;
    first.box.fire('change');
    page.el('apply').focus();
    page.el('apply').click();
    assert.equal(document.activeElement, document.body, 'precondition: a disabled button holds no focus');
    const listed = panel.last('gates');
    page.deliver({ ...listed, gates: [{ ...listed.gates[0], state: 'retired' }, ...listed.gates.slice(1)] });
    page.deliver({ type: 'result', ok: true, text: 'retired feedback_gadget_rule.md.' });
    page.deliver({ type: 'busy', busy: false });
    assert.equal(document.activeElement, page.el('notice'), 'the outcome is where the keyboard user lands');
    assert.ok(panel.webview.html.includes('id="notice" role="status" aria-live="polite" tabindex="-1"'));
    page.el('filter').focus();
    page.deliver(panel.last('gates'));
    assert.equal(document.activeElement, page.el('filter'), 'a user who moved the focus keeps it there');
  } finally { await app.dispose(); }
});

test('each checkbox is described by its rule and its pending change, and Apply follows the list in the tab order', async () => {
  const app = harness();
  try {
    const panel = await app.open();
    const page = runPage(panel.webview.html);
    page.deliver(panel.last('gates'));
    const byId = (id) => page.dom.created.find((element) => element.id === id);
    const gadget = page.rows()[0];
    assert.equal(gadget.box.getAttribute('aria-label'), 'Load feedback_gadget_rule.md in every session');
    const [titleId, pendingId] = gadget.box.getAttribute('aria-describedby').split(' ');
    assert.equal(byId(titleId).textContent, 'Never ship a gadget index unrebuilt. Never ship a gadget index unrebuilt.');
    gadget.box.checked = false;
    gadget.box.fire('change');
    assert.equal(byId(pendingId).textContent, 'will retire');
    const html = panel.webview.html;
    const at = (id) => html.indexOf(`id="${id}"`);
    assert.ok(at('filter') < at('list') && at('list') < at('apply') && at('apply') < at('revert') && at('revert') < at('finish'));
    assert.match(html, /\.actions \{ position: sticky; bottom: 0;/);
    assert.match(html, /\n {2}\.gate \.body \{[^}]*overflow-wrap: anywhere;[^}]*min-width: 0;|\n {2}\.gate \.body \{[^}]*min-width: 0;[^}]*overflow-wrap: anywhere;/);
    assert.doesNotMatch(html, /white-space: nowrap/);
  } finally { await app.dispose(); }
});

test('with gates switched off the page says why none load, and never that a change switches them on', async () => {
  const app = harness({ gatesOn: false });
  try {
    const panel = await app.open();
    const page = runPage(panel.webview.html);
    page.deliver(panel.last('gates'));
    assert.equal(page.el('switchedOff').hidden, false);
    assert.equal(page.el('switchedOff').textContent, 'Memory gates are switched off (permissionWildcarding.gates.enabled), so none of '
      + 'these load now. A change here is still made and compiled, and takes effect when gates are turned on.');
    page.deliver({ ...panel.last('gates'), off: '' });
    assert.equal(page.el('switchedOff').hidden, true, 'gates on: no notice');
  } finally { await app.dispose(); }
});

test('Manage gates opens one panel, a second run reveals it, and one that arrives after deactivate opens nothing', async () => {
  const app = harness();
  try {
    await app.open({ ready: false });
    assert.equal(app.panels.length, 1);
    assert.equal(app.panels[0].viewType, 'permission-wildcarding.gates');
    assert.deepEqual(app.panels[0].options, { enableScripts: true, localResourceRoots: [] });
    assert.equal(app.spawns.length, 0, 'nothing is listed until the page asks');
    await app.open({ ready: false });
    assert.equal(app.panels.length, 1, 'the open panel is revealed, not a second opened');
    assert.equal(app.panels[0].revealed, 1);
    await app.extension.deactivate();
    assert.equal(app.panels[0].disposed, true);
    await app.open({ ready: false });
    assert.equal(app.panels.length, 1, 'a torn-down host opens nothing');
  } finally { await app.dispose(); }
});
