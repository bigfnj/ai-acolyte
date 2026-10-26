'use strict';
// THE CHILD-PROCESS CENSUS OVER src/ (audit of 1.9.2). test/extension-lifecycle-async.test.js
// ("every child process the extension starts is handed over to be killable") reads
// vscode-extension/extension.js alone, so a spawn inside src/ that the extension reaches was
// listed by no test: those reach trackChild by the `options.track` convention, or are bounded some
// other way, and nothing said which. This reads every src/ file that imports a spawner, finds every
// reference to one (a call, or a spawner handed on as a value), and requires each to be listed in
// SITES below with how it is tracked or why it need not be. A new spawn fails here, named by its
// file and line, until someone has decided which it is.
//
// The spawners: child_process's spawn, spawnSync, exec, execSync, execFile, execFileSync and fork;
// worker_threads' Worker; and src/spawn-thread.js's two doors, execFileOffThread and
// configRpcOffThread, which start a Worker and hand back the ThreadChild its caller must track.
// An import in a form this cannot read (a multi-line destructure, say) fails the test rather than
// being skipped, so the census cannot go quiet by a change of spelling.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');

const SPAWNERS = {
  child_process: ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'],
  worker_threads: ['Worker'],
  './spawn-thread': ['execFileOffThread', 'configRpcOffThread'],
};

// Every site, by file, the spawner, and a fragment of its line (line numbers move on every edit;
// the fragment must match exactly one found site). `how` is the answer this census asks for, and
// `proof`, where there is one, is what in the same file makes it true.
const SYNC = 'synchronous: the caller waits for it, so no child outlives the call for deactivate to end';
const SITES = [
  { file: 'src/auto-learn-manager.js', spawner: 'spawnSync', text: 'const result = spawnSync(launch.file, launch.args,',
    how: `${SYNC}; Auto Learn's codex rule check, bounded by its 30 s timeout`, proof: /timeout: 30000/ },
  { file: 'src/claude-strip-model.js', spawner: 'Worker', text: 'worker = new Worker(__filename',
    how: 'a thread, not a process: checkOffThread returns terminate(), which the extension\'s deactivate calls (stripModelThread)',
    proof: /terminate: \(\) => \{ try \{ worker\?\.terminate\(\);/ },
  { file: 'src/codex-mcp-config.js', spawner: 'spawnSync', text: 'const result = spawnSync(launch.file, launch.args, { ...launch.options, windowsHide: true,',
    how: `${SYNC}; nativeRpc, the CLI's config RPC, bounded by its 40 s timeout`, proof: /encoding: 'utf8', timeout: 40000,/ },
  { file: 'src/codex-mcp-config.js', spawner: 'spawn', text: 'const child = gate(() => spawn(launch.file',
    how: 'nativeRpcAsync: the worker reaches options.track (the extension passes trackChild), and a backstop tree-kills it at timeoutMs',
    proof: /if \(typeof options\.track === 'function'\) options\.track\(child\);/ },
  { file: 'src/codex-mcp-config.js', spawner: 'spawn', text: 'child = spawn(launch.file, launch.args, { ...launch.options, windowsHide: true, cwd: request.home,',
    how: 'the Codex app-server inside the RPC worker process: the worker ends it at its deadline, and the host\'s tree kill of '
      + 'the worker reaches it (not detached, so in the worker\'s group on POSIX)', proof: /closed = new Promise\(resolve => child\.once\('close', resolve\)\);/ },
  { file: 'src/codex-mcp-config.js', spawner: 'configRpcOffThread', text: "require('./spawn-thread').configRpcOffThread(requests, options, context)",
    how: 'the config RPC on a thread: configRpcOffThread hands its ThreadChild to options.track (src/spawn-thread.js), which ends its tree through END_TREE' },
  { file: 'src/codex-consolidation.js', spawner: 'spawnSync', text: ': spawnSync;',
    how: `${SYNC}; probeWorkspaceOwnership, a one-shot read-only \`git rev-parse --git-dir\` ownership check on the Auto Learn `
      + 'worker thread (never the host), once per failed consolidation, bounded by PROBE_TIMEOUT_MS', proof: /timeout: PROBE_TIMEOUT_MS,/ },
  { file: 'src/codex-recall.js', spawner: 'spawnSync', text: 'const processResult = spawnSync(runtime.pythonExecutable',
    how: `${SYNC}; the CPU semantic recall bridge, bounded by its timeout`, proof: /input: JSON\.stringify\(input\), encoding: 'utf8', env, timeout,/ },
  { file: 'src/codex-version.js', spawner: 'spawnSync', text: ': spawnSync;',
    how: `${SYNC}; codexVersionStatus, \`codex --version\` for the CLI, bounded by its timeout`, proof: /timeout: options\.timeoutMs \|\| DEFAULT_TIMEOUT_MS \}\);/ },
  { file: 'src/codex-version.js', spawner: 'execFile', text: ": options.offThread === true ? require('./spawn-thread').execFileOffThread : execFile;",
    how: 'probeCodexVersionStatus: the child reaches options.track, and its own timer ends its tree', proof: /if \(child && typeof options\.track === 'function'\) options\.track\(child\);/ },
  { file: 'src/codex-version.js', spawner: 'execFileOffThread', text: ": options.offThread === true ? require('./spawn-thread').execFileOffThread : execFile;",
    how: 'the same probe off the host thread: its ThreadChild reaches options.track the same way', proof: /timer = setTimeout\(\(\) => \{ timedOut = true; endProcessTree\(child\); \}, timeoutMs\);/ },
  { file: 'src/exec-resolve.js', spawner: 'execFile', text: "childProcess.execFile(taskkillPath(), ['/PID', String(child.pid), '/T', '/F'],",
    how: 'untracked by design: it is the tree kill itself (endProcessTree), which every caller awaits, and it is bounded by its 5 s timeout',
    proof: /\{ windowsHide: true, timeout: 5000 \}, \(\) => \{ fallback\(\); resolve\(\); \}\);/ },
  { file: 'src/memory-guard-install.js', spawner: 'spawn', text: 'const child = spawn(launch.file, launch.args, { ...launch.options, cwd,',
    how: 'memoryGuardProbe: the child reaches options.track (the extension passes trackChild), and the deadline ends its tree',
    proof: /if \(typeof options\.track === 'function'\) options\.track\(child\);/ },
  { file: 'src/rule-usage.js', spawner: 'Worker', text: 'worker = new Worker(__filename',
    how: 'a thread, not a process: countOffThread returns terminate(), which the extension\'s deactivate calls (ruleUsageThread)',
    proof: /terminate: \(\) => \{ try \{ worker\?\.terminate\(\);/ },
  { file: 'src/spawn-thread.js', spawner: 'execFile', text: 'track(gated(() => execFile(task.file',
    how: 'on the spawn thread: runTask tracks it, and ends it with endProcessTree when the host asks (END_TREE)',
    proof: /Promise\.all\(\[\.\.\.children\]\.map\(\(spawned\) => endProcessTree\(spawned\)\)\)/ },
  { file: 'src/spawn-thread.js', spawner: 'Worker', text: 'worker = new Worker(__filename',
    how: 'the spawn thread: startThread returns its ThreadChild, which each door hands to its caller to track, and which answers END_TREE',
    proof: /\[END_TREE\]\(\) \{/ },
];

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory()
  ? walk(path.join(dir, entry.name)) : entry.name.endsWith('.js') ? [path.join(dir, entry.name)] : []));
