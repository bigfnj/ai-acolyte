'use strict';

// Real Codex PermissionRequest hook, without an editor or a model.
//   node scripts/check-permission-request-runtime.js [--codex <executable>]
//
// `codex exec` cannot exercise this: it forces approval_policy "never" and
// rejects an escalation without asking (measured on 0.145.0), so the hook never
// fires there. This drives `codex app-server` instead, where an approval reaches
// the client as item/commandExecution/requestApproval unless a hook decides it.
//
// A scripted loopback responder asks for one escalated run of a harmless probe
// executable in an isolated repository. The product installer writes the hook entry into a
// temporary CODEX_HOME; a fixture-only capture hook beside it records the
// event's shape (key names, types, the command's root word, the permission mode)
// and never its text. Trust is granted the way /hooks grants it, by writing the
// exact `trusted_hash` hooks/list reports, and only into that temporary home.
// No credentials, no provider inference, no network beyond 127.0.0.1.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const { commandLaunch } = require(path.join(ROOT, 'src', 'exec-resolve.js'));
const { setCodexPermissionHook } = require(path.join(ROOT, 'src', 'permission-request-install.js'));
const { setHookMode } = require(path.join(ROOT, 'src', 'permission-request.js'));

const STRIPPED_ENV = ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'OPENAI_BASE_URL', 'OPENAI_ORG_ID',
  'OPENAI_ORGANIZATION', 'OPENAI_PROJECT_ID', 'AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_ENDPOINT',
  'CLAUDE_CODE_ENTRYPOINT', 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE'];
// Codex auto-allows `git status` as a known read-only command, so an approval
// needs an executable it knows nothing about. Bare-named, so the hook's own
// classifier sees an ordinary command rather than a .cmd script wrapper.
const PROBE = 'acolyte-permission-probe';
const COMMAND = `${PROBE} status`;
const WITNESS = 'permission-runtime-witness.txt';
const TIMEOUT_MS = 60000;

const CAPTURE = String.raw`'use strict';
const fs = require('fs');
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  let event = {};
  try { event = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
  const input = event.tool_input && typeof event.tool_input === 'object' ? event.tool_input : {};
  const command = typeof input.command === 'string' ? input.command : '';
  const root = (command.trim().split(/\s+/)[0] || '').replace(/^.*[\\/]/, '').replace(/["']/g, '').toLowerCase();
  fs.appendFileSync(process.argv[2], JSON.stringify({ keys: Object.keys(event).sort(), tool_name: event.tool_name,
    hook_event_name: event.hook_event_name, permission_mode: event.permission_mode,
    toolInputKeys: Object.keys(input).sort(), commandType: Array.isArray(input.command) ? 'array' : typeof input.command,
    commandRoot: /^[a-z0-9_.-]{1,40}$/.test(root) ? root : 'other', commandWords: command.trim().split(/\s+/).filter(Boolean).length,
    transcriptType: typeof event.transcript_path }) + '\n');
});
`;

