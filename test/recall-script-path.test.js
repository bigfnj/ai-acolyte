'use strict';

// NO WORKSPACE FOLDER EVER SUPPLIES THE RECALL SCRIPT THE EXTENSION RUNS (2026-10-14, G1).
//
// recallScriptPath (vscode-extension/extension.js:636#recallScriptPath) resolves the
// memory.recallScript setting (user tier only since F7, 177c901), then the copy bundled into
// the VSIX, then the dev layout. Until this change it went on to three legs over every open
// workspace folder (the folder as the repo root, as a projects/ dir, as a .claude/ root) and a
// fourth under ~/.claude/projects/permission-wildcarding, the project's pre-rename name. Those
// legs ran only with the bundled copy missing, and then a repository's own memory/recall.py
// was handed to the Codex memory worker and spawned by the recall rebuild.
//
// To make the bundled and dev copies absent without touching the checkout, each scenario loads
// a COPY of the extension's own modules from a private directory with no memory/ beside or
// above it. The copy is the same bytes; only __dirname differs. The second half of this file
// holds the packaging to shipping the bundled copy, which is what keeps the empty answer from
// being the normal case.
//
// Harness copied, not shared, per the suite's standing decision
// (test/extension-activation.test.js:313#sharing). Its shape is test/machine-scoped-settings.test.js's.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const EXT = path.join(ROOT, 'vscode-extension');
const ROOT_SRC = path.join(ROOT, 'src');
const FIXTURE = '# fixture, never run\n';

function plant(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, FIXTURE);
  return file;
}

// A private copy of the extension's top-level modules and manifest: <base>/vscode-extension/.
// <base>/vscode-extension/memory/ is the bundled leg and <base>/memory/ the dev leg; neither
// exists unless a scenario plants it.
function copyExtension(base) {
  const dir = path.join(base, 'vscode-extension');
  fs.mkdirSync(dir, { recursive: true });
  for (const entry of fs.readdirSync(EXT, { withFileTypes: true })) {
    if (entry.isFile() && (entry.name.endsWith('.js') || entry.name === 'package.json')) {
      fs.copyFileSync(path.join(EXT, entry.name), path.join(dir, entry.name));
    }
  }
  return dir;
}

