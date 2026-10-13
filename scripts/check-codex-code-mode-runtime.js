#!/usr/bin/env node
'use strict';

// Real Codex code-mode `exec` cells, completed directly or continued by `wait`,
// using a scripted loopback provider. No inference or provider credentials.
//
//   node scripts/check-codex-code-mode-runtime.js --extension-dir <source-or-staged-root>
//     [--write-fixture <path>]
//
// WHY THIS EXISTS (2026-10-13). The history parser reads a custom
// `functions.exec` cell whose body calls `tools.exec_command(...)`, and the
// September 28 record left "custom functions.exec/functions.wait continuation"
// outside its proof because no actual continued cell had ever been observed.
// Codex 0.161.0 exposes `exec` (a custom, grammar-format tool) and `wait` (a
// function tool) when the fixture enables `code_mode`, so a scripted responder
// can make a fresh app-server emit both shapes. This records what the rollout
// contains and what the named subject's parser concludes, cell by cell.
//
// What it asserts is the safety property, not the current coverage: a cell is
// credited with its true terminal outcome or left `unknown`, and never with the
// opposite one. A parser that later joins `wait` results back to their cell
// keeps passing; one that credits a failed continued cell with success fails.
// The observed per-cell verdicts are printed and recorded either way.
//
// `--write-fixture` writes a sanitized copy of the one-session sequence rollout
// (every cell shape in real order and real cell-ID allocation) for
// test/codex-code-mode-history.test.js. Paths, ids and timestamps are replaced;
// no instructions, environment or machine detail is carried over.
//
// code_mode is enabled ONLY in this fixture's temporary CODEX_HOME. Nothing
// here implies the feature is on, or stable, in anybody's real profile.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');
const readline = require('node:readline');
const { spawn, spawnSync } = require('node:child_process');

const SECRET_ENV = ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'OPENAI_BASE_URL', 'OPENAI_ORG_ID',
  'OPENAI_ORGANIZATION', 'OPENAI_PROJECT_ID', 'AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_ENDPOINT'];
const WITNESS = 'acolyte-code-mode-witness';
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 2) {
  assert.ok(['--extension-dir', '--write-fixture'].includes(args[i]) && args[i + 1],
    'usage: check-codex-code-mode-runtime.js --extension-dir <source-or-staged-root> [--write-fixture <path>]');
}
const option = (name) => { const at = args.indexOf(name); return at < 0 ? null : args[at + 1]; };
assert.ok(option('--extension-dir'), '--extension-dir must name the subject');
const subject = path.resolve(option('--extension-dir'));
const { commandLaunch } = require(path.join(subject, 'src/exec-resolve'));
const { parseCodexJsonl } = require(path.join(subject, 'src/history-adapters'));
const { rolloutFor } = require('./check-codex-runtime');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-code-mode-'));
const digest = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const evidence = { boundary: 'Isolated real Codex app-server with code_mode enabled only in a temporary CODEX_HOME; scripted loopback provider, no inference or credentials; fixture-only rollouts.', root, cases: [] };

// A cell either finishes inside its own yield window (`complete`) or yields
// first and is finished by `wait` (`continued`). Exit 7 is a deliberate
// nonzero; the shell may report it as another nonzero code, which is why the
// expectation is a status rather than a number.
const COMPLETE_SUCCESS = { exitCode: 0, delayMs: 10, cellYieldMs: 25000, expected: 'success', continued: false };
const COMPLETE_FAILED = { exitCode: 7, delayMs: 10, cellYieldMs: 25000, expected: 'failed', continued: false };
const CONTINUED_SUCCESS = { exitCode: 0, delayMs: 4000, cellYieldMs: 500, expected: 'success', continued: true };
const CONTINUED_FAILED = { exitCode: 7, delayMs: 4000, cellYieldMs: 500, expected: 'failed', continued: true };
const CASES = [
  ['complete-success', [COMPLETE_SUCCESS]],
  ['complete-failed', [COMPLETE_FAILED]],
  ['continued-success', [CONTINUED_SUCCESS]],
  ['continued-failed', [CONTINUED_FAILED]],
  // One session, all four shapes in sequence: real ordering and real cell-ID
  // allocation for the sanitized fixture, and the parser's view of a session
  // that mixes them.
  ['sequence', [COMPLETE_SUCCESS, COMPLETE_FAILED, CONTINUED_SUCCESS, CONTINUED_FAILED]],
];

