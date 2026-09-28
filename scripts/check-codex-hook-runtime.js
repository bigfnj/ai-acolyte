#!/usr/bin/env node
'use strict';

// Real Codex Stop callback from the named staged subject, without an editor.
// node scripts/check-codex-hook-runtime.js --extension-dir <stage>
//   [--codex <executable>] [--codex-layout default|custom-override]
// Only the inspected fixture definition uses the documented one-invocation
// trust override. No persisted trust is written and no provider inference runs.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { createRuntimeContext, runtimeCase, assertAllowed, rolloutFor } = require('./check-codex-runtime');

const BOUNDARY = 'Real Codex exec with the staged setCodexHook configuration and staged Stop callback; no editor, synthetic history, provider inference, credentials or persisted hook-trust changes. Scripted loopback responder requests inspected read-only git commands in an isolated empty repository.';
const ENV_KEYS = ['HOME', 'USERPROFILE', 'CODEX_HOME', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'OPENAI_BASE_URL',
  'OPENAI_ORG_ID', 'OPENAI_ORGANIZATION', 'OPENAI_PROJECT_ID', 'AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_ENDPOINT'];
const MODULES = ['auto-learn-manager', 'codex-stop-hook', 'codex-hook-config', 'codex-hook-install', 'history-adapters'];
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const fileHash = (file) => hash(fs.readFileSync(file));
const json = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

function args(argv) {
  const result = {};
  for (let n = 0; n < argv.length; n += 2) {
    assert.ok(['--extension-dir', '--codex-layout', '--codex'].includes(argv[n]) && argv[n + 1], 'unknown or incomplete option');
    assert.equal(result[argv[n]], undefined, 'duplicate option'); result[argv[n]] = argv[n + 1];
  }
  assert.ok(result['--extension-dir'], '--extension-dir must name the immutable staged subject');
  assert.ok(!result['--codex-layout'] || ['default', 'custom-override'].includes(result['--codex-layout']), 'unknown Codex layout');
  return result;
}
function subjectFiles(extension) {
  return Object.fromEntries(['package.json', 'extension.js', ...fs.readdirSync(path.join(extension, 'src'))
    .filter((name) => name.endsWith('.js')).map((name) => 'src/' + name)].sort().map((relative) =>
    [relative, { sha256: fileHash(path.join(extension, relative)), mtimeMs: fs.statSync(path.join(extension, relative)).mtimeMs }]));
}

