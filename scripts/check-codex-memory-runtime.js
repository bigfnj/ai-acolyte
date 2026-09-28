#!/usr/bin/env node
'use strict';

// Actual Codex memory injection with a scripted loopback model response. Only
// isolated fixtures enable memory, with generation disabled. This proves input
// loading and the named adapter's retrieval, not model recall or obedience.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const readline = require('node:readline');
const { spawn, spawnSync } = require('node:child_process');

const TIMEOUT_MS = 45000;
const BOUNDARY = 'Actual fresh Codex app-server processes, synthetic native-memory files and named extension adapter. Scripted loopback responder, no model inference or credentials. Memory generation disabled. No VS Code UI or model obedience claim; fixture enablement is not a live-profile setting.';
const SECRET_ENV = ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'OPENAI_BASE_URL',
  'OPENAI_ORG_ID', 'OPENAI_ORGANIZATION', 'OPENAI_PROJECT_ID', 'AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_ENDPOINT'];
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const hashFile = (file) => sha(fs.readFileSync(file));
function strings(value, result = []) {
  if (typeof value === 'string') result.push(value);
  else if (Array.isArray(value)) value.forEach((item) => strings(item, result));
  else if (value && typeof value === 'object') Object.values(value).forEach((item) => strings(item, result));
  return result;
}
function argsOf(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    assert.ok(['--extension-dir', '--codex', '--codex-layout', '--mutation'].includes(argv[index]) && argv[index + 1],
      'usage: check-codex-memory-runtime.js --extension-dir path [--codex executable] [--codex-layout default|custom-override] [--mutation omit-summary]');
    assert.equal(args[argv[index]], undefined, 'duplicate option');
    args[argv[index]] = argv[index + 1];
  }
  assert.ok(args['--extension-dir'], 'explicit extension subject required');
  assert.ok(!args['--codex-layout'] || ['default', 'custom-override'].includes(args['--codex-layout']), 'unknown layout');
  assert.ok(!args['--mutation'] || args['--mutation'] === 'omit-summary', 'unknown mutation');
  return args;
}
function snapshot(directory) {
  if (!fs.existsSync(directory)) return {};
  const result = {};
  function visit(at) {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const file = path.join(at, entry.name);
      assert.ok(!entry.isSymbolicLink(), 'fixture snapshot must not follow links');
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) result[path.relative(directory, file).replace(/\\/g, '/')] = hashFile(file);
    }
  }
  visit(directory);
  return result;
}
async function within(promise, milliseconds) {
  let timer;
  try { return await Promise.race([promise.then(() => true), new Promise((resolve) => { timer = setTimeout(() => resolve(false), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
async function stop(child, closed) {
  if (!child) return;
  child.stdin.end();
  if (await within(closed, 5000)) return;
  assert.ok(child.pid && child.exitCode === null, 'fixture child exited but retained stdio handles');
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    assert.ifError(result.error);
  } else child.kill('SIGTERM');
  assert.ok(await within(closed, 5000), 'owned Codex child did not close');
}

async function runtimeCase(context, name, enabled, useMemories) {
  const { home, codexHome, workspace, launch, witnesses } = context;
  const observed = { name, enabled, useMemories, generateMemories: false, requests: 0, turnCompleted: false };
  const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: codexHome };
  for (const key of SECRET_ENV) delete env[key];
  let child, closed, reader, timer, requestText;
  let stopping = false;
  let nextId = 0;
  const pending = new Map();
  let resolveTurn, rejectTurn;
  const completed = new Promise((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject; });
  completed.catch(() => {});
  function fail(error) {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    rejectTurn(error);
  }
  const server = http.createServer((req, res) => {
    const buffers = [];
    let size = 0;
    req.on('data', (buffer) => {
      size += buffer.length;
      if (size > 4 * 1024 * 1024) { req.destroy(); fail(new Error('oversized fixture request')); }
      else buffers.push(buffer);
    });
    req.on('error', fail);
    req.on('end', () => {
      try {
        assert.equal(req.method, 'POST');
        assert.equal(req.url, '/v1/responses');
        assert.equal(req.headers.authorization, undefined, 'fixture must not use credentials');
        assert.equal(req.headers['api-key'], undefined, 'fixture must not use API keys');
        observed.requests += 1;
        assert.equal(observed.requests, 1, 'memory generation or additional inference request is forbidden');
        const body = JSON.parse(Buffer.concat(buffers).toString('utf8'));
        requestText = strings([body.instructions, body.input]).join('\n');
        const item = { id: 'memory_fixture_message', type: 'message', role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text: 'Memory loading fixture complete.', annotations: [] }] };
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (const event of [
          { type: 'response.created', response: { id: 'memory_fixture_response', object: 'response', status: 'in_progress', output: [] } },
          { type: 'response.output_item.added', output_index: 0, item },
          { type: 'response.output_item.done', output_index: 0, item },
          { type: 'response.completed', response: { id: 'memory_fixture_response', object: 'response', status: 'completed', output: [item],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
        ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        res.end();
      } catch (error) { if (!res.headersSent) res.writeHead(500); res.end('Fixture rejected'); fail(error); }
    });
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const config = [
      'model = "acolyte-memory-fixture"', 'model_provider = "acolyte_memory_fixture"',
      'approval_policy = "never"', 'sandbox_mode = "read-only"',
      '[features]', 'plugins = false', `memories = ${enabled}`,
      '[memories]', 'generate_memories = false', `use_memories = ${useMemories}`, 'disable_on_external_context = false',
      '[model_providers.acolyte_memory_fixture]', 'name = "Acolyte memory scripted responder"',
      `base_url = "http://127.0.0.1:${server.address().port}/v1"`, 'wire_api = "responses"',
      'requires_openai_auth = false', 'request_max_retries = 0', 'stream_max_retries = 0', '',
    ].join('\n');
    fs.writeFileSync(path.join(codexHome, 'config.toml'), config);
    observed.configSha256 = sha(config);
    child = spawn(launch.file, launch.args, { ...launch.options, windowsHide: true, cwd: workspace, env, stdio: ['pipe', 'pipe', 'pipe'] });
    closed = new Promise((resolve) => child.once('close', resolve));
    let stderrBytes = 0;
    child.stderr.on('data', (buffer) => { stderrBytes += buffer.length; });
    child.once('error', fail);
    child.once('exit', (code) => { if (!stopping && !observed.turnCompleted) fail(new Error(`Codex exited early (${code}; stderr ${stderrBytes} bytes)`)); });
    const send = (value) => child.stdin.write(JSON.stringify(value) + '\n');
    const rpc = (method, params) => new Promise((resolve, reject) => {
      const id = ++nextId; pending.set(id, { resolve, reject }); send({ id, method, params });
    });
    child.stdin.on('error', (error) => { if (!stopping) fail(error); });
    reader = readline.createInterface({ input: child.stdout });
    reader.on('line', (line) => {
      try {
        const message = JSON.parse(line);
        if (message.id != null && !message.method && pending.has(message.id)) {
          const request = pending.get(message.id); pending.delete(message.id);
          if (message.error) request.reject(new Error(`RPC error ${message.error.code}: ${message.error.message}`));
          else request.resolve(message.result);
          return;
        }
        assert.ok(!(message.id != null && message.method), 'no server approval or tool request is allowed in memory loading fixture');
        if (message.method === 'error') throw new Error('runtime error event');
        if (message.method === 'item/started') {
          assert.ok(['userMessage', 'agentMessage', 'reasoning'].includes(message.params?.item?.type), 'scripted response must not execute any tools');
        }
        if (message.method === 'turn/completed') {
          assert.equal(message.params?.turn?.status, 'completed'); observed.turnCompleted = true; resolveTurn();
        }
      } catch (error) { fail(error); }
    });
    timer = setTimeout(() => fail(new Error(`memory runtime timed out after ${TIMEOUT_MS}ms`)), TIMEOUT_MS);
    await rpc('initialize', { clientInfo: { name: 'acolyte_memory_check', version: '1' }, capabilities: { experimentalApi: true } });
    send({ method: 'initialized', params: {} });
    const thread = await rpc('thread/start', { cwd: workspace, model: 'acolyte-memory-fixture', modelProvider: 'acolyte_memory_fixture',
      approvalPolicy: 'never', sandbox: 'read-only' });
    observed.threadId = thread.thread?.id;
    assert.ok(observed.threadId);
    await rpc('turn/start', { threadId: observed.threadId,
      input: [{ type: 'text', text: 'Inspect the synthetic repository fixture context. Do not execute tools.' }] });
    await completed;
    assert.equal(observed.requests, 1);
    assert.equal(typeof requestText, 'string');
    observed.inputSha256 = sha(requestText);
    observed.inputBytes = Buffer.byteLength(requestText);
    observed.witnesses = Object.fromEntries(Object.entries(witnesses).map(([key, value]) => [key, requestText.includes(value)]));
    observed.memoryRootLoaded = requestText.replace(/\\/g, '/').includes(path.join(codexHome, 'memories').replace(/\\/g, '/'));
    observed.stderrBytes = stderrBytes;
    assert.equal(observed.witnesses.instructions, true, 'fixture user instructions must be loaded');
    assert.equal(observed.witnesses.summary, enabled && useMemories, 'WITNESS native memory summary loading must match explicit feature/use state');
    assert.equal(observed.memoryRootLoaded, enabled && useMemories, 'native memory root must correspond to selected fixture home');
    for (const key of ['registry', 'rollout', 'skill', 'raw', 'shadowed']) {
      assert.equal(observed.witnesses[key], false, `${key} body must not be automatically injected as summary`);
    }
    observed.inputChecksPassed = true;
    return observed;
  } catch (error) { error.runtimeEvidence = observed; throw error; }
  finally {
    stopping = true; clearTimeout(timer); reader?.close();
    try { await stop(child, closed); }
    finally { await new Promise((resolve) => server.close(resolve)); }
  }
}

async function main() {
  const args = argsOf(process.argv.slice(2));
  const extension = path.resolve(args['--extension-dir']);
  const modulePaths = ['codex-memory', 'codex-paths', 'exec-resolve'].map((name) => path.join(extension, 'src', name + '.js'));
  for (const file of modulePaths) assert.ok(fs.statSync(file).isFile(), `missing subject module ${file}`);
  const subjectHashes = Object.fromEntries(modulePaths.map((file) => [file, hashFile(file)]));
  const reportRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-codex-memory-runtime-'));
  const owned = path.join(reportRoot, 'isolated-state');
  const home = path.join(owned, 'home');
  const custom = args['--codex-layout'] === 'custom-override';
  const codexHome = custom ? path.join(owned, 'custom-codex') : path.join(home, '.codex');
  const workspace = path.join(owned, 'workspace');
  const memoryRoot = path.join(codexHome, 'memories');
  for (const dir of [home, workspace, memoryRoot]) fs.mkdirSync(dir, { recursive: true });
  const reportPath = path.join(reportRoot, 'evidence.json');
  const report = { status: 'running', boundary: BOUNDARY, extension, subjectHashes, harnessSha256: hashFile(__filename),
    codexLayout: custom ? 'custom-override' : 'default', mutation: args['--mutation'] || null,
    fixture: { home, codexHome, workspace, memoryRoot }, runtimeCases: [], queryCases: [], startedAt: new Date().toISOString() };
  const save = () => fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  save();
  console.log(`${BOUNDARY}\nEvidence: ${reportPath}`);
  try {
    const { commandLaunch } = require(modulePaths[2]);
    const adapter = require(modulePaths[0]);
    const executable = args['--codex'] || 'codex';
    const versionLaunch = commandLaunch(executable, ['--version']);
    assert.ok(versionLaunch.resolved, 'Codex executable not reachable');
    const version = spawnSync(versionLaunch.file, versionLaunch.args, { ...versionLaunch.options, windowsHide: true, encoding: 'utf8', timeout: 10000 });
    assert.ifError(version.error); assert.equal(version.status, 0);
    report.codexVersion = version.stdout.trim(); assert.match(report.codexVersion, /^codex-cli \S+$/);
    report.codexResolvedExecutable = versionLaunch.resolved;
    report.codexResolvedExecutableHash = hashFile(versionLaunch.resolved);
    const suffix = crypto.randomBytes(5).toString('hex');
    const witnesses = Object.fromEntries(['instructions', 'summary', 'registry', 'rollout', 'skill', 'raw', 'shadowed'].map((key) => [key, `acolytememory${key}${suffix}`]));
    const fixtures = {
      'memory_summary.md': `v1\n## Synthetic repository\n${witnesses.summary}\n`,
      'MEMORY.md': `# Task Group: synthetic fixture\n## Task 1: registry search\n### rollout_summary_files\n- rollout_summaries/fixture.md\n### keywords\n- ${witnesses.registry}\n### learnings\n- Registry-only evidence.\n`,
      'rollout_summaries/fixture.md': `# Synthetic rollout\n${witnesses.rollout}\n`,
      'skills/fixture/SKILL.md': `# Synthetic skill\n${witnesses.skill}\n`,
      'raw_memories.md': `${witnesses.raw}\n`,
    };
    for (const [relative, text] of Object.entries(fixtures)) {
      const file = path.join(memoryRoot, ...relative.split('/')); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text);
    }
    const instructions = path.join(codexHome, custom ? 'AGENTS.override.md' : 'AGENTS.md');
    fs.writeFileSync(instructions, '# Synthetic user instructions\n' + witnesses.instructions + '\n');
    if (custom) fs.writeFileSync(path.join(codexHome, 'AGENTS.md'), '# Shadowed instructions\n' + witnesses.shadowed + '\n');
    report.witnesses = witnesses;
    const originalMemory = snapshot(memoryRoot);
    report.originalMemory = originalMemory;
    for (const featureState of ['unknown', 'disabled', 'enabled']) {
      const corpus = adapter.readCodexMemory({ home, codexHome, featureState });
      assert.equal(corpus.featureState, featureState);
      assert.equal(corpus.storageState, 'readable');
      assert.equal(corpus.state, featureState === 'disabled' ? 'disabled' : 'readable');
      assert.deepEqual(corpus.diagnostics, []);
      assert.deepEqual(corpus.files.map((file) => file.relativePath), ['MEMORY.md', 'memory_summary.md', 'rollout_summaries/fixture.md', 'skills/fixture/SKILL.md']);
      for (const [key, relativePath] of [['registry', 'MEMORY.md'], ['rollout', 'rollout_summaries/fixture.md'], ['skill', 'skills/fixture/SKILL.md']]) {
        const hits = adapter.queryCodexMemory(corpus, witnesses[key]);
        assert.equal(hits.length, 1, 'query must identify exactly one selected source section');
        const hit = hits[0]; assert.equal(hit.relativePath, relativePath);
        assert.equal(hit.path, path.join(memoryRoot, ...relativePath.split('/')));
        assert.equal(hit.text, fixtures[relativePath].slice(hit.startOffset, hit.endOffset));
        assert.equal(hit.sha256, sha(Buffer.from(hit.text)));
        assert.ok(hit.startLine > 0 && hit.endLine >= hit.startLine);
        report.queryCases.push({ featureState, query: witnesses[key], relativePath, id: hit.id, sourceId: hit.sourceId,
          startLine: hit.startLine, endLine: hit.endLine, startOffset: hit.startOffset, endOffset: hit.endOffset, sha256: hit.sha256, score: hit.score });
      }
      assert.deepEqual(adapter.queryCodexMemory(corpus, witnesses.raw), [], 'raw input must never be indexed');
    }
    if (args['--mutation'] === 'omit-summary') {
      fs.unlinkSync(path.join(memoryRoot, 'memory_summary.md'));
      report.mutationWitness = 'removed isolated summary after adapter query proof';
    }
    const expectedMemory = snapshot(memoryRoot);
    const launch = commandLaunch(executable, ['app-server', '--stdio']);
    for (const [name, enabled, useMemories] of [['disabled', false, true], ['enabled-use-off', true, false], ['enabled-use-on', true, true]]) {
      let observed;
      try { observed = await runtimeCase({ home, codexHome, workspace, launch, witnesses }, name, enabled, useMemories); }
      catch (error) { if (error.runtimeEvidence) report.runtimeCases.push(error.runtimeEvidence); throw error; }
      assert.ok(!report.runtimeCases.some((entry) => entry.threadId === observed.threadId), 'each memory case must use a fresh thread/process');
      report.runtimeCases.push(observed);
      const afterMemory = snapshot(memoryRoot);
      for (const [relative, expected] of Object.entries(expectedMemory)) {
        assert.equal(afterMemory[relative], expected, `native fixture bytes changed with generation disabled: ${relative}`);
      }
      // Codex initializes its own Git tracking and extension instructions when
      // the feature is enabled, independently of generate_memories/use_memories.
      observed.runtimeCreatedMemoryFiles = Object.keys(afterMemory).filter((relative) => !Object.hasOwn(expectedMemory, relative));
      assert.ok(observed.runtimeCreatedMemoryFiles.every((relative) => relative.startsWith('.git/') || relative === 'extensions/ad_hoc/instructions.md'),
        'unexpected generated memory content appeared despite generation being disabled');
      observed.nativeFixtureBytesUnchanged = true;
      if (custom) assert.equal(fs.existsSync(path.join(home, '.codex')), false, 'custom layout must not create default Codex home');
      observed.passed = true;
      save(); console.log(`PASS ${name}: summaryLoaded=${observed.witnesses.summary}`);
    }
    assert.equal(report.runtimeCases.length, 3);
    report.status = 'passed';
  } catch (error) { report.status = 'failed'; report.failure = String(error.stack || error); process.exitCode = 1; }
  finally {
    try {
      for (const [file, expected] of Object.entries(subjectHashes)) {
        assert.equal(hashFile(file), expected, 'named subject changed during runtime check');
        assert.ok(require.cache[file], `subject module did not execute: ${file}`);
      }
      assert.equal(hashFile(__filename), report.harnessSha256, 'runtime harness changed during execution');
      report.executedSubjectModules = Object.keys(subjectHashes);
      report.subjectUnchanged = true;
    } catch (error) { report.status = 'failed'; report.integrityFailure = String(error.message); process.exitCode = 1; }
    report.finishedAt = new Date().toISOString(); save();
    console.log(`${report.status.toUpperCase()}: ${report.runtimeCases.filter((item) => item.passed).length}/3 fresh memory cases; ${reportPath}`);
    if (report.failure) console.error(report.failure);
  }
}

if (require.main === module) main().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
