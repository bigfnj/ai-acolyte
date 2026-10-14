#!/usr/bin/env node
// Probe exact MCP approval config and persisted outcomes in fresh isolated Codex profiles.
// Usage: node scripts/check-codex-mcp-runtime.js [--extension-dir <source-or-staged-root>]
//   [--write-fixture <path>]
// The named subject (default: this checkout) supplies the history parser whose
// verdict on each actual rollout is checked (2026-10-13).
// `--write-fixture` writes a sanitized copy of all six case rollouts, one
// session after another, for test/codex-mcp-item-completed.test.js: only the
// record kinds the parser reads survive, and ids, paths, timestamps and every
// instruction or message text are replaced (2026-10-13). The sixth, a call the
// server answers with a JSON-RPC error, was added later the same day beside the
// two declines, so a decline (no evidence) and a failure in the call (evidence)
// are measured in the same shape; the first five sessions are unchanged.
// No provider inference, credentials, live policy changes, or extension UI claims.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const readline = require('node:readline');
const { spawn, spawnSync } = require('node:child_process');
const { commandLaunch } = require('../src/exec-resolve');
const { rolloutFor, isolateWorkspaceInstructions, assertNoForeignInstructions, PROVIDER_CREDENTIAL_ENV } = require('./check-codex-runtime');
function fixtureServer() {
  const fs = require('node:fs'), readline = require('node:readline');
  const log = process.argv[2];
  const send = value => process.stdout.write(JSON.stringify(value) + '\n');
  readline.createInterface({ input: process.stdin }).on('line', line => {
    const request = JSON.parse(line);
    fs.appendFileSync(log, JSON.stringify(request) + '\n');
    if (request.id == null) return;
    let result;
    if (request.method === 'initialize') result = { protocolVersion: request.params.protocolVersion,
      capabilities: { tools: {} }, serverInfo: { name: 'acolyte-isolated-fixture', version: '1' } };
    else if (request.method === 'ping') result = {};
    // `crash` (2026-10-13): the server answers its call with a JSON-RPC error, so
    // a call that reached the server and failed there is measured beside a decline.
    else if (request.method === 'tools/call' && request.params?.name === 'crash') {
      send({ jsonrpc:'2.0', id:request.id, error:{ code:-32603, message:'acolyte-mcp-crash-witness' } }); return;
    }
    else if (request.method === 'tools/list') result = { tools: ['succeed','fail','neighbor','ProbeCase','NeighborCase','crash'].map(name => ({
      name, description: 'Harmless isolated ' + name + ' fixture', inputSchema: { type:'object',
        properties:{ shouldFail:{type:'boolean'}, marker:{type:'string'} }, additionalProperties:false },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } })) };
    else if (request.method === 'tools/call') result = { content: [{ type:'text', text:'acolyte-mcp-' + request.params.name + '-witness' }],
      isError: request.params.name === 'fail' || request.params.arguments?.shouldFail === true };
    else if (request.method === 'resources/list') result = { resources: [] };
    else if (request.method === 'resources/templates/list') result = { resourceTemplates: [] };
    else { send({ jsonrpc:'2.0', id:request.id, error:{code:-32601,message:'Fixture does not implement '+request.method} }); return; }
    send({ jsonrpc:'2.0', id:request.id, result });
  });
}
function createMcpRuntimeContext(options) {
  for (const key of ['home','codexHome','workspace','fixtureServerPath','logPath']) {
    assert.ok(typeof options[key] === 'string' && path.isAbsolute(options[key]), key + ' must be an explicit absolute isolated path');
  }
  const serverName = options.serverName || 'fixture';
  assert.match(serverName, /^[A-Za-z0-9_]{1,64}$/);
  const resolver = options.extensionDir ? require(path.join(options.extensionDir,'src','exec-resolve')) : require('../src/exec-resolve');
  const nodeExecutable = resolver.resolveExecutable(options.nodeExecutable || 'node');
  assert.ok(nodeExecutable,'A real Node executable must be available for the MCP fixture');
  assert.match(path.basename(nodeExecutable),/^node(?:\.exe)?$/i,'The MCP fixture must use Node, not the VS Code/Electron executable');
  return { ...options, nodeExecutable, serverName, evidenceRoot: options.evidenceRoot || path.join(path.dirname(options.logPath), 'runtime') };
}