// Comment lines are not code: a line starting `//`, `*` or `/*`, and an inline `/* ... */`.
const codeOf = (line) => {
  const text = line.replace(/\/\*.*?\*\//g, '');
  return /^\s*(\/\/|\*|\/\*)/.test(text) ? '' : text;
};
// Nor is the inside of a string: `resolvedLaunch(name, args, 'spawn')` and `kind: 'execFile'` name a
// spawner and start nothing. Imports are read before this, since their module name is a string.
const QUOTED = /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g;
const unquoted = (line) => line.replace(QUOTED, (literal) => literal[0] + literal[0]);

function census(dir = SRC) {
  const sites = [];
  const unreadable = [];
  for (const file of walk(dir)) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).map(codeOf);
    const bare = lines.map(unquoted);
    for (const [module, spawners] of Object.entries(SPAWNERS)) {
      const request = module.startsWith('./') ? escape(module) : `(?:node:)?${escape(module)}`;
      const required = `require\\(\\s*['"]${request}['"]\\s*\\)`;
      lines.forEach((line, index) => {
        if (!new RegExp(required).test(line)) return;
        const site = (at, spawner) => sites.push({ file: rel, line: at + 1, spawner, text: lines[at].trim() });
        const destructured = new RegExp(`(?:const|let|var)\\s*\\{([^}]*)\\}\\s*=\\s*${required}`).exec(line);
        const namespace = new RegExp(`(?:const|let|var)\\s+([\\w$]+)\\s*=\\s*${required}\\s*;`).exec(line);
        const member = new RegExp(`${required}\\s*\\.\\s*([\\w$]+)`).exec(line);
        if (destructured) {
          for (const part of destructured[1].split(',').map((name) => name.trim()).filter(Boolean)) {
            const [imported, local = imported] = part.split(':').map((name) => name.trim());
            if (!spawners.includes(imported)) continue;
            // A reference is the bare name: not a member (`options.execFile`), not a longer name.
            const reference = new RegExp(`(?<![\\w$.])${escape(local)}(?![\\w$])`);
            bare.forEach((other, at) => { if (at !== index && reference.test(other)) site(at, imported); });
          }
        } else if (namespace) {
          const reference = new RegExp(`(?<![\\w$.])${escape(namespace[1])}\\s*\\.\\s*(${spawners.join('|')})(?![\\w$])`, 'g');
          bare.forEach((other, at) => { for (const hit of other.matchAll(reference)) site(at, hit[1]); });
        } else if (member) {
          if (spawners.includes(member[1])) site(index, member[1]);
        } else {
          unreadable.push(`${rel}:${index + 1}  ${line.trim()}`);
        }
      });
    }
  }
  return { sites, unreadable };
}

