'use strict';

// Does Codex obey `<project>/.codex/rules`, for which projects, and does
// src/codex-policy.js say the same? Measured against the real Codex runtime in
// fresh isolated profiles, because the answer is version behaviour and the
// module's trust handling is built on it.
//
//   node scripts/check-codex-project-rules-runtime.js [--codex <executable>]
//
// Isolation mirrors scripts/check-codex-runtime.js: temp HOME, USERPROFILE and
// CODEX_HOME, provider credentials stripped, a scripted loopback model that
// issues ONE harmless command with `sandbox_permissions: require_escalated`, and
// every approval DECLINED. No inference, no credentials, no real profile. A case
// passes when the session's behaviour (approval requested or not, witness printed
// or not) matches the expectation AND codexRuleFileSet agrees about whether the
// project rule file is in the set. The config.toml fallback (no reachable codex)
// must never include a folder the session did not load: it may be narrower,
// never wider.
//
// First run 2026-10-13 against codex-cli 0.161.0: every case below as expected.
// That version exposes the shell as `exec_command` with `cmd`; older ones used
// `shell_command` with `command`. The tool is picked from the model request.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { spawn, spawnSync } = require('node:child_process');
const { commandLaunch } = require('../src/exec-resolve');
const { codexRuleFileSet } = require('../src/codex-policy');
const { isolateWorkspaceInstructions, assertNoForeignInstructions } = require('./check-codex-runtime');

const COMMAND = 'acolyte-project-rules-probe.cmd';
const WITNESS = 'acolyte-project-rules-witness';
const CREDENTIALS = ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'OPENAI_BASE_URL', 'OPENAI_ORG_ID',
  'OPENAI_ORGANIZATION', 'OPENAI_PROJECT_ID', 'AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_ENDPOINT'];
const lcDrive = (value) => value[0].toLowerCase() + value.slice(1);

function isolatedEnv(home, codexHome, extraPath) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: codexHome };
  if (extraPath) env.PATH = extraPath + path.delimiter + process.env.PATH;
  for (const key of CREDENTIALS) delete env[key];
  return env;
}

