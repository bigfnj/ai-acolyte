#!/usr/bin/env node
'use strict';

// Actual extension-host background routes, isolated from the nine UI groups.
// Periodic fixtures deliberately drop Codex watcher scheduling, without changing
// the product's one-minute minimum interval. No vscode or timer API is mocked.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');

assert.equal(process.platform, 'win32');
const options = {};
const args = process.argv.slice(2);
while (args.length) {
  const key = args.shift();
  assert.ok(['--extension-dir', '--route', '--codex-layout', '--mutation'].includes(key) && args.length);
  assert.equal(options[key], undefined);
  options[key] = args.shift();
}
assert.ok(options['--extension-dir'], '--extension-dir is required');
const original = path.resolve(options['--extension-dir']);
const route = options['--route'] || 'watcher';
const layout = options['--codex-layout'] || 'custom-override';
const mutation = options['--mutation'] || 'none';
assert.ok(['watcher', 'periodic'].includes(route));
assert.ok(['default', 'custom-override'].includes(layout));
assert.ok(['none', route + '-noop'].includes(mutation));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-background-'));
const home = path.join(root, 'home');
const codexHome = layout === 'custom-override' ? path.join(root, 'custom-codex') : path.join(home, '.codex');
const workspace = path.join(root, 'workspace');
const userData = path.join(root, 'user-data');
const extensions = path.join(root, 'extensions');
const report = path.join(root, 'background.json');
for (const dir of [home, workspace, extensions, path.join(userData, 'User'), path.join(home, '.claude'), path.join(codexHome, 'sessions')]) fs.mkdirSync(dir, { recursive: true });
const hash = (value) => createHash('sha256').update(value).digest('hex');
let extensionDir = original;
const changes = [];
if (route === 'periodic' || mutation !== 'none') {
  extensionDir = path.join(root, 'subject');
  fs.cpSync(original, extensionDir, { recursive: true });
  const file = path.join(extensionDir, 'extension.js');
  const before = fs.readFileSync(file, 'utf8');
  const beforeMtimeMs = fs.statSync(file).mtimeMs;
  let text = before;
  const replace = (from, to, label) => {
    assert.equal(text.split(from).length - 1, 1, `fixture route changed: ${label}`);
    text = text.replace(from, to);
    changes.push(label);
  };
  for (const event of ['Change', 'Create', 'Delete']) {
    replace(`watcher.onDid${event}(() => scheduleAutoLearn());`, `watcher.onDid${event}(() => {\r\n`
      + `        if (base === CODEX_HOME_DIR) { fs.appendFileSync(path.join(os.homedir(), 'background-callbacks.jsonl'), JSON.stringify({ kind: 'codex-watcher-skipped', event: '${event}', at: Date.now() }) + '\\n'); return; }\r\n`
      + '        scheduleAutoLearn();\r\n      });', 'Codex ' + event + ' event scheduling deliberately skipped');
  }
  if (route === 'periodic') {
    replace('autoLearnTimer = setInterval(() => runAutoLearnScan(false), cfg.intervalMinutes * 60 * 1000);',
      "autoLearnTimer = setInterval(() => { fs.appendFileSync(path.join(os.homedir(), 'background-callbacks.jsonl'), JSON.stringify({ kind: 'periodic-tick', skipped: "
      + (mutation === 'periodic-noop' ? 'true' : 'false') + ", at: Date.now() }) + '\\n'); "
      + (mutation === 'periodic-noop' ? '' : 'runAutoLearnScan(false); ') + '}, cfg.intervalMinutes * 60 * 1000);',
      mutation === 'periodic-noop' ? 'periodic callback witnessed but scan skipped' : 'periodic callback witnessed before original scan');
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  fs.writeFileSync(file, text);
  assert.ok(fs.statSync(file).mtimeMs > beforeMtimeMs);
  fs.writeFileSync(path.join(root, 'subject-change.json'), JSON.stringify({ original, subject: extensionDir,
    originalHash: hash(before), subjectHash: hash(text), beforeMtimeMs, afterMtimeMs: fs.statSync(file).mtimeMs, changes }, null, 2) + '\n');
}
const instructions = '# Background fixture\nKeep this background user instruction.\n';
fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), instructions);
fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: [], ask: [], deny: [] } }) + '\n');
fs.writeFileSync(path.join(codexHome, layout === 'custom-override' ? 'AGENTS.override.md' : 'AGENTS.md'), instructions);
if (layout === 'custom-override') fs.writeFileSync(path.join(codexHome, 'AGENTS.md'), '# Background inactive base\nThis background base remains untouched.\n');
fs.writeFileSync(path.join(userData, 'User', 'settings.json'), JSON.stringify({
  'telemetry.telemetryLevel': 'off', 'extensions.autoUpdate': false, 'update.mode': 'none',
  'window.restoreWindows': 'none', 'workbench.startupEditor': 'none',
  'permissionWildcarding.guidance.enabled': false, 'permissionWildcarding.gates.enabled': false,
  'permissionWildcarding.autoLearn.enabled': true, 'permissionWildcarding.autoLearn.mode': 'recommend',
  'permissionWildcarding.autoLearn.intervalMinutes': route === 'periodic' ? 1 : 60,
  'permissionWildcarding.autoLearn.debounceSeconds': 1,
}, null, 2) + '\n');
const { resolveExecutable } = require(path.join(original, 'src/exec-resolve.js'));
const code = resolveExecutable('code');
assert.ok(code, 'VS Code command unavailable');
const codeExecutable = path.resolve(path.dirname(code), '..', 'Code.exe');
assert.ok(fs.existsSync(codeExecutable));
const quote = (value) => "'" + String(value).replace(/'/g, "''") + "'";
const launchArgs = [`--extensionDevelopmentPath=${extensionDir}`,
  `--extensionTestsPath=${path.join(__dirname, 'vscode-background', 'index.js')}`,
  `--user-data-dir=${userData}`, `--extensions-dir=${extensions}`,
  '--new-window', '--disable-extensions', '--disable-workspace-trust', '--disable-telemetry', '--disable-gpu',
  '--skip-welcome', '--skip-release-notes', workspace].map((value) => '"' + value.replace(/"/g, '""') + '"').join(' ');
const timeout = 135000;
const launch = path.join(root, 'launch.ps1');
fs.writeFileSync(launch, ["$ErrorActionPreference = 'Stop'",
  `$child = Start-Process -FilePath ${quote(codeExecutable)} -ArgumentList ${quote(launchArgs)} -PassThru -WindowStyle Hidden -RedirectStandardOutput ${quote(path.join(root, 'vscode.stdout.log'))} -RedirectStandardError ${quote(path.join(root, 'vscode.stderr.log'))}`,
  '$null = $child.Handle', `if (-not $child.WaitForExit(${timeout})) {`,
  '  taskkill.exe /PID $child.Id /T /F', "  throw 'Background acceptance timed out.'", '}',
  'if ($null -eq $child.ExitCode) { exit 1 }', 'exit $child.ExitCode',
].join('\r\n') + '\r\n');
const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: codexHome,
  ACOLYTE_BACKGROUND_ROOT: root, ACOLYTE_BACKGROUND_EXTENSION: extensionDir,
  ACOLYTE_BACKGROUND_ROUTE: route, ACOLYTE_BACKGROUND_LAYOUT: layout, ACOLYTE_BACKGROUND_MUTATION: mutation };
delete env.ELECTRON_RUN_AS_NODE;
console.log(JSON.stringify({ route, layout, mutation, original, subject: extensionDir, profile: root }));
const launched = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', launch],
  { env, cwd: root, encoding: 'utf8', windowsHide: true, timeout: timeout + 10000 });
if (launched.stdout) process.stdout.write(launched.stdout);
if (launched.stderr) process.stderr.write(launched.stderr);
assert.ok(fs.existsSync(report), `host produced no background report: ${launched.error?.message || launched.status}`);
const result = JSON.parse(fs.readFileSync(report, 'utf8'));
result.launcherExitCode = launched.status;
result.launcherError = launched.error?.message || null;
result.harnessHashes = Object.fromEntries(['drive-codex-background.js', 'vscode-background/index.js', 'check-codex-runtime.js'].map((file) => [file, hash(fs.readFileSync(path.join(__dirname, file)))]));
fs.writeFileSync(report, JSON.stringify(result, null, 2) + '\n');
for (const item of result.results) console.log(`${item.verdict}: ${item.name}${item.detail ? '\n' + item.detail : ''}`);
console.log(`Evidence: ${report}`);
process.exitCode = result.results.some((item) => item.verdict !== 'PASS') || launched.status !== 0 || launched.error ? 1 : 0;