function writeMcpFixture(context, overrides = {}) {
  const file = path.join(context.codexHome, 'config.toml');
  assert.equal(fs.existsSync(file), false, 'MCP fixture setup must not replace an existing config');
  for (const dir of [context.home,context.codexHome,context.workspace,path.dirname(context.fixtureServerPath),path.dirname(context.logPath)]) fs.mkdirSync(dir,{recursive:true});
  const fixtureText = '(' + fixtureServer.toString() + ')();\n';
  if (fs.existsSync(context.fixtureServerPath)) assert.equal(fs.readFileSync(context.fixtureServerPath,'utf8'),fixtureText);
  else fs.writeFileSync(context.fixtureServerPath,fixtureText,{flag:'wx'});
  const serverKey = 'mcp_servers.' + JSON.stringify(context.serverName);
  const lines=[
    'model = "acolyte-mcp-fixture"','model_provider = "acolyte_fixture"','approval_policy = "on-request"','sandbox_mode = "read-only"',
    '[features]','plugins = false',
    '[model_providers.acolyte_fixture]','name = "Acolyte scripted loopback responder"',
    'base_url = "http://127.0.0.1:1/v1"','wire_api = "responses"','requires_openai_auth = false','request_max_retries = 0','stream_max_retries = 0',
    '[' + serverKey + ']','command = '+JSON.stringify(context.nodeExecutable),'args = '+JSON.stringify([context.fixtureServerPath,context.logPath]),'required = true',
    'startup_timeout_sec = 10','tool_timeout_sec = 10','default_tools_approval_mode = "prompt"',
  ];
  for(const [key,value] of Object.entries(overrides)) lines.push('['+serverKey+'.tools.'+JSON.stringify(key)+']','approval_mode = '+JSON.stringify(value));
  fs.writeFileSync(file,lines.join('\n')+'\n',{flag:'wx'});
  return file;
}

