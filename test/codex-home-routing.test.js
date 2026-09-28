'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { codexRuleFileSet } = require('../src/codex-policy');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-home-routing-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const home = path.join(root, 'user');
  const codexHome = path.join(root, 'custom-codex');
  const workspace = path.join(root, 'workspace');
  for (const dir of [home, codexHome, workspace]) fs.mkdirSync(dir);
  const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: codexHome };
  return { root, home, codexHome, workspace, env };
}

function run(args, box) {
  const result = spawnSync(process.execPath, args, {
    cwd: box.workspace, env: box.env, encoding: 'utf8', timeout: 30000, windowsHide: true,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

test('policy enumeration follows CODEX_HOME and explicit isolated homes do not inherit it', (t) => {
  const box = fixture(t);
  const defaultDir = path.join(box.home, '.codex', 'rules');
  const customDir = path.join(box.codexHome, 'rules');
  for (const dir of [defaultDir, customDir]) fs.mkdirSync(dir, { recursive: true });
  const normal = path.join(defaultDir, 'normal.rules');
  const custom = path.join(customDir, 'custom.rules');
  fs.writeFileSync(normal, '# default profile\n');
  fs.writeFileSync(custom, '# active profile\n');
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = box.codexHome;
  t.after(() => { if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous; });

  assert.deepEqual(codexRuleFileSet().files, [custom]);
  assert.deepEqual(codexRuleFileSet({ home: box.home }).files, [normal]);
  assert.deepEqual(codexRuleFileSet({ home: box.home, codexHome: box.codexHome }).files, [custom]);
});

test('the active profile supplies the managed cache and manager default history and policy paths', (t) => {
  const box = fixture(t);
  fs.writeFileSync(path.join(box.codexHome, 'cloud-config-bundle-cache.json'), JSON.stringify({ fixture: 'active custom profile' }));
  const policyModule = require.resolve('../src/codex-policy');
  const managerModule = require.resolve('../src/auto-learn-manager');
  const result = run(['-e', `
    const { readEnterpriseBundle } = require(${JSON.stringify(policyModule)});
    const { createAutoLearnManager } = require(${JSON.stringify(managerModule)});
    console.log(JSON.stringify({ bundle: readEnterpriseBundle(), paths: createAutoLearnManager().paths }));
  `], box);
  assert.equal(result.bundle.fixture, 'active custom profile');
  assert.deepEqual(result.paths.codexHistory, [path.join(box.codexHome, 'sessions')]);
  assert.equal(result.paths.codexRules, path.join(box.codexHome, 'rules', 'permission-wildcarding.rules'));
  assert.equal(fs.existsSync(path.join(box.home, '.codex')), false);
});

test('CLI scan discovers custom-home Codex history and retains its output target', (t) => {
  const box = fixture(t);
  const sessions = path.join(box.codexHome, 'sessions');
  fs.mkdirSync(sessions);
  const records = [{ type: 'session_meta', payload: { id: 'custom-home-fixture', cwd: box.workspace } }];
  for (let index = 0; index < 3; index += 1) {
    const call_id = `custom-home-${index}`;
    records.push({ type: 'response_item', payload: {
      type: 'function_call', name: 'shell_command', call_id,
      arguments: JSON.stringify({ command: 'git status --short', workdir: box.workspace }),
    } });
    records.push({ type: 'response_item', payload: {
      type: 'function_call_output', call_id, output: JSON.stringify({ exit_code: 0, output: 'fixture' }),
    } });
  }
  fs.writeFileSync(path.join(sessions, 'rollout-custom.jsonl'), records.map(JSON.stringify).join('\n') + '\n');
  const cli = path.resolve(__dirname, '..', 'bin', 'wildcard-perms');
  const scan = run([cli, '--learn', 'scan', '--workspace', box.workspace], box);
  assert.equal(scan.newObservations, 3);
  const status = run([cli, '--learn', 'status', '--workspace', box.workspace], box);
  assert.equal(status.paths.codexRules, path.join(box.codexHome, 'rules', 'permission-wildcarding.rules'));
  assert.equal(fs.existsSync(path.join(box.home, '.codex')), false, 'scan/status must not create or write the default profile');
  const second = run([cli, '--learn', 'scan', '--workspace', box.workspace], box);
  assert.equal(second.newObservations, 0, 'routing the custom profile must preserve scan deduplication');
});