// Activates the copied extension with `folders` open and returns what the two callers of
// recallScriptPath did: the script the Codex memory worker was handed, and every warning the
// recall rebuild raised. Nothing is spawned: the worker is scripted and the toolbox venv
// points at a directory that does not exist, so even a found script stops at the venv check.
async function resolveWith(t, { base, home, folders }) {
  const extDir = copyExtension(base);
  const extensionPath = path.join(extDir, 'extension.js');
  const memoryDir = path.join(home, 'memory-corpus');
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: [] } }));
  const calls = [];
  const warnings = [];
  const disposable = () => ({ dispose() {} });
  const commands = new Map();
  const vscode = {
    StatusBarAlignment: { Left: 1, Right: 2 }, ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    ProgressLocation: { Notification: 15 },
    RelativePattern: class RelativePattern { constructor(b, pattern) { this.base = b; this.pattern = pattern; } },
    ThemeColor: class ThemeColor {}, Uri: { file: (p) => ({ fsPath: p }) },
    commands: { registerCommand(id, handler) { commands.set(id, handler); return disposable(); }, executeCommand() {} },
    window: {
      createOutputChannel() { return { appendLine() {}, append() {}, show() {}, clear() {}, dispose() {} }; },
      createStatusBarItem() { return { show() {}, hide() {}, dispose() {} }; },
      registerWebviewViewProvider() { return disposable(); },
      withProgress(options, task) { return task({ report() {} }); },
      setStatusBarMessage() {}, showErrorMessage() {},
      showWarningMessage(message) { warnings.push(String(message)); return Promise.resolve(undefined); },
      showInformationMessage() { return Promise.resolve(undefined); },
    },
    workspace: {
      isTrusted: true, workspaceFolders: folders.map((fsPath) => ({ uri: { fsPath } })),
      createFileSystemWatcher() { return { onDidChange() {}, onDidCreate() {}, onDidDelete() {}, dispose() {} }; },
      getConfiguration() {
        return {
          get: (key, fallback) => (key === 'autoLearn.enabled' ? false : fallback),
          // No tier sets memory.recallScript: the setting leg is out of play here.
          inspect: () => ({}),
          update: async () => {},
        };
      },
      onDidChangeConfiguration() { return disposable(); }, onDidChangeWorkspaceFolders() { return disposable(); },
    },
  };
  const inCopy = (parent) => !!parent?.filename && parent.filename.startsWith(extDir + path.sep);
  const originalLoad = Module._load;
  const envKeys = ['HOME', 'USERPROFILE', 'CODEX_HOME', 'CODEX_TOOLBOX'];
  const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, '.codex'),
    CODEX_TOOLBOX: path.join(home, 'no-toolbox-here'),
  });
  Module._load = function load(request, parent, isMain) {
    if (request === 'vscode') return vscode;
    if (request === 'os') return { ...os, homedir: () => home };
    if (inCopy(parent) && request === './autoLearnWorkerRunner') {
      return { createAutoLearnWorkerRunner: () => ({
        async run(operation, ...args) { calls.push({ operation, args }); return {}; },
        async deactivate() {},
      }) };
    }
    if (inCopy(parent) && request === './memoryLint') {
      return {
        MemoryLint: class MemoryLint { activate() {} onReconcile() { return disposable(); } },
        memoryReport: () => ({ conf: {}, dir: memoryDir, report: null }),
        cfg: () => ({ enabled: true, dir: '', lineBudget: 300, totalBudget: 12000, maxLines: 200 }),
        discoverDirs: () => [],
      };
    }
    // The copy has no src/ of its own: its ./src/ and ../src/ requires load the real modules.
    for (const prefix of ['./src/', '../src/']) {
      if (inCopy(parent) && request.startsWith(prefix)) {
        return originalLoad.call(this, path.join(ROOT_SRC, request.slice(prefix.length)), parent, isMain);
      }
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  const purge = () => {
    for (const key of Object.keys(require.cache)) {
      if (key.startsWith(ROOT_SRC + path.sep) || key.startsWith(extDir + path.sep)) delete require.cache[key];
    }
  };
  let extension;
  try {
    purge();
    extension = require(extensionPath);
    extension.activate({ subscriptions: [] });
    await commands.get('permission-wildcarding.rebuildCodexMemory')();
    await commands.get('permission-wildcarding.rebuildRecall')();
  } finally {
    try { await extension?.deactivate?.(); } catch { /* teardown only */ }
    Module._load = originalLoad;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    purge();
  }
  const rebuild = calls.find((call) => call.operation === 'rebuildCodexMemory');
  assert.ok(rebuild, `precondition: the rebuild reached the worker: ${JSON.stringify(calls.map((call) => call.operation))}`);
  return { handed: rebuild.args[0]?.recallOptions?.recallScript, warnings };
}

function scenario(t, label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `acolyte-recall-path-${label}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  return { base: path.join(root, 'install'), home, root };
}

const NOT_FOUND = /recall\.py not found/;

// Each layout the removed legs probed, planted alone, so a revert of any one leg is caught by
// its own case and not hidden behind an earlier one.
const LAYOUTS = [
  ['a workspace folder that is a repo root', (s) => {
    const folder = path.join(s.root, 'repo');
    return { folders: [folder], planted: plant(path.join(folder, 'memory', 'recall.py')) };
  }],
  ['a workspace folder holding the old-name project dir', (s) => {
    const folder = path.join(s.root, 'projects-dir');
    return { folders: [folder], planted: plant(path.join(folder, 'permission-wildcarding', 'memory', 'recall.py')) };
  }],
  ['a workspace folder that is a .claude root', (s) => {
    const folder = path.join(s.root, 'dot-claude');
    return { folders: [folder], planted: plant(path.join(folder, 'projects', 'permission-wildcarding', 'memory', 'recall.py')) };
  }],
  ['the ~/.claude/projects/permission-wildcarding convention', (s) => {
    const folder = path.join(s.root, 'unrelated');
    fs.mkdirSync(folder, { recursive: true });
    return { folders: [folder], planted: plant(path.join(s.home, '.claude', 'projects', 'permission-wildcarding', 'memory', 'recall.py')) };
  }],
];

for (const [label, layout] of LAYOUTS) {
  test(`with no bundled or dev copy, ${label} is never the recall script, and the not-found path runs`, async (t) => {
    const s = scenario(t, 'legacy');
    const { folders, planted } = layout(s);
    // MUTATION: restore the workspace legs and the PROJECTS_DIR leg in recallScriptPath (the
    // b1cf72c tree). The worker is handed `planted` and the rebuild stops at the venv check
    // instead of the not-found warning, so both assertions below fail. Confirmed 2026-10-14.
    const { handed, warnings } = await resolveWith(t, { ...s, folders });
    assert.equal(handed, undefined, `the extension would run a script it found at ${planted}`);
    assert.ok(warnings.some((message) => NOT_FOUND.test(message)),
      `the recall rebuild did not take its not-found path: ${JSON.stringify(warnings)}`);
  });
}

test('the controls: the bundled copy wins, and the dev copy is used when it is the only one', async (t) => {
  // These prove the harness can see a found script at all, so the empty answers above are
  // the function's and not the copy's.
  const bundledCase = scenario(t, 'bundled');
  const repo = path.join(bundledCase.root, 'repo');
  plant(path.join(repo, 'memory', 'recall.py'));
  const bundled = plant(path.join(bundledCase.base, 'vscode-extension', 'memory', 'recall.py'));
  plant(path.join(bundledCase.base, 'memory', 'recall.py'));
  const first = await resolveWith(t, { ...bundledCase, folders: [repo] });
  assert.equal(first.handed, bundled);
  assert.ok(!first.warnings.some((message) => NOT_FOUND.test(message)), 'a found script still reported not found');

  const devCase = scenario(t, 'dev');
  const dev = plant(path.join(devCase.base, 'memory', 'recall.py'));
  const second = await resolveWith(t, { ...devCase, folders: [] });
  assert.equal(second.handed, dev);
});

// THE VSIX MUST CARRY THE COPY. recallScriptPath's bundled leg is `<extension>/memory/recall.py`;
// an installed extension has no dev layout, so a VSIX without that file is a VSIX whose recall
// rebuild says "not found" until the user sets a path. Verified against the installed 1.6.3
// extension (memory/recall.py, memory/codex_recall.py, memory/models/bge-small.vocab.txt).
// package.mjs cannot run here (it calls vsce through npx), so its copy step is read; the dev
// staging script is run for real.
test('packaging puts memory/recall.py where the bundled leg looks, and nothing excludes it', () => {
  const pkg = fs.readFileSync(path.join(ROOT, 'scripts', 'package.mjs'), 'utf8');
  // MUTATION: delete package.mjs's recall.py cpSync. This fails. Confirmed 2026-10-14.
  assert.match(pkg, /const extMemory = join\(ext, 'memory'\);/, 'the bundled memory dir is no longer <extension>/memory');
  assert.match(pkg, /cpSync\(join\(root, 'memory', 'recall\.py'\), join\(extMemory, 'recall\.py'\)\)/,
    'package.mjs no longer copies memory/recall.py into the extension');
  assert.match(pkg, /const ext = join\(root, 'vscode-extension'\);/);
  assert.match(pkg, /package --no-dependencies/);
  assert.match(pkg, /cwd: ext,/, 'vsce must package the directory the copy lands in');

  // vsce honours .vscodeignore and a manifest `files` list, never .gitignore (which does ignore
  // vscode-extension/memory/ as a build output).
  const ignore = fs.readFileSync(path.join(EXT, '.vscodeignore'), 'utf8')
    .split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
  for (const pattern of ignore) {
    const catchAll = ['*', '**', '**/*', '*/**'].includes(pattern);
    assert.ok(!catchAll && !/memory|\.py/.test(pattern), `.vscodeignore pattern ${pattern} can exclude memory/recall.py`);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(EXT, 'package.json'), 'utf8'));
  if (manifest.files) {
    assert.ok(manifest.files.some((entry) => /^memory(\/|$)|recall\.py/.test(entry)), 'the manifest files list leaves memory/recall.py out');
  }
});

test('the dev staging copy carries memory/recall.py byte-identical', (t) => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-recall-stage-')), 'extension');
  t.after(() => fs.rmSync(path.dirname(out), { recursive: true, force: true }));
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'stage-extension.mjs'), '--out', out], { stdio: 'pipe' });
  const staged = path.join(out, 'memory', 'recall.py');
  assert.ok(fs.existsSync(staged), 'the staged extension has no memory/recall.py');
  assert.ok(fs.readFileSync(staged).equals(fs.readFileSync(path.join(ROOT, 'memory', 'recall.py'))));
});