async function mcpRuntimeCase(context, name, options = {}) {
  assert.match(name,/^[A-Za-z0-9_.-]+$/);
  const tool = options.tool || 'ProbeCase', approval = options.approvalDecision || 'decline';
  assert.ok(['accept','decline'].includes(approval), 'Fixture allows per-call approval only');
  const {home,codexHome,workspace,serverName,logPath:log} = context;
  const directory=path.join(context.evidenceRoot,name);
  assert.equal(fs.existsSync(directory),false,'MCP runtime evidence names must be unique');
  fs.mkdirSync(directory,{recursive:true});
  const configFile = path.join(codexHome,'config.toml'), configBefore = fs.readFileSync(configFile);
  const logStart = fs.existsSync(log) ? fs.statSync(log).size : 0;
  const observed={name,serverName,tool,providerRequests:0,events:[],serverRequests:[],configRead:null,catalog:null,providerInputs:[],stderr:''};
  let child,closed,reader,timer,stopping=false,id=0;
  const pending=new Map(); let resolveTurn,rejectTurn;
  const done=new Promise((resolve,reject)=>{resolveTurn=resolve;rejectTurn=reject;});done.catch(()=>{});
  function fail(error) { for (const p of pending.values()) p.reject(error);pending.clear();rejectTurn(error); }
  const server=http.createServer((req,res)=>{
    const chunks=[];req.on('data',x=>chunks.push(x));req.on('end',()=>{try{
      assert.equal(req.headers.authorization,undefined);assert.equal(req.headers['api-key'],undefined);
      // Opt-in, because scripts/vscode-acceptance/mcp.js reuses this case with a
      // workspace this module does not own; main() below always asks (2026-10-13).
      const raw=Buffer.concat(chunks).toString('utf8');
      if(options.foreignInstructionCheck){assertNoForeignInstructions(raw,name);observed.canaryFreeRequests=observed.providerRequests+1;}
      const body=JSON.parse(raw);observed.providerRequests++;
      assert.ok(observed.providerRequests<=2,'at most two scripted provider requests');
      observed.providerInputs.push(body.input);
      let item;
      if(observed.providerRequests===1) {
        observed.tools=body.tools;
        const namespace=body.tools.find(t=>t.name==='mcp__'+serverName);
        const entry=namespace?.tools?.find(t=>t.name===tool);
        assert.ok(entry,'Fixture tool is actually exposed: '+JSON.stringify(body.tools.map(x=>x.name||x.type)));
        observed.providerToolName=namespace.name+'.'+entry.name;
        item={id:'fc_fixture',type:'function_call',namespace:namespace.name,name:entry.name,call_id:'call_fixture',arguments:JSON.stringify(options.arguments || {})};
      } else item={id:'msg_fixture',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'Fixture complete.',annotations:[]}]};
      const responseId='response_fixture_'+observed.providerRequests;
      res.writeHead(200,{'Content-Type':'text/event-stream'});
      for(const event of [
        {type:'response.created',response:{id:responseId,object:'response',status:'in_progress',output:[]}},
        {type:'response.output_item.added',output_index:0,item},
        {type:'response.output_item.done',output_index:0,item},
        {type:'response.completed',response:{id:responseId,object:'response',status:'completed',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}}
      ]) res.write('event: '+event.type+'\ndata: '+JSON.stringify(event)+'\n\n');
      res.end();
    }catch(error){res.writeHead(500);res.end('Fixture failed');fail(error);}});
  });
  try {
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const endpoint = 'http://127.0.0.1:'+server.address().port+'/v1';
    const resolver=context.extensionDir?require(path.join(context.extensionDir,'src','exec-resolve')):{commandLaunch};
    const launch=resolver.commandLaunch('codex',['-c','model_providers.acolyte_fixture.base_url='+JSON.stringify(endpoint),'app-server','--stdio']);assert.ok(launch.resolved);
    const env={...process.env,HOME:home,USERPROFILE:home,CODEX_HOME:codexHome};
    for(const key of PROVIDER_CREDENTIAL_ENV) delete env[key];
    child=spawn(launch.file,launch.args,{...launch.options,windowsHide:true,cwd:workspace,env,stdio:['pipe','pipe','pipe']});
    closed=new Promise(resolve=>child.once('close',resolve));child.once('error',fail);
    child.stderr.on('data',x=>observed.stderr+=x.toString());
    child.once('exit',code=>{if(!stopping)fail(new Error('Codex exited '+code));});
    const send=msg=>child.stdin.write(JSON.stringify(msg)+'\n');
    const rpc=(method,params)=>new Promise((resolve,reject)=>{const next=++id;pending.set(next,{resolve,reject});send({id:next,method,params});});
    reader=readline.createInterface({input:child.stdout});reader.on('line',line=>{try{
      const msg=JSON.parse(line);
      if(msg.id!=null&&!msg.method&&pending.has(msg.id)){const p=pending.get(msg.id);pending.delete(msg.id);msg.error?p.reject(new Error(JSON.stringify(msg.error))):p.resolve(msg.result);return;}
      observed.events.push(msg);
      if(msg.id!=null&&msg.method) {
        observed.serverRequests.push(msg);
        if(msg.method==='mcpServer/elicitation/request') send({id:msg.id,result:{action:approval==='accept'?'accept':'decline',content:approval==='accept'?{}:null}});
        else send({id:msg.id,result:{decision:approval}});
      }
      if(msg.method==='turn/completed')resolveTurn();
    }catch(error){fail(error);}});
    timer=setTimeout(()=>fail(new Error('Fixture timed out')),45000);
    await rpc('initialize',{clientInfo:{name:'acolyte_mcp_capability',version:'1'},capabilities:{experimentalApi:true}});send({method:'initialized',params:{}});
    observed.configRead=await rpc('config/read',{cwd:workspace,includeLayers:true});
    const thread=await rpc('thread/start',{cwd:workspace,model:'acolyte-mcp-fixture',modelProvider:'acolyte_fixture',approvalPolicy:'on-request',sandbox:'read-only'});
    observed.threadId=thread.thread.id;
    observed.catalog=await rpc('mcpServerStatus/list',{});
    await rpc('turn/start',{threadId:observed.threadId,input:[{type:'text',text:'Invoke the isolated harmless MCP fixture.'}]});
    await done;
    observed.thread=await rpc('thread/read',{threadId:observed.threadId,includeTurns:true});
    assert.equal(observed.providerRequests,2);
    assert.deepEqual(fs.readFileSync(configFile),configBefore,'MCP runtime must preserve the exact reviewed config bytes');
  } catch(error) { observed.error=error.stack; }
  finally {
    stopping=true;clearTimeout(timer);
    if(child) {
      child.stdin.end();
      const timeout=setTimeout(()=>{if(child.exitCode==null)spawnSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,timeout:5000});},5000);
      await closed;clearTimeout(timeout);
    }
    reader?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
    if(observed.threadId){try{observed.rollout=rolloutFor(codexHome,observed.threadId);observed.records=fs.readFileSync(observed.rollout,'utf8').trim().split('\n').map(JSON.parse);}catch(error){observed.rolloutError=error.message;}}
    const entries=fs.existsSync(log)?fs.readFileSync(log).subarray(logStart).toString('utf8').trim():'';
    observed.mcpCalls=entries?entries.split('\n').map(JSON.parse):[];
    observed.evidencePath=path.join(directory,'evidence.json');
    fs.writeFileSync(observed.evidencePath,JSON.stringify(observed,null,2)+'\n');
    return observed;
  }
}

