#!/usr/bin/env node
'use strict';

// Actual fresh Codex instruction loading after the named helper's mutations.
// Synthetic sources and a scripted loopback responder: no inference or live data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const readline = require('node:readline');
const { spawn, spawnSync } = require('node:child_process');

const TIMEOUT_MS = 45000;
const BEGIN = '<!-- BEGIN permission-wildcarding: native Codex memory gates (managed) -->';
const BOUNDARY = 'Actual fresh Codex app-server processes load instructions written by the named native gate helper. Synthetic annotated memory only; scripted loopback responder without credentials or inference. Native memory injection and generation disabled. Automatic-refresh helper is invoked directly; no watcher, VS Code UI, model obedience, or live-profile claim.';
const SECRET_ENV = ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'OPENAI_BASE_URL',
  'OPENAI_ORG_ID', 'OPENAI_ORGANIZATION', 'OPENAI_PROJECT_ID', 'AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_ENDPOINT'];
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const hashFile = file => sha(fs.readFileSync(file));
function strings(value, result = []) {
  if (typeof value === 'string') result.push(value);
  else if (Array.isArray(value)) value.forEach(item => strings(item, result));
  else if (value && typeof value === 'object') Object.values(value).forEach(item => strings(item, result));
  return result;
}
function argsOf(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    assert.ok(['--extension-dir', '--codex', '--codex-layout', '--mutation'].includes(argv[index]) && argv[index + 1],
      'usage: check-codex-native-gates-runtime.js --extension-dir path [--codex executable] [--codex-layout default|custom-override] [--mutation omit-native-block]');
    assert.equal(args[argv[index]], undefined, 'duplicate option');
    args[argv[index]] = argv[index + 1];
  }
  assert.ok(args['--extension-dir'], 'explicit extension subject required');
  assert.ok(!args['--codex-layout'] || ['default', 'custom-override'].includes(args['--codex-layout']), 'unknown layout');
  assert.ok(!args['--mutation'] || args['--mutation'] === 'omit-native-block', 'unknown mutation');
  return args;
}
function snapshot(directory) {
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
  try { return await Promise.race([promise.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), milliseconds); })]); }
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

