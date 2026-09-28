#!/usr/bin/env node
'use strict';

// Real direct exec_command/write_stdin completion, using a scripted loopback
// provider. No inference or provider credentials. The named subject supplies
// both executable resolution and the history parser under test.
// node scripts/check-codex-wait-runtime.js --extension-dir <source-or-staged-root>
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');
const readline = require('node:readline');
const { spawn, spawnSync } = require('node:child_process');
assert.equal(process.argv.length, 4, 'usage: check-codex-wait-runtime.js --extension-dir <source-or-staged-root>');
assert.equal(process.argv[2], '--extension-dir');
const subject = path.resolve(process.argv[3]);
const { commandLaunch } = require(path.join(subject, 'src/exec-resolve'));
const { parseCodexJsonl } = require(path.join(subject, 'src/history-adapters'));
const { rolloutFor } = require('./check-codex-runtime');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-wait-completion-'));
const evidence = { boundary: 'Isolated real Codex app-server; scripted loopback provider, no inference or credentials; fixture-only rollouts.', root, cases: [] };
const digest = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
async function run(name, exitCode) {
  const dir = path.join(root, name), home = path.join(dir, 'home'), codexHome = path.join(home, '.codex'), workspace = path.join(dir, 'workspace');
  for (const target of [codexHome, workspace]) fs.mkdirSync(target, { recursive: true });
  const script = path.join(workspace, 'delay.cjs');
  fs.writeFileSync(script, `setTimeout(() => { console.log('acolyte-wait-completion-witness'); process.exit(${exitCode}); }, 3500);\n`);
  const childEnv = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: codexHome };
  for (const key of ['OPENAI_API_KEY','CODEX_API_KEY','CODEX_ACCESS_TOKEN','OPENAI_BASE_URL','OPENAI_ORG_ID','OPENAI_ORGANIZATION','OPENAI_PROJECT_ID','AZURE_OPENAI_API_KEY','AZURE_OPENAI_ENDPOINT']) delete childEnv[key];
  const observed = { name, exitCode, requests: 0, approvals: 0, calls: [], toolResults: [], commandEvents: [] };
  evidence.cases.push(observed);
  let child, lines, timer, stopping = false, count = 0, finishedResolve, finishedReject;
  const pending = new Map();
  const finished = new Promise((resolve, reject) => { finishedResolve = resolve; finishedReject = reject; });
  finished.catch(() => {});
  const fail = (error) => { for (const item of pending.values()) item.reject(error); pending.clear(); finishedReject(error); };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try {
        assert.equal(req.headers.authorization, undefined);
        assert.equal(req.headers['api-key'], undefined);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        observed.requests += 1;
        assert.ok(observed.requests <= 6, 'at most five actual polls');
        const outputs = body.input.filter((item) => item.type === 'function_call_output');
        const latest = outputs[outputs.length - 1];
        if (latest) observed.toolResults.push(latest);
        let item;
        if (observed.requests === 1) {
          observed.catalog = body.tools.map((tool) => ({ name: tool.name, parameters: tool.parameters }));
          assert.ok(body.tools.some((tool) => tool.name === 'exec_command'), 'runtime exposes unified exec_command');
          assert.ok(body.tools.some((tool) => tool.name === 'write_stdin'), 'runtime exposes write_stdin');
          item = { type: 'function_call', name: 'exec_command', call_id: 'call_start', arguments: JSON.stringify({ cmd: `node "${script}"`, yield_time_ms: 1000, max_output_tokens: 200, sandbox_permissions: 'require_escalated', justification: 'Harmless isolated completion canary.' }) };
        } else {
          assert.ok(latest, 'next request must carry real tool output');
          const text = typeof latest.output === 'string' ? latest.output : JSON.stringify(latest.output);
          const session = /Process running with session ID\s+(\d+)/i.exec(text);
          if (session) {
            item = { type: 'function_call', name: 'write_stdin', call_id: `call_wait_${observed.requests}`, arguments: JSON.stringify({ session_id: Number(session[1]), chars: '', yield_time_ms: 1000, max_output_tokens: 200 }) };
          } else {
            assert.match(text, /Process exited with code|Exit code:/i, 'completed result carries an authoritative exit status');
            assert.ok(observed.toolResults.some((result) => String(result.output).includes('acolyte-wait-completion-witness')),
              'completed process emits execution witness in an actual tool result');
            observed.terminalOutput = text;
            item = { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Isolated completion canary finished.', annotations: [] }] };
          }
        }
        item.id = `fixture_${observed.requests}`;
        if (item.type === 'function_call') observed.calls.push(item);
        const id = `response_${observed.requests}`;
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (const event of [
          { type: 'response.created', response: { id, object: 'response', status: 'in_progress', output: [] } },
          { type: 'response.output_item.added', output_index: 0, item },
          { type: 'response.output_item.done', output_index: 0, item },
          { type: 'response.completed', response: { id, object: 'response', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
        ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        res.end();
      } catch (error) { res.writeHead(500); res.end('Fixture rejected'); fail(error); }
    });
  });
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    fs.writeFileSync(path.join(codexHome, 'config.toml'), [
      'model="acolyte-wait-fixture"','model_provider="fixture"','approval_policy="on-request"','sandbox_mode="read-only"',
      '[features]','unified_exec=true','plugins=false',
      '[model_providers.fixture]','name="Scripted isolated fixture"',`base_url="http://127.0.0.1:${server.address().port}/v1"`,'wire_api="responses"','requires_openai_auth=false','request_max_retries=0','stream_max_retries=0','',
    ].join('\n'));
    const launch = commandLaunch('codex', ['app-server', '--stdio']);
    child = spawn(launch.file, launch.args, { ...launch.options, env: childEnv, cwd: workspace, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
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
          assert.equal(message.method, 'item/commandExecution/requestApproval');
          observed.approvals += 1;
          send({ id: message.id, result: { decision: 'accept' } });
        } else if (message.method === 'item/completed' && message.params?.item?.type === 'commandExecution') {
          observed.commandEvents.push(message.params.item);
        } else if (message.method === 'turn/completed') {
          assert.equal(message.params.turn.status, 'completed'); observed.completed = true; finishedResolve();
        } else if (message.method === 'error') throw new Error(JSON.stringify(message.params));
      } catch (error) { fail(error); }
    });
    timer = setTimeout(() => fail(new Error('Native wait canary timed out')), 40000);
    observed.initialized = await rpc('initialize', { clientInfo: { name: 'acolyte_wait_canary', version: '1' }, capabilities: { experimentalApi: true } });
    send({ method: 'initialized', params: {} });
    const started = await rpc('thread/start', { cwd: workspace, model: 'acolyte-wait-fixture', modelProvider: 'fixture', approvalPolicy: 'on-request', sandbox: 'read-only' });
    observed.threadId = started.thread.id;
    await rpc('turn/start', { threadId: observed.threadId, input: [{ type: 'text', text: 'Run the harmless isolated long command and wait for it.' }] });
    await finished;
    assert.ok(observed.calls.some((call) => call.name === 'write_stdin'), 'WITNESS actual separate write_stdin completed the process');
    assert.equal(observed.approvals, 1, 'exactly one individually accepted process execution');
  } catch (error) { observed.error = error.message; throw error; }
  finally {
    stopping = true; clearTimeout(timer);
    if (child) {
      const closed = new Promise((resolve) => child.once('close', resolve));
      child.stdin.end();
      await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 1500))]);
      if (child.exitCode === null) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 });
    }
    lines?.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
    if (observed.threadId) {
      observed.rolloutPath = rolloutFor(codexHome, observed.threadId);
      const text = fs.readFileSync(observed.rolloutPath, 'utf8');
      observed.rolloutHash = digest(observed.rolloutPath);
      observed.observations = parseCodexJsonl(text, { file: observed.rolloutPath }).map(({ command, status, tool, callId }) => ({ command, status, tool, callId }));
      observed.recordShapes = text.split(/\r?\n/).filter(Boolean).map(JSON.parse)
        .filter((record) => record.type === 'response_item' && ['function_call', 'function_call_output'].includes(record.payload?.type))
        .map((record) => ({ type: record.type, payload: record.payload }));
    }
    fs.writeFileSync(path.join(root, 'evidence.json'), JSON.stringify(evidence, null, 2));
  }
}
(async () => {
  evidence.subject = subject;
  evidence.parserHash = digest(path.join(subject, 'src/history-adapters.js'));
  evidence.parserMtimeMs = fs.statSync(path.join(subject, 'src/history-adapters.js')).mtimeMs;
  evidence.harnessHash = digest(__filename);
  for (const [name, code] of [['success', 0], ['failed', 7]]) {
    await run(name, code);
    const observed = evidence.cases[evidence.cases.length - 1];
    assert.equal(observed.observations.length, 1, 'WITNESS real process yields exactly one original observation');
    assert.equal(observed.observations[0].status, name, 'WITNESS real wait outcome reaches the selected history parser');
    assert.equal(observed.observations[0].callId, 'call_start', 'wait result updates the original invocation');
    assert.equal(/Process exited with code 0\b/.test(observed.terminalOutput), code === 0,
      'the actual terminal process exit must agree with the expected outcome');
    observed.parserOutcomeVerified = true;
    fs.writeFileSync(path.join(root, 'evidence.json'), JSON.stringify(evidence, null, 2));
  }
  console.log(JSON.stringify({ evidence: path.join(root, 'evidence.json'), cases: evidence.cases.map(({ name, approvals, calls, observations }) => ({ name, approvals, calls: calls.map((item) => item.name), observations })) }));
})().catch((error) => { console.error(JSON.stringify({ evidence: path.join(root, 'evidence.json'), error: error.message })); process.exitCode = 1; });