const tomlString = (text) => `"${String(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main() {
  assert.equal(process.platform, 'win32', 'this runtime fixture targets Windows, like its Stop-hook sibling');
  const codex = option('--codex') || 'codex';
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-permission-runtime-'));
  const home = path.join(out, 'home');
  const codexHome = path.join(home, '.codex');
  const workspace = path.join(out, 'workspace');
  for (const dir of [codexHome, workspace, path.join(home, '.claude')]) fs.mkdirSync(dir, { recursive: true });
  const report = { status: 'running', codex, startedAt: new Date().toISOString(), cases: [] };
  const reportPath = path.join(out, 'evidence.json');
  const save = () => fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: codexHome,
    PATH: workspace + path.delimiter + process.env.PATH };
  for (const key of STRIPPED_ENV) delete env[key];
  const sync = (file, args) => {
    const launch = commandLaunch(file, args);
    assert.ok(launch.resolved, `${file} must be reachable`);
    const run = spawnSync(launch.file, launch.args, { ...launch.options, cwd: workspace, env, encoding: 'utf8', windowsHide: true, timeout: 15000 });
    assert.ifError(run.error);
    assert.equal(run.status, 0, run.stderr || run.stdout);
    return run.stdout.trim();
  };
  const productLog = path.join(home, '.ai-acolyte', 'permission-request.jsonl');
  const captureLog = path.join(out, 'capture.jsonl');
  const lines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []);
  let trust = [];
  let port = 0;
  const writeConfig = () => fs.writeFileSync(path.join(codexHome, 'config.toml'), [
    'model = "acolyte-runtime-fixture"', 'model_provider = "acolyte_runtime_fixture"',
    'approval_policy = "on-request"', 'sandbox_mode = "read-only"', '[features]', 'hooks = true', 'plugins = false',
    '[model_providers.acolyte_runtime_fixture]', 'name = "Acolyte scripted loopback responder"',
    `base_url = "http://127.0.0.1:${port}/v1"`, 'wire_api = "responses"',
    'requires_openai_auth = false', 'request_max_retries = 0', 'stream_max_retries = 0',
    ...trust.flatMap((hook) => [`[hooks.state.${tomlString(hook.key)}]`, `trusted_hash = ${tomlString(hook.currentHash)}`]), ''].join('\n'));

  // One app-server process: initialize, optionally list hooks, optionally run
  // one turn. `beforeTurn` runs after the thread exists and before the turn.
  async function session(name, { turn = true, beforeTurn } = {}) {
    const evidence = { name, providerRequests: 0, approvals: 0, executions: [], hookNotifications: [], passed: false };
    const beforeProduct = lines(productLog).length;
    const beforeCapture = lines(captureLog).length;
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        evidence.providerRequests += 1;
        const item = evidence.providerRequests === 1
          ? { id: 'fc_permission', type: 'function_call', name: 'shell_command', call_id: 'call_permission',
            arguments: JSON.stringify({ command: COMMAND, workdir: workspace, sandbox_permissions: 'require_escalated',
              justification: 'Run the isolated harmless permission fixture.' }) }
          : { id: 'msg_permission', type: 'message', role: 'assistant', status: 'completed',
            content: [{ type: 'output_text', text: 'Fixture complete.', annotations: [] }] };
        const id = `response_permission_${evidence.providerRequests}`;
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (const event of [{ type: 'response.created', response: { id, object: 'response', status: 'in_progress', output: [] } },
          { type: 'response.output_item.added', output_index: 0, item }, { type: 'response.output_item.done', output_index: 0, item },
          { type: 'response.completed', response: { id, object: 'response', status: 'completed', output: [item],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }]) {
          res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        }
        res.end();
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
    writeConfig();
    const launch = commandLaunch(codex, ['app-server', '--stdio']);
    const child = spawn(launch.file, launch.args, { ...launch.options, cwd: workspace, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const closed = new Promise((resolve) => child.once('close', resolve));
    child.stderr.on('data', () => {});
    let nextId = 0;
    const pending = new Map();
    let resolveTurn;
    let rejectTurn;
    const done = new Promise((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject; });
    done.catch(() => {});
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const rpc = (method, params) => new Promise((resolve, reject) => { const id = ++nextId; pending.set(id, { resolve, reject }); send({ id, method, params }); });
    const reader = readline.createInterface({ input: child.stdout });
    reader.on('line', (line) => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.id != null && !message.method && pending.has(message.id)) {
        const entry = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) entry.reject(new Error(`${name}: RPC ${message.error.code} ${message.error.message}`));
        else entry.resolve(message.result);
        return;
      }
      if (message.id != null && message.method) {
        if (/requestApproval$/.test(message.method)) {
          evidence.approvals += 1;
          send({ id: message.id, result: { decision: 'decline' } });
        } else send({ id: message.id, error: { code: -32601, message: 'fixture handles approvals only' } });
        return;
      }
      if (/hook/i.test(message.method || '')) {
        const run = message.params?.run || {};
        evidence.hookNotifications.push({ method: message.method, eventName: run.eventName, status: run.status });
      }
      if (message.method === 'item/completed' && message.params?.item?.type === 'commandExecution') {
        const item = message.params.item;
        const prior = evidence.executions.find((entry) => entry.id === item.id);
        const next = { id: item.id, status: item.status, exitCode: item.exitCode ?? null,
          witness: String(item.aggregatedOutput || '').includes(WITNESS) };
        if (prior) Object.assign(prior, { exitCode: next.exitCode ?? prior.exitCode, witness: prior.witness || next.witness });
        else evidence.executions.push(next);
      }
      if (message.method === 'turn/completed') resolveTurn();
    });
    const timer = setTimeout(() => rejectTurn(new Error(`${name}: timed out`)), TIMEOUT_MS);
    try {
      await rpc('initialize', { clientInfo: { name: 'acolyte_permission_runtime', version: '1' }, capabilities: { experimentalApi: true } });
      send({ method: 'initialized', params: {} });
      const listed = await rpc('hooks/list', { cwds: [workspace] });
      evidence.hooks = (listed.data || []).flatMap((entry) => entry.hooks || [])
        .filter((hook) => hook.eventName === 'permissionRequest')
        .map((hook) => ({ key: hook.key, currentHash: hook.currentHash, trustStatus: hook.trustStatus, source: hook.source }));
      if (turn) {
        const started = await rpc('thread/start', { cwd: workspace, model: 'acolyte-runtime-fixture',
          modelProvider: 'acolyte_runtime_fixture', approvalPolicy: 'on-request', sandbox: 'read-only' });
        if (beforeTurn) beforeTurn();
        await rpc('turn/start', { threadId: started.thread.id, input: [{ type: 'text', text: 'Run the isolated fixture.' }] });
        await done;
      }
    } finally {
      clearTimeout(timer);
      child.stdin.end();
      const exited = await Promise.race([closed.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 5000))]);
      if (!exited && child.pid) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      reader.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    evidence.hookCalls = { product: lines(productLog).slice(beforeProduct), capture: lines(captureLog).slice(beforeCapture) };
    report.cases.push(evidence);
    save();
    return evidence;
  }

  try {
    report.codexVersion = sync(codex, ['--version']);
    sync('git', ['init', '--quiet', workspace]);
    fs.writeFileSync(path.join(workspace, WITNESS), 'harmless runtime fixture\n');
    fs.writeFileSync(path.join(workspace, `${PROBE}.cmd`), `@echo off\r\necho ${WITNESS}\r\n`);
    const installed = setCodexPermissionHook(true, { home, codexHome });
    assert.equal(installed.configured, true);
    assert.equal(installed.trust, 'not-verified');
    const captureScript = path.join(out, 'capture.js');
    fs.writeFileSync(captureScript, CAPTURE);
    const hooks = JSON.parse(fs.readFileSync(installed.path, 'utf8'));
    hooks.hooks.PermissionRequest.push({ matcher: 'Bash', hooks: [{ type: 'command', timeout: 10,
      command: `node '${captureScript}' '${captureLog}'`, commandWindows: `& 'node' '${captureScript}' '${captureLog}'` }] });
    fs.writeFileSync(installed.path, `${JSON.stringify(hooks, null, 2)}\n`);

    const untrusted = await session('untrusted-hook-is-skipped');
    assert.equal(untrusted.hooks.length, 2, 'hooks/list shows both PermissionRequest hooks');
    assert.ok(untrusted.hooks.every((hook) => hook.trustStatus === 'untrusted'), 'a configured hook starts untrusted');
    assert.equal(untrusted.approvals, 1, 'Codex asks the client');
    assert.equal(untrusted.hookCalls.product.length, 0, 'WITNESS Codex skips an untrusted hook');
    assert.equal(untrusted.hookCalls.capture.length, 0);
    untrusted.passed = true;

    trust = untrusted.hooks;
    const listed = await session('trust-is-recorded-against-the-exact-hash', { turn: false });
    assert.ok(listed.hooks.every((hook) => hook.trustStatus === 'trusted'), `trusted after review: ${JSON.stringify(listed.hooks.map((h) => h.trustStatus))}`);
    listed.passed = true;

    const observe = await session('observe-hook-fires-before-codex-asks');
    assert.equal(observe.hookCalls.product.length, 1, 'WITNESS Codex calls the trusted PermissionRequest hook');
    assert.equal(observe.hookCalls.capture.length, 1);
    const entry = observe.hookCalls.product[0];
    assert.equal(entry.product, 'codex');
    assert.equal(entry.tool, 'Bash');
    assert.equal(entry.reason, 'no-allow-rule');
    assert.equal(entry.permissionMode, 'default', 'Codex reports on-request as permission_mode "default"');
    assert.equal(entry.host, 'acolyte_permission_runtime', 'WITNESS the host is the originator read from the rollout');
    assert.equal(observe.approvals, 1, 'an abstaining hook leaves the approval to the person');
    assert.equal(observe.executions[0]?.status, 'declined');
    report.payload = observe.hookCalls.capture[0];
    report.productEntry = entry;
    observe.passed = true;

    setHookMode('approve', { home });
    const approveNoRule = await session('approve-mode-with-no-rule-still-asks');
    assert.equal(approveNoRule.hookCalls.product[0]?.decision, 'abstain');
    assert.equal(approveNoRule.approvals, 1);
    approveNoRule.passed = true;

    const rules = path.join(codexHome, 'rules', 'fixture.rules');
    const addRule = () => {
      fs.mkdirSync(path.dirname(rules), { recursive: true });
      fs.writeFileSync(rules, `prefix_rule(pattern = ["${PROBE}"], decision = "allow")\n`);
    };
    // The one disagreement a rules-based hook can legitimately resolve: a rule
    // written while Codex is already running. Either Codex reloads it (no
    // prompt, no hook call) or it asks, and the hook approves from the fresh file.
    const midSession = await session('rule-written-after-codex-started', { beforeTurn: addRule });
    report.midSessionRule = { hookCalls: midSession.hookCalls.product.map((item) => item.decision),
      approvals: midSession.approvals, executions: midSession.executions };
    assert.equal(midSession.approvals, 0, 'nobody was asked');
    assert.ok(midSession.executions.some((item) => item.exitCode === 0 && item.witness), 'the command ran');
    midSession.passed = true;

    const ruled = await session('a-rule-codex-loaded-means-no-prompt-and-no-hook-call');
    assert.equal(ruled.hookCalls.product.length, 0, 'WITNESS the hook is not consulted for a call the rules already allow');
    assert.equal(ruled.approvals, 0);
    assert.ok(ruled.executions.some((item) => item.exitCode === 0 && item.witness));
    ruled.passed = true;
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed';
    report.failure = String(error.stack || error);
    process.exitCode = 1;
  } finally {
    report.finishedAt = new Date().toISOString();
    save();
    console.log(`${report.status.toUpperCase()}: ${report.cases.filter((item) => item.passed).length}/${report.cases.length} cases; ${reportPath}`);
    if (report.payload) console.log(`payload shape: ${JSON.stringify(report.payload)}`);
    if (report.midSessionRule) console.log(`rule written mid-session: ${JSON.stringify(report.midSessionRule)}`);
    if (report.failure) console.error(report.failure);
  }
}

main().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