async function runtimeCase(context, name, expected) {
  const { home, codexHome, workspace, launch } = context;
  const observed = { name, memoriesEnabled: false, generateMemories: false, requests: 0, turnCompleted: false };
  const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: codexHome };
  for (const key of SECRET_ENV) delete env[key];
  let child, closed, reader, timer, requestText;
  let stopping = false, nextId = 0;
  const pending = new Map();
  let resolveTurn, rejectTurn;
  const completed = new Promise((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject; });
  completed.catch(() => {});
  function fail(error) {
    for (const request of pending.values()) request.reject(error);
    pending.clear(); rejectTurn(error);
  }
  const server = http.createServer((req, res) => {
    const buffers = [];
    let size = 0;
    req.on('data', buffer => {
      size += buffer.length;
      if (size > 4 * 1024 * 1024) { req.destroy(); fail(new Error('oversized fixture request')); }
      else buffers.push(buffer);
    });
    req.on('error', fail);
    req.on('end', () => {
      try {
        assert.equal(req.method, 'POST'); assert.equal(req.url, '/v1/responses');
        assert.equal(req.headers.authorization, undefined, 'fixture must not use credentials');
        assert.equal(req.headers['api-key'], undefined, 'fixture must not use API keys');
        observed.requests++;
        assert.equal(observed.requests, 1, 'additional provider requests are forbidden');
        const body = JSON.parse(Buffer.concat(buffers).toString('utf8'));
        requestText = strings([body.instructions, body.input]).join('\n');
        const item = { id: 'native_gates_fixture_message', type: 'message', role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text: 'Native gate loading fixture complete.', annotations: [] }] };
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (const event of [
          { type: 'response.created', response: { id: 'native_gates_fixture_response', object: 'response', status: 'in_progress', output: [] } },
          { type: 'response.output_item.added', output_index: 0, item },
          { type: 'response.output_item.done', output_index: 0, item },
          { type: 'response.completed', response: { id: 'native_gates_fixture_response', object: 'response', status: 'completed', output: [item],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
        ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        res.end();
      } catch (error) { if (!res.headersSent) res.writeHead(500); res.end('Fixture rejected'); fail(error); }
    });
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const config = [
      'model = "acolyte-native-gates-fixture"', 'model_provider = "acolyte_native_gates_fixture"',
      'approval_policy = "never"', 'sandbox_mode = "read-only"',
      '[features]', 'plugins = false', 'memories = false',
      '[memories]', 'generate_memories = false', 'use_memories = false', 'disable_on_external_context = false',
      '[model_providers.acolyte_native_gates_fixture]', 'name = "Acolyte scripted responder"',
      `base_url = "http://127.0.0.1:${server.address().port}/v1"`, 'wire_api = "responses"',
      'requires_openai_auth = false', 'request_max_retries = 0', 'stream_max_retries = 0', '',
    ].join('\n');
    fs.writeFileSync(path.join(codexHome, 'config.toml'), config);
    observed.configSha256 = sha(config);
    child = spawn(launch.file, launch.args, { ...launch.options, windowsHide: true, cwd: workspace, env, stdio: ['pipe', 'pipe', 'pipe'] });
    observed.pid = child.pid;
    closed = new Promise(resolve => child.once('close', resolve));
    let stderrBytes = 0;
    child.stderr.on('data', buffer => { stderrBytes += buffer.length; });
    child.once('error', fail);
    child.once('exit', code => { if (!stopping && !observed.turnCompleted) fail(new Error(`Codex exited early (${code}; stderr ${stderrBytes} bytes)`)); });
    const send = value => child.stdin.write(JSON.stringify(value) + '\n');
    const rpc = (method, params) => new Promise((resolve, reject) => {
      const id = ++nextId; pending.set(id, { resolve, reject }); send({ id, method, params });
    });
    child.stdin.on('error', error => { if (!stopping) fail(error); });
    reader = readline.createInterface({ input: child.stdout });
    reader.on('line', line => {
      try {
        const message = JSON.parse(line);
        if (message.id != null && !message.method && pending.has(message.id)) {
          const request = pending.get(message.id); pending.delete(message.id);
          if (message.error) request.reject(new Error(`RPC error ${message.error.code}: ${message.error.message}`));
          else request.resolve(message.result);
          return;
        }
        assert.ok(!(message.id != null && message.method), 'no server approval or tool request is allowed');
        if (message.method === 'error') throw new Error('runtime error event');
        if (message.method === 'item/started') assert.ok(['userMessage', 'agentMessage', 'reasoning'].includes(message.params?.item?.type), 'no tool execution is allowed');
        if (message.method === 'turn/completed') {
          assert.equal(message.params?.turn?.status, 'completed'); observed.turnCompleted = true; resolveTurn();
        }
      } catch (error) { fail(error); }
    });
    timer = setTimeout(() => fail(new Error(`native gates runtime timed out after ${TIMEOUT_MS}ms`)), TIMEOUT_MS);
    await rpc('initialize', { clientInfo: { name: 'acolyte_native_gates_check', version: '1' }, capabilities: { experimentalApi: true } });
    send({ method: 'initialized', params: {} });
    const thread = await rpc('thread/start', { cwd: workspace, model: 'acolyte-native-gates-fixture', modelProvider: 'acolyte_native_gates_fixture',
      approvalPolicy: 'never', sandbox: 'read-only' });
    observed.threadId = thread.thread?.id; assert.ok(observed.threadId);
    await rpc('turn/start', { threadId: observed.threadId,
      input: [{ type: 'text', text: 'Inspect the synthetic repository fixture context. Do not execute tools.' }] });
    await completed;
    assert.equal(observed.requests, 1); assert.equal(typeof requestText, 'string');
    observed.inputSha256 = sha(requestText); observed.inputBytes = Buffer.byteLength(requestText); observed.stderrBytes = stderrBytes;
    observed.loaded = Object.fromEntries(Object.entries(expected.present).map(([key, value]) => [key, requestText.includes(value)]));
    observed.absent = Object.fromEntries(Object.entries(expected.absent).map(([key, value]) => [key, !requestText.includes(value)]));
    for (const [key, loaded] of Object.entries(observed.loaded)) assert.equal(loaded, true, `WITNESS ${name}: ${key} must be loaded in fresh Codex instructions`);
    for (const [key, absent] of Object.entries(observed.absent)) assert.equal(absent, true, `WITNESS ${name}: ${key} must be absent from fresh Codex instructions`);
    observed.inputChecksPassed = true;
    return observed;
  } catch (error) { error.runtimeEvidence = observed; throw error; }
  finally {
    stopping = true; clearTimeout(timer); reader?.close();
    try { await stop(child, closed); }
    finally { await new Promise(resolve => server.close(resolve)); }
  }
}

async function main() {
  const args = argsOf(process.argv.slice(2)), extension = path.resolve(args['--extension-dir']);
  const names = ['codex-memory-gates', 'codex-memory', 'codex-paths', 'agent-guidance', 'permissions', 'permission-match', 'policy-lock', 'exec-resolve'];
  const modules = Object.fromEntries(names.map(name => [name, path.join(extension, 'src', name + '.js')]));
  const subjectHashes = Object.fromEntries(Object.values(modules).map(file => [file, hashFile(file)]));
  const reportRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-native-gates-runtime-'));
  const owned = path.join(reportRoot, 'isolated-state'), home = path.join(owned, 'home');
  const custom = args['--codex-layout'] === 'custom-override';
  const codexHome = custom ? path.join(owned, 'custom-codex') : path.join(home, '.codex');
  const workspace = path.join(owned, 'workspace'), memoryRoot = path.join(codexHome, 'memories');
  for (const directory of [home, workspace, memoryRoot, path.join(home, '.claude')]) fs.mkdirSync(directory, { recursive: true });
  const reportPath = path.join(reportRoot, 'evidence.json');
  const report = { status: 'running', boundary: BOUNDARY, extension, subjectHashes, harnessSha256: hashFile(__filename),
    codexLayout: custom ? 'custom-override' : 'default', mutation: args['--mutation'] || null,
    fixture: { home, codexHome, workspace, memoryRoot }, runtimeCases: [], transitions: [], startedAt: new Date().toISOString() };
  const save = () => fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  save(); console.log(`${BOUNDARY}\nEvidence: ${reportPath}`);
  try {
    const helper = require(modules['codex-memory-gates']), { commandLaunch } = require(modules['exec-resolve']);
    const executable = args['--codex'] || 'codex', versionLaunch = commandLaunch(executable, ['--version']);
    assert.ok(versionLaunch.resolved, 'Codex executable not reachable');
    const version = spawnSync(versionLaunch.file, versionLaunch.args, { ...versionLaunch.options, windowsHide: true, encoding: 'utf8', timeout: 10000 });
    assert.ifError(version.error); assert.equal(version.status, 0);
    report.codexVersion = version.stdout.trim(); assert.match(report.codexVersion, /^codex-cli \S+$/);
    report.codexResolvedExecutable = versionLaunch.resolved; report.codexResolvedExecutableHash = hashFile(versionLaunch.resolved);
    const suffix = crypto.randomBytes(5).toString('hex');
    const witnesses = Object.fromEntries(['user', 'shared', 'claude', 'shadowed', 'initial', 'changed', 'skill', 'summary', 'unscoped', 'raw'].map(key => [key, `acolytenativegate${key}${suffix}`]));
    report.witnesses = witnesses;
    const shared = `<!-- BEGIN permission-wildcarding: memory gates (managed) -->\n## Existing shared gates\n- Preserve ${witnesses.shared}.\n<!-- END permission-wildcarding: memory gates -->`;
    const originalInstructions = `# Fixture user instructions\n${witnesses.user}\n\n${shared}\n`;
    const instructions = path.join(codexHome, custom ? 'AGENTS.override.md' : 'AGENTS.md');
    const claude = path.join(home, '.claude', 'CLAUDE.md');
    fs.writeFileSync(claude, `# Fixture Claude user instructions\n${witnesses.claude}\n\n${shared}\n`);
    fs.writeFileSync(instructions, originalInstructions);
    const base = path.join(codexHome, 'AGENTS.md');
    if (custom) fs.writeFileSync(base, `# Shadowed base instructions\n${witnesses.shadowed}\n\n${shared}\n`);
    const protectedFiles = Object.fromEntries([claude, ...(custom ? [base] : [])].map(file => [file, hashFile(file)]));
    const annotated = witness => `---\nscope: global\n---\n# Explicit fixture annotation\n<!-- gate -->\n- Always record ${witness} before completing this synthetic task.\n<!-- /gate -->\n`;
    const fixtures = {
      'MEMORY.md': annotated(witnesses.initial),
      'skills/fixture/SKILL.md': annotated(witnesses.skill),
      'memory_summary.md': `v1\n## Summary without a global gate annotation\n${witnesses.summary}\n`,
      'rollout_summaries/fixture.md': `# Local rollout without an annotation\n${witnesses.unscoped}\n`,
      'raw_memories.md': `${witnesses.raw}\n`,
    };
    for (const [relative, text] of Object.entries(fixtures)) {
      const file = path.join(memoryRoot, ...relative.split('/')); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text);
    }
    let expectedMemory = snapshot(memoryRoot);
    report.sourceSnapshots = [{ name: 'initial', files: expectedMemory }];
    report.protectedFiles = protectedFiles; report.instructions = instructions;
    const options = { home, codexHome }, launch = commandLaunch(executable, ['app-server', '--stdio']);
    const checkPreserved = () => {
      assert.deepEqual(snapshot(memoryRoot), expectedMemory, 'native memory source bytes must remain exact');
      for (const [file, expected] of Object.entries(protectedFiles)) assert.equal(hashFile(file), expected, `protected shared/Claude instructions changed: ${file}`);
      const active = fs.readFileSync(instructions, 'utf8');
      assert.ok(active.includes(shared), 'existing shared Claude-derived gate block must remain byte-exact');
      assert.ok(active.includes(witnesses.user), 'user instruction text must remain');
      if (custom) assert.equal(fs.existsSync(path.join(home, '.codex')), false, 'custom layout must not create default Codex home');
    };
    const run = async (name, present, absent) => {
      const before = hashFile(instructions);
      let result;
      try { result = await runtimeCase({ home, codexHome, workspace, launch }, name, { present, absent }); }
      catch (error) { if (error.runtimeEvidence) report.runtimeCases.push(error.runtimeEvidence); throw error; }
      assert.ok(!report.runtimeCases.some(item => item.threadId === result.threadId), 'each case requires a fresh process/thread');
      assert.equal(hashFile(instructions), before, 'runtime must not alter instruction file');
      checkPreserved();
      Object.assign(result, { instructionSha256: before, sourceBytesUnchanged: true, protectedInstructionsUnchanged: true, passed: true });
      report.runtimeCases.push(result); save(); console.log(`PASS ${name}: actual fresh instruction loading`);
    };
    const commonPresent = { user: witnesses.user, sharedBlock: shared };
    const commonAbsent = { claudeOnly: witnesses.claude, shadowed: witnesses.shadowed, nativeSummary: witnesses.summary,
      unscopedProse: witnesses.unscoped, rawMemory: witnesses.raw };
    const initial = helper.inspectNativeCodexGates(options);
    assert.equal(initial.complete, true); assert.equal(initial.count, 2); assert.equal(initial.target.path, instructions);
    assert.deepEqual(initial.gates.map(gate => gate.relativePath), ['MEMORY.md', 'skills/fixture/SKILL.md']);
    assert.equal(initial.target.on, false);
    const installed = helper.setNativeCodexGates(true, { fingerprint: initial.fingerprint }, options);
    assert.equal(installed.on, true); assert.equal(installed.changed, true);
    assert.equal(helper.inspectNativeCodexGates(options).target.current, true);
    checkPreserved(); report.transitions.push({ name: 'reviewed-install', result: installed, reviewedFingerprint: initial.fingerprint,
      fullBody: initial.body, bodySha256: initial.bodyHash, gates: initial.gates });
    if (args['--mutation'] === 'omit-native-block') {
      const before = fs.statSync(instructions), beforeHash = hashFile(instructions);
      fs.writeFileSync(instructions, originalInstructions);
      fs.utimesSync(instructions, before.atime, new Date(before.mtimeMs + 2000));
      const afterHash = hashFile(instructions);
      assert.notEqual(beforeHash, afterHash); assert.ok(fs.statSync(instructions).mtimeMs > before.mtimeMs);
      assert.equal(fs.readFileSync(instructions, 'utf8').includes(BEGIN), false);
      report.mutationWitness = { name: 'omitted fixture native block after successful helper install', path: instructions, beforeHash, afterHash,
        advancedMtime: true, observedNativeMarkerAbsent: true };
      save(); console.log('WITNESS mutated instruction bytes executed by the next fresh Codex process');
    }
    await run('installed', { ...commonPresent, nativeMarker: BEGIN, completeCompiledBody: initial.body }, { ...commonAbsent, futureChangedGate: witnesses.changed });
    fs.writeFileSync(path.join(memoryRoot, 'MEMORY.md'), annotated(witnesses.changed));
    expectedMemory = snapshot(memoryRoot); report.sourceSnapshots.push({ name: 'deliberate-source-edit', files: expectedMemory });
    const changed = helper.inspectNativeCodexGates(options);
    assert.equal(changed.target.current, false); assert.notEqual(changed.bodyHash, initial.bodyHash);
    const refreshed = helper.refreshNativeCodexGates(options);
    assert.equal(refreshed.on, true); assert.equal(refreshed.changed, true);
    assert.equal(helper.inspectNativeCodexGates(options).target.current, true);
    checkPreserved(); report.transitions.push({ name: 'automatic-refresh-helper', result: refreshed, fullBody: changed.body, bodySha256: changed.bodyHash });
    await run('refreshed', { ...commonPresent, nativeMarker: BEGIN, completeCompiledBody: changed.body }, { ...commonAbsent, replacedGate: witnesses.initial });
    const removal = helper.inspectNativeCodexGates(options);
    const removed = helper.setNativeCodexGates(false, { fingerprint: removal.removalFingerprint }, options);
    assert.equal(removed.on, false); assert.equal(removed.changed, true);
    assert.equal(fs.readFileSync(instructions, 'utf8'), originalInstructions, 'remove must restore exact fixture instructions');
    const noReinstall = helper.refreshNativeCodexGates(options);
    assert.equal(noReinstall.skipped, true); assert.equal(noReinstall.changed, false); assert.equal(noReinstall.on, false);
    checkPreserved(); report.transitions.push({ name: 'reviewed-remove', result: removed, automaticRefreshAfterRemoval: noReinstall });
    await run('removed', commonPresent, { ...commonAbsent, nativeMarker: BEGIN, oldGate: witnesses.initial,
      changedGate: witnesses.changed, skillGate: witnesses.skill });
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
      report.executedSubjectModules = Object.keys(subjectHashes); report.subjectUnchanged = true;
    } catch (error) { report.status = 'failed'; report.integrityFailure = String(error.message); process.exitCode = 1; }
    report.finishedAt = new Date().toISOString(); save();
    console.log(`${report.status.toUpperCase()}: ${report.runtimeCases.filter(item => item.passed).length}/3 fresh gate cases; ${reportPath}`);
    if (report.failure) console.error(report.failure);
    if (report.integrityFailure) console.error(report.integrityFailure);
  }
}
if (require.main === module) main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