// ONE MCP OUTCOME AS THE ROLLOUT RECORDS IT, IN EITHER SHAPE (2026-10-13).
// Codex 0.145.0 wrote an event_msg/mcp_tool_call_end with {invocation, result:
// {Ok|Err}}. Codex 0.161.0 writes none: the outcome is an event_msg/item_completed
// whose item is {type: "McpToolCall", server, tool, status, result: {content,
// isError}}, or {status: "failed", error: {message}} and no result when declined
// (measured by main() below; the sanitized rollouts are
// test/fixtures/codex-mcp-item-completed-sanitized.jsonl). This is the Codex-side
// fact that main() AND scripts/vscode-acceptance/mcp.js assert, so it is defined
// once: the acceptance suite asserted only the 0.145.0 record and would have
// failed every case on 0.161.0 (the gap 6eb35c1 recorded). It deliberately does
// not borrow the product parser's reading (codexMcpCompletion in
// src/history-adapters.js): main() checks the parser's verdict separately, and a
// harness that read the rollout through the parser could not catch the parser
// misreading it.
//
// `executed`: the tool ran, so Ok / a result whose `isError` must match;
// otherwise the call was declined, so Err / an error with no result. `status` is
// the McpToolCall item's own status (the old record has none); `witness`, when
// given, must appear in the recorded result content. `errorMessage`, when given
// for a call with no result, is the exact recorded error (the Err string, or the
// item's error.message, and nothing else in it): a decline's and a server
// error's words are what tells them apart (2026-10-13, see DECLINED in main()).
// Each shape present must agree. A rollout carrying both -- no measured version
// writes both -- passes only if both agree, the same call the parser merges into
// one observation. Returns the shape or shapes found, `+`-joined, for the
// evidence record.
function assertMcpRolloutOutcome(records, expected, label = 'MCP outcome') {
  const { server, tool, executed, isError, status, witness, errorMessage } = expected;
  const direct = (Array.isArray(records) ? records : []).filter((record) =>
    record && record.type === 'event_msg' && record.payload && typeof record.payload === 'object');
  const ends = direct.filter((record) => record.payload.type === 'mcp_tool_call_end');
  const items = direct.filter((record) => record.payload.type === 'item_completed' && record.payload.item?.type === 'McpToolCall');
  const shapes = [...(ends.length ? ['mcp_tool_call_end'] : []), ...(items.length ? ['item_completed/McpToolCall'] : [])];
  assert.ok(shapes.length, `${label}: the rollout records the MCP outcome in one of the two known shapes`);
  assert.ok(ends.length <= 1 && items.length <= 1,
    `${label}: one call is recorded at most once per shape (${ends.length} mcp_tool_call_end, ${items.length} McpToolCall)`);
  const carries = (content) => witness === undefined || JSON.stringify(content ?? null).includes(witness);
  if (ends.length) {
    const { invocation, result } = ends[0].payload;
    assert.equal(invocation?.server, server, `${label}: mcp_tool_call_end server`);
    assert.equal(invocation?.tool, tool, `${label}: mcp_tool_call_end tool`);
    if (executed) {
      assert.ok(result && Object.hasOwn(result, 'Ok'), `${label}: an executed call is recorded Ok`);
      assert.equal(result.Ok?.isError, isError, `${label}: mcp_tool_call_end isError`);
      assert.ok(carries(result.Ok.content), `${label}: mcp_tool_call_end carries the tool's own result`);
    } else {
      assert.ok(result && Object.hasOwn(result, 'Err'), `${label}: a declined call is recorded Err`);
      if (errorMessage !== undefined) assert.deepEqual(result, { Err: errorMessage }, `${label}: mcp_tool_call_end records exactly the error`);
    }
  }
  if (items.length) {
    const { item } = items[0].payload;
    assert.equal(item.server, server, `${label}: McpToolCall server`);
    assert.equal(item.tool, tool, `${label}: McpToolCall tool`);
    if (status !== undefined) assert.equal(item.status, status, `${label}: McpToolCall status`);
    if (executed) {
      assert.ok(item.result && typeof item.result === 'object', `${label}: an executed call carries its result`);
      assert.equal(item.result.isError, isError, `${label}: McpToolCall isError`);
      assert.ok(carries(item.result.content), `${label}: McpToolCall carries the tool's own result`);
    } else {
      assert.equal(item.result ?? null, null, `${label}: a declined call ran nothing`);
      assert.ok(item.error?.message, `${label}: a declined call records why`);
      if (errorMessage !== undefined) {
        assert.equal(Object.hasOwn(item, 'result'), false, `${label}: McpToolCall writes no result key at all`);
        assert.deepEqual(item.error, { message: errorMessage }, `${label}: McpToolCall records exactly the error`);
      }
    }
  }
  return shapes.join('+');
}

