#!/usr/bin/env node
'use strict';

// Exercise the real Codex app-server, shell execution, approvals and instruction
// loading against modules from the INSTALLED extension. The model is a scripted
// loopback HTTP responder, not model inference. No provider credentials are used.
// This does not drive the VS Code UI or prove that a model follows instructions.
// Protocol reference: https://learn.chatgpt.com/docs/app-server
//
// node scripts/check-codex-runtime.js [--extension-dir <installed-or-copied-dir>]
//   [--codex <executable>] [--mutation remove-generated-rule] [--codex-layout default|custom-override]
// The mutation changes only isolated generated policy and MUST fail the allowed
// case. It exists to prove that a green result depends on the generated rule.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { spawn, spawnSync } = require('node:child_process');

const TIMEOUT_MS = 45000;
const COMMAND = 'acolyte-runtime-probe.cmd';
const SHELL_WITNESS = 'acolyte-runtime-shell-witness';
const GATE_WITNESS = 'acolyte-runtime-gate-witness';
const USER_WITNESS = 'acolyte-runtime-user-owned-instruction';
const SHADOWED_WITNESS = 'acolyte-runtime-shadowed-base-instruction';
const BOUNDARY = 'Real Codex runtime and extension modules from the named subject; scripted local model responder. No inference, credentials, or VS Code UI.';

// Connect the same runtime fixture to another owner's isolated directories.
// Construction reads installed modules only; runtimeCase writes config.toml
// and Codex writes its own session state. Instructions, rules and probes remain
// the caller's fixtures. Each runtimeCase owns and closes a fresh app-server.
function createRuntimeContext(options) {
  const { extensionDir, workspace, home, codexHome } = options;
  for (const [name, value] of Object.entries({ extensionDir, workspace, home, codexHome })) {
    assert.ok(typeof value === 'string' && path.isAbsolute(value), `${name} must be an explicit absolute fixture path`);
  }
  const { commandLaunch } = require(path.join(extensionDir, 'src', 'exec-resolve.js'));
  const launch = commandLaunch(options.codexExecutable || 'codex', ['app-server', '--stdio']);
  assert.ok(launch.resolved, 'Codex executable is not reachable');
  const childEnv = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: codexHome,
    PATH: workspace + path.delimiter + process.env.PATH };
  for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'OPENAI_BASE_URL',
    'OPENAI_ORG_ID', 'OPENAI_ORGANIZATION', 'OPENAI_PROJECT_ID', 'AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_ENDPOINT']) delete childEnv[key];
  return { workspace, home, codexHome, launch, childEnv,
    guidance: require(path.join(extensionDir, 'src', 'agent-guidance.js')),
    gates: require(path.join(extensionDir, 'src', 'agent-gates.js')),
    customLayout: options.customLayout === true,
    commandName: options.commandName ?? COMMAND,
    approvalDecision: options.approvalDecision ?? 'decline',
    shellWitness: options.shellWitness ?? SHELL_WITNESS,
    instructionWitnesses: options.instructionWitnesses,
    instructionChecks: options.instructionChecks,
  };
}

function parseArgs(args) {
  const result = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    assert.ok(['--extension-dir', '--codex', '--mutation', '--codex-layout'].includes(key) && args[i + 1],
      'usage: check-codex-runtime.js [--extension-dir path] [--codex executable] [--mutation remove-generated-rule] [--codex-layout default|custom-override]');
    assert.equal(result[key], undefined, `duplicate option ${key}`);
    result[key] = args[i + 1];
  }
  assert.ok(!result['--mutation'] || result['--mutation'] === 'remove-generated-rule', 'unknown mutation');
  assert.ok(!result['--codex-layout'] || ['default', 'custom-override'].includes(result['--codex-layout']), 'unknown Codex layout');
  return result;
}

function strings(value, output = []) {
  if (typeof value === 'string') output.push(value);
  else if (Array.isArray(value)) value.forEach((item) => strings(item, output));
  else if (value && typeof value === 'object') Object.values(value).forEach((item) => strings(item, output));
  return output;
}