test('every spawn in src/ is listed with how it is tracked, or why it need not be', () => {
  const { sites, unreadable } = census();
  assert.deepEqual(unreadable, [], 'a spawner module is imported in a form this census cannot read, so it cannot tell '
    + 'which spawners are in scope:\n  ' + unreadable.join('\n  '));
  // Witness: the census found the sites the audit listed, so a reader that stopped matching cannot
  // pass on an empty sweep.
  assert.ok(sites.length >= 10, `the census found only ${sites.length} sites`);
  const unlisted = [];
  const matched = new Map(SITES.map((entry) => [entry, []]));
  for (const site of sites) {
    const entries = SITES.filter((entry) => entry.file === site.file && entry.spawner === site.spawner && site.text.includes(entry.text));
    if (entries.length !== 1) { unlisted.push(`${site.file}:${site.line}  ${site.spawner}  ${site.text}`); continue; }
    matched.get(entries[0]).push(site);
  }
  assert.deepEqual(unlisted, [], 'a spawn in src/ is not in this census (add it to SITES with how it is tracked, or why it '
    + 'need not be; one entry per site):\n  ' + unlisted.join('\n  '));
  const stale = [...matched].filter(([, found]) => found.length !== 1)
    .map(([entry, found]) => `${entry.file}  ${entry.spawner}  "${entry.text}" matched ${found.length} sites`);
  assert.deepEqual(stale, [], 'a SITES entry matches no site, or more than one:\n  ' + stale.join('\n  '));
  for (const entry of SITES) assert.ok(entry.how && entry.how.length > 20, `${entry.file} ${entry.spawner}: say how it is tracked`);
  // What makes each `how` true is still in its file, so deleting the tracking fails here too.
  const unproven = SITES.filter((entry) => entry.proof && !entry.proof.test(fs.readFileSync(path.join(ROOT, entry.file), 'utf8')))
    .map((entry) => `${entry.file}  ${entry.spawner}  ${entry.proof}`);
  assert.deepEqual(unproven, [], 'a listed site no longer does what its entry says:\n  ' + unproven.join('\n  '));
});

// The census itself, against what it must and must not count. MUTATION: drop the string stripping
// (search `lines` in place of `bare`) and the quoted spawner names count as sites.
test('the census counts calls and spawners handed on, and not comments or strings', () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'acolyte-spawn-census-'));
  try {
    const probe = path.join(dir, 'probe.js');
    fs.writeFileSync(probe, [
      "const { spawn, execFile: run } = require('node:child_process');",
      "const cp = require('child_process');",
      '// spawn(this is a comment)',
      "const launch = resolvedLaunch(name, args, 'spawn');",
      'const child = spawn(file, args);',
      'const pick = options.run || run;',
      'cp.fork(file);',
      "const thread = require('./spawn-thread').execFileOffThread;",
      'const notASpawner = options.spawn(file);',
    ].join('\n'));
    const found = census(dir).sites.map((site) => `${site.line} ${site.spawner}`);
    assert.deepEqual(found, ['5 spawn', '6 execFile', '7 fork', '8 execFileOffThread']);
    fs.writeFileSync(probe, "const {\n  spawn,\n} = require('child_process');\nspawn(file);\n");
    assert.equal(census(dir).unreadable.length, 1, 'a multi-line destructure is unreadable, not skipped');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