function sse(res, item, id) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const event of [
    { type: 'response.created', response: { id, object: 'response', status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id, object: 'response', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
  ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  res.end();
}

function outputText(output) {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) return output.map((part) => (typeof part?.text === 'string' ? part.text : JSON.stringify(part))).join('\n');
  return JSON.stringify(output);
}

async function run(name, cells) {
  const dir = path.join(root, name), home = path.join(dir, 'home'), codexHome = path.join(home, '.codex'), workspace = path.join(dir, 'workspace');
  for (const target of [codexHome, workspace]) fs.mkdirSync(target, { recursive: true });
  const plan = cells.map((cell, index) => {
    const script = path.join(workspace, `cell-${index + 1}.cjs`);
    fs.writeFileSync(script, `setTimeout(() => { console.log('${WITNESS}'); process.exit(${cell.exitCode}); }, ${cell.delayMs});\n`);
    // A plain string literal with forward slashes, so the parser's lexer, which
    // refuses variables, concatenation and escapes it cannot prove, can read it.
    const command = `node "${script.replace(/\\/g, '/')}"`;
    const source = `// @exec: {"yield_time_ms": ${cell.cellYieldMs}, "max_output_tokens": 400}\n`
      + `const result = await tools.exec_command({ cmd: ${JSON.stringify(command)}, sandbox_permissions: "require_escalated", justification: "Harmless isolated code-mode canary.", yield_time_ms: 30000 });\n`
      + 'text(result);\n';
    return { ...cell, callId: `call_cell_${index + 1}`, command, source };
  });
  const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: codexHome };
  for (const key of SECRET_ENV) delete env[key];
  const observed = { name, cells: plan.map(({ callId, expected, continued }) => ({ callId, expected, continued })),
    requests: 0, approvals: [], calls: [], waits: [], events: [] };
  evidence.cases.push(observed);
  let child, lines, timer, stopping = false, count = 0, finishedResolve, finishedReject, next = 0;
  const pending = new Map();
  const finished = new Promise((resolve, reject) => { finishedResolve = resolve; finishedReject = reject; });
  finished.catch(() => {});
  const fail = (error) => { for (const item of pending.values()) item.reject(error); pending.clear(); finishedReject(error); };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try {
        assert.equal(req.headers.authorization, undefined, 'fixture provider must receive no authorization header');
        assert.equal(req.headers['api-key'], undefined, 'fixture provider must receive no API key header');
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        observed.requests += 1;
        assert.ok(observed.requests <= 1 + plan.length * 3, 'unexpected extra provider requests');
        const outputs = body.input.filter((item) => ['function_call_output', 'custom_tool_call_output'].includes(item.type));
        const latest = outputs[outputs.length - 1];
        if (observed.requests === 1) {
          observed.catalog = body.tools.map((tool) => ({ type: tool.type, name: tool.name }));
          assert.ok(body.tools.some((tool) => tool.type === 'custom' && tool.name === 'exec'), 'code_mode exposes the custom exec tool');
          assert.ok(body.tools.some((tool) => tool.name === 'wait'), 'code_mode exposes wait');
        } else assert.ok(latest, 'every continuation request must carry real tool output');
        const running = latest && /Script running with cell ID\s+([A-Za-z0-9_-]+)/i.exec(outputText(latest.output));
        let item;
        if (running) {
          observed.waits.push({ after: latest.call_id, cellId: running[1] });
          item = { type: 'function_call', name: 'wait', call_id: `call_wait_${observed.requests}`, arguments: JSON.stringify({ cell_id: running[1], yield_time_ms: 10000 }) };
        } else if (next < plan.length) {
          const cell = plan[next++];
          item = { type: 'custom_tool_call', name: 'exec', call_id: cell.callId, input: cell.source };
        } else {
          item = { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Isolated code-mode canary finished.', annotations: [] }] };
        }
        item.id = `fixture_${observed.requests}`;
        if (item.type !== 'message') observed.calls.push({ type: item.type, name: item.name, call_id: item.call_id });
        sse(res, item, `response_${observed.requests}`);
      } catch (error) { res.writeHead(500); res.end('Fixture rejected'); fail(error); }
    });
  });
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    fs.writeFileSync(path.join(codexHome, 'config.toml'), [
      'model="acolyte-code-mode-fixture"', 'model_provider="fixture"', 'approval_policy="on-request"', 'sandbox_mode="read-only"',
      '[features]', 'code_mode=true', 'plugins=false',
      '[model_providers.fixture]', 'name="Scripted isolated fixture"', `base_url="http://127.0.0.1:${server.address().port}/v1"`, 'wire_api="responses"', 'requires_openai_auth=false', 'request_max_retries=0', 'stream_max_retries=0', '',
    ].join('\n'));
    const launch = commandLaunch('codex', ['app-server', '--stdio']);
    assert.ok(launch.resolved, 'Codex executable is not reachable');
    child = spawn(launch.file, launch.args, { ...launch.options, env, cwd: workspace, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    observed.stderrBytes = 0;
    child.stderr.on('data', (chunk) => { observed.stderrBytes += chunk.length; });
    child.once('error', fail);
    child.once('exit', (code) => { if (!stopping && !observed.completed) fail(new Error(`App-server exited ${code}`)); });
    const send = (value) => child.stdin.write(`${JSON.stringify(value)}\n`);
    const rpc = (method, params) => new Promise((resolve, reject) => { const id = ++count; pending.set(id, { resolve, reject }); send({ id, method, params }); });
    lines = readline.createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      try {
        const message = JSON.parse(line);
        if (message.id != null && !message.method && pending.has(message.id)) {
          const item = pending.get(message.id); pending.delete(message.id);
          if (message.error) item.reject(new Error(JSON.stringify(message.error))); else item.resolve(message.result);
        } else if (message.id != null && message.method) {
          // Per-call acceptance of a nested command only; never a policy amendment.
          assert.equal(message.method, 'item/commandExecution/requestApproval', 'unexpected server request');
          observed.approvals.push(message.method);
          send({ id: message.id, result: { decision: 'accept' } });
        } else if (message.method === 'item/completed' && message.params?.item?.type === 'commandExecution') {
          observed.events.push({ status: message.params.item.status, exitCode: message.params.item.exitCode ?? null });
        } else if (message.method === 'turn/completed') {
          assert.equal(message.params.turn.status, 'completed'); observed.completed = true; finishedResolve();
        } else if (message.method === 'error') throw new Error(JSON.stringify(message.params));
      } catch (error) { fail(error); }
    });
    timer = setTimeout(() => fail(new Error('Code-mode canary timed out')), 30000 * plan.length);
    await rpc('initialize', { clientInfo: { name: 'acolyte_code_mode_canary', version: '1' }, capabilities: { experimentalApi: true } });
    send({ method: 'initialized', params: {} });
    const started = await rpc('thread/start', { cwd: workspace, model: 'acolyte-code-mode-fixture', modelProvider: 'fixture', approvalPolicy: 'on-request', sandbox: 'read-only' });
    observed.threadId = started.thread.id;
    await rpc('turn/start', { threadId: observed.threadId, input: [{ type: 'text', text: 'Run the harmless isolated code-mode cells.' }] });
    await finished;
  } catch (error) { observed.error = error.message; throw error; }
  finally {
    stopping = true; clearTimeout(timer);
    if (child) {
      const closed = new Promise((resolve) => child.once('close', resolve));
      child.stdin.end();
      await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 1500))]);
      if (child.exitCode === null && process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 });
      else if (child.exitCode === null) child.kill('SIGTERM');
    }
    lines?.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
    if (observed.threadId) {
      observed.rolloutPath = rolloutFor(codexHome, observed.threadId);
      observed.rolloutHash = digest(observed.rolloutPath);
      const text = fs.readFileSync(observed.rolloutPath, 'utf8');
      const verdicts = parseCodexJsonl(text, { file: observed.rolloutPath });
      for (const cell of plan) {
        const matches = verdicts.filter((item) => item.callId === cell.callId && item.command === cell.command);
        const record = observed.cells.find((entry) => entry.callId === cell.callId);
        record.observations = matches.length;
        record.status = matches[0]?.status ?? null;
      }
      observed.recordTypes = text.split(/\r?\n/).filter(Boolean).map(JSON.parse)
        .map((record) => [record.type, record.payload?.type].filter(Boolean).join('/'));
    }
    fs.writeFileSync(path.join(root, 'evidence.json'), JSON.stringify(evidence, null, 2));
  }
}