function git(cwd, ...args) {
  const run = spawnSync('git', ['-c', 'user.name=probe', '-c', 'user.email=probe@example.invalid',
    '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(run.status, 0, `git ${args.join(' ')}: ${run.stderr}`);
}

// One session: config/read for the layers, then one turn that runs the probe.
async function session(codex, { home, codexHome, cwd, configLines, label }) {
  const observed = { approvals: 0, items: [], providerRequests: 0 };
  let child, closed, reader, timer, nextId = 0, stopping = false;
  const pending = new Map();
  let resolveTurn, rejectTurn;
  const turn = new Promise((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject; });
  turn.catch(() => {});
  const fail = (error) => { for (const entry of pending.values()) entry.reject(error); pending.clear(); rejectTurn(error); };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try {
        assert.equal(req.headers.authorization, undefined, 'the loopback model must receive no credentials');
        const raw = Buffer.concat(chunks).toString('utf8');
        assertNoForeignInstructions(raw, label);
        const body = JSON.parse(raw);
        observed.providerRequests += 1;
        observed.canaryFreeRequests = observed.providerRequests;
        assert.ok(observed.providerRequests <= 2, 'one tool call and one final answer');
        let item;
        if (observed.providerRequests === 1) {
          const names = (body.tools || []).map((tool) => tool.name);
          const name = names.includes('exec_command') ? 'exec_command' : 'shell_command';
          assert.ok(names.includes(name), `no shell tool exposed: ${names.join(', ')}`);
          observed.tool = name;
          item = { id: 'fc_probe', type: 'function_call', name, call_id: 'call_probe', arguments: JSON.stringify({
            [name === 'exec_command' ? 'cmd' : 'command']: `${COMMAND} allowed`, workdir: cwd,
            sandbox_permissions: 'require_escalated', justification: 'Run the isolated harmless probe.' }) };
        } else {
          item = { id: 'msg_probe', type: 'message', role: 'assistant', status: 'completed',
            content: [{ type: 'output_text', text: 'Probe complete.', annotations: [] }] };
        }
        const id = `response_probe_${observed.providerRequests}`;
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (const event of [
          { type: 'response.created', response: { id, object: 'response', status: 'in_progress', output: [] } },
          { type: 'response.output_item.added', output_index: 0, item },
          { type: 'response.output_item.done', output_index: 0, item },
          { type: 'response.completed', response: { id, object: 'response', status: 'completed', output: [item],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
        ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        res.end();
      } catch (error) { res.writeHead(500); res.end(); fail(error); }
    });
  });
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    fs.writeFileSync(path.join(codexHome, 'config.toml'), [
      'model = "acolyte-probe"', 'model_provider = "acolyte_probe"', 'approval_policy = "on-request"',
      'sandbox_mode = "read-only"', ...(configLines.top || []), '[features]', 'plugins = false',
      '[model_providers.acolyte_probe]', 'name = "Acolyte scripted loopback responder"',
      `base_url = "http://127.0.0.1:${server.address().port}/v1"`, 'wire_api = "responses"',
      'requires_openai_auth = false', 'request_max_retries = 0', 'stream_max_retries = 0',
      ...(configLines.tables || []), '',
    ].join('\n'));
    const launch = commandLaunch(codex, ['app-server', '--stdio']);
    assert.ok(launch.resolved, `Codex executable is not reachable: ${codex}`);
    child = spawn(launch.file, launch.args, { ...launch.options, windowsHide: true, cwd: home,
      env: isolatedEnv(home, codexHome, cwd), stdio: ['pipe', 'pipe', 'pipe'] });
    closed = new Promise((resolve) => child.once('close', resolve));
    child.stderr.resume();
    child.once('exit', (code) => { if (!stopping) fail(new Error(`Codex exited ${code}`)); });
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const rpc = (method, params) => new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      send({ id, method, params });
    });
    reader = readline.createInterface({ input: child.stdout });
    reader.on('line', (line) => {
      try {
        const message = JSON.parse(line);
        if (message.id != null && !message.method && pending.has(message.id)) {
          const entry = pending.get(message.id);
          pending.delete(message.id);
          if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
          else entry.resolve(message.result);
          return;
        }
        if (message.id != null && message.method) {
          // Decline only: this check never approves anything, even once.
          observed.approvals += 1;
          send({ id: message.id, result: { decision: 'decline' } });
        }
        if (message.method === 'item/completed' && message.params?.item?.type === 'commandExecution') {
          const item = message.params.item;
          const prior = observed.items.find((entry) => entry.id === item.id);
          const witness = String(item.aggregatedOutput || '').includes(WITNESS);
          if (prior) prior.witness = prior.witness || witness;
          else observed.items.push({ id: item.id, status: item.status, witness });
        }
        if (message.method === 'turn/completed') resolveTurn();
      } catch (error) { fail(error); }
    });
    timer = setTimeout(() => fail(new Error('runtime timeout')), 45000);
    await rpc('initialize', { clientInfo: { name: 'acolyte_project_rules_check', version: '1' },
      capabilities: { experimentalApi: true } });
    send({ method: 'initialized', params: {} });
    const read = await rpc('config/read', { cwd, includeLayers: true });
    observed.projectLayers = (read.layers || []).filter((layer) => layer.name?.type === 'project')
      .map((layer) => ({ folder: layer.name.dotCodexFolder, enabled: !layer.disabledReason }));
    const thread = await rpc('thread/start', { cwd, model: 'acolyte-probe', modelProvider: 'acolyte_probe',
      approvalPolicy: 'on-request', sandbox: 'read-only' });
    await rpc('turn/start', { threadId: thread.thread.id, input: [{ type: 'text', text: 'Run the probe.' }] });
    await turn;
  } finally {
    stopping = true;
    clearTimeout(timer);
    if (child) {
      child.stdin.end();
      const kill = setTimeout(() => {
        if (child.exitCode == null) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 });
      }, 5000);
      await closed;
      clearTimeout(kill);
    }
    reader?.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  return observed;
}

// Each case builds its own profile and project. `loaded` is what the session is
// expected to obey; `layer` the expected config/read listing for the rule folder.
const trustTable = (key, level = 'trusted') => [`[projects.'${key}']`, `trust_level = "${level}"`];
const CASES = [
  { name: 'untrusted', loaded: false },
  { name: 'trusted', trust: (c) => trustTable(lcDrive(c.project)), loaded: true },
  { name: 'trusted-without-rule', trust: (c) => trustTable(lcDrive(c.project)), noRule: true, loaded: false },
  { name: 'explicitly-untrusted', trust: (c) => trustTable(lcDrive(c.project), 'untrusted'), loaded: false },
  { name: 'key-segment-case', trust: (c) => trustTable(lcDrive(c.project).replace(/Proj$/, 'PROJ')), loaded: true },
  { name: 'key-forward-slashes', trust: (c) => trustTable(lcDrive(c.project).replace(/\\/g, '/')), loaded: false },
  { name: 'key-trailing-separator', trust: (c) => trustTable(`${lcDrive(c.project)}\\`), loaded: false },
  { name: 'trusted-parent-outside-repository', trust: (c) => trustTable(lcDrive(c.dir)), loaded: false },
  { name: 'repository-root-rule-cwd-below', trust: (c) => trustTable(lcDrive(c.project)), repository: true,
    sub: 'inner', loaded: true },
  { name: 'worktree-trusted-through-main', trust: (c) => trustTable(lcDrive(path.join(c.dir, 'Main'))),
    worktree: true, loaded: true },
  { name: 'custom-root-marker', top: ['project_root_markers = [".acolyte-root"]'], marker: '.acolyte-root',
    trust: (c) => trustTable(lcDrive(c.project)), sub: 'inner', loaded: true },
];