function hash(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function rolloutFor(codexHome, threadId) {
  const pending = [path.join(codexHome, 'sessions')];
  const found = [];
  while (pending.length) {
    const directory = pending.pop();
    if (!fs.existsSync(directory)) continue;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(file);
      else if (entry.isFile() && entry.name.endsWith('.jsonl') && entry.name.includes(threadId)) found.push(file);
    }
  }
  assert.equal(found.length, 1, 'fresh runtime thread must produce exactly one identifiable rollout');
  return found[0];
}

function removeOwnedState(root, state) {
  const resolvedRoot = path.resolve(root);
  const resolvedState = path.resolve(state);
  assert.equal(path.dirname(resolvedState), resolvedRoot, 'cleanup must stay directly inside the owned evidence directory');
  assert.equal(path.basename(resolvedState), 'isolated-state', 'cleanup target must be the owned state directory');
  fs.rmSync(resolvedState, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

async function finishesWithin(promise, milliseconds) {
  let timer;
  try {
    return await Promise.race([promise.then(() => true),
      new Promise((resolve) => { timer = setTimeout(() => resolve(false), milliseconds); })]);
  } finally { clearTimeout(timer); }
}

async function stopChild(child, closed) {
  if (!child) return;
  child.stdin.end();
  // Wait for close, not merely exit: inherited stdout/stderr handles can still
  // be held by the npm shim's Codex child after the shim exits.
  if (await finishesWithin(closed, 5000)) return;
  if (child.pid && child.exitCode === null && child.signalCode === null) {
    // commandLaunch may return an npm batch shim. Terminate only this spawned
    // process tree, or killing cmd.exe alone can leave its app-server running.
    const killed = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'],
      { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    if (killed.error) throw killed.error;
    assert.ok(await finishesWithin(closed, 5000),
      `spawned Codex process tree ${child.pid} did not close (taskkill status ${killed.status})`);
  } else {
    assert.ok(await finishesWithin(closed, 5000), 'spawned Codex process exited but its stdio did not close');
  }
}

async function runtimeCase(context, name, argument, instructionsExpected) {
  const { workspace, home, codexHome, launch, childEnv, guidance, gates } = context;
  const commandName = context.commandName ?? COMMAND;
  const shellWitness = context.shellWitness ?? SHELL_WITNESS;
  const approvalDecision = context.approvalDecision ?? 'decline';
  const instructionWitnesses = { user: USER_WITNESS, gate: GATE_WITNESS, shadowed: SHADOWED_WITNESS,
    ...context.instructionWitnesses };
  assert.match(commandName, /^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'fixture command must be a bare executable name');
  assert.ok(['accept', 'decline'].includes(approvalDecision), 'fixture approvals may only accept one call or decline; never amend policy');
  assert.ok(typeof shellWitness === 'string' && shellWitness.length > 0, 'execution witness must be nonempty');
  assert.equal(typeof instructionsExpected, 'boolean', 'managed instruction expectation must be explicit');
  for (const [label, witness] of Object.entries(instructionWitnesses)) {
    assert.ok(typeof witness === 'string' && witness.length > 0, `instruction witness ${label} must be nonempty`);
  }
  if (context.instructionChecks !== undefined) {
    assert.ok(context.instructionChecks && typeof context.instructionChecks === 'object' && !Array.isArray(context.instructionChecks),
      'instructionChecks must contain required and absent fixture strings');
    for (const kind of ['required', 'absent']) {
      assert.ok(Array.isArray(context.instructionChecks[kind]) && context.instructionChecks[kind].every((text) =>
        typeof text === 'string' && text.trim().length > 0), `instructionChecks.${kind} must be an array of nonempty fixture strings`);
    }
    assert.ok(context.instructionChecks.required.length + context.instructionChecks.absent.length > 0,
      'instructionChecks must check at least one fixture string');
  }
  const observed = { name, argument, providerRequests: 0, approvals: 0, commandItems: [], turnCompleted: false };
  let firstInstructions;
  let child;
  let childClosed;
  let lineReader;
  let timer;
  let nextId = 0;
  let stopping = false;
  const pending = new Map();
  let resolveTurn;
  let rejectTurn;
  const completed = new Promise((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject; });
  // A failure can precede awaiting completion during the initialize handshake.
  completed.catch(() => {});
  function fail(error) {
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
    rejectTurn(error);
  }
  const server = http.createServer((req, res) => {
    const chunks = [];
    let bytes = 0;
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > 4 * 1024 * 1024) {
        req.destroy();
        fail(new Error(`${name}: oversized fixture provider request`));
      } else chunks.push(chunk);
    });
    req.on('error', fail);
    req.on('end', () => {
      try {
        assert.equal(req.method, 'POST', `${name}: unexpected provider request method`);
        assert.equal(req.url, '/v1/responses', `${name}: unexpected provider request path`);
        assert.equal(req.headers.authorization, undefined, `${name}: fixture provider must receive no authorization header`);
        assert.equal(req.headers['api-key'], undefined, `${name}: fixture provider must receive no API key header`);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        observed.providerRequests += 1;
        assert.ok(observed.providerRequests <= 2, `${name}: runtime requested an unexpected extra model response`);
        if (observed.providerRequests === 1) {
          firstInstructions = strings([body.instructions, body.input]).join('\n').replace(/\r\n/g, '\n');
          assert.ok(body.tools?.some((tool) => tool.name === 'shell_command'), `${name}: runtime did not expose shell_command`);
        }
        const item = observed.providerRequests === 1
          ? { id: 'fc_runtime_fixture', type: 'function_call', name: 'shell_command', call_id: 'call_runtime_fixture',
            arguments: JSON.stringify({ command: `${commandName} ${argument}`, workdir: workspace,
              sandbox_permissions: 'require_escalated', justification: 'Run the isolated harmless Acolyte runtime fixture.' }) }
          : { id: 'msg_runtime_fixture', type: 'message', role: 'assistant', status: 'completed',
            content: [{ type: 'output_text', text: 'Isolated runtime fixture complete.', annotations: [] }] };
        const responseId = `response_fixture_${observed.providerRequests}`;
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (const event of [
          { type: 'response.created', response: { id: responseId, object: 'response', status: 'in_progress', output: [] } },
          { type: 'response.output_item.added', output_index: 0, item },
          { type: 'response.output_item.done', output_index: 0, item },
          { type: 'response.completed', response: { id: responseId, object: 'response', status: 'completed', output: [item],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
        ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        res.end();
      } catch (error) {
        res.writeHead(500);
        res.end('Fixture request rejected.');
        fail(error);
      }
    });
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    fs.writeFileSync(path.join(codexHome, 'config.toml'), [
      'model = "acolyte-runtime-fixture"', 'model_provider = "acolyte_runtime_fixture"',
      'approval_policy = "on-request"', 'sandbox_mode = "read-only"',
      '[features]', 'plugins = false',
      '[model_providers.acolyte_runtime_fixture]', 'name = "Acolyte scripted loopback responder"',
      `base_url = "http://127.0.0.1:${server.address().port}/v1"`, 'wire_api = "responses"',
      'requires_openai_auth = false', 'request_max_retries = 0', 'stream_max_retries = 0', '',
    ].join('\n'));
    child = spawn(launch.file, launch.args, { ...launch.options, windowsHide: true, cwd: workspace,
      env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    childClosed = new Promise((resolve) => child.once('close', resolve));
    // Count stderr rather than retaining logs that might grow to contain session
    // details. JSON-RPC errors, missing events and timed out turns fail the case.
    let stderrBytes = 0;
    child.stderr.on('data', (chunk) => { stderrBytes += chunk.length; });
    child.once('error', fail);
    child.once('exit', (code) => {
      if (!stopping && !observed.turnCompleted) fail(new Error(`${name}: Codex exited before turn completion (code ${code}; stderr ${stderrBytes} bytes)`));
    });
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const rpc = (method, params) => new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      send({ id, method, params });
    });
    child.stdin.on('error', (error) => { if (!stopping) fail(error); });
    lineReader = readline.createInterface({ input: child.stdout });
    lineReader.on('line', (line) => {
      try {
        const message = JSON.parse(line);
        if (message.id != null && !message.method && pending.has(message.id)) {
          const entry = pending.get(message.id);
          pending.delete(message.id);
          if (message.error) entry.reject(new Error(`${name}: RPC error ${message.error.code}: ${message.error.message}`));
          else entry.resolve(message.result);
          return;
        }
        if (message.id != null && message.method) {
          assert.equal(message.method, 'item/commandExecution/requestApproval', `${name}: unexpected server request`);
          observed.approvals += 1;
          assert.equal(observed.approvals, 1, `${name}: only one command approval is permitted per runtime case`);
          send({ id: message.id, result: { decision: approvalDecision } });
        }
        if (message.method === 'item/completed' && message.params?.item?.type === 'commandExecution') {
          const item = message.params.item;
          const next = { id: item.id, status: item.status, exitCode: item.exitCode ?? null,
            witness: String(item.aggregatedOutput || '').includes(shellWitness) };
          // Codex 0.145 emits a declined completion twice for the same item,
          // first without an exit code and then with -1. Count execution items,
          // retaining any witness, rather than mistaking that update for a rerun.
          const prior = observed.commandItems.find((entry) => entry.id === item.id);
          if (prior) {
            assert.equal(next.status, prior.status, `${name}: conflicting completion statuses`);
            if (prior.exitCode != null && next.exitCode != null) {
              assert.equal(next.exitCode, prior.exitCode, `${name}: conflicting completion exit codes`);
            }
            prior.exitCode = next.exitCode ?? prior.exitCode;
            prior.witness = prior.witness || next.witness;
          } else observed.commandItems.push(next);
        }
        if (message.method === 'error') throw new Error(`${name}: runtime emitted an error event`);
        if (message.method === 'turn/completed') {
          assert.equal(message.params?.turn?.status, 'completed', `${name}: turn did not complete successfully`);
          observed.turnCompleted = true;
          resolveTurn();
        }
      } catch (error) { fail(error); }
    });
    timer = setTimeout(() => fail(new Error(`${name}: runtime timeout after ${TIMEOUT_MS} ms`)), TIMEOUT_MS);
    await rpc('initialize', { clientInfo: { name: 'acolyte_runtime_check', version: '1' }, capabilities: { experimentalApi: true } });
    send({ method: 'initialized', params: {} });
    const started = await rpc('thread/start', { cwd: workspace, model: 'acolyte-runtime-fixture',
      modelProvider: 'acolyte_runtime_fixture', approvalPolicy: 'on-request', sandbox: 'read-only' });
    assert.ok(started.thread?.id, `${name}: no thread id returned`);
    observed.threadId = started.thread.id;
    await rpc('turn/start', { threadId: started.thread.id,
      input: [{ type: 'text', text: 'Run the isolated harmless runtime fixture.' }] });
    await completed;
    assert.equal(observed.providerRequests, 2, `${name}: expected tool response and final response`);
    assert.equal(observed.commandItems.length, 1, `${name}: expected one completed command item`);
    assert.equal(typeof firstInstructions, 'string', `${name}: first provider input was not captured`);
    assert.ok(firstInstructions.includes(instructionWitnesses.user), `${name}: user-owned AGENTS instruction was not loaded`);
    if (context.customLayout) {
      assert.ok(!firstInstructions.includes(instructionWitnesses.shadowed), `${name}: base instructions must remain shadowed by the active override`);
    }
    observed.instructions = {};
    for (const [label, needle] of [['guidanceBegin', guidance.BEGIN], ['guidanceEnd', guidance.END],
      ['guidanceBody', guidance.GUIDANCE_BODY.replace(/\r\n/g, '\n')],
      ['gatesBegin', gates.GATES_BEGIN], ['gatesEnd', gates.GATES_END], ['gateWitness', instructionWitnesses.gate]]) {
      const found = firstInstructions.includes(needle);
      observed.instructions[label] = found;
      assert.equal(found, instructionsExpected, `${name}: loaded ${label} must be ${instructionsExpected}`);
    }
    if (context.instructionChecks !== undefined) {
      observed.instructionChecks = Object.fromEntries(['required', 'absent'].map((kind) => [kind,
        context.instructionChecks[kind].map((text) => ({ text, found: firstInstructions.includes(text.replace(/\r\n/g, '\n')) }))]));
      for (const kind of ['required', 'absent']) {
        for (const item of observed.instructionChecks[kind]) {
          assert.equal(item.found, kind === 'required', `${name}: ${kind} instruction fixture must be ${kind === 'required'}: ${item.text}`);
        }
      }
    }
    observed.stderrBytes = stderrBytes;
    return observed;
  } catch (error) {
    error.runtimeEvidence = observed;
    throw error;
  } finally {
    stopping = true;
    clearTimeout(timer);
    try { await stopChild(child, childClosed); }
    catch (error) { error.runtimeEvidence = observed; throw error; }
    finally {
      lineReader?.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  }
}

function assertDeclined(result) {
  assert.equal(result.approvals, 1, `${result.name}: expected exactly one approval request`);
  assert.equal(result.commandItems[0].status, 'declined', `${result.name}: command must be declined`);
  assert.equal(result.commandItems[0].witness, false, `${result.name}: declined command must not execute`);
}

function assertAllowed(result, expectedApprovals = 0) {
  assert.ok([0, 1].includes(expectedApprovals), 'a successful fixture either uses its rule or accepts one call');
  assert.equal(result.approvals, expectedApprovals, `${result.name}: ${expectedApprovals === 0
    ? 'generated rule must suppress approval' : 'expected exactly one individually accepted approval'}`);
  assert.equal(result.commandItems[0].status, 'completed', `${result.name}: command must complete`);
  assert.equal(result.commandItems[0].exitCode, 0, `${result.name}: command must exit zero`);
  assert.equal(result.commandItems[0].witness, true, `${result.name}: command must emit the execution witness`);
}

async function main() {
  assert.equal(process.platform, 'win32', 'this runtime acceptance fixture currently targets Windows');
  const args = parseArgs(process.argv.slice(2));
  const manifestVersion = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vscode-extension', 'package.json'), 'utf8')).version;
  const extension = args['--extension-dir'] ? path.resolve(args['--extension-dir'])
    : path.join(os.homedir(), '.vscode', 'extensions', `local.permission-wildcarding-${manifestVersion}`);
  assert.ok(fs.existsSync(path.join(extension, 'extension.js')), `installed extension missing: ${extension}`);
  const installedVersion = JSON.parse(fs.readFileSync(path.join(extension, 'package.json'), 'utf8')).version;
  if (!args['--extension-dir']) assert.equal(installedVersion, manifestVersion, 'installed extension version differs from requested manifest version');
  const evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-codex-runtime-'));
  const state = path.join(evidenceRoot, 'isolated-state');
  const home = path.join(state, 'home');
  const customLayout = args['--codex-layout'] === 'custom-override';
  const codexHome = customLayout ? path.join(state, 'custom-codex') : path.join(home, '.codex');
  const workspace = path.join(state, 'workspace');
  const reportPath = path.join(evidenceRoot, 'evidence.json');
  const report = { status: 'running', boundary: BOUNDARY, extension, installedVersion,
    explicitExtensionOverride: !!args['--extension-dir'], mutation: args['--mutation'] || null,
    codexLayout: customLayout ? 'custom-override' : 'default',
    startedAt: new Date().toISOString(), cases: [] };
  const originalEnv = Object.fromEntries(['HOME', 'USERPROFILE', 'CODEX_HOME'].map((key) => [key, process.env[key]]));
  try {
    for (const dir of [codexHome, path.join(home, '.claude'), workspace]) fs.mkdirSync(dir, { recursive: true });
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.CODEX_HOME = codexHome;
    assert.equal(os.homedir(), home, 'home must be isolated before installed modules load');
    const files = ['src/exec-resolve.js', 'src/policy-exporters.js', 'src/agent-guidance.js', 'src/agent-gates.js', 'src/history-adapters.js', 'src/codex-paths.js'];
    report.moduleHashes = Object.fromEntries(files.map((file) => [file, hash(path.join(extension, file))]));
    const { commandLaunch } = require(path.join(extension, 'src/exec-resolve'));
    const { renderCodexRules, mergeGeneratedCodexRules } = require(path.join(extension, 'src/policy-exporters'));
    const guidance = require(path.join(extension, 'src/agent-guidance'));
    const gates = require(path.join(extension, 'src/agent-gates'));
    const { parseCodexJsonl } = require(path.join(extension, 'src/history-adapters'));
    const executable = args['--codex'] || 'codex';
    const versionLaunch = commandLaunch(executable, ['--version']);
    assert.ok(versionLaunch.resolved, `Codex executable is not reachable: ${executable}`);
    const version = spawnSync(versionLaunch.file, versionLaunch.args, { ...versionLaunch.options,
      encoding: 'utf8', windowsHide: true, timeout: 10000 });
    assert.equal(version.status, 0, 'Codex version probe failed');
    report.codexVersion = version.stdout.trim();
    const launch = commandLaunch(executable, ['app-server', '--stdio']);
    const childEnv = { ...process.env, PATH: workspace + path.delimiter + process.env.PATH };
    for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'OPENAI_BASE_URL',
      'OPENAI_ORG_ID', 'OPENAI_ORGANIZATION', 'OPENAI_PROJECT_ID', 'AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_ENDPOINT']) delete childEnv[key];
    fs.writeFileSync(path.join(workspace, COMMAND), `@echo off\r\necho ${SHELL_WITNESS}\r\n`);
    const agentsFile = path.join(codexHome, customLayout ? 'AGENTS.override.md' : 'AGENTS.md');
    const shadowedText = `# Base instructions kept intact\n${SHADOWED_WITNESS}\n`;
    if (customLayout) fs.writeFileSync(path.join(codexHome, 'AGENTS.md'), shadowedText);
    const originalInstructions = `# Fixture user instructions\n${USER_WITNESS}\n`;
    fs.writeFileSync(agentsFile, originalInstructions);
    fs.writeFileSync(path.join(home, '.claude', 'gates.generated.md'), `## Fixture memory gate\n${GATE_WITNESS}\n`);
    const ruleDir = path.join(codexHome, 'rules');
    fs.mkdirSync(ruleDir);
    const ruleFile = path.join(ruleDir, 'permission-wildcarding.rules');
    const manualRuleText = '# Fixture user-owned policy text\n';
    fs.writeFileSync(ruleFile, manualRuleText);
    const context = { workspace, home, codexHome, launch, childEnv, guidance, gates, customLayout };
    console.log(`Subject: AI Acolyte ${installedVersion}; ${report.codexVersion}; ${extension}${args['--extension-dir'] ? ' (explicit extension override)' : ' (installed extension)'}`);
    console.log(BOUNDARY);
    console.log(`Codex layout: ${report.codexLayout}`);
    if (report.mutation) console.log(`MUTATION ACTIVE: ${report.mutation}; an allowed-case failure is expected.`);
    async function check(name, argument, instructionsExpected, assertion) {
      let result;
      try { result = await runtimeCase(context, name, argument, instructionsExpected); }
      catch (error) {
        if (error.runtimeEvidence) report.cases.push(error.runtimeEvidence);
        throw error;
      }
      report.cases.push(result);
      assertion(result);
      const rollout = rolloutFor(codexHome, result.threadId);
      const observations = parseCodexJsonl(fs.readFileSync(rollout, 'utf8'), { file: rollout, platform: process.platform });
      const commandObservations = observations.filter((item) => item.command === `${COMMAND} ${argument}`);
      assert.equal(commandObservations.length, 1, `${name}: installed parser must recognize the real runtime shell call`);
      const observation = commandObservations[0];
      assert.equal(observation.source, 'codex', `${name}: parsed observation must have the Codex source`);
      if (result.commandItems[0].status === 'completed') {
        assert.equal(observation.status, 'success', `${name}: installed parser must credit the real successful result`);
      } else {
        assert.notEqual(observation.status, 'success', `${name}: declined execution must not become learning success`);
      }
      result.rollout = { observations: commandObservations.length, status: observation.status, tool: observation.tool,
        sha256: hash(rollout) };
      delete result.threadId;
      console.log(`PASS ${name}: approvals=${result.approvals}, command=${result.commandItems[0].status}, managed instructions=${instructionsExpected}`);
    }
    await check('no-generated-rule', 'allowed', false, assertDeclined);
    const backupDir = path.join(home, '.claude', 'backups');
    for (const results of [guidance.setGuidanceAll(true, { home, codexHome, backupDir }), gates.setGatesAll(true, { home, codexHome, backupDir })]) {
      const codex = results.find((item) => item.agent === 'codex');
      assert.ok(codex?.changed && codex.on && !codex.error, 'installed writer must enable the Codex managed block');
    }
    const generated = renderCodexRules([{ prefix: [COMMAND, 'allowed'], risk: 'low', autoSafe: false, successCount: 3 }], { includeReviewed: true });
    assert.match(generated, /prefix_rule\(/, 'installed exporter must generate the rule');
    fs.writeFileSync(ruleFile, mergeGeneratedCodexRules(manualRuleText, generated));
    if (report.mutation === 'remove-generated-rule') fs.writeFileSync(ruleFile, manualRuleText);
    await check('generated-rule-allows-command', 'allowed', true, assertAllowed);
    await check('neighbor-still-requests-approval', 'other', true, assertDeclined);
    fs.writeFileSync(ruleFile, manualRuleText);
    for (const results of [guidance.setGuidanceAll(false, { home, codexHome, backupDir }), gates.setGatesAll(false, { home, codexHome, backupDir })]) {
      const codex = results.find((item) => item.agent === 'codex');
      assert.ok(codex?.changed && !codex.on && !codex.error, 'installed writer must remove the Codex managed block');
    }
    assert.equal(fs.readFileSync(agentsFile, 'utf8').trim(), originalInstructions.trim(), 'removal must preserve user-owned instructions');
    await check('removed-rule-and-instructions', 'allowed', false, assertDeclined);
    if (customLayout) {
      assert.equal(fs.readFileSync(path.join(codexHome, 'AGENTS.md'), 'utf8'), shadowedText, 'inactive base instruction file must remain byte-identical');
      assert.equal(fs.existsSync(path.join(home, '.codex')), false, 'custom profile check must not create the default Codex home');
    }
    for (const file of files) assert.equal(hash(path.join(extension, file)), report.moduleHashes[file], `installed module changed during check: ${file}`);
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed';
    report.failure = String(error.message || error);
    process.exitCode = 1;
  } finally {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try { removeOwnedState(evidenceRoot, state); report.isolatedStateRemoved = true; }
    catch (error) { report.cleanupFailure = String(error.message || error); report.status = 'failed'; process.exitCode = 1; }
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`${report.status.toUpperCase()}: ${report.cases.length} runtime cases; evidence ${reportPath}`);
    if (report.failure) console.error(report.failure);
    if (report.cleanupFailure) console.error(report.cleanupFailure);
  }
}

module.exports = { createRuntimeContext, runtimeCase, rolloutFor, assertAllowed, assertDeclined };

if (require.main === module) main().catch((error) => { console.error(error.message || error); process.exitCode = 1; });
