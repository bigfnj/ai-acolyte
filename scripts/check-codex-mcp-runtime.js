#!/usr/bin/env node
// Probe exact MCP approval config and persisted outcomes in fresh isolated Codex profiles.
// Usage: node scripts/check-codex-mcp-runtime.js
// No provider inference, credentials, live policy changes, or extension UI claims.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const readline = require('node:readline');
const { spawn, spawnSync } = require('node:child_process');
const { commandLaunch } = require('../src/exec-resolve');
const { rolloutFor } = require('./check-codex-runtime');
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
    else if (request.method === 'tools/list') result = { tools: ['succeed','fail','neighbor','ProbeCase','NeighborCase'].map(name => ({
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
      const body=JSON.parse(Buffer.concat(chunks));observed.providerRequests++;
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
    for(const key of ['OPENAI_API_KEY','CODEX_API_KEY','CODEX_ACCESS_TOKEN','OPENAI_BASE_URL','OPENAI_ORG_ID','OPENAI_ORGANIZATION','OPENAI_PROJECT_ID','AZURE_OPENAI_API_KEY','AZURE_OPENAI_ENDPOINT']) delete env[key];
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
async function main() {
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'acolyte-codex-mcp-runtime-'));
  const versionLaunch = commandLaunch('codex', ['--version']);
  const versionRun = spawnSync(versionLaunch.file, versionLaunch.args, { ...versionLaunch.options, windowsHide:true, encoding:'utf8', timeout:10000 });
  assert.equal(versionRun.status,0); const codexVersion=versionRun.stdout.trim();
  const results=[];
  const cases = [
    ['default-prompt-decline','succeed',{},'decline',1,0,'failed','Err'],
    ['exact-approved-success','succeed',{succeed:'approve'},'decline',0,1,'completed','Ok'],
    ['exact-approved-failure','fail',{fail:'approve'},'decline',0,1,'failed','Ok'],
    ['neighbor-remains-prompt','neighbor',{succeed:'approve'},'decline',1,0,'failed','Err'],
    ['single-call-reviewed-success','succeed',{},'accept',1,1,'completed','Ok'],
  ];
  for (const [name,tool,overrides,approval,prompts,executed,status,resultKind] of cases) {
    const directory=path.join(root,name),home=path.join(directory,'home');
    const context=createMcpRuntimeContext({home,codexHome:path.join(home,'.codex'),workspace:path.join(directory,'workspace'),
      fixtureServerPath:path.join(root,'fixture-server.cjs'),logPath:path.join(directory,'mcp.jsonl')});
    writeMcpFixture(context,overrides);
    const observed=await mcpRuntimeCase(context,name,{tool,approvalDecision:approval});
    results.push({name,tool,error:observed.error,approvals:observed.serverRequests.length,executed:observed.mcpCalls.filter(x=>x.method==='tools/call').length,
      items:observed.events.filter(x=>x.method==='item/completed').map(x=>x.params.item),evidence:observed.evidencePath});
    console.log(JSON.stringify(results.at(-1)));
    assert.equal(observed.error,undefined,name+' actual runtime completed');
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
    const ends=observed.records.filter(x=>x.type==='event_msg'&&x.payload.type==='mcp_tool_call_end');
    assert.equal(ends.length,1);assert.equal(ends[0].payload.invocation.server,'fixture');
    assert.equal(ends[0].payload.invocation.tool,tool);assert.ok(Object.hasOwn(ends[0].payload.result,resultKind));
    if(resultKind==='Ok') {
      assert.equal(ends[0].payload.result.Ok.isError,tool==='fail');
      assert.ok(JSON.stringify(ends[0].payload.result.Ok.content).includes('acolyte-mcp-'+tool+'-witness'));
    }
    assert.equal(observed.configRead.config.mcp_servers.fixture.default_tools_approval_mode,'prompt');
    for(const [key,value] of Object.entries(overrides))assert.equal(observed.configRead.config.mcp_servers.fixture.tools[key].approval_mode,value);
  }
  const report=path.join(root,'evidence.json');fs.writeFileSync(report,JSON.stringify({status:'passed',root,codexVersion,boundary:'Actual Codex app-server and local MCP; scripted loopback provider, no inference or credentials',results},null,2)+'\n');
  console.log(JSON.stringify({report}));
}
module.exports={createMcpRuntimeContext,writeMcpFixture,mcpRuntimeCase};
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