async function main() {
  assert.equal(process.platform, 'win32', 'this runtime check currently targets Windows (the probe is a .cmd)');
  const args = process.argv.slice(2);
  assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--codex'), 'usage: [--codex <executable>]');
  const codex = args[1] || 'codex';
  const version = commandLaunch(codex, ['--version']);
  assert.ok(version.resolved, `Codex executable is not reachable: ${codex}`);
  const codexVersion = spawnSync(version.file, version.args, { ...version.options, encoding: 'utf8',
    windowsHide: true, timeout: 10000 }).stdout.trim();
  // Long-name form: os.tmpdir() can be an 8.3 short name, and Codex does not
  // trust a short-name key for a long-name cwd (measured).
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-codex-project-rules-')));
  const report = { codexVersion, root, startedAt: new Date().toISOString(), cases: [], execpolicy: {} };
  console.log(`Subject: ${codexVersion}; isolated profiles under ${root}`);
  let failures = 0;
  for (const spec of CASES) {
    const dir = path.join(root, spec.name);
    const home = path.join(dir, 'home');
    const codexHome = path.join(home, '.codex');
    const project = path.join(dir, 'Proj');
    const cwd = spec.sub ? path.join(project, spec.sub) : project;
    fs.mkdirSync(codexHome, { recursive: true });
    if (spec.worktree) {
      const main = path.join(dir, 'Main');
      fs.mkdirSync(main);
      git(main, 'init', '-q');
      fs.writeFileSync(path.join(main, 'x.txt'), 'x');
      git(main, 'add', '.');
      git(main, 'commit', '-q', '-m', 'fixture');
      git(main, 'worktree', 'add', '-q', project);
    } else fs.mkdirSync(project);
    if (spec.repository) git(project, 'init', '-q');
    if (spec.marker) fs.writeFileSync(path.join(project, spec.marker), '');
    // The PROJECT, not the cwd, is the instruction root here: two cases put the
    // cwd below it on purpose. A repository's or worktree's own `.git` and the
    // custom marker already stop the walk at the project; the plain-folder cases
    // get an empty `.git`, which Codex counts for AGENTS.md but not for project
    // layers or trust (src/codex-policy.js), so no case's rule result moves. The
    // canary sits one level up, beside Main (check-codex-runtime.js, 2026-10-13).
    isolateWorkspaceInstructions(project);
    fs.mkdirSync(cwd, { recursive: true });
    const rules = path.join(project, '.codex', 'rules');
    fs.mkdirSync(rules, { recursive: true });
    const ruleFile = path.join(rules, 'project.rules');
    if (!spec.noRule) fs.writeFileSync(ruleFile, `prefix_rule(pattern=["${COMMAND}", "allowed"], decision="allow")\n`);
    fs.writeFileSync(path.join(cwd, COMMAND), `@echo off\r\necho ${WITNESS}\r\n`);
    const context = { dir, project, cwd };
    const result = { name: spec.name, expectedLoaded: spec.loaded };
    try {
      const observed = await session(codex, { home, codexHome, cwd, label: spec.name,
        configLines: { top: spec.top, tables: spec.trust ? spec.trust(context) : [] } });
      const item = observed.items[0];
      result.tool = observed.tool;
      result.approvals = observed.approvals;
      result.executed = Boolean(item && item.status === 'completed' && item.witness);
      result.layer = observed.projectLayers.find((layer) => layer.folder.toLowerCase() ===
        path.join(project, '.codex').toLowerCase()) || null;
      assert.equal(observed.items.length, 1, 'one command item');
      // Obeyed means: no approval was requested and the probe ran. Not obeyed
      // means: an approval was requested, declined, and the probe never ran.
      assert.equal(result.approvals === 0 && result.executed, spec.loaded, 'session obeyed the project rule');
      assert.equal(result.approvals === 1 && !result.executed, !spec.loaded, 'or prompted and was declined');
      if (!spec.noRule) assert.equal(Boolean(result.layer?.enabled), spec.loaded, 'config/read agrees with the session');
      // The module, through Codex: the same answer as the session.
      const viaCodex = codexRuleFileSet({ home, codexHome, workspaceRoot: cwd, codexExecutable: codex });
      result.moduleIncludes = viaCodex.files.some((file) => file.toLowerCase() === ruleFile.toLowerCase());
      if (!spec.noRule) assert.equal(result.moduleIncludes, spec.loaded, 'codexRuleFileSet agrees with the session');
      // The module without Codex: narrower allowed, wider never.
      const fallback = codexRuleFileSet({ home, codexHome, workspaceRoot: cwd,
        codexExecutable: path.join(dir, 'no-such-codex.exe') });
      result.fallbackIncludes = fallback.files.some((file) => file.toLowerCase() === ruleFile.toLowerCase());
      assert.ok(!result.fallbackIncludes || spec.loaded, 'the config.toml fallback never includes an unloaded folder');
      console.log(`PASS ${spec.name}: approvals=${result.approvals} executed=${result.executed} ` +
        `module=${result.moduleIncludes} fallback=${result.fallbackIncludes}`);
    } catch (error) {
      failures += 1;
      result.failure = String(error.message || error);
      console.log(`FAIL ${spec.name}: ${result.failure}`);
    }
    report.cases.push(result);
  }

  // CODEX_HOME at a repository root is not a project layer (a home directory
  // that is a git repository). config/read only.
  {
    const home = path.join(root, 'home-repository', 'home');
    const codexHome = path.join(home, '.codex');
    fs.mkdirSync(path.join(home, 'Proj', '.codex'), { recursive: true });
    fs.mkdirSync(codexHome, { recursive: true });
    git(home, 'init', '-q');
    fs.writeFileSync(path.join(codexHome, 'config.toml'), trustTable(lcDrive(home)).join('\n') + '\n');
    const workspaceRoot = path.join(home, 'Proj');
    const { readCodexConfigLayers } = require('../src/codex-mcp-config');
    const folders = readCodexConfigLayers({ home, codexHome, workspaceRoot, codexExecutable: codex }).layers
      .filter((layer) => layer.name?.type === 'project').map((layer) => layer.name.dotCodexFolder.toLowerCase());
    const set = codexRuleFileSet({ home, codexHome, workspaceRoot, codexExecutable: codex });
    report.homeRepository = {
      codexHomeListedByCodex: folders.includes(codexHome.toLowerCase()),
      codexHomeListedAsProject: set.projectDirectories.some((dir) => dir.toLowerCase() === path.join(codexHome, 'rules').toLowerCase()),
    };
    const ok = !report.homeRepository.codexHomeListedByCodex && !report.homeRepository.codexHomeListedAsProject;
    if (!ok) failures += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'} home-repository: CODEX_HOME at the repository root is ` +
      `${ok ? 'not' : 'reported as'} a project layer`);
  }

  // Why the user-scope write validator leaves project rules out: what one
  // neighbouring --rules member does to `codex execpolicy check`.
  {
    const dir = path.join(root, 'execpolicy');
    const home = path.join(dir, 'home');
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    const user = path.join(dir, 'user.rules');
    const forbid = path.join(dir, 'forbid.rules');
    const broken = path.join(dir, 'broken.rules');
    fs.writeFileSync(user, 'prefix_rule(pattern=["probe-tool", "run"], decision="allow")\n');
    fs.writeFileSync(forbid, 'prefix_rule(pattern=["probe-tool"], decision="forbidden")\n');
    fs.writeFileSync(broken, 'prefix_rule(pattern=["probe-tool" decision=\n');
    const check = (...files) => {
      const launch = commandLaunch(codex, ['execpolicy', 'check', ...files.flatMap((file) => ['--rules', file]), '--', 'probe-tool', 'run']);
      const run = spawnSync(launch.file, launch.args, { ...launch.options, encoding: 'utf8', windowsHide: true,
        timeout: 30000, env: isolatedEnv(home, path.join(home, '.codex')) });
      let decision = null;
      try { decision = JSON.parse(run.stdout).decision; } catch {}
      return { status: run.status, decision };
    };
    report.execpolicy = { alone: check(user), withForbiddingNeighbour: check(user, forbid), withBrokenNeighbour: check(user, broken) };
    const { alone, withForbiddingNeighbour, withBrokenNeighbour } = report.execpolicy;
    const ok = alone.decision === 'allow' && withForbiddingNeighbour.decision === 'forbidden' && withBrokenNeighbour.status !== 0;
    if (!ok) failures += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'} execpolicy: alone=${alone.decision} forbidding-neighbour=` +
      `${withForbiddingNeighbour.decision} broken-neighbour-exit=${withBrokenNeighbour.status}`);
  }

  report.status = failures ? 'failed' : 'passed';
  report.finishedAt = new Date().toISOString();
  const evidence = path.join(root, 'evidence.json');
  fs.writeFileSync(evidence, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`${report.status.toUpperCase()}: ${report.cases.length} sessions; evidence ${evidence}`);
  if (failures) process.exitCode = 1;
}

if (require.main === module) main().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