// Synthetic values in the real structure. Only the record kinds the parser
// reads (and the session head it seeds from) survive; every path collapses onto
// one synthetic workspace, and ids/timestamps are renumbered in order.
function sanitizedFixture(rolloutPath, workspace) {
  const records = fs.readFileSync(rolloutPath, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
  const forward = workspace.replace(/\\/g, '/');
  const scrub = (value) => typeof value === 'string'
    ? value.split(forward).join('C:/src/example').split(workspace).join('C:\\src\\example')
      .split(workspace.replace(/\\/g, '\\\\')).join('C:\\\\src\\\\example')
    : value;
  const lines = [];
  let ordinal = 0;
  const stamp = () => new Date(Date.UTC(2026, 9, 13, 12, 0, ordinal)).toISOString();
  const session = '0192cccc-3333-7000-8000-00000000cc01';
  const turn = '0192cccc-3333-7000-8000-00000000cc02';
  const push = (type, payload) => { lines.push(JSON.stringify({ timestamp: stamp(), ordinal, type, payload })); ordinal += 1; };
  const meta = records.find((record) => record.type === 'session_meta')?.payload || {};
  // Field values that describe the Codex build and this harness (version,
  // originator = the harness's own clientInfo name, source, history mode) are
  // kept because they are what the fixture is evidence OF; everything that
  // describes the machine is replaced.
  const kept = (value) => (typeof value === 'string' ? value : 'unknown');
  push('session_meta', { session_id: session, id: session, timestamp: stamp(), cwd: 'C:\\src\\example',
    originator: kept(meta.originator), cli_version: kept(meta.cli_version), source: kept(meta.source),
    model_provider: 'example', base_instructions: 'Synthetic fixture. No real instructions are reproduced here.',
    history_mode: kept(meta.history_mode) });
  push('turn_context', { turn_id: turn, cwd: 'C:\\src\\example', approval_policy: 'on-request', sandbox_policy: 'read-only', model: 'example-model' });
  let n = 0;
  for (const record of records) {
    const payload = record.payload;
    if (record.type !== 'response_item' || !['custom_tool_call', 'custom_tool_call_output', 'function_call', 'function_call_output'].includes(payload?.type)) continue;
    n += 1;
    const copy = { type: payload.type, id: `${payload.type === 'function_call' || payload.type === 'custom_tool_call' ? 'fc' : 'out'}_cc${String(n).padStart(6, '0')}`,
      call_id: payload.call_id };
    if (payload.name !== undefined) copy.name = payload.name;
    if (payload.input !== undefined) copy.input = scrub(payload.input);
    if (payload.arguments !== undefined) copy.arguments = scrub(payload.arguments);
    if (payload.output !== undefined) {
      copy.output = Array.isArray(payload.output)
        ? payload.output.map((part) => ({ ...part, text: scrub(part.text).replace(/"chunk_id":"[0-9a-f]+"/, '"chunk_id":"c0ffee"')
          .replace(/Wall time [0-9.]+ seconds/, 'Wall time 1.0 seconds').replace(/"wall_time_seconds":[0-9.]+/, '"wall_time_seconds":1.0') }))
        : scrub(payload.output).replace(/Wall time [0-9.]+ seconds/, 'Wall time 1.0 seconds');
    }
    copy.internal_chat_message_metadata_passthrough = { turn_id: turn };
    push('response_item', copy);
  }
  push('event_msg', { type: 'task_complete', turn_id: turn });
  return lines.join('\n') + '\n';
}

(async () => {
  evidence.subject = subject;
  evidence.parserHash = digest(path.join(subject, 'src/history-adapters.js'));
  evidence.harnessHash = digest(__filename);
  const version = commandLaunch('codex', ['--version']);
  evidence.codexVersion = String(spawnSync(version.file, version.args, { ...version.options, encoding: 'utf8', windowsHide: true, timeout: 10000 }).stdout || '').trim();
  const failures = [];
  for (const [name, cells] of CASES) {
    try { await run(name, cells); }
    catch (error) { failures.push(`${name}: ${error.message}`); continue; }
    const observed = evidence.cases[evidence.cases.length - 1];
    try {
      assert.equal(observed.approvals.length, cells.length, `${name}: one individually accepted nested command per cell`);
      assert.equal(observed.waits.length, cells.filter((cell) => cell.continued).length,
        `${name}: WITNESS every continued cell actually yielded and was resumed by wait`);
      for (const cell of observed.cells) {
        assert.equal(cell.observations, 1, `${name}/${cell.callId}: WITNESS exactly one observation per cell`);
        if (!cell.continued) assert.equal(cell.status, cell.expected, `${name}/${cell.callId}: a completed cell carries its own outcome`);
        else assert.ok([cell.expected, 'unknown'].includes(cell.status),
          `${name}/${cell.callId}: a continued cell is credited with its true outcome or withheld, never the opposite (got ${cell.status})`);
      }
      observed.passed = true;
    } catch (error) { failures.push(error.message); }
  }
  const sequence = evidence.cases.find((item) => item.name === 'sequence');
  if (option('--write-fixture') && sequence?.rolloutPath) {
    const target = path.resolve(option('--write-fixture'));
    fs.writeFileSync(target, sanitizedFixture(sequence.rolloutPath, path.join(root, 'sequence', 'workspace')));
    evidence.fixture = { path: target, sha256: digest(target) };
  }
  evidence.status = failures.length ? 'failed' : 'passed';
  evidence.failures = failures;
  fs.writeFileSync(path.join(root, 'evidence.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ status: evidence.status, evidence: path.join(root, 'evidence.json'), codexVersion: evidence.codexVersion,
    cases: evidence.cases.map(({ name, approvals, waits, cells }) => ({ name, approvals: approvals.length, waits: waits.length,
      cells: cells.map(({ callId, continued, expected, status }) => `${callId}:${continued ? 'continued' : 'complete'}:${expected}->${status}`) })),
    failures }, null, 1));
  if (failures.length) process.exitCode = 1;
})().catch((error) => { console.error(JSON.stringify({ evidence: path.join(root, 'evidence.json'), error: error.message })); process.exitCode = 1; });