async function main() {
  assert.equal(process.platform, 'win32', 'this real runtime fixture currently targets Windows');
  const options = args(process.argv.slice(2));
  const extension = path.resolve(options['--extension-dir']);
  for (const name of MODULES) assert.ok(fs.existsSync(path.join(extension, 'src', name + '.js')), 'missing staged ' + name);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-codex-hook-runtime-'));
  const home = path.join(out, 'home');
  const customLayout = options['--codex-layout'] === 'custom-override';
  const codexHome = customLayout ? path.join(out, 'custom-codex') : path.join(home, '.codex');
  const workspace = path.join(out, 'workspace');
  const reportPath = path.join(out, 'evidence.json');
  const report = { status: 'running', boundary: BOUNDARY, out, extension,
    codexLayout: customLayout ? 'custom-override' : 'default', subjectFiles: subjectFiles(extension),
    harnessHashes: { hook: fileHash(__filename), runtime: fileHash(path.join(__dirname, 'check-codex-runtime.js')) },
    startedAt: new Date().toISOString(), cases: [], steps: [] };
  const save = () => fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  save();
  try {
    for (const directory of [home, codexHome, workspace, path.join(home, '.claude')]) fs.mkdirSync(directory, { recursive: true });
    Object.assign(process.env, { HOME: home, USERPROFILE: home, CODEX_HOME: codexHome });
    for (const key of ENV_KEYS.slice(3)) delete process.env[key];
    const { commandLaunch } = require(path.join(extension, 'src', 'exec-resolve.js'));
    const { createAutoLearnManager } = require(path.join(extension, 'src', 'auto-learn-manager.js'));
    const { setCodexHook, inspectCodexHook } = require(path.join(extension, 'src', 'codex-hook-install.js'));
    const { parseCodexJsonl } = require(path.join(extension, 'src', 'history-adapters.js'));
    const codex = options['--codex'] || 'codex';
    function sync(command, argv, extra = {}) {
      const launch = commandLaunch(command, argv);
      assert.ok(launch.resolved, command + ' must be reachable');
      const result = spawnSync(launch.file, launch.args, { ...launch.options, cwd: workspace, windowsHide: true, encoding: 'utf8', timeout: 15000, ...extra });
      assert.ifError(result.error); assert.equal(result.status, 0, result.stderr || result.stdout); return result;
    }
    report.codexVersion = sync(codex, ['--version']).stdout.trim();
    report.gitVersion = sync('git', ['--version']).stdout.trim();
    sync('git', ['init', '--quiet', workspace]);
    fs.writeFileSync(path.join(workspace, 'hook-runtime-witness.txt'), 'Harmless runtime fixture\n');
    const user = 'acolyte-stop-hook-user-witness';
    const shadowed = 'acolyte-stop-hook-shadowed-base';
    const instructions = path.join(codexHome, customLayout ? 'AGENTS.override.md' : 'AGENTS.md');
    fs.writeFileSync(instructions, '# Isolated hook instructions\n' + user + '\n');
    if (customLayout) fs.writeFileSync(path.join(codexHome, 'AGENTS.md'), shadowed + '\n');
    const claudeSettings = path.join(home, '.claude', 'settings.json');
    fs.writeFileSync(claudeSettings, '{"permissions":{"allow":["Bash(fixture-only *)"]},"owner":"preserve"}\r\n');
    const claudeBefore = fileHash(claudeSettings);
    const manager = createAutoLearnManager({ home, codexHome, workspaceRoot: workspace });
    manager.setMode('observe', 3);
    assert.equal(manager.listCandidates().length, 0);
    const hookOptions = { home, codexHome, scriptPath: path.join(extension, 'src', 'codex-stop-hook.js') };
    const installed = setCodexHook(true, hookOptions);
    assert.equal(installed.status, 'configured'); assert.equal(installed.trust, 'not-verified');
    assert.equal(installed.reviewRequired, true);
    const definition = json(installed.path);
    assert.equal(definition.hooks.Stop.length, 1);
    assert.equal(definition.hooks.Stop[0].hooks.length, 1, 'exactly one inspected hook may run in this fixture');
    assert.equal(definition.hooks.Stop[0].hooks[0].type, 'command');
    assert.ok(definition.hooks.Stop[0].hooks[0].commandWindows.includes(hookOptions.scriptPath));
    const hookHash = fileHash(installed.path);
    const context = createRuntimeContext({ extensionDir: extension, home, codexHome, workspace, customLayout,
      codexExecutable: codex, commandName: 'git', shellWitness: 'hook-runtime-witness.txt',
      instructionWitnesses: { user, shadowed, gate: 'absent-hook-fixture-gate' } });
    const childEnv = context.childEnv;
    report.fixture = { home, codexHome, workspace, state: manager.paths.state, rules: manager.paths.codexRules,
      hookConfig: installed.path, hookConfigHash: hookHash, callback: hookOptions.scriptPath, callbackHash: fileHash(hookOptions.scriptPath) };
    console.log(report.boundary);
    console.log(`Subject ${extension}; ${report.codexVersion}; ${report.codexLayout}; evidence ${reportPath}`);
    const preserve = () => {
      assert.equal(fileHash(claudeSettings), claudeBefore, 'WITNESS Codex hook must preserve Claude policy bytes');
      assert.equal(fileHash(installed.path), hookHash, 'runtime must not rewrite hook definitions or trust');
      if (customLayout) assert.equal(fs.existsSync(path.join(home, '.codex')), false, 'custom profile must not create default Codex home');
    };
    const find = (subcommand) => manager.listCandidates().find((item) => item.prefix[0] === 'git' && item.prefix[1] === subcommand);

    async function turn(name, command, vetted, expectedExit, tool = true) {
      const evidence = { name, command, vettedOnlyForThisInvocation: vetted, requests: 0, stdout: '', stderr: '', passed: false };
      report.cases.push(evidence); save();
      const server = http.createServer((req, res) => {
        const chunks = []; req.on('data', (chunk) => chunks.push(chunk)); req.on('end', () => {
          try {
            assert.equal(req.method, 'POST'); assert.equal(req.url, '/v1/responses');
            assert.equal(req.headers.authorization, undefined); assert.equal(req.headers['api-key'], undefined);
            const body = JSON.parse(Buffer.concat(chunks)); evidence.requests++;
            assert.ok(evidence.requests <= (tool ? 2 : 1), 'no hook-triggered tool or model loop');
            assert.ok(body.tools.some((item) => item.name === 'shell_command'));
            const item = tool && evidence.requests === 1
              ? { id: 'fc_stop_fixture', type: 'function_call', name: 'shell_command', call_id: 'call_stop_fixture', arguments: JSON.stringify({ command, workdir: workspace }) }
              : { id: 'msg_stop_fixture', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Isolated Stop fixture complete.', annotations: [] }] };
            const id = 'response_stop_fixture_' + evidence.requests;
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            for (const event of [{ type: 'response.created', response: { id, object: 'response', status: 'in_progress', output: [] } },
              { type: 'response.output_item.added', output_index: 0, item }, { type: 'response.output_item.done', output_index: 0, item },
              { type: 'response.completed', response: { id, object: 'response', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }]) {
              res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
            }
            res.end();
          } catch (error) { evidence.providerError = error.stack; res.writeHead(500); res.end('Fixture rejected'); }
        });
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      fs.writeFileSync(path.join(codexHome, 'config.toml'), [
        'model = "acolyte-runtime-fixture"', 'model_provider = "acolyte_runtime_fixture"', 'approval_policy = "never"', 'sandbox_mode = "danger-full-access"',
        '[features]', 'hooks = true', 'plugins = false', '[model_providers.acolyte_runtime_fixture]', 'name = "Inspected Stop fixture local responder"',
        `base_url = "http://127.0.0.1:${server.address().port}/v1"`, 'wire_api = "responses"', 'requires_openai_auth = false', 'request_max_retries = 0', 'stream_max_retries = 0', '',
      ].join('\n'));
      const argv = ['exec', ...(vetted ? ['--dangerously-bypass-hook-trust'] : []), '--json', '--sandbox', 'danger-full-access', 'Run only the isolated fixture.'];
      const launch = commandLaunch(codex, argv); evidence.argv = argv;
      const child = spawn(launch.file, launch.args, { ...launch.options, cwd: workspace, env: childEnv, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      child.stdin.end(); child.stdout.on('data', (chunk) => { evidence.stdout += chunk; }); child.stderr.on('data', (chunk) => { evidence.stderr += chunk; });
      const timer = setTimeout(() => { if (child.pid) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }); }, 60000);
      try { evidence.exit = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); }); }
      finally { clearTimeout(timer); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
      save(); assert.equal(evidence.exit, 0, evidence.stderr); assert.equal(evidence.providerError, undefined);
      assert.equal(evidence.requests, tool ? 2 : 1, 'Stop must not create another model turn');
      const events = evidence.stdout.trim().split('\n').map(JSON.parse);
      const completed = events.filter((event) => event.type === 'item.completed' && event.item?.type === 'command_execution');
      assert.equal(completed.length, tool ? 1 : 0);
      if (tool) {
        assert.equal(completed[0].item.exit_code, expectedExit, 'actual command exit status must match fixture');
        if (expectedExit === 0) assert.ok(completed[0].item.aggregated_output.includes('hook-runtime-witness.txt'), 'read-only git output is the execution witness');
      }
      const thread = events.find((event) => event.type === 'thread.started');
      assert.ok(thread?.thread_id); evidence.threadId = thread.thread_id;
      const rollout = rolloutFor(codexHome, thread.thread_id);
      const observations = parseCodexJsonl(fs.readFileSync(rollout, 'utf8'), { file: rollout, platform: process.platform });
      const observed = observations.filter((item) => item.command === command);
      assert.equal(observed.length, tool ? 1 : 0);
      if (tool) assert.equal(observed[0].status, expectedExit === 0 ? 'success' : 'failed');
      evidence.rollout = { path: rollout, sha256: fileHash(rollout), statuses: observed.map((item) => item.status) };
      preserve(); evidence.passed = true; save(); console.log('PASS ' + name);
    }

    const originalState = fileHash(manager.paths.state);
    await turn('untrusted-hook-remains-skipped', 'git status --short', false, 0);
    assert.equal(fileHash(manager.paths.state), originalState, 'WITNESS untrusted hook cannot change learner state');
    assert.equal(manager.listCandidates().length, 0);
    await turn('trusted-observe-learns-real-success', 'git status --short', true, 0);
    assert.equal(find('status')?.counts.success, 2, 'WITNESS actual staged callback ingests completed successes');
    assert.equal(manager.status().mode, 'observe');
    assert.equal(fs.existsSync(manager.paths.codexRules), false, 'observe mode must not write policy');
    await turn('trusted-observe-retains-real-failure', 'git log --oneline', true, 1);
    assert.equal(find('log')?.counts.success, 0, 'WITNESS failed actual process receives no success credit');
    assert.equal(find('log')?.counts.failed, 1);
    const counts = manager.listCandidates().map((item) => ({ key: item.key, counts: item.counts }));
    await turn('repeated-stop-without-tools-deduplicates', '', true, null, false);
    assert.deepEqual(manager.listCandidates().map((item) => ({ key: item.key, counts: item.counts })), counts,
      'WITNESS another real Stop does not duplicate earlier observations');
    manager.setMode('auto-safe', 3);
    await turn('trusted-auto-safe-writes-codex-policy', 'git status --short', true, 0);
    assert.equal(manager.status().mode, 'auto-safe', 'hook preserves the explicitly persisted mode');
    assert.equal(find('status')?.counts.success, 3);
    assert.ok(fs.readFileSync(manager.paths.codexRules, 'utf8').includes('status'), 'WITNESS no-editor Stop callback writes eligible Codex policy');
    assert.ok(json(manager.paths.state).applied.codex.includes(find('status').key));
    const beforeFresh = fileHash(manager.paths.state);
    const allowed = await runtimeCase(context, 'fresh-runtime-uses-hook-generated-rule', 'status --short', false);
    assertAllowed(allowed); assert.equal(fileHash(manager.paths.state), beforeFresh, 'untrusted app-server hook remains skipped');
    report.steps.push({ name: 'fresh-process-rule-consumption', ...allowed, passed: true });
    assert.equal(inspectCodexHook(hookOptions).trust, 'not-verified', 'vetted-only invocations do not confer persisted trust');
    preserve(); report.status = 'passed';
  } catch (error) { report.status = 'failed'; report.failure = String(error.stack || error); process.exitCode = 1; }
  finally {
    try {
      assert.deepEqual(subjectFiles(extension), report.subjectFiles, 'immutable staged subject changed');
      assert.equal(fileHash(__filename), report.harnessHashes.hook); assert.equal(fileHash(path.join(__dirname, 'check-codex-runtime.js')), report.harnessHashes.runtime);
      report.subjectUnchanged = true;
    } catch (error) { report.status = 'failed'; report.integrityFailure = error.message; process.exitCode = 1; }
    for (const [key, value] of Object.entries(originalEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    report.finishedAt = new Date().toISOString(); save();
    console.log(`${report.status.toUpperCase()}: ${report.cases.filter((item) => item.passed).length}/5 CLI turns, ${report.steps.filter((item) => item.passed).length}/1 fresh rule-consumption process; ${reportPath}`);
    if (report.failure) console.error(report.failure);
  }
}

if (require.main === module) main().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
