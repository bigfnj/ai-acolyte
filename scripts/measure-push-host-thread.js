'use strict';

// MEASURE HOW LONG A DASHBOARD PUSH HOLDS THE EXTENSION HOST THREAD (2026-10-14).
//
//   node scripts/measure-push-host-thread.js --codex <file-or-name> [--before <rev>] [--after <rev>]
//     [--n <samples>] [--tmp <dir>] [--keep]
//   node scripts/measure-push-host-thread.js --stand-in [same options]
//
// The figures in docs/engineering-record.md, "Process spawns: the v1.6.3 lifecycle and
// performance confirmation" (cold push 673 -> 20 ms, after a config.toml edit 218 -> 8.1 ms,
// real codex 0.161.0, n=11), are this script's measurement: run it with
// `--codex <the real codex> --before 2d8d223^ --after 2d8d223`.
//
// Each sample is a FRESH node process. It loads the real vscode-extension/extension.js of one
// tree under a stub vscode (the harness of test/dashboard-project-trust.test.js), sets
// `autoLearn.codexExecutable` to the codex given, and times the host thread around the real
// `_push()` three times: cold, with a project `.codex/rules` whose trust Codex has not been
// asked about; after a config.toml edit, which makes the trust verdict stale; and warm. The
// trees alternate sample by sample, so a drift on the box lands on both. Reported per tree:
// n, then p50 [min-max] of the host-thread time from the push to the next setImmediate (the
// synchronous part plus the microtasks after it, which is where a spawn started in a promise
// lands), the synchronous part alone, and the event-loop-delay histogram's maximum. Also how
// long after the cold push the trust verdict and the version were on screen.
//
// A tree is this checkout as it stands on disk, or a git revision, extracted with
// `git archive` (src/, vscode-extension/, memory/) into this script's own temp dir.
//
// SAFE BY CONSTRUCTION, because an earlier bench nearly overwrote a winget codex.exe:
//   - Everything it writes is under ONE temp dir it creates (`--tmp`, else the OS temp
//     dir), and every write is checked to be inside it. A sample's HOME, USERPROFILE,
//     CODEX_HOME, TMP, TEMP, APPDATA and LOCALAPPDATA all point inside it, and the OpenAI
//     and Codex credential variables are removed, so the codex it runs sees no account.
//   - A Codex install location is never written: the winget Links and Packages folders,
//     npm's global folder, and the folder (and link target) of the codex given and of the
//     codex on PATH. `--tmp` resolving inside one is refused before anything is created.
//   - The codex given is only ever executed, never copied, renamed or replaced. `--stand-in`
//     writes a node stand-in (it answers `--version` and the app-server's config/read)
//     inside the temp dir instead, for a box with no codex.
//   - The temp dir is removed at the end unless --keep is given.
//
// Read docs/engineering-record.md's MEASUREMENT HAZARD first: on a box under endpoint
// security a bare `node -e 0` costs hundreds of milliseconds, and the protocol at the top of
// that file is what makes a figure from this script mean anything.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const windows = process.platform === 'win32';
const usage = 'usage: node scripts/measure-push-host-thread.js (--codex <file-or-name> | --stand-in) '
  + '[--before <rev>] [--after <rev>] [--n <samples>] [--tmp <dir>] [--keep]';
// The one list every runtime harness scrubs (test/runtime-credential-scrub.test.js), matched
// without case because Windows environment names have none; and the rest of those families.
const CREDENTIALS = new Set(require('./check-codex-runtime').PROVIDER_CREDENTIAL_ENV.map((name) => name.toUpperCase()));
const scrubbed = (key) => CREDENTIALS.has(key.toUpperCase()) || /^(OPENAI|AZURE_OPENAI)_/i.test(key);

const same = (a, b) => (windows ? a.toLowerCase() === b.toLowerCase() : a === b);
function inside(parent, target) {
  const rest = path.relative(parent, target);
  if (rest === '') return true;
  if (path.isAbsolute(rest) || rest === '..' || rest.startsWith(`..${path.sep}`)) return false;
  return !windows || same(path.join(parent, rest), target);
}
const real = (target) => { try { return fs.realpathSync.native(target); } catch { return path.resolve(target); } };