// Whether isolateWorkspaceInstructions (check-codex-runtime.js) would plant for
// this workspace: its PARENT strictly inside the temp tree, not the temp root.
// The same test it applies, so a caller can opt in exactly where it would not
// refuse; test/vscode-acceptance-mcp.test.js pins that the two agree. The
// VS Code driver's workspace is <tmp>/acolyte-vscode-drive-*/workspace, so it
// qualifies; a workspace handed in from anywhere else does not.
function workspaceUnderTempTree(workspace) {
  let parent;
  try { parent = fs.realpathSync.native(path.dirname(path.resolve(workspace))); } catch { return false; }
  const relative = path.relative(fs.realpathSync.native(require('node:os').tmpdir()), parent);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

// SYNTHETIC VALUES IN THE REAL STRUCTURE (2026-10-13), the convention of
// check-codex-code-mode-runtime.js. Kept: the record kinds the history parser
// reads, in real order -- the namespaced function_call and its output, every
// event_msg/item_completed (McpToolCall and the UserMessage/AgentMessage items
// beside it, which the parser must ignore), task_complete -- with Codex's own
// field names and values for the MCP item (server, tool, status, result or
// error) untouched. Dropped: developer and user messages, world_state and
// token records, which carry instructions and nothing the parser reads (on
// this box they carried the developer's own home AGENTS.md until the harness
// isolation of 2026-10-13; see check-codex-runtime.js). Replaced: session,
// turn and record ids, timestamps, durations, every message text, and the
// session head, which names the cwd.
function sanitizedMcpFixture(cases) {
  const lines = [];
  let clock = 0;
  const peek = () => new Date(Date.UTC(2026, 9, 13, 13, 0, 0, clock * 10)).toISOString();
  const stamp = () => { const value = peek(); clock += 1; return value; };
  cases.forEach(({ records }, index) => {
    const n = index + 1;
    const session = `0192dddd-4444-7000-8000-00000000dd0${n}`, turn = `0192dddd-4444-7000-8000-00000000de0${n}`;
    let ordinal = 0, recordNumber = 0;
    const push = (type, payload) => { lines.push(JSON.stringify({ timestamp: stamp(), ordinal: ordinal++, type, payload })); };
    const recordId = (prefix) => `${prefix}_dd${n}${String(++recordNumber).padStart(4, '0')}`;
    const meta = records.find((record) => record.type === 'session_meta')?.payload || {};
    const kept = (value) => (typeof value === 'string' ? value : 'unknown');
    push('session_meta', { session_id: session, id: session, timestamp: peek(), cwd: 'C:\\src\\example',
      originator: kept(meta.originator), cli_version: kept(meta.cli_version), source: kept(meta.source),
      model_provider: 'example', base_instructions: 'Synthetic fixture. No real instructions are reproduced here.',
      history_mode: kept(meta.history_mode) });
    push('turn_context', { turn_id: turn, cwd: 'C:\\src\\example', approval_policy: 'on-request', sandbox_policy: 'read-only', model: 'example-model' });
    const wall = (text) => String(text).replace(/Wall time: [0-9.]+ seconds/, 'Wall time: 0.0100 seconds');
    for (const record of records) {
      const payload = record.payload || {};
      if (record.type === 'response_item' && payload.type === 'function_call') {
        push('response_item', { type: 'function_call', id: payload.id, name: payload.name, namespace: payload.namespace,
          arguments: payload.arguments, call_id: payload.call_id, internal_chat_message_metadata_passthrough: { turn_id: turn } });
      } else if (record.type === 'response_item' && payload.type === 'function_call_output') {
        push('response_item', { type: 'function_call_output', id: recordId('fco'), call_id: payload.call_id,
          output: Array.isArray(payload.output) ? payload.output.map((part) => ({ ...part, text: wall(part.text) })) : wall(payload.output),
          internal_chat_message_metadata_passthrough: { turn_id: turn } });
      } else if (record.type === 'event_msg' && payload.type === 'item_completed' && payload.item) {
        const item = payload.item.type === 'McpToolCall'
          ? { ...payload.item, duration: { secs: 0, nanos: payload.item.duration?.nanos ? 1000000 : 0 } }
          : { type: payload.item.type, id: recordId('item'), content: [{ type: payload.item.type === 'AgentMessage' ? 'Text' : 'text', text: 'Synthetic fixture message.' }] };
        push('event_msg', { type: 'item_completed', thread_id: session, turn_id: turn, item,
          started_at_ms: 1791925900000 + clock, completed_at_ms: 1791925900000 + clock });
      } else if (record.type === 'event_msg' && payload.type === 'task_complete') {
        push('event_msg', { type: 'task_complete', turn_id: turn });
      }
    }
  });
  return lines.join('\n') + '\n';
}

async function main() {
  const argv = process.argv.slice(2);
  const usage = 'usage: check-codex-mcp-runtime.js [--extension-dir <source-or-staged-root>] [--write-fixture <path>]';
  assert.ok(argv.length % 2 === 0, usage);
  for (let i = 0; i < argv.length; i += 2) assert.ok(['--extension-dir', '--write-fixture'].includes(argv[i]) && argv[i + 1], usage);
  const option = (name) => { const at = argv.indexOf(name); return at < 0 ? null : argv[at + 1]; };
  const subject = path.resolve(option('--extension-dir') || path.join(__dirname, '..'));
  const { parseCodexJsonl } = require(path.join(subject, 'src', 'history-adapters.js'));
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'acolyte-codex-mcp-runtime-'));
  const versionLaunch = commandLaunch('codex', ['--version']);
  const versionRun = spawnSync(versionLaunch.file, versionLaunch.args, { ...versionLaunch.options, windowsHide:true, encoding:'utf8', timeout:10000 });
  assert.equal(versionRun.status,0); const codexVersion=versionRun.stdout.trim();
  const results=[], rollouts=[];
  // WHAT A DECLINE AND A SERVER ERROR WRITE, measured 2026-10-13 on codex-cli
  // 0.161.0: both are a failed McpToolCall with no result, told apart only by
  // the error's words. Declined: the user refused at the prompt and the local
  // server log shows no tools/call. Server error: the call reached the server,
  // which answered it with a JSON-RPC error (fixtureServer's `crash`). Each is
  // asserted exactly; a build that rewords either fails here before the parser
  // can quietly misread it (src/history-adapters.js, CODEX_MCP_DECLINED, keeps
  // its own copy of the first, so this harness never borrows the parser's view).
  const DECLINED='user rejected MCP tool call';
  const SERVER_ERROR='tool call error: tool call failed for `fixture/crash`\n\nCaused by:\n    Mcp error: -32603: acolyte-mcp-crash-witness';
  // name, tool, per-tool overrides, prompt answer, prompts, tools/call count,
  // item status, Ok or Err, the exact error, and THE PARSER'S VERDICT: a
  // declined call never ran, so it is no evidence, `unknown` (2026-10-13; it
  // read `failed` before); a tool that ran and said isError, or a call the
  // server failed, is `failed`. The server-error case is last, so the first
  // five sessions of the written fixture are what they always were.
  const cases = [
    ['default-prompt-decline','succeed',{},'decline',1,0,'failed','Err',DECLINED,'unknown'],
    ['exact-approved-success','succeed',{succeed:'approve'},'decline',0,1,'completed','Ok',undefined,'success'],
    ['exact-approved-failure','fail',{fail:'approve'},'decline',0,1,'failed','Ok',undefined,'failed'],
    ['neighbor-remains-prompt','neighbor',{succeed:'approve'},'decline',1,0,'failed','Err',DECLINED,'unknown'],
    ['single-call-reviewed-success','succeed',{},'accept',1,1,'completed','Ok',undefined,'success'],
    ['exact-approved-server-error','crash',{crash:'approve'},'decline',0,1,'failed','Err',SERVER_ERROR,'failed'],
  ];
  for (const [name,tool,overrides,approval,prompts,executed,status,resultKind,errorMessage,verdict] of cases) {
    const directory=path.join(root,name),home=path.join(directory,'home');
    const context=createMcpRuntimeContext({home,codexHome:path.join(home,'.codex'),workspace:path.join(directory,'workspace'),
      fixtureServerPath:path.join(root,'fixture-server.cjs'),logPath:path.join(directory,'mcp.jsonl')});
    writeMcpFixture(context,overrides);
    // Workspace is its own project root, canary one level up (check-codex-runtime.js, 2026-10-13).
    isolateWorkspaceInstructions(context.workspace);
    const observed=await mcpRuntimeCase(context,name,{tool,approvalDecision:approval,foreignInstructionCheck:true});
    rollouts.push({name,records:observed.records||[]});
    results.push({name,tool,error:observed.error,approvals:observed.serverRequests.length,executed:observed.mcpCalls.filter(x=>x.method==='tools/call').length,
      items:observed.events.filter(x=>x.method==='item/completed').map(x=>x.params.item),evidence:observed.evidencePath});
    console.log(JSON.stringify(results.at(-1)));
    assert.equal(observed.error,undefined,name+' actual runtime completed');
    assert.equal(observed.canaryFreeRequests,observed.providerRequests,name+' every provider request was checked for foreign instructions');
    assert.equal(observed.serverRequests.length,prompts,name+' exact approval count');
    for (const request of observed.serverRequests) {
      assert.equal(request.method,'mcpServer/elicitation/request');
      assert.equal(request.params._meta.codex_approval_kind,'mcp_tool_call');
      assert.equal(request.params.serverName,'fixture');
    }
    const calls=observed.mcpCalls.filter(x=>x.method==='tools/call');
    assert.equal(calls.length,executed,name+' witnessed actual MCP execution count');
    if(executed)assert.equal(calls[0].params.name,tool);
    const items=observed.events.filter(x=>x.method==='item/completed'&&x.params.item.type==='mcpToolCall');
    assert.equal(items.length,1);assert.equal(items[0].params.item.status,status,name+' actual completion status');
    // TWO ROLLOUT SHAPES FOR ONE OUTCOME (2026-10-13): whichever the binary
    // wrote, checked by the assertion scripts/vscode-acceptance/mcp.js shares,
    // and recorded.
    results.at(-1).recordShape=assertMcpRolloutOutcome(observed.records,{server:'fixture',tool,executed:resultKind==='Ok',
      isError:tool==='fail',status,witness:'acolyte-mcp-'+tool+'-witness',errorMessage},name);
    // What the product's history parser makes of the same rollout. Recorded per
    // case and asserted after the loop, so one run reports every case.
    const parsed=parseCodexJsonl(fs.readFileSync(observed.rollout,'utf8'),{file:observed.rollout}).filter(x=>x.kind==='codex-mcp');
    results.at(-1).parser={expected:verdict,observations:parsed.map(x=>({server:x.mcpServer,tool:x.mcpTool,status:x.status}))};
    assert.equal(observed.configRead.config.mcp_servers.fixture.default_tools_approval_mode,'prompt');
    for(const [key,value] of Object.entries(overrides))assert.equal(observed.configRead.config.mcp_servers.fixture.tools[key].approval_mode,value);
  }
  // The parser verdicts. A rollout shape the parser cannot read yields NO
  // observation, which looks exactly like a session that called no MCP tool;
  // on 0.161.0 that is what happened to every case (2026-10-13), and this is
  // the line that says so instead of passing on the Codex facts alone.
  // Written before the parser verdict is asserted, so a run against a parser
  // that misses the shape still leaves the fixture its regression test needs.
  let fixture=null;
  if(option('--write-fixture')) {
    const target=path.resolve(option('--write-fixture'));
    fs.writeFileSync(target,sanitizedMcpFixture(rollouts));
    fixture={path:target,sha256:require('node:crypto').createHash('sha256').update(fs.readFileSync(target)).digest('hex')};
  }
  const parserMisses=results.filter(r=>r.parser.observations.length!==1||r.parser.observations[0].status!==r.parser.expected||r.parser.observations[0].tool!==r.tool);
  const status=parserMisses.length?'failed':'passed';
  const report=path.join(root,'evidence.json');fs.writeFileSync(report,JSON.stringify({status,root,codexVersion,boundary:'Actual Codex app-server and local MCP; scripted loopback provider, no inference or credentials',parserMisses:parserMisses.map(r=>r.name),fixture,results},null,2)+'\n');
  console.log(JSON.stringify({status,codexVersion,shapes:[...new Set(results.map(r=>r.recordShape))],parserMisses:parserMisses.map(r=>`${r.name}: expected ${r.parser.expected}, parser saw ${r.parser.observations.length} MCP observations (${r.parser.observations.map(x=>x.status).join(', ')||'none'})`),
    verdicts:results.map(r=>`${r.name}: ${r.parser.observations.map(x=>x.status).join(', ')||'none'}`),report}));
  assert.deepEqual(parserMisses.map(r=>r.name),[],`the history parser missed ${parserMisses.length} of ${results.length} actual MCP outcomes on ${codexVersion}`);
}
module.exports={createMcpRuntimeContext,writeMcpFixture,mcpRuntimeCase,assertMcpRolloutOutcome,workspaceUnderTempTree};
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