// Where a codex is installed: never a place this script writes. Read from the environment
// and from the codex files themselves; nothing is spawned to find them.
function onPath(name) {
  if (windows) return require(path.join(ROOT, 'src', 'exec-resolve.js')).resolveExecutable(name);
  for (const dir of String(process.env.PATH || '').split(path.delimiter).filter((entry) => path.isAbsolute(entry))) {
    const candidate = path.join(dir, name);
    try { fs.accessSync(candidate, fs.constants.X_OK); if (fs.statSync(candidate).isFile()) return candidate; } catch { /* not here */ }
  }
  return null;
}
function codexInstallRoots(codexFiles) {
  const roots = [];
  if (process.env.LOCALAPPDATA) {
    roots.push(path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links'),
      path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages'));
  }
  if (process.env.ProgramFiles) roots.push(path.join(process.env.ProgramFiles, 'WinGet'));
  if (process.env.APPDATA) roots.push(path.join(process.env.APPDATA, 'npm'));
  if (process.env.npm_config_prefix) roots.push(process.env.npm_config_prefix);
  if (!windows) roots.push('/usr/local/lib/node_modules', '/usr/lib/node_modules', path.join(os.homedir(), '.npm-global'));
  for (const file of codexFiles.filter(Boolean)) roots.push(path.dirname(path.resolve(file)), path.dirname(real(file)));
  return [...new Set(roots.flatMap((root) => [path.resolve(root), real(root)]))];
}

// Every write goes through these, checked against the one temp dir and the install roots.
function guard(rootDir, installRoots) {
  const check = (target) => {
    const resolved = path.resolve(target);
    if (!inside(rootDir, resolved)) throw new Error(`refusing to write outside the temp dir: ${resolved}`);
    const hit = installRoots.find((root) => inside(root, resolved) || inside(root, real(path.dirname(resolved))));
    if (hit) throw new Error(`refusing to write inside a Codex install location (${hit}): ${resolved}`);
    return resolved;
  };
  return {
    check,
    mkdir: (dir) => fs.mkdirSync(check(dir), { recursive: true }),
    write: (file, text, mode) => fs.writeFileSync(check(file), text, mode ? { mode } : undefined),
    append: (file, text) => fs.appendFileSync(check(file), text),
  };
}

// ── one sample, in a fresh process ───────────────────────────────────────────────────────
async function child([tree, codexExecutable, sampleDir]) {
  const { monitorEventLoopDelay, performance } = require('node:perf_hooks');
  const Module = require('node:module');
  const base = real(sampleDir);
  const io = guard(base, codexInstallRoots([codexExecutable, onPath('codex')]));
  // What the parent set up, checked where it matters: in the process the codex inherits from.
  for (const key of Object.keys(process.env)) if (scrubbed(key)) throw new Error(`a credential variable reached the sample: ${key}`);
  for (const key of ['HOME', 'USERPROFILE', 'CODEX_HOME', 'TMP', 'TEMP', 'APPDATA', 'LOCALAPPDATA']) {
    if (!process.env[key] || !inside(base, path.resolve(process.env[key]))) throw new Error(`${key} is not inside the sample's temp dir`);
  }
  const home = path.join(base, 'home');
  const codexHome = path.join(home, '.codex');
  const workspace = path.join(base, 'ws');
  io.mkdir(path.join(home, '.claude'));
  io.write(path.join(home, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: [], deny: [] } }));
  io.mkdir(path.join(codexHome, 'rules'));
  io.write(path.join(codexHome, 'rules', 'user.rules'), 'prefix_rule(pattern=["rg"], decision="allow")\n');
  io.write(path.join(codexHome, 'config.toml'), 'model = "x"\n');
  io.mkdir(path.join(workspace, '.git'));
  io.write(path.join(workspace, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  io.mkdir(path.join(workspace, '.codex', 'rules'));
  io.write(path.join(workspace, '.codex', 'rules', 'project.rules'), 'prefix_rule(pattern=["fd"], decision="allow")\n');

  const disposable = () => ({ dispose() {} });
  let provider = null;
  const vscode = {
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    RelativePattern: class { constructor(b, p) { this.base = b; this.pattern = p; } },
    StatusBarAlignment: { Right: 2 }, ThemeColor: class { constructor(id) { this.id = id; } },
    ProgressLocation: { Notification: 15 }, Uri: { file: (fsPath) => ({ fsPath }) },
    commands: { registerCommand() { return disposable(); }, executeCommand() {} },
    window: {
      createStatusBarItem() { return { hide() {}, show() {}, dispose() {} }; },
      createOutputChannel() { return { appendLine() {}, append() {}, clear() {}, show() {}, dispose() {} }; },
      registerWebviewViewProvider(_id, instance) { provider = instance; return disposable(); },
      setStatusBarMessage() {}, showErrorMessage() { return Promise.resolve(); },
      showInformationMessage() { return Promise.resolve(); }, showWarningMessage() { return Promise.resolve(); },
      showQuickPick() { return Promise.resolve(); }, showInputBox() { return Promise.resolve(); },
    },
    workspace: {
      isTrusted: true, workspaceFolders: [{ uri: { fsPath: workspace } }],
      createFileSystemWatcher(pattern) { return { pattern, onDidChange() {}, onDidCreate() {}, onDidDelete() {}, dispose() {} }; },
      getConfiguration() {
        return {
          get: (key, fallback) => (key === 'autoLearn.codexExecutable' ? codexExecutable : key === 'autoLearn.enabled' ? false : fallback),
          inspect: (key) => (key === 'autoLearn.codexExecutable' ? { defaultValue: 'codex', globalValue: codexExecutable } : {}),
          update: async () => {},
        };
      },
      onDidChangeConfiguration() { return disposable(); }, onDidChangeWorkspaceFolders() { return disposable(); },
    },
  };
  const extensionPath = path.join(tree, 'vscode-extension', 'extension.js');
  const treeSrc = path.join(tree, 'src');
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === 'vscode') return vscode;
    if (request === 'os') return { ...os, homedir: () => home };
    if (parent?.filename === extensionPath && request.startsWith('./src/')) {
      return originalLoad.call(this, path.join(treeSrc, request.slice('./src/'.length)), parent, isMain);
    }
    if (request === './codexMemoryGatesUi' && parent?.filename === extensionPath) {
      return { createCodexMemoryGatesUi: () => ({ activate() {}, dispose() {}, review() {}, status() { return {}; } }) };
    }
    if (request === './memoryLint' && parent?.filename === extensionPath) {
      return {
        MemoryLint: class { activate() {} onReconcile() { return disposable(); } },
        memoryReport: () => ({ conf: {}, dir: null, report: null, gateSources: undefined }),
        memoryStoreDir: () => null,
        cfg: () => ({ enabled: true, dir: '', lineBudget: 300, totalBudget: 12000, maxLines: 200 }),
        discoverDirs: () => [],
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  const extension = require(extensionPath);
  extension.activate({ subscriptions: [] });
  const posted = [];
  const view = {
    visible: true,
    webview: { options: null, html: null, onDidReceiveMessage: disposable, postMessage(p) { posted.push(p); return Promise.resolve(true); } },
    onDidDispose: disposable, onDidChangeVisibility: disposable,
  };
  const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const until = async (predicate, ms) => {
    const start = Date.now();
    while (!predicate()) { if (Date.now() - start > ms) return false; await tick(20); }
    return true;
  };
  const realPush = provider._push.bind(provider);
  let gate = false;
  // Every push but the measured ones waits for the gate, so the debounced push that
  // resolveWebviewView asks for cannot take the cold push from under the measurement.
  provider._push = () => { if (gate) realPush(); };
  provider.resolveWebviewView(view);
  const timedPush = async () => {
    const histogram = monitorEventLoopDelay({ resolution: 1 });
    histogram.enable();
    // The histogram measures the gap between two of its own timer callbacks, so it has to
    // be running BEFORE the push or the first stall is never seen.
    await tick(60);
    const start = performance.now();
    realPush();
    const sync = performance.now() - start;
    await new Promise((resolve) => setImmediate(resolve));
    const host = performance.now() - start;
    await tick(100);
    histogram.disable();
    return { host: +host.toFixed(2), sync: +sync.toFixed(2), loopDelayMax: +(histogram.max / 1e6).toFixed(2) };
  };
  const out = {};
  const coldAt = Date.now() + 60;
  out.cold = await timedPush();
  gate = true;
  out.trustLanded = await until(() => posted.some((p) => p.codexPermissions && p.codexPermissions.pending === false), 15000);
  out.trustMs = Date.now() - coldAt;
  out.versionLanded = await until(() => posted.some((p) => p.codexMemory?.cli?.version), 15000);
  out.versionMs = Date.now() - coldAt;
  out.version = posted.filter((p) => p.codexMemory?.cli).at(-1)?.codexMemory.cli.version || null;
  out.codexLabels = (posted.at(-1)?.savedPermissions || []).filter((entry) => entry.agent === 'codex').map((entry) => entry.label);
  await tick(200);
  io.append(path.join(codexHome, 'config.toml'), '# touched\n');
  out.afterEdit = await timedPush();
  out.trustLandedAgain = await until(() => posted.at(-1)?.codexPermissions?.pending === false, 15000);
  await tick(200);
  out.warm = await timedPush();
  await extension.deactivate();
  Module._load = originalLoad;
  process.stdout.write(`${JSON.stringify(out)}\n`);
  setTimeout(() => process.exit(0), 200).unref();
}

// ── the comparison, in this process ──────────────────────────────────────────────────────
function standIn(io, dir) {
  io.mkdir(dir);
  const script = path.join(dir, 'stand-in-codex.js');
  io.write(script, `
const args = process.argv.slice(2);
if (args[0] === '--version') { process.stdout.write('codex-cli 0.161.0\\n'); process.exit(0); }
const rl = require('readline').createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.id == null) return;
  const result = message.method === 'config/read'
    ? { config: {}, layers: [{ name: { type: 'project', dotCodexFolder: require('path').join(message.params.cwd, '.codex') }, version: 'x' }] }
    : {};
  process.stdout.write(JSON.stringify({ id: message.id, result }) + '\\n');
});
rl.on('close', () => process.exit(0));
`);
  if (windows) {
    const shim = path.join(dir, 'codex.cmd');
    io.write(shim, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
    return shim;
  }
  const shim = path.join(dir, 'codex');
  io.write(shim, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, 0o755);
  return shim;
}

function extractTree(io, temp, rev, label) {
  const { resolvedLaunch } = require(path.join(ROOT, 'src', 'exec-resolve.js'));
  const git = resolvedLaunch('git', ['-C', ROOT, 'rev-parse', '--short', `${rev}^{commit}`], 'spawnSync');
  const short = execFileSync(git.file, git.args, { ...git.options, encoding: 'utf8', windowsHide: true }).trim();
  const tar = io.check(path.join(temp, `${label}.tar`));
  const dir = path.join(temp, 'trees', label);
  io.mkdir(dir);
  const archive = resolvedLaunch('git', ['-C', ROOT, '-c', 'core.autocrlf=false', 'archive', '--format=tar', '-o', tar, short,
    '--', 'src', 'vscode-extension', 'memory'], 'spawnSync');
  execFileSync(archive.file, archive.args, { ...archive.options, windowsHide: true });
  // System32's bsdtar on Windows, by absolute path; PATH's tar on POSIX, where execvp walks PATH alone.
  const tarExe = windows ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  execFileSync(tarExe, ['-xf', tar, '-C', io.check(dir)], { windowsHide: true });
  return { label: `${label} (${short})`, dir };
}

function sampleEnv(sampleDir) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (scrubbed(key)) delete env[key];
  delete env.NODE_OPTIONS;
  const home = path.join(sampleDir, 'home');
  const tmp = path.join(sampleDir, 'tmp');
  Object.assign(env, {
    HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, '.codex'), TMP: tmp, TEMP: tmp, TMPDIR: tmp,
    APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_CACHE_HOME: path.join(home, '.cache'), XDG_STATE_HOME: path.join(home, '.local', 'state'),
  });
  return env;
}

const p50 = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const figure = (values) => (values.length
  ? `${p50(values).toFixed(1)} [${Math.min(...values).toFixed(1)}-${Math.max(...values).toFixed(1)}]` : 'n/a');

function main(args) {
  const values = (name) => args.flatMap((value, index) => (args[index - 1] === name ? [value] : []));
  for (let i = 0; i < args.length; i += 1) {
    if (['--stand-in', '--keep'].includes(args[i])) continue;
    if (!['--codex', '--before', '--after', '--n', '--tmp'].includes(args[i]) || !args[i + 1]) throw new Error(usage);
    i += 1;
  }
  const useStandIn = args.includes('--stand-in');
  const codexArg = values('--codex')[0];
  if (useStandIn === Boolean(codexArg)) throw new Error(usage);
  const n = Number(values('--n')[0] || 11);
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(usage);

  let codex = null;
  if (codexArg) {
    codex = onPath(codexArg) || (fs.existsSync(codexArg) ? path.resolve(codexArg) : null);
    if (!codex) throw new Error(`no codex at ${codexArg}`);
  }
  const installRoots = codexInstallRoots([codex, onPath('codex')]);
  const tmpBase = real(values('--tmp')[0] || os.tmpdir());
  const blocked = installRoots.find((root) => inside(root, tmpBase));
  if (blocked) throw new Error(`refusing a temp dir inside a Codex install location (${blocked}): ${tmpBase}`);
  if (inside(ROOT, tmpBase)) throw new Error(`refusing a temp dir inside the checkout: ${tmpBase}`);
  const temp = real(fs.mkdtempSync(path.join(tmpBase, 'acolyte-push-bench-')));
  const io = guard(temp, installRoots);
  let report = '';
  try {
    if (useStandIn) codex = standIn(io, path.join(temp, 'stand-in'));
    const trees = [];
    for (const [label, rev] of [['before', values('--before')[0]], ['after', values('--after')[0]]]) {
      if (rev) trees.push(extractTree(io, temp, rev, label));
      else if (label === 'after') trees.push({ label: 'this checkout', dir: ROOT });
    }
    const rows = new Map(trees.map((tree) => [tree.label, []]));
    for (let i = 0; i < n; i += 1) {
      // Alternate the order too, so neither tree always runs first after the other.
      for (const tree of i % 2 ? [...trees].reverse() : trees) {
        const sampleDir = real(fs.mkdtempSync(path.join(io.check(temp), 's-')));
        io.mkdir(path.join(sampleDir, 'tmp'));
        const run = spawnSync(process.execPath, [__filename, '--child', tree.dir, codex, sampleDir], {
          cwd: sampleDir, env: sampleEnv(sampleDir), encoding: 'utf8', windowsHide: true, timeout: 180000,
        });
        const line = String(run.stdout || '').trim().split(/\r?\n/).at(-1);
        let row;
        try { row = JSON.parse(line); } catch {
          throw new Error(`sample ${i + 1} of ${tree.label} gave no result (status ${run.status}): ${String(run.stderr || run.error || '').slice(0, 600)}`);
        }
        rows.get(tree.label).push(row);
        process.stderr.write(`${tree.label} ${i + 1}/${n}: cold ${row.cold.host} ms, after edit ${row.afterEdit.host} ms\n`);
        try { fs.rmSync(io.check(sampleDir), { recursive: true, force: true, maxRetries: 5 }); } catch { /* removed with the temp dir */ }
      }
    }
    const lines = [`codex: ${useStandIn ? 'the node stand-in' : codex}; n=${n} per tree, a fresh process per sample, trees interleaved`];
    for (const [label, list] of rows) {
      const versions = [...new Set(list.map((row) => row.version))].join(', ');
      const landed = list.every((row) => row.trustLanded && row.trustLandedAgain && row.versionLanded);
      lines.push('', `${label}: n=${list.length}, version ${versions}, every trust verdict and version landed: ${landed}`);
      lines.push('  p50 [min-max] ms             host thread, push -> next setImmediate   synchronous part      loop-delay max');
      for (const [phase, name] of [['cold', 'cold push'], ['afterEdit', 'after a config.toml edit'], ['warm', 'warm push']]) {
        lines.push(`  ${name.padEnd(28)} ${figure(list.map((row) => row[phase].host)).padEnd(41)}`
          + `${figure(list.map((row) => row[phase].sync)).padEnd(22)}${figure(list.map((row) => row[phase].loopDelayMax))}`);
      }
      lines.push(`  trust verdict on screen after a cold push: ${figure(list.map((row) => row.trustMs))}; version: ${figure(list.map((row) => row.versionMs))}`);
    }
    report = lines.join('\n');
    if (args.includes('--keep')) io.write(path.join(temp, 'samples.json'), JSON.stringify(Object.fromEntries(rows), null, 1));
  } finally {
    if (!args.includes('--keep')) fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5 });
  }
  process.stdout.write(`${report}\n${args.includes('--keep') ? `kept: ${temp}\n` : ''}`);
}

if (process.argv[2] === '--child') {
  child(process.argv.slice(3)).catch((error) => { process.stderr.write(`${error.stack || error}\n`); process.exit(1); });
} else {
  try { main(process.argv.slice(2)); } catch (error) { process.stderr.write(`${error.message}\n`); process.exit(2); }
}
