#!/usr/bin/env node
'use strict';

// Optional real-renderer companion to drive-vscode.js. Uses stock Node CDP and
// visible DOM controls, never a replacement vscode API or workbench service.
// The unique window title, loopback port and child-target parent relationship
// identify the isolated fixture window and its dashboard webview.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const TIMEOUT_MS = 240000;
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function argumentsFor(args) {
  const result = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    assert.ok(['--port', '--progress', '--report', '--window-title'].includes(key) && args[i + 1],
      'usage: renderer.js --port N --progress path --report path --window-title unique-fixture-title');
    assert.equal(result[key], undefined, `duplicate argument ${key}`);
    result[key] = args[i + 1];
  }
  for (const key of ['--port', '--progress', '--report', '--window-title']) assert.ok(result[key], `missing ${key}`);
  const port = Number(result['--port']);
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65535, 'port must be a TCP port number');
  assert.match(result['--window-title'], /^acolyte-vscode-drive-[a-z0-9_-]+$/i,
    'window title must identify the launcher-owned fixture');
  return { port, progress: path.resolve(result['--progress']), report: path.resolve(result['--report']),
    windowTitle: result['--window-title'] };
}

async function connect(url, port) {
  const endpoint = new URL(url);
  assert.equal(endpoint.protocol, 'ws:', 'CDP must use the local WebSocket endpoint');
  assert.equal(endpoint.hostname, '127.0.0.1', 'CDP connection must stay on the explicit loopback address');
  assert.equal(Number(endpoint.port), port, 'CDP connection must stay on the launcher-assigned port');
  const socket = new WebSocket(endpoint);
  let nextId = 0;
  const pending = new Map();
  const rejectPending = (error) => {
    for (const value of pending.values()) { clearTimeout(value.timer); value.reject(error); }
    pending.clear();
  };
  socket.addEventListener('message', (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(`CDP ${entry.method}: ${message.error.message}`));
    else entry.resolve(message.result);
  });
  socket.addEventListener('close', () => rejectPending(new Error('owned renderer CDP connection closed')));
  socket.addEventListener('error', () => rejectPending(new Error('owned renderer CDP connection failed')));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error('CDP connection timed out')); }, 5000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('cannot connect to owned renderer')); }, { once: true });
  });
  return {
    call(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP ${method} timed out`)); }, 5000);
        pending.set(id, { resolve, reject, timer, method });
        try { socket.send(JSON.stringify({ id, method, params })); }
        catch (error) { pending.delete(id); clearTimeout(timer); reject(error); }
      });
    },
    close() { rejectPending(new Error('renderer sidecar stopped')); socket.close(); },
  };
}

// Executed in the renderer solely to inspect real controls and obtain their
// screen coordinates. Input itself goes through CDP mouse/keyboard events.
function inspectUi(expectedTitle) {
  if (!document.title.includes(expectedTitle)) throw new Error('renderer window title does not match the owned fixture');
  const visible = (element) => {
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return box.width > 0 && box.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  };
  const text = (element) => String(element?.textContent || '').replace(/\s+/g, ' ').trim();
  const point = (element) => {
    if (!element || !visible(element)) return null;
    const box = element.getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
  const buttons = (element) => [...element.querySelectorAll('button, .monaco-button, [role="button"]')]
    .filter(visible).map((button) => ({ text: text(button), point: point(button) }));
  const pickers = [...document.querySelectorAll('.quick-input-widget')].filter(visible).map((picker) => ({
    title: text(picker.querySelector('.quick-input-title')),
    input: point(picker.querySelector('input:not([type="checkbox"])')),
    inputValue: picker.querySelector('input:not([type="checkbox"])')?.value || '',
    rows: [...picker.querySelectorAll('.monaco-list-row')].filter(visible).map((row) => {
      const checkbox = row.querySelector('[role="checkbox"], input[type="checkbox"]');
      return { label: text(row.querySelector('.label-name') || row.querySelector('.monaco-icon-label') || row),
        text: text(row), point: point(row), checkbox: point(checkbox),
        checked: checkbox?.getAttribute('aria-checked') === 'true' || checkbox?.checked === true };
    }),
    buttons: buttons(picker),
  }));
  const dialogs = [...document.querySelectorAll('.monaco-dialog-box')].filter(visible).map((dialog) => ({
    title: text(dialog.querySelector('.dialog-message-text')),
    // VS Code renders detail newlines as <br> elements. innerText preserves
    // those visible breaks; textContent would join the JSON and its headings.
    detail: String(dialog.querySelector('.dialog-message-detail')?.innerText || '').replace(/\r\n/g, '\n'),
    buttons: buttons(dialog),
  }));
  const editors = [...document.querySelectorAll('.monaco-editor .view-lines')].filter(visible)
    .map((element) => String(element.innerText || '').replace(/\u00a0/g, ' ').replace(/\u200b/g, ''));
  const notifications = [...document.querySelectorAll('.notification-list-item')].filter(visible).map(text);
  const statusbar = [...document.querySelectorAll('.statusbar-item')].filter(visible).map(text);
  return { windowTitle: document.title, pickers, dialogs, editors, notifications, statusbar };
}

function diagnosticChecks(detail) {
  const sections = [];
  const header = /(?:^|\n)(normalized command argv|Windows PowerShell host argv): (\[[^\n]+\])\n/g;
  const matches = [...detail.matchAll(header)];
  for (let i = 0; i < matches.length; i += 1) {
    const match = matches[i];
    const end = matches[i + 1]?.index ?? detail.indexOf('\n\nLearner:', match.index);
    assert.ok(end > match.index, `diagnostic ${match[1]} section has no boundary`);
    const body = detail.slice(match.index + match[0].length, end).trim();
    const summary = body.match(/^decision: ([^\n]+); matched rules: (\d+)\n/);
    assert.ok(summary, `diagnostic ${match[1]} has no structured decision summary`);
    const verdict = JSON.parse(body.slice(summary[0].length).trim());
    assert.ok(Array.isArray(verdict.matchedRules), `${match[1]} lacks actual matchedRules`);
    assert.equal(verdict.matchedRules.length, Number(summary[2]), `${match[1]} summary disagrees with the JSON result`);
    const decision = verdict.decision || 'none';
    assert.equal(summary[1], decision === 'none' ? 'no decision (prompt/default policy)' : decision,
      `${match[1]} summary disagrees with the JSON decision`);
    sections.push({ label: match[1], argv: JSON.parse(match[2]), decision,
      matchedRules: verdict.matchedRules.length, raw: verdict });
  }
  assert.equal(sections.filter((item) => item.label === 'normalized command argv').length, 1,
    'diagnostic must report exactly one normalized invocation independently of host wrappers');
  return sections;
}

function inspectDashboardRoot(expectedTitle) {
  if (!document.title.includes(expectedTitle)) throw new Error('dashboard window title does not match the owned fixture');
  return [...document.querySelectorAll('iframe')].map((frame) => {
    let url;
    try { url = new URL(frame.src); } catch { return { url: frame.src, product: false }; }
    const purpose = url.searchParams.get('purpose');
    // VS Code only emits purpose when current webview options contain it.
    // Reclaiming a view can replace those options while keeping its identity.
    const product = url.protocol === 'vscode-webview:' && url.searchParams.get('extensionId') === 'local.permission-wildcarding' &&
      (purpose === null || purpose === 'webviewView');
    const box = frame.getBoundingClientRect();
    const style = getComputedStyle(frame);
    return { url: frame.src, id: frame.id, product, purpose, x: box.x + frame.clientLeft, y: box.y + frame.clientTop,
      width: box.width, height: box.height, display: style.display,
      visible: box.width > 0 && box.height > 0 && style.display !== 'none' && style.visibility !== 'hidden',
      unscaled: Math.abs(box.width - frame.offsetWidth) < 1 && Math.abs(box.height - frame.offsetHeight) < 1 };
  });
}

function inspectDashboardRootHit(expectedTitle, expectedUrl, point) {
  if (!document.title.includes(expectedTitle)) throw new Error('dashboard input window title changed');
  const element = document.elementFromPoint(point.x, point.y);
  return { matches: element?.tagName === 'IFRAME' && element.src === expectedUrl,
    tag: element?.tagName, id: element?.id, html: element?.outerHTML.slice(0, 1500) };
}

function inspectDashboardDocument(expectedUrl, scrollTo) {
  if (location.href !== expectedUrl) throw new Error('dashboard child target URL changed');
  const frame = document.querySelector('iframe#active-frame');
  const doc = frame?.contentDocument;
  if (!doc) return { ready: false, reason: 'active-frame document is not available', url: location.href };
  const ids = ['guidanceCard', 'gatesCard', 'guidanceBtn', 'gatesBtn', 'autoLearnCard', 'alScan', 'alReview', 'alUndo', 'alWhy',
    'runNow', 'permissionsView', 'permissionsRestore', 'permissionsImport', 'codexHook', 'codexMemoryCard',
    'searchCodexMemory', 'inspectCodexMemory', 'reviewCodexMcp', 'rebuildCodexMemory', 'codexMemoryGates', 'list'];
  if (scrollTo) {
    let element;
    if (ids.includes(scrollTo)) element = doc.getElementById(scrollTo);
    else if (scrollTo === 'savedPermissionsHead') element = doc.querySelector('.rowhead[data-row="list"]');
    else if (scrollTo === 'savedMore') element = doc.querySelector('#list li.more');
    else if (['guidanceHead', 'gatesHead', 'autoLearnHead', 'codexMemoryHead', 'permissionToolsHead'].includes(scrollTo)) {
      element = doc.querySelector('.rowhead[data-row="' + scrollTo.replace('Head', '') + '"]');
    } else throw new Error('unexpected dashboard scroll target');
    if (!element) throw new Error('dashboard scroll control is absent');
    element.scrollIntoView({ block: 'center', inline: 'nearest' });
  }
  const frameBox = frame.getBoundingClientRect();
  const style = (element) => doc.defaultView.getComputedStyle(element);
  const visible = (element) => {
    if (!element) return false;
    const box = element.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && style(element).display !== 'none' && style(element).visibility !== 'hidden';
  };
  const text = (element) => String(element?.innerText || '').trim();
  const point = (element) => {
    if (!visible(element)) return null;
    const box = element.getBoundingClientRect();
    return { x: frameBox.x + frame.clientLeft + box.x + box.width / 2,
      y: frameBox.y + frame.clientTop + box.y + box.height / 2 };
  };
  const hit = (element) => {
    if (!visible(element)) return { matches: false, hovered: false };
    const box = element.getBoundingClientRect();
    const actual = doc.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return { matches: !!actual && (actual === element || element.contains(actual)), hovered: element.matches(':hover'),
      tag: actual?.tagName, id: actual?.id, html: actual?.outerHTML.slice(0, 700) };
  };
  const result = { ready: true, frameUrl: doc.location.href, activeFrame: { x: frameBox.x, y: frameBox.y,
    width: frameBox.width, height: frameBox.height,
    unscaled: Math.abs(frameBox.width - frame.offsetWidth) < 1 && Math.abs(frameBox.height - frame.offsetHeight) < 1 } };
  for (const control of ['guidance', 'gates']) {
    const suffix = control === 'guidance' ? 'Guidance' : 'Gates';
    const card = doc.getElementById(control + 'Card');
    const button = doc.getElementById(control + 'Btn');
    const head = doc.querySelector('.rowhead[data-row="' + control + '"]');
    if (!card || !button) return { ready: false, reason: 'instruction cards are not present', url: doc.location.href };
    result[control] = { visible: visible(card), display: style(card).display,
      badge: text(doc.getElementById('st' + suffix)), expanded: visible(doc.getElementById('body' + suffix)),
      status: text(doc.getElementById(control === 'guidance' ? 'gdtext' : 'mgtext')),
      button: text(button), enabled: !button.disabled, buttonPoint: point(button),
      headPoint: point(head), buttonHit: hit(button), headHit: hit(head) };
  }
  const autoLearnHead = doc.querySelector('.rowhead[data-row="autoLearn"]');
  result.autoLearn = { expanded: visible(doc.getElementById('bodyAutoLearn')),
    badge: text(doc.getElementById('stAutoLearn')), status: text(doc.getElementById('altext')),
    notes: text(doc.getElementById('alsub')), headPoint: point(autoLearnHead), headHit: hit(autoLearnHead),
    counts: Object.fromEntries(['safe', 'review', 'observe'].map((key) => [key, text(doc.getElementById('al' + key))])), buttons: {} };
  for (const id of ['alScan', 'alReview', 'alUndo', 'alWhy']) {
    const button = doc.getElementById(id);
    if (!button) return { ready: false, reason: 'Auto Learn controls are absent', url: doc.location.href };
    result.autoLearn.buttons[id] = { text: text(button), enabled: !button.disabled,
      buttonPoint: point(button), buttonHit: hit(button) };
  }
  for (const id of ['runNow', 'permissionsView', 'permissionsRestore', 'permissionsImport', 'codexHook', 'searchCodexMemory', 'inspectCodexMemory', 'reviewCodexMcp', 'rebuildCodexMemory', 'codexMemoryGates']) {
    const button = doc.getElementById(id);
    result[id] = button ? { text: text(button), enabled: !button.disabled, visible: visible(button),
      buttonPoint: point(button), buttonHit: hit(button) } : null;
  }
  const toolsHead = doc.getElementById('permissionToolsToggle');
  const toolsBody = doc.getElementById('bodyPermissionTools');
  result.permissionTools = toolsHead && toolsBody ? {
    text: text(toolsHead.querySelector('.rowname')), visible: visible(toolsHead),
    expanded: visible(toolsBody), hidden: toolsBody.hidden, ariaExpanded: toolsHead.getAttribute('aria-expanded'),
    controls: toolsHead.getAttribute('aria-controls'), focused: doc.activeElement === toolsHead,
    buttonIds: [...toolsBody.querySelectorAll('button')].map((button) => button.id),
    groupCount: toolsBody.querySelectorAll('h3.permission-group').length,
    headPoint: point(toolsHead), headHit: hit(toolsHead),
  } : null;
  result.permissions = {
    total: text(doc.getElementById('total')), claude: text(doc.getElementById('claudeTotal')),
    codex: text(doc.getElementById('codexTotal')), coverage: text(doc.getElementById('permissionCoverage')),
    totalTitle: doc.getElementById('total')?.title, claudeTitle: doc.getElementById('claudeTotal')?.title,
    codexTitle: doc.getElementById('codexTotal')?.title,
  };
  const savedHead = doc.querySelector('.rowhead[data-row="list"]');
  const savedMore = doc.querySelector('#list li.more');
  result.savedPermissions = { title: text(savedHead?.querySelector('.rowname')),
    expanded: visible(doc.getElementById('bodyList')), count: text(doc.getElementById('wcount')),
    headPoint: point(savedHead), headHit: hit(savedHead),
    rows: [...doc.querySelectorAll('#list li')].filter((row) => row.querySelector('code')).map((row) => ({
      label: text(row.querySelector('code')), agent: text(row.querySelector('.agent')),
      remove: !!row.querySelector('button.x'), inspect: !!row.querySelector('button.inspect'),
    })) };
  result.savedMore = savedMore ? { text: text(savedMore), visible: visible(savedMore),
    buttonPoint: point(savedMore), buttonHit: hit(savedMore) } : null;
  const memoryHead = doc.querySelector('.rowhead[data-row="codexMemory"]');
  result.codexMemory = { visible: visible(doc.getElementById('codexMemoryCard')),
    expanded: visible(doc.getElementById('bodyCodexMemory')), badge: text(doc.getElementById('stCodexMemory')),
    root: text(doc.getElementById('codexMemoryDir')), status: text(doc.getElementById('codexMemoryStatus')),
    nativeGateStatus: text(doc.getElementById('codexMemoryGatesStatus')),
    headPoint: point(memoryHead), headHit: hit(memoryHead) };
  return result;
}

async function main() {
  const options = argumentsFor(process.argv.slice(2));
  const dashboardEnabled = process.env.ACOLYTE_ACCEPTANCE_DASHBOARD_UI === '1';
  const pruneEnabled = process.env.ACOLYTE_ACCEPTANCE_CODEX_PRUNE === '1';
  const restoreEnabled = process.env.ACOLYTE_ACCEPTANCE_CODEX_RESTORE === '1';
  const derivedEnabled = process.env.ACOLYTE_ACCEPTANCE_CODEX_DERIVED === '1';
  const featuresOnly = process.env.ACOLYTE_ACCEPTANCE_FEATURES_ONLY === '1';
  const approvalsOnly = process.env.ACOLYTE_ACCEPTANCE_APPROVALS_ONLY === '1';
  const mcpOnly = process.env.ACOLYTE_ACCEPTANCE_MCP_ONLY === '1';
  const recallOnly = process.env.ACOLYTE_ACCEPTANCE_RECALL_ONLY === '1';
  const nativeGatesOnly = process.env.ACOLYTE_ACCEPTANCE_NATIVE_GATES_ONLY === '1';
  const report = { status: 'running', startedAt: new Date().toISOString(), port: options.port,
    windowTitle: options.windowTitle, phase: 'opt-in', observations: [], checkboxChecked: false,
    pickerAccepted: false, grantClicked: false, hostCompleted: false, diagnostics: [], dashboard: [], autoLearn: [],
    codexPrune: [], codexRestore: [], codexDerived: [], codexFeatures: [], codexApprovals: [], codexMcp: [], codexRecall: [], codexNativeGates: [] };
  const deadline = Date.now() + TIMEOUT_MS;
  let client;
  let lastUi;
  let progress;
  let activeDiagnostic;
  let activeDashboard;
  let activeAutoLearn;
  let activePrune;
  let activeRestore;
  let activeDerived;
  let activeFeature;
  let activeApproval;
  let activeMcp;
  let activeRecall;
  let activeNativeGates;
  let dashboardClient;
  let dashboardTarget;
  function readProgress() {
    try { progress = JSON.parse(fs.readFileSync(options.progress, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    if (['failed', 'review-runtime-failed'].includes(progress?.phase)) {
      throw new Error(`host reported ${progress.phase}: ${String(progress.error || progress.detail || 'see host report').slice(0, 1200)}`);
    }
    return progress;
  }
  async function waitFor(label, task) {
    report.phase = label;
    while (Date.now() < deadline) {
      readProgress();
      const result = await task();
      if (result) return result;
      await delay(150);
    }
    throw new Error(`timed out after ${TIMEOUT_MS} ms at ${label}; host phase ${progress?.phase || 'not yet reported'}`);
  }
  async function ui() {
    const result = await client.call('Runtime.evaluate', {
      expression: `(${inspectUi.toString()})(${JSON.stringify(options.windowTitle)})`, returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || 'renderer inspection failed');
    lastUi = result.result.value;
    return lastUi;
  }
  async function click(point) {
    assert.ok(point && Number.isFinite(point.x) && Number.isFinite(point.y), 'expected visible control has no click point');
    // Hover establishes Chromium's input route before crossing into an OOPIF.
    await client.call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    await client.call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await client.call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
  }
  async function key(keyName, code, virtualKey, text) {
    await client.call('Input.dispatchKeyEvent', { type: 'keyDown', key: keyName, code, windowsVirtualKeyCode: virtualKey,
      ...(text === undefined ? {} : { text, unmodifiedText: text }) });
    await client.call('Input.dispatchKeyEvent', { type: 'keyUp', key: keyName, code, windowsVirtualKeyCode: virtualKey });
  }
  async function fillInput(picker, value) {
    await click(picker.input);
    await client.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
    await client.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
    await client.call('Input.insertText', { text: value });
  }
  async function exactPicker(title, preceding = []) {
    return waitFor(`waiting for ${title}`, async () => {
      const state = await ui();
      assert.equal(state.dialogs.length, 0, `unexpected modal before ${title}`);
      if (!state.pickers.length) return null;
      assert.equal(state.pickers.length, 1, 'multiple visible pickers are ambiguous');
      const picker = state.pickers[0];
      if (preceding.includes(picker.title)) return null;
      assert.equal(picker.title, title, 'refusing an unrelated diagnostic picker');
      return picker;
    });
  }
  async function selectSingle(title, label, preceding = []) {
    const row = await waitFor(`waiting for the actual ${label} row in ${title}`, async () => {
      const picker = await exactPicker(title, preceding);
      const rows = picker.rows.filter((entry) => entry.label === label);
      assert.ok(rows.length <= 1, `multiple exact ${label} rows in ${title} are ambiguous`);
      if (!rows.length) return null;
      assert.equal(rows[0].checkbox, null, 'diagnostic agent/shell selection must be a single-choice picker');
      return rows[0];
    });
    await click(row.point);
    if (activeDiagnostic) report.observations.push({ phase: 'diagnostic-picker-selected', caseId: activeDiagnostic.caseId, title, label });
  }
  function ackDiagnostic(value) {
    assert.equal(path.dirname(path.resolve(activeDiagnostic.ackPath)), path.dirname(options.progress),
      'diagnostic acknowledgment must stay inside the owned fixture directory');
    fs.writeFileSync(activeDiagnostic.ackPath, JSON.stringify({ caseId: activeDiagnostic.caseId, ...value }, null, 2) + '\n');
  }
  async function driveDiagnostic(fixture) {
    activeDiagnostic = fixture;
    assert.ok(['reviewed-allowed', 'neighbor-declined', 'undone-declined'].includes(fixture.caseId), 'unexpected diagnostic case');
    assert.ok(['allow', 'none'].includes(fixture.expectedDecision));
    assert.ok(Array.isArray(fixture.expectedArgv) && fixture.expectedArgv.length === 2);
    const expectedCommand = fixture.caseId === 'neighbor-declined'
      ? report.commandName.replace(/^acolyte-review-/i, 'acolyte-neighbor-') : report.commandName;
    assert.equal(fixture.expectedArgv[0], expectedCommand, 'diagnostic must stay inside this exact fixture command pair');
    assert.equal(fixture.expectedArgv[1], 'allowed', 'diagnostic must use the harmless fixture argument');
    assert.equal(fixture.expectedDecision, fixture.caseId === 'reviewed-allowed' ? 'allow' : 'none');
    assert.equal(fixture.command, fixture.expectedArgv.join(' '), 'diagnostic command must match its expected argv');
    assert.ok(typeof fixture.expectedRulesPath === 'string' && typeof fixture.expectedDisplayedRulesPath === 'string');
    assert.equal(path.dirname(path.resolve(fixture.ackPath)), path.dirname(options.progress));
    let buttonsBefore;
    if (fixture.viaDashboard) {
      assert.ok(dashboardEnabled, 'dashboard diagnostic launch requires the dashboard flag');
      const before = await autoLearnReady(fixture.expectedBeforeButtons);
      buttonsBefore = autoLearnButtons(before);
      await dashboardClick('autoLearn', 'alWhy');
    }
    const agentTitle = 'Which agent showed the approval prompt?';
    const shellTitle = 'Which shell syntax should Auto Learn parse?';
    const inputTitle = 'Why did Codex prompt?';
    await selectSingle(agentTitle, 'Codex');
    await selectSingle(shellTitle, 'PowerShell', [agentTitle]);
    const input = await exactPicker(inputTitle, [shellTitle]);
    await fillInput(input, fixture.command);
    const entered = await ui();
    assert.equal(entered.pickers.length, 1);
    assert.equal(entered.pickers[0].title, inputTitle);
    assert.equal(entered.pickers[0].inputValue, fixture.command, 'actual diagnostic input differs from the runtime command');
    await key('Enter', 'Enter', 13);
    const dialog = await waitFor(`waiting for ${fixture.caseId} diagnostic modal`, async () => {
      const state = await ui();
      if (!state.dialogs.length) return null;
      assert.equal(state.dialogs.length, 1, 'multiple diagnostic dialogs are ambiguous');
      assert.equal(state.dialogs[0].title, 'Codex execpolicy analysis', 'refusing an unrelated diagnostic modal');
      return state.dialogs[0];
    });
    const text = dialog.detail;
    assert.match(text, /^Rules checked together \(\d+\):\n/);
    const rulesEnd = text.indexOf('\n\nnormalized command argv:');
    assert.ok(rulesEnd > 0, 'rules listing and normalized command section must be separate');
    const displayedRules = text.slice(0, rulesEnd).split('\n').slice(1);
    assert.ok(displayedRules.includes('- ' + fixture.expectedDisplayedRulesPath), 'diagnostic does not list the selected Codex rules file');
    assert.ok(text.includes('Managed and system-scope Codex policy is not enumerated here'), 'diagnostic omitted managed/system policy blind spots');
    assert.ok(text.includes('Session approval state and sandbox restrictions are also outside this check.'),
      'diagnostic omitted session/sandbox blind spots');
    const checks = diagnosticChecks(text);
    const direct = checks.find((item) => item.label === 'normalized command argv');
    assert.deepEqual(direct.argv, fixture.expectedArgv, 'diagnostic normalized argv differs from the actual runtime command');
    assert.equal(direct.decision, fixture.expectedDecision, 'direct invocation decision disagrees with the expected runtime transition');
    if (fixture.expectedDecision === 'allow') assert.ok(direct.matchedRules > 0, 'allow must name a matching rule');
    else assert.equal(direct.matchedRules, 0, 'neighbor/undone command must have no matching rule');
    const evidence = { status: 'passed', observedDecision: direct.decision, argv: direct.argv,
      rulePath: fixture.expectedRulesPath, displayedRulePath: fixture.expectedDisplayedRulesPath,
      dialogText: dialog.title + '\n' + text, checks,
      expectedRuntimeApprovals: fixture.expectedRuntimeApprovals, expectedRuntimeStatus: fixture.expectedRuntimeStatus };
    if (fixture.viaDashboard) Object.assign(evidence, { clicked: 'alWhy', buttonsBefore });
    report.diagnostics.push({ caseId: fixture.caseId, ...evidence });
    const okay = dialog.buttons.filter((button) => button.text === 'OK');
    assert.equal(okay.length, 1, 'expected exactly one actual diagnostic OK button');
    await click(okay[0].point);
    await waitFor(`waiting for ${fixture.caseId} modal dismissal`, async () => !(await ui()).dialogs.length);
    ackDiagnostic(evidence);
    activeDiagnostic = null;
  }
  function ackDashboard(value) {
    assert.equal(path.dirname(path.resolve(activeDashboard.ackPath)), path.dirname(options.progress),
      'dashboard acknowledgment must stay inside the owned fixture directory');
    fs.writeFileSync(activeDashboard.ackPath, JSON.stringify({ caseId: activeDashboard.caseId, ...value }, null, 2) + '\n');
  }
  async function evaluate(targetClient, inspect, args) {
    const result = await targetClient.call('Runtime.evaluate', {
      expression: `(${inspect.toString()})(...${JSON.stringify(args)})`, returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || 'dashboard inspection failed');
    return result.result.value;
  }
  async function dashboardState(scrollTo = null) {
    const state = await ui();
    assert.equal(state.dialogs.length, 0, 'dashboard control cannot be used with an open modal');
    assert.equal(state.pickers.length, 0, 'dashboard control cannot be used with an open picker');
    const observedFrames = await evaluate(client, inspectDashboardRoot, [options.windowTitle]);
    report.lastDashboardFrames = observedFrames;
    const frames = observedFrames.filter((frame) => frame.product);
    assert.ok(frames.length <= 1, 'multiple product webview frames are ambiguous');
    let result = null;
    if (frames.length && frames[0].visible) {
      const frame = frames[0];
      assert.ok(frame.unscaled, 'dashboard outer iframe has an unsupported CSS transform');
      const response = await fetch(`http://127.0.0.1:${options.port}/json/list`, { signal: AbortSignal.timeout(2000), redirect: 'error' });
      assert.ok(response.ok, 'owned CDP target listing is unavailable');
      const targets = await response.json();
      const matches = targets.filter((target) => target.type === 'iframe' && target.parentId === report.targetId && target.url === frame.url);
      report.lastDashboardTargets = targets.map(({ id, parentId, type, url }) => ({ id, parentId, type, url }));
      assert.ok(matches.length <= 1, 'multiple child targets claim the owned dashboard URL');
      if (matches.length) {
        const target = matches[0];
        if (dashboardTarget?.id !== target.id) {
          dashboardClient?.close();
          dashboardClient = await connect(target.webSocketDebuggerUrl, options.port);
          dashboardTarget = target;
        }
        result = await evaluate(dashboardClient, inspectDashboardDocument, [target.url, scrollTo]);
        report.lastDashboardDocument = result;
        if (result.ready) {
          assert.ok(result.activeFrame.unscaled, 'dashboard inner iframe has an unsupported CSS transform');
          result.outerFrame = frame;
          const entries = [result.guidance, result.gates, result.autoLearn, result.permissionTools,
            result.runNow, result.permissionsView, result.permissionsRestore, result.permissionsImport,
            result.codexHook, result.codexMemory, result.savedPermissions, result.savedMore, result.searchCodexMemory, result.inspectCodexMemory,
            result.reviewCodexMcp, result.rebuildCodexMemory, result.codexMemoryGates,
            ...Object.values(result.autoLearn.buttons)].filter(Boolean);
          for (const entry of entries) {
            for (const key of ['headPoint', 'buttonPoint']) {
              if (entry[key]) {
                entry[key].x += frame.x;
                entry[key].y += frame.y;
              }
            }
          }
        }
      } else {
        dashboardClient?.close();
        dashboardClient = null;
        dashboardTarget = null;
      }
    }
    if (result?.ready && result.guidance.visible && result.gates.visible) return result;
    if (!report.dashboardDiscoveryScreenshot || Date.now() - (report.dashboardDiscoverySnapshotAt || 0) > 5000) {
      report.dashboardDiscoverySnapshotAt = Date.now();
      report.dashboardDiscoveryScreenshot = await dashboardScreenshot('discovery');
      fs.writeFileSync(options.report, JSON.stringify(report, null, 2) + '\n');
    }
    return null;
  }
  async function dashboardClick(control, part) {
    const route = {
      codexRules: ['permissionsView'],
      codexRestore: ['permissionsRestore', 'Restore permissions', 'Codex'],
      importCodexRules: ['permissionsImport', 'Import project permissions', 'Codex'],
      claudeRules: ['permissionsView'],
      restore: ['permissionsRestore', 'Restore permissions', 'Claude Code'],
      reviewCodexApprovals: ['runNow'],
    }[control];
    if (route) control = route[0];
    if (['permissionsView', 'permissionsRestore', 'permissionsImport', 'codexHook', 'reviewCodexMcp'].includes(control)) {
      await permissionToolsReady();
    }
    const autoButton = control === 'autoLearn' && part !== 'head';
    const directButton = ['runNow', 'permissionsView', 'permissionsRestore', 'permissionsImport', 'codexHook', 'searchCodexMemory', 'inspectCodexMemory', 'reviewCodexMcp', 'rebuildCodexMemory', 'codexMemoryGates', 'savedMore'].includes(control) && part === 'button';
    assert.ok(await dashboardState(directButton ? control : autoButton ? part : control + (part === 'head' ? 'Head' : 'Btn')),
      'dashboard became unavailable before the click');
    let movedPoint;
    const ready = await waitFor(`waiting for ${control} ${part} to receive actual mouse input`, async () => {
      const state = await dashboardState();
      assert.ok(state, 'dashboard became unavailable before the click');
      const entry = autoButton ? state.autoLearn.buttons[part] : state[control];
      const point = entry[part === 'head' ? 'headPoint' : 'buttonPoint'];
      const frame = state.outerFrame;
      assert.ok(point && point.x > frame.x && point.x < frame.x + frame.width &&
        point.y > frame.y && point.y < frame.y + frame.height, 'dashboard control is outside its visible iframe');
      if (!movedPoint || point.x !== movedPoint.x || point.y !== movedPoint.y) {
        await client.call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
        movedPoint = point;
        return null;
      }
      const rootHit = await evaluate(client, inspectDashboardRootHit, [options.windowTitle, frame.url, point]);
      const childHit = entry[part === 'head' ? 'headHit' : 'buttonHit'];
      report.lastDashboardInput = { caseId: activeNativeGates?.caseId || activeRecall?.caseId || activeMcp?.caseId || activeApproval?.caseId || activeFeature?.caseId || activeDashboard?.caseId || activeAutoLearn?.caseId || activeDiagnostic?.caseId || activePrune?.caseId,
        control, part, point, rootHit, childHit };
      if (!report.dashboardInputSnapshotAt || Date.now() - report.dashboardInputSnapshotAt > 5000) {
        report.dashboardInputSnapshotAt = Date.now();
        fs.writeFileSync(options.report, JSON.stringify(report, null, 2) + '\n');
      }
      // A modal can intercept the first move even after its visible contents
      // disappear. Move again only after the owned iframe is the actual hit
      // target; never press until its child control receives hover as well.
      if (rootHit.matches && childHit.matches && !childHit.hovered) {
        await client.call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
      }
      return rootHit.matches && childHit.matches && childHit.hovered ? report.lastDashboardInput : null;
    });
    report.observations.push({ phase: 'dashboard-control-click', ...ready });
    await click(ready.point);
    if (route?.[1]) {
      const picker = await exactPicker(route[1]);
      assert.deepEqual(picker.rows.map((row) => row.label).sort(), ['Claude Code', 'Codex'],
        'WITNESS shared permission action offers both agents');
      await selectSingle(route[1], route[2]);
      await waitFor('waiting for the shared agent picker to close', async () => {
        const current = await ui();
        return current.pickers.every((entry) => entry.title !== route[1]) ? current : null;
      });
      report.observations.push({ phase: 'permission-agent-selected', control, title: route[1], agent: route[2] });
    }
    return control;
  }
  async function permissionToolsReady() {
    const ids = ['permissionsView', 'permissionsRestore', 'permissionsImport', 'codexHook', 'reviewCodexMcp'];
    const inspect = (state, expanded) => {
      const menu = state?.permissionTools;
      assert.ok(menu?.visible, 'WITNESS the actual Permission tools disclosure is visible');
      assert.equal(menu.text, 'Permission tools');
      assert.equal(menu.controls, 'bodyPermissionTools');
      assert.deepEqual(menu.buttonIds, ids, 'WITNESS Permission tools contains exactly the five shared or agent-specific controls');
      assert.equal(menu.groupCount, 0, 'WITNESS shared permission actions are not duplicated in agent groups');
      assert.equal(state.permissionsView.text, 'View / remove permissions…');
      assert.equal(state.permissionsRestore.text, 'Restore permissions…');
      assert.equal(state.permissionsImport.text, 'Import project permissions…');
      assert.equal(menu.expanded, expanded, 'WITNESS Permission tools has the expected visible state');
      assert.equal(menu.hidden, !expanded);
      assert.equal(menu.ariaExpanded, String(expanded), 'WITNESS Permission tools announces its actual expanded state');
      for (const id of ids) assert.equal(state[id]?.visible, expanded,
        `WITNESS ${id} is ${expanded ? 'shown' : 'hidden'} with Permission tools`);
      return menu;
    };
    const initial = await dashboardState('permissionToolsHead');
    if (report.permissionTools) {
      inspect(initial, true);
      report.permissionTools.retainedAcrossActions += 1;
      return;
    }
    inspect(initial, false);
    const closedScreenshot = await dashboardScreenshot('permission-tools-closed');
    await dashboardClick('permissionTools', 'head');
    const opened = await waitFor('waiting for Permission tools mouse expansion', async () => {
      const state = await dashboardState(); return state?.permissionTools?.expanded ? state : null;
    });
    inspect(opened, true);
    assert.equal(opened.permissionTools.focused, true, 'WITNESS clicking the native disclosure focuses its keyboard control');
    const openScreenshot = await dashboardScreenshot('permission-tools-open');
    // Native button activation needs the Enter character as well as keyDown;
    // workbench pickers elsewhere consume keyDown directly.
    await key('Enter', 'Enter', 13, '\r');
    const collapsed = await waitFor('waiting for Permission tools keyboard collapse', async () => {
      const state = await dashboardState(); return state?.permissionTools && !state.permissionTools.expanded ? state : null;
    });
    inspect(collapsed, false);
    assert.equal(collapsed.permissionTools.focused, true);
    await key('Enter', 'Enter', 13, '\r');
    const reopened = await waitFor('waiting for Permission tools keyboard expansion', async () => {
      const state = await dashboardState(); return state?.permissionTools?.expanded ? state : null;
    });
    inspect(reopened, true);
    report.permissionTools = { status: 'passed', buttonIds: ids, initialCollapsed: true,
      mouseExpanded: true, keyboardCollapsed: true, keyboardExpanded: true, retainedAcrossActions: 0,
      closedScreenshot, openScreenshot };
  }
  function autoLearnButtons(state) {
    return Object.fromEntries(['alScan', 'alReview', 'alUndo', 'alWhy'].map((id) => [id, state.autoLearn.buttons[id].enabled]));
  }
  async function autoLearnReady(expected) {
    assert.ok(dashboardEnabled, 'Auto Learn webview actions require the dashboard flag');
    assert.deepEqual(Object.keys(expected).sort(), ['alReview', 'alScan', 'alUndo', 'alWhy']);
    for (const value of Object.values(expected)) assert.equal(typeof value, 'boolean');
    const initial = await waitFor('waiting for actual Auto Learn dashboard', dashboardState);
    if (!initial.autoLearn.expanded) await dashboardClick('autoLearn', 'head');
    return waitFor('waiting for actual Auto Learn button states', async () => {
      const state = await dashboardState();
      report.lastAutoLearnState = state?.autoLearn;
      if (!state?.autoLearn.expanded) return null;
      const actual = autoLearnButtons(state);
      return Object.keys(expected).every((id) => actual[id] === expected[id]) ? state : null;
    });
  }
  function ackAutoLearn(value) {
    assert.equal(path.dirname(path.resolve(activeAutoLearn.ackPath)), path.dirname(options.progress),
      'Auto Learn acknowledgment must stay inside the owned fixture directory');
    fs.writeFileSync(activeAutoLearn.ackPath, JSON.stringify({ caseId: activeAutoLearn.caseId, ...value }, null, 2) + '\n');
  }
  async function driveAutoLearn(fixture) {
    activeAutoLearn = fixture;
    const cases = { 'actual-history-scan': 'scan', 'actual-history-rescan': 'scan', 'actual-review-undo': 'undo' };
    assert.ok(Object.hasOwn(cases, fixture.caseId), 'unexpected dashboard Auto Learn case');
    assert.equal(fixture.action, cases[fixture.caseId], 'unexpected dashboard Auto Learn action');
    assert.equal(path.dirname(path.resolve(fixture.ackPath)), path.dirname(options.progress));
    const before = await autoLearnReady(fixture.expectedBeforeButtons);
    if (fixture.action === 'scan') {
      assert.equal(before.autoLearn.badge, 'disabled', 'first Scan and rescan must run with background learning disabled');
      assert.equal(before.autoLearn.buttons.alReview.enabled, false, 'Review must stay disabled during the manual scans');
    }
    const id = fixture.action === 'scan' ? 'alScan' : 'alUndo';
    assert.equal(before.autoLearn.buttons[id].enabled, true, `${id} must be enabled before its actual click`);
    await dashboardClick('autoLearn', id);
    const after = await autoLearnReady(fixture.expectedAfterButtons);
    const evidence = { status: 'passed', clicked: id, buttonsBefore: autoLearnButtons(before), buttonsAfter: autoLearnButtons(after),
      before: before.autoLearn, after: after.autoLearn };
    report.autoLearn.push({ caseId: fixture.caseId, ...evidence });
    ackAutoLearn(evidence);
    activeAutoLearn = null;
  }
  function assertDashboardState(observed, expected, expanded) {
    assert.ok(observed, 'instruction dashboard is not visible');
    for (const control of ['guidance', 'gates']) {
      const state = expected[control];
      assert.ok(['partial', 'on', 'off'].includes(state), 'unexpected dashboard state');
      const badgePatterns = control === 'guidance'
        ? { partial: /^partially installed$/, on: /^on$/, off: /^not installed$/ }
        : { partial: /^\d+ partially installed$/, on: /^\d+ active$/, off: /^\d+ waiting$/ };
      assert.match(observed[control].badge, badgePatterns[state], `${control} collapsed badge disagrees with ${state}`);
      assert.equal(observed[control].expanded, expanded, `${control} row expansion differs from the expected visible state`);
      if (expanded) {
        const label = control === 'guidance' ? 'Shell-style guidance' : 'Memory gates';
        assert.ok(observed[control].status.startsWith(label + ': ' + state.toUpperCase()), `${control} expanded status disagrees with ${state}`);
        assert.equal(observed[control].enabled, true, `${control} action must be enabled`);
        if (state === 'on') assert.equal(observed[control].button, control === 'guidance' ? 'Remove guidance…' : 'Remove gates…');
        else assert.match(observed[control].button, /^Add to claude \+ codex instructions$/i);
      }
    }
  }
  async function dashboardScreenshot(label) {
    await ui();
    const file = path.join(path.dirname(options.report), `dashboard-${label}.png`);
    const screenshot = await client.call('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(screenshot.data, 'base64'));
    return file;
  }
  async function driveDashboard(fixture) {
    activeDashboard = fixture;
    assert.ok(dashboardEnabled, 'dashboard UI actions require ACOLYTE_ACCEPTANCE_DASHBOARD_UI=1');
    assert.equal(path.dirname(path.resolve(fixture.ackPath)), path.dirname(options.progress));
    if (fixture.phase === 'dashboard-saved-permissions') {
      assert.equal(fixture.caseId, 'saved-permissions-mixed');
      assert.equal(fixture.expectedRows.length, 12, 'mixed fixture must exercise the capped preview');
      assert.deepEqual([...new Set(fixture.expectedRows.map((row) => row.agent))].sort(), ['Claude', 'Codex']);
      let before = await waitFor('waiting for the mixed saved permissions preview', async () => {
        const state = await dashboardState('savedPermissionsHead');
        if (!state) return null;
        const actual = state.savedPermissions.rows.map(({ label, agent }) => [agent, label]);
        const expected = fixture.expectedRows.map(({ label, agent }) => [agent, label]);
        return JSON.stringify(actual) === JSON.stringify(expected) ? state : null;
      });
      assert.equal(before.savedPermissions.title, 'Saved permissions');
      assert.equal(before.savedPermissions.count, '17 total');
      if (!before.savedPermissions.expanded) await dashboardClick('savedPermissions', 'head');
      before = await dashboardState('list');
      assert.equal(before.savedPermissions.expanded, true, 'WITNESS combined saved permission rows are visibly expanded');
      for (const row of before.savedPermissions.rows) {
        assert.equal(row.remove, row.agent === 'Claude', 'WITNESS only Claude rows expose immediate removal');
        assert.equal(row.inspect, row.agent === 'Codex', 'WITNESS Codex rows expose rule inspection');
      }
      assert.match(before.savedMore?.text || '', /5 more/);
      assert.match(before.savedMore.text, /17/);
      const listScreenshot = await dashboardScreenshot('saved-permissions-mixed');
      await dashboardClick('savedMore', 'button');
      const title = 'Saved permissions · Claude + Codex';
      const filters = [];
      for (const expected of fixture.pickerFilters) {
        const picker = await exactPicker(title);
        await fillInput(picker, expected.query);
        const matched = await waitFor(`waiting for saved permissions filter ${expected.query}`, async () => {
          const current = await exactPicker(title);
          if (current.inputValue !== expected.query) return null;
          if (JSON.stringify(current.rows.map((row) => row.label).sort()) !== JSON.stringify([...expected.labels].sort())) return null;
          for (const row of current.rows) {
            assert.ok(row.text.includes(expected.agent), 'WITNESS filtered permission row identifies its agent');
            assert.equal(row.checkbox, null, 'saved permissions uses a single-choice inventory');
          }
          return current;
        });
        filters.push({ query: expected.query, rows: matched.rows.map(({ label, text }) => ({ label, text })),
          screenshot: await dashboardScreenshot('saved-permissions-filter-' + expected.agent.toLowerCase()) });
      }
      await key('Escape', 'Escape', 27);
      await waitFor('waiting for the saved permission picker to dismiss without selection', async () => !(await ui()).pickers.length);
      const after = await dashboardState('list');
      assert.deepEqual(after.savedPermissions.rows, before.savedPermissions.rows, 'searching the unified inventory must preserve preview rows');
      const evidence = { status: 'passed', before, after, clicked: 'savedMore', filters,
        screenshots: [listScreenshot, ...filters.map((filter) => filter.screenshot)] };
      report.dashboard.push({ caseId: fixture.caseId, ...evidence });
      ackDashboard(evidence);
      activeDashboard = null;
      return;
    }
    if (fixture.phase === 'dashboard-open') {
      assert.equal(fixture.caseId, 'partial-codex-only');
      assert.deepEqual(fixture.expected, { guidance: 'partial', gates: 'partial' });
      let before = await waitFor('waiting for actual instruction dashboard', dashboardState);
      if (before.autoLearn.expanded) {
        await dashboardClick('autoLearn', 'head');
        before = await waitFor('waiting for Auto Learn row to collapse before instruction screenshots', async () => {
          const state = await dashboardState();
          return state && !state.autoLearn.expanded ? state : null;
        });
      }
      assertDashboardState(before, fixture.expected, false);
      await dashboardState('guidanceCard');
      const collapsedScreenshot = await dashboardScreenshot('partial-collapsed');
      for (const control of ['guidance', 'gates']) {
        await dashboardClick(control, 'head');
        await waitFor(`waiting for ${control} dashboard row to expand`, async () => {
          const observed = await dashboardState();
          return observed?.[control].expanded ? observed : null;
        });
      }
      const after = await dashboardState();
      assertDashboardState(after, fixture.expected, true);
      const expandedScreenshot = await dashboardScreenshot('partial-expanded');
      const evidence = { status: 'passed', before, after, clicked: null, modalDecision: null,
        screenshots: [collapsedScreenshot, expandedScreenshot] };
      report.dashboard.push({ caseId: fixture.caseId, ...evidence });
      ackDashboard(evidence);
      activeDashboard = null;
      return;
    }
    assert.equal(fixture.phase, 'dashboard-action');
    const cases = {
      'guidance-add': ['guidance', 'add'], 'gates-add': ['gates', 'add'],
      'guidance-cancel': ['guidance', 'cancel-remove'], 'guidance-remove': ['guidance', 'remove'],
      'gates-cancel': ['gates', 'cancel-remove'], 'gates-remove': ['gates', 'remove'],
      'guidance-add-from-off': ['guidance', 'add'], 'gates-add-from-off': ['gates', 'add'],
      'guidance-remove-after-off-add': ['guidance', 'remove'], 'gates-remove-after-off-add': ['gates', 'remove'],
    };
    assert.deepEqual([fixture.control, fixture.action], cases[fixture.caseId], 'dashboard action does not match an owned case');
    const before = await dashboardState();
    assertDashboardState(before, fixture.expectedBefore, true);
    if (fixture.action === 'add') assert.match(before[fixture.control].button, /^Add to /);
    else assert.equal(fixture.expectedBefore[fixture.control], 'on');
    await dashboardClick(fixture.control, 'button');
    let modalDecision = null;
    let dialogText = null;
    if (fixture.action !== 'add') {
      const expectedTitle = fixture.control === 'guidance' ? 'Remove shell-style guidance?' : 'Remove memory gates?';
      const dialog = await waitFor(`waiting for ${fixture.caseId} removal modal`, async () => {
        const state = await ui();
        if (!state.dialogs.length) return null;
        assert.equal(state.dialogs.length, 1, 'multiple removal dialogs are ambiguous');
        assert.equal(state.dialogs[0].title, expectedTitle, 'refusing an unrelated removal modal');
        return state.dialogs[0];
      });
      assert.ok(Array.isArray(fixture.expectedDisplayedPaths) && fixture.expectedDisplayedPaths.length === 2);
      for (const expectedPath of fixture.expectedDisplayedPaths) assert.ok(dialog.detail.includes(expectedPath), 'removal modal omitted an instruction target');
      modalDecision = fixture.action === 'cancel-remove' ? 'Cancel' : 'Remove';
      dialogText = dialog.title + '\n' + dialog.detail;
      const choices = dialog.buttons.filter((button) => button.text === modalDecision);
      assert.equal(choices.length, 1, 'expected one exact removal decision button');
      await click(choices[0].point);
      await waitFor(`waiting for ${fixture.caseId} modal dismissal`, async () => !(await ui()).dialogs.length);
    }
    const after = await waitFor(`waiting for ${fixture.caseId} dashboard result`, async () => {
      const observed = await dashboardState();
      report.lastDashboardState = observed;
      try { assertDashboardState(observed, fixture.expectedAfter, true); return observed; }
      catch (error) { report.lastDashboardMismatch = error.message; return null; }
    });
    const screenshots = [];
    if (fixture.expectedAfter.guidance === 'on' && fixture.expectedAfter.gates === 'on' && fixture.action === 'add') {
      screenshots.push(await dashboardScreenshot(fixture.caseId + '-both-on'));
    }
    const evidence = { status: 'passed', before, after, clicked: fixture.control + 'Btn', modalDecision, dialogText, screenshots };
    report.dashboard.push({ caseId: fixture.caseId, ...evidence });
    ackDashboard(evidence);
    activeDashboard = null;
  }
  function ackPrune(value) {
    assert.equal(path.dirname(path.resolve(activePrune.ackPath)), path.dirname(options.progress),
      'Codex inventory acknowledgment must stay inside the owned fixture directory');
    fs.writeFileSync(activePrune.ackPath, JSON.stringify({ caseId: activePrune.caseId, ...value }, null, 2) + '\n');
  }
  async function drivePrune(fixture) {
    activePrune = fixture;
    assert.ok(pruneEnabled, 'Codex inventory UI actions require ACOLYTE_ACCEPTANCE_CODEX_PRUNE=1');
    assert.equal(fixture.phase, 'codex-prune-action');
    const cases = {
      'cancel-allow': { action: 'cancel', decision: 'allow', button: 'Cancel' },
      'remove-allow': { action: 'remove', decision: 'allow', button: 'Remove' },
      'inspect-prompt': { action: 'inspect', decision: 'prompt', button: 'OK' },
      'inspect-forbidden': { action: 'inspect', decision: 'forbidden', button: 'OK' },
      'inspect-unsupported': { action: 'inspect', decision: null, button: 'OK' },
      'finish-interrupted': { action: 'resume', decision: null, button: 'Finish removal' },
    };
    const expected = cases[fixture.caseId];
    assert.ok(expected, 'unexpected Codex inventory case');
    assert.equal(fixture.action, expected.action, 'Codex inventory action must match the owned case');
    assert.equal(fixture.expectedDecision, expected.decision, 'Codex inventory decision must match the owned case');
    const resume = expected.action === 'resume';
    const title = resume ? 'Finish interrupted Codex removal?'
      : expected.decision === 'allow' ? 'Remove this Codex allow rule?' : 'Codex rule (read-only)';
    assert.equal(fixture.expectedDialogTitle, title, 'unexpected Codex inventory modal title');
    assert.equal(path.dirname(path.resolve(fixture.ackPath)), path.dirname(options.progress));
    assert.ok(typeof fixture.expectedDisplayedPath === 'string' && fixture.expectedDisplayedPath.endsWith('.rules'),
      'inventory must identify a displayed rules file');
    let filter;
    let suffix;
    if (resume) {
      assert.equal(fixture.expectedLabel, 'Finish interrupted Codex removal', 'resume must select the exact pending-removal row');
      const name = /^acolyte-inventory-([a-f0-9]{10})\.rules$/.exec(path.basename(fixture.expectedDisplayedPath));
      assert.ok(name, 'resume metadata must identify the isolated inventory file');
      suffix = name[1];
      assert.equal(suffix, report.pruneFixtureSuffix, 'resume must follow the same isolated inventory fixture');
      filter = fixture.expectedLabel;
    } else if (expected.decision) {
      const pattern = JSON.parse(fixture.expectedLabel);
      assert.ok(Array.isArray(pattern) && pattern.length === 1 && typeof pattern[0] === 'string', 'inventory fixture requires one exact prefix token');
      const name = /^acolyte-prune-(?:(prompt|forbidden)-)?([a-f0-9]{10})\.cmd$/.exec(pattern[0]);
      assert.ok(name, 'refusing a rule outside the isolated inventory fixture');
      assert.equal(name[1], expected.decision === 'allow' ? undefined : expected.decision,
        'inventory prefix must belong to the expected decision fixture');
      suffix = name[2];
      assert.equal(path.basename(fixture.expectedDisplayedPath), `acolyte-inventory-${suffix}.rules`,
        'selected rule must come from the isolated inventory file');
      filter = pattern[0];
    } else {
      assert.equal(fixture.expectedLabel, fixture.expectedDisplayedPath, 'unsupported row must name the expected file');
      filter = path.basename(fixture.expectedDisplayedPath);
      const name = /^acolyte-computed-([a-f0-9]{10})\.rules$/.exec(filter);
      assert.ok(name, 'unsupported file must belong to the isolated inventory fixture');
      suffix = name[1];
    }
    report.pruneFixtureSuffix ||= suffix;
    assert.equal(suffix, report.pruneFixtureSuffix, 'inventory actions must stay within one isolated fixture');
    assert.ok(Array.isArray(fixture.expectedDescription) && fixture.expectedDescription.length > 0 &&
      fixture.expectedDescription.every((text) => typeof text === 'string' && text.length), 'row description assertions are required');
    assert.ok(Array.isArray(fixture.expectedDetailIncludes) && fixture.expectedDetailIncludes.length > 0 &&
      fixture.expectedDetailIncludes.every((text) => typeof text === 'string' && text.length), 'modal detail assertions are required');
    const dashboard = await waitFor('waiting for actual Codex inventory dashboard button', async () => {
      const state = await dashboardState();
      return state?.permissionsView ? state : null;
    });
    assert.equal(dashboard.permissionsView.text, 'View / remove permissions…', 'unexpected shared inventory button label');
    assert.equal(dashboard.permissionsView.enabled, true, 'shared inventory button must be enabled');
    await dashboardClick('codexRules', 'button');
    const picker = await exactPicker('Saved permissions · Claude + Codex');
    await fillInput(picker, filter);
    const selected = await waitFor(`waiting for exact Codex inventory row ${fixture.caseId}`, async () => {
      const current = await exactPicker('Saved permissions · Claude + Codex');
      const rows = current.rows.filter((row) => row.label === fixture.expectedLabel);
      assert.ok(rows.length <= 1, 'multiple exact Codex inventory rows are ambiguous');
      if (!rows.length) return null;
      const row = rows[0];
      assert.equal(row.checkbox, null, 'Codex inventory must be a single-choice picker');
      assert.ok(row.text.includes('Codex'), 'selected row must identify Codex');
      for (const text of fixture.expectedDescription) assert.ok(row.text.includes(text), `inventory row omitted ${text}`);
      if (resume) assert.ok(row.text.includes('removal needs attention'), 'resume row must identify a pending removal');
      else assert.ok(row.text.includes(fixture.expectedDisplayedPath), 'selected inventory row omitted its rules path');
      return row;
    });
    report.observations.push({ phase: 'codex-inventory-row-selected', caseId: fixture.caseId,
      title: picker.title, label: selected.label, text: selected.text });
    await click(selected.point);
    const dialog = await waitFor(`waiting for actual ${fixture.caseId} modal`, async () => {
      const state = await ui();
      if (!state.dialogs.length) return null;
      assert.equal(state.dialogs.length, 1, 'multiple Codex inventory modals are ambiguous');
      const current = state.dialogs[0];
      assert.equal(current.title, title, 'refusing an unrelated Codex inventory modal');
      if (resume) assert.ok(current.detail.includes('This finishes the previously confirmed removal'),
        'resume modal must describe the existing authorized transaction');
      else assert.ok(current.detail.includes(fixture.expectedDisplayedPath), 'inventory modal omitted its rules path');
      if (expected.decision) {
        assert.ok(current.detail.includes(`Codex prefix: ${fixture.expectedLabel}`), 'inventory modal omitted the selected prefix');
        assert.ok(current.detail.includes(`Decision: ${expected.decision}`), 'inventory modal decision differs from the selected rule');
      }
      for (const text of fixture.expectedDetailIncludes) assert.ok(current.detail.includes(text), `inventory modal omitted ${text}`);
      return current;
    });
    if (expected.action === 'inspect') assert.equal(dialog.buttons.filter((button) => button.text === 'Remove').length, 0,
      'read-only inventory entries must not expose Remove');
    const choices = dialog.buttons.filter((button) => button.text === expected.button);
    assert.equal(choices.length, 1, 'expected one exact Codex inventory dialog decision button');
    const screenshot = await dashboardScreenshot('codex-prune-' + fixture.caseId);
    const evidence = { status: 'passed', clicked: 'codexRules', selectedLabel: selected.label,
      selectedText: selected.text, dialogText: dialog.title + '\n' + dialog.detail,
      modalDecision: expected.button, screenshot };
    await click(choices[0].point);
    await waitFor(`waiting for ${fixture.caseId} inventory modal dismissal`, async () => {
      const state = await ui();
      return state.dialogs.length === 0 && state.pickers.length === 0;
    });
    report.codexPrune.push({ caseId: fixture.caseId, ...evidence });
    ackPrune(evidence);
    activePrune = null;
  }
  function ackRestore(value) {
    assert.equal(path.dirname(path.resolve(activeRestore.ackPath)), path.dirname(options.progress),
      'Codex restore acknowledgment must stay inside the owned fixture directory');
    fs.writeFileSync(activeRestore.ackPath, JSON.stringify({ caseId: activeRestore.caseId, ...value }, null, 2) + '\n');
  }
  async function driveRestore(fixture) {
    activeRestore = fixture;
    assert.ok(restoreEnabled, 'Codex restore UI requires ACOLYTE_ACCEPTANCE_CODEX_RESTORE=1');
    assert.equal(fixture.phase, 'codex-restore-action');
    const cases = {
      'cancel-missing': { button: 'Cancel', variant: '', title: 'Restore this Codex rule?' },
      'restore-missing': { button: 'Restore', variant: '', title: 'Restore this Codex rule?' },
      'inspect-excluded': { button: 'OK', variant: '-excluded', title: 'Excluded by an intentional removal' },
      'finish-interrupted': { button: 'Finish restore', variant: '-resume', title: 'Finish interrupted Codex restore?' },
    };
    const expected = cases[fixture.caseId];
    assert.ok(expected, 'unexpected Codex restore case');
    assert.equal(fixture.expectedDialogTitle, expected.title, 'restore modal must match the owned case');
    assert.equal(path.dirname(path.resolve(fixture.ackPath)), path.dirname(options.progress));
    assert.ok(typeof fixture.expectedPath === 'string' && path.isAbsolute(fixture.expectedPath), 'restore must name an absolute file');
    const relativePath = path.relative(path.dirname(options.progress), fixture.expectedPath);
    assert.ok(relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath),
      'restore target must remain inside the launcher-owned fixture');
    const name = /^acolyte-restore-([a-f0-9]{10})\.rules$/.exec(path.basename(fixture.expectedPath));
    assert.ok(name, 'restore file must belong to the isolated fixture');
    report.restoreFixtureSuffix ||= name[1];
    assert.equal(name[1], report.restoreFixtureSuffix, 'restore actions must use the same isolated file');
    const resume = fixture.caseId === 'finish-interrupted';
    let filter;
    if (resume) assert.equal(fixture.expectedLabel, null, 'restore recovery has a direct modal, not a rule picker');
    else {
      const pattern = JSON.parse(fixture.expectedLabel);
      assert.deepEqual(pattern, [`acolyte-restore${expected.variant}-${name[1]}.cmd`],
        'restore prefix must match this case and its isolated file');
      filter = pattern[0];
      assert.ok(Array.isArray(fixture.expectedDescription) && fixture.expectedDescription.length > 0 &&
        fixture.expectedDescription.every((text) => typeof text === 'string' && text.length), 'restore row assertions are required');
    }
    assert.ok(Array.isArray(fixture.expectedDetailIncludes) && fixture.expectedDetailIncludes.length > 0 &&
      fixture.expectedDetailIncludes.every((text) => typeof text === 'string' && text.length), 'restore detail assertions are required');
    const dashboard = await waitFor('waiting for actual Codex restore dashboard button', async () => {
      const state = await dashboardState();
      return state?.permissionsRestore ? state : null;
    });
    assert.equal(dashboard.permissionsRestore.text, 'Restore permissions…');
    assert.equal(dashboard.permissionsRestore.enabled, true);
    await dashboardClick('codexRestore', 'button');
    let selected = null;
    if (!resume) {
      const picker = await exactPicker('Restore Codex rules');
      await fillInput(picker, filter);
      selected = await waitFor(`waiting for exact Codex restore row ${fixture.caseId}`, async () => {
        const current = await exactPicker('Restore Codex rules');
        const rows = current.rows.filter((row) => row.label === fixture.expectedLabel);
        assert.ok(rows.length <= 1, 'multiple exact restore rows are ambiguous');
        if (!rows.length) return null;
        const row = rows[0];
        assert.equal(row.checkbox, null, 'restore must be a single-choice picker');
        assert.ok(row.text.includes(fixture.expectedPath), 'restore row must identify its original file');
        for (const text of fixture.expectedDescription) assert.ok(row.text.includes(text), `restore row omitted ${text}`);
        if (fixture.caseId === 'inspect-excluded') assert.ok(row.text.includes('Excluded by an intentional removal'));
        else assert.ok(row.text.includes('Codex · allow · missing rule'));
        return row;
      });
      report.observations.push({ phase: 'codex-restore-row-selected', caseId: fixture.caseId,
        title: picker.title, label: selected.label, text: selected.text });
      await click(selected.point);
    }
    const dialog = await waitFor(`waiting for actual ${fixture.caseId} restore modal`, async () => {
      const state = await ui();
      if (!state.dialogs.length) return null;
      assert.equal(state.dialogs.length, 1, 'multiple Codex restore modals are ambiguous');
      const current = state.dialogs[0];
      assert.equal(current.title, expected.title, 'refusing an unrelated restore modal');
      if (resume) {
        assert.ok(current.detail.includes('Finish the restore you already confirmed.'), 'resume must refer to the saved authorized transaction');
      } else {
        assert.ok(current.detail.includes(fixture.expectedPath), 'restore modal omitted the original file');
        if (fixture.caseId !== 'inspect-excluded') {
          assert.ok(current.detail.includes(`Prefix: ${fixture.expectedLabel}`), 'restore modal omitted its exact prefix');
          assert.ok(current.detail.includes('Decision: allow'), 'restore modal must identify the expected decision');
        }
      }
      for (const text of fixture.expectedDetailIncludes) assert.ok(current.detail.includes(text), `restore modal omitted ${text}`);
      return current;
    });
    if (fixture.caseId === 'inspect-excluded') assert.equal(dialog.buttons.filter((button) => button.text === 'Restore').length, 0,
      'a removal-suppressed prefix must not offer Restore');
    const choices = dialog.buttons.filter((button) => button.text === expected.button);
    assert.equal(choices.length, 1, 'expected one exact Codex restore decision button');
    const screenshot = await dashboardScreenshot('codex-restore-' + fixture.caseId);
    const evidence = { status: 'passed', clicked: 'codexRestore', selectedLabel: selected?.label || null,
      selectedText: selected?.text || null, dialogText: dialog.title + '\n' + dialog.detail,
      modalDecision: expected.button, screenshot };
    await click(choices[0].point);
    await waitFor(`waiting for ${fixture.caseId} restore modal dismissal`, async () => {
      const state = await ui();
      return state.dialogs.length === 0 && state.pickers.length === 0;
    });
    report.codexRestore.push({ caseId: fixture.caseId, ...evidence });
    ackRestore(evidence);
    activeRestore = null;
  }
  function ackDerived(value) {
    assert.equal(path.dirname(path.resolve(activeDerived.ackPath)), path.dirname(options.progress),
      'Codex guidance acknowledgment must stay inside the owned fixture directory');
    fs.writeFileSync(activeDerived.ackPath, JSON.stringify({ caseId: activeDerived.caseId, ...value }, null, 2) + '\n');
  }
  async function driveDerived(fixture) {
    activeDerived = fixture;
    assert.ok(derivedEnabled, 'Codex derived UI requires ACOLYTE_ACCEPTANCE_CODEX_DERIVED=1');
    assert.equal(fixture.phase, 'codex-derived-action');
    const cases = { 'accept-derived': { action: 'accept', button: 'Accept', state: 'not yet decided' },
      'decline-derived': { action: 'decline', button: 'Decline', state: 'installed' } };
    const expected = cases[fixture.caseId];
    assert.ok(expected, 'unexpected Codex derived-guidance case');
    assert.equal(fixture.action, expected.action);
    assert.equal(fixture.expectedLabel, 'Reuse unchanged repository query results in Codex');
    assert.equal(path.dirname(path.resolve(fixture.ackPath)), path.dirname(options.progress));
    assert.deepEqual(fixture.expectedDescription, ['Codex', '50 observed runs', expected.state], 'guidance must identify the measured fixture state');
    assert.ok(Array.isArray(fixture.expectedDetailIncludes) && fixture.expectedDetailIncludes.length > 0 &&
      fixture.expectedDetailIncludes.every((text) => typeof text === 'string' && text.length), 'guidance body assertions are required');
    const picker = await waitFor('waiting for the actual Derived guidance picker', async () => {
      const state = await ui();
      assert.equal(state.dialogs.length, 0, 'unexpected modal before derived-guidance selection');
      if (!state.pickers.length) return null;
      assert.equal(state.pickers.length, 1, 'multiple derived-guidance pickers are ambiguous');
      assert.match(state.pickers[0].title, /^Derived guidance\b/, 'refusing an unrelated guidance picker');
      return state.pickers[0];
    });
    await fillInput(picker, fixture.expectedLabel);
    const selected = await waitFor(`waiting for exact ${fixture.caseId} guidance row`, async () => {
      const current = await exactPicker(picker.title);
      const rows = current.rows.filter((row) => row.label === fixture.expectedLabel);
      assert.ok(rows.length <= 1, 'multiple exact guidance rows are ambiguous');
      if (!rows.length) return null;
      const row = rows[0];
      assert.equal(row.checkbox, null, 'derived guidance must be a single-choice picker');
      for (const text of fixture.expectedDescription) assert.ok(row.text.includes(text), `guidance row omitted ${text}`);
      for (const text of fixture.expectedDetailIncludes) assert.ok(row.text.includes(text), `guidance row omitted ${text}`);
      assert.ok(row.text.includes('this is not a count of historical approval prompts'), 'observed runs must not be described as measured prompts');
      return row;
    });
    const rowScreenshot = await dashboardScreenshot('codex-derived-' + fixture.caseId + '-advice');
    report.observations.push({ phase: 'codex-derived-row-selected', caseId: fixture.caseId,
      title: picker.title, label: selected.label, text: selected.text });
    await click(selected.point);
    const dialog = await waitFor(`waiting for actual ${expected.button} guidance review modal`, async () => {
      const state = await ui();
      if (!state.dialogs.length) return null;
      assert.equal(state.dialogs.length, 1, 'multiple guidance review modals are ambiguous');
      const current = state.dialogs[0];
      assert.equal(current.title, fixture.expectedLabel, 'refusing an unrelated guidance review modal');
      for (const text of fixture.expectedDetailIncludes) assert.ok(current.detail.includes(text), `visible guidance review omitted ${text}`);
      assert.ok(current.detail.includes('this is not a count of historical approval prompts'),
        'visible guidance review must distinguish observed runs from prompts');
      assert.ok(current.detail.includes(`Currently ${expected.state}`), 'guidance modal must show the current decision state');
      assert.deepEqual(current.buttons.map((button) => button.text).filter(Boolean).sort(), ['Accept', 'Cancel', 'Decline', 'Reset'],
        'guidance review must expose all explicit decisions and Cancel');
      return current;
    });
    const screenshot = await dashboardScreenshot('codex-derived-' + fixture.caseId + '-decision');
    const choices = dialog.buttons.filter((button) => button.text === expected.button);
    assert.equal(choices.length, 1, 'expected one exact guidance decision button');
    await click(choices[0].point);
    await waitFor(`waiting for ${fixture.caseId} decision dismissal`, async () => {
      const state = await ui();
      return state.dialogs.length === 0 && state.pickers.length === 0;
    });
    const evidence = { status: 'passed', selectedLabel: selected.label, selectedText: selected.text,
      decision: expected.button, dialogText: dialog.title + '\n' + dialog.detail, screenshot, rowScreenshot };
    report.codexDerived.push({ caseId: fixture.caseId, ...evidence });
    ackDerived(evidence);
    activeDerived = null;
  }
  function ackFeature(value) {
    assert.equal(path.dirname(path.resolve(activeFeature.ackPath)), path.dirname(options.progress),
      'feature acknowledgment must stay inside the owned fixture');
    fs.writeFileSync(activeFeature.ackPath, JSON.stringify({ caseId: activeFeature.caseId, ...value }, null, 2) + '\n');
  }
  async function memoryDashboardReady() {
    const initial = await waitFor('waiting for native Codex memory dashboard', async () => {
      const state = await dashboardState();
      return state?.codexMemory?.visible ? state : null;
    });
    if (!initial.codexMemory.expanded) await dashboardClick('codexMemory', 'head');
    return waitFor('waiting for expanded native Codex memory dashboard', async () => {
      const state = await dashboardState();
      return state?.codexMemory?.expanded ? state : null;
    });
  }
  async function driveFeature(fixture) {
    activeFeature = fixture;
    assert.ok(featuresOnly, 'feature actions require explicit focused UI mode');
    assert.equal(fixture.phase, 'codex-feature-action');
    assert.equal(path.dirname(path.resolve(fixture.ackPath)), path.dirname(options.progress));
    const cases = {
      'hook-cancel': { kind: 'hook', decision: 'Cancel', title: 'Learn from Codex turns while the editor is closed?' },
      'hook-configure': { kind: 'hook', decision: 'Configure hook', title: 'Learn from Codex turns while the editor is closed?' },
      'hook-remove': { kind: 'hook', decision: 'Remove hook', title: 'Remove Codex after-turn learning?' },
      'memory-empty': { kind: 'memory-status' }, 'memory-search': { kind: 'search' }, 'memory-inspect': { kind: 'inspect' },
      'memory-search-bom-first': { kind: 'search' }, 'memory-search-bom-later': { kind: 'search' },
    };
    const expected = cases[fixture.caseId];
    assert.ok(expected, 'unexpected native Codex feature case');
    assert.equal(fixture.kind, expected.kind);
    const target = fixture.expectedPath || fixture.expectedRoot;
    assert.ok(typeof target === 'string' && path.isAbsolute(target), 'feature must name its absolute fixture target');
    const relative = path.relative(path.dirname(options.progress), target);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'feature target must stay inside launcher fixture');
    assert.ok(Array.isArray(fixture.expectedDetailIncludes) && fixture.expectedDetailIncludes.length > 0 &&
      fixture.expectedDetailIncludes.every((text) => typeof text === 'string' && text.length), 'feature requires concrete visible detail checks');
    let evidence;
    if (fixture.kind === 'hook') {
      assert.equal(path.basename(target), 'hooks.json');
      assert.equal(fixture.expectedTitle, expected.title);
      assert.equal(fixture.expectedDecision, expected.decision);
      assert.ok(typeof fixture.expectedCommand === 'string' && fixture.expectedCommand.includes('codex-stop-hook'), 'hook must name the actual Acolyte after-turn entry');
      const dashboard = await waitFor('waiting for actual hook configuration button', async () => {
        const state = await dashboardState(); return state?.codexHook ? state : null;
      });
      assert.equal(dashboard.codexHook.text, 'Configure Codex after-turn learning…');
      assert.equal(dashboard.codexHook.enabled, true);
      await dashboardClick('codexHook', 'button');
      const dialog = await waitFor(`waiting for actual ${fixture.caseId} modal`, async () => {
        const state = await ui();
        if (!state.dialogs.length) return null;
        assert.equal(state.dialogs.length, 1, 'multiple hook modals are ambiguous');
        const current = state.dialogs[0];
        assert.equal(current.title, expected.title, 'refusing unrelated hook modal');
        assert.ok(current.detail.includes(target), 'hook review omitted selected profile path');
        assert.ok(current.detail.includes(fixture.expectedCommand), 'hook review omitted exact executable command');
        for (const text of fixture.expectedDetailIncludes) assert.ok(current.detail.includes(text), `hook review omitted ${text}`);
        const action = fixture.caseId === 'hook-remove' ? 'Remove hook' : 'Configure hook';
        assert.deepEqual(current.buttons.map((button) => button.text).filter(Boolean).sort(), ['Cancel', action].sort());
        return current;
      });
      const choices = dialog.buttons.filter((button) => button.text === expected.decision);
      assert.equal(choices.length, 1);
      const screenshot = await dashboardScreenshot('codex-feature-' + fixture.caseId);
      evidence = { status: 'passed', clicked: 'codexHook', modalDecision: expected.decision,
        dialogText: dialog.title + '\n' + dialog.detail, screenshot };
      await click(choices[0].point);
      await waitFor('waiting for hook modal dismissal', async () => { const state = await ui(); return !state.dialogs.length && !state.pickers.length; });
    } else {
      const dashboard = await memoryDashboardReady();
      assert.equal(path.basename(fixture.kind === 'search' ? path.dirname(target) : target), 'memories');
      if (fixture.kind === 'memory-status') {
        assert.equal(dashboard.codexMemory.root, fixture.expectedRoot, 'memory card must name the selected home');
        for (const text of fixture.expectedBadgeIncludes) assert.ok(dashboard.codexMemory.badge.includes(text), `memory badge omitted ${text}`);
        for (const text of fixture.expectedDetailIncludes) assert.ok(dashboard.codexMemory.status.includes(text), `memory status omitted ${text}`);
        evidence = { status: 'passed', clicked: null, memory: dashboard.codexMemory,
          screenshot: await dashboardScreenshot('codex-feature-memory-empty') };
      } else if (fixture.kind === 'search') {
        assert.equal(path.basename(target), 'MEMORY.md');
        const searches = {
          'memory-search': { query: 'nebulaprism', label: 'Task: Acolyte native fixture', line: 1 },
          'memory-search-bom-first': { query: 'bomfirst', label: 'Task: Acolyte BOM first', line: 1 },
          'memory-search-bom-later': { query: 'bomlater', label: 'Task: Acolyte BOM later', line: 5 },
        };
        const search = searches[fixture.caseId];
        const suffix = new RegExp('^' + search.query + '([a-f0-9]{10})$').exec(fixture.query);
        assert.ok(suffix, 'query must belong to the isolated native memory fixture');
        report.memoryFixtureSuffix ||= suffix[1];
        assert.equal(suffix[1], report.memoryFixtureSuffix, 'native memory searches must stay in the same fixture');
        assert.equal(fixture.expectedLabel, `${search.label} ${suffix[1]}`);
        assert.equal(fixture.expectedDescription, `MEMORY.md:${search.line}`);
        assert.equal(dashboard.searchCodexMemory.text, 'Search native memory…');
        await dashboardClick('searchCodexMemory', 'button');
        const input = await exactPicker('AI Acolyte: Search Codex memory');
        await fillInput(input, fixture.query);
        await key('Enter', 'Enter', 13);
        const picker = await exactPicker('AI Acolyte: Codex memory matches', ['AI Acolyte: Search Codex memory']);
        const selected = await waitFor('waiting for exact native registry passage', async () => {
          const current = await exactPicker(picker.title);
          const rows = current.rows.filter((row) => row.label === fixture.expectedLabel);
          assert.ok(rows.length <= 1, 'multiple exact native memory rows are ambiguous');
          if (!rows.length) return null;
          assert.equal(rows[0].checkbox, null, 'memory search must use single passage selection');
          assert.ok(rows[0].text.includes(fixture.expectedDescription));
          for (const text of fixture.expectedDetailIncludes) assert.ok(rows[0].text.includes(text), `memory result omitted ${text}`);
          return rows[0];
        });
        const pickerScreenshot = await dashboardScreenshot('codex-feature-' + fixture.caseId + '-result');
        await click(selected.point);
        await waitFor('waiting for selected registry passage editor', async () => {
          const state = await ui();
          return !state.pickers.length && !state.dialogs.length &&
            state.editors.some((text) => fixture.expectedDetailIncludes.every((clause) => text.includes(clause)));
        });
        evidence = { status: 'passed', clicked: 'searchCodexMemory', selectedLabel: selected.label,
          selectedText: selected.text, pickerScreenshot, screenshot: await dashboardScreenshot('codex-feature-' + fixture.caseId + '-editor') };
      } else {
        assert.equal(dashboard.inspectCodexMemory.text, 'Inspect memory sources…');
        await dashboardClick('inspectCodexMemory', 'button');
        const text = await waitFor('waiting for actual native memory inspection document', async () => {
          const state = await ui();
          return state.editors.find((body) => body.includes('Codex native memory') && fixture.expectedDetailIncludes.every((clause) => body.includes(clause))) || null;
        });
        evidence = { status: 'passed', clicked: 'inspectCodexMemory', visibleDocumentText: text,
          screenshot: await dashboardScreenshot('codex-feature-memory-inspection') };
      }
    }
    report.codexFeatures.push({ caseId: fixture.caseId, ...evidence });
    ackFeature(evidence); activeFeature = null;
  }
  function ackRecall(value) {
    assert.equal(path.dirname(path.resolve(activeRecall.ackPath)), path.dirname(options.progress));
    fs.writeFileSync(activeRecall.ackPath, JSON.stringify({ caseId: activeRecall.caseId, ...value }, null, 2) + '\n');
  }
  async function driveRecall(fixture) {
    activeRecall = fixture;
    assert.equal(recallOnly, true); assert.equal(fixture.phase, 'codex-recall-action');
    assert.equal(path.dirname(path.resolve(fixture.ackPath)), path.dirname(options.progress));
    const cases = {
      'search-registry': ['software development enjoyment', 'Task: Languages', 'MEMORY.md'],
      'search-rollout': ['vehicle motor breakdown from missing lubrication', 'Mechanical repair', 'rollout_summaries/vehicle.md'],
      'search-skill': ['offline access cached files', 'Disk retrieval', 'skills/snapshot/SKILL.md'],
      'search-fallback': ['code', 'Task: Languages', 'MEMORY.md'],
    };
    const dashboard = await memoryDashboardReady();
    let evidence;
    if (fixture.caseId === 'rebuild') {
      assert.equal(fixture.kind, 'rebuild'); assert.equal(fixture.expectedCount, 4);
      assert.equal(fixture.expectedNotification, 'AI Acolyte: indexed 4 Codex memory passages for search by meaning and keywords.');
      assert.equal(dashboard.rebuildCodexMemory.text, 'Rebuild Codex recall index…');
      assert.equal(dashboard.rebuildCodexMemory.enabled, true);
      assert.equal((await ui()).notifications.some((text) => text.includes(fixture.expectedNotification)), false,
        'rebuild must not inherit an old success notification');
      await dashboardClick('rebuildCodexMemory', 'button');
      const notification = await waitFor('waiting for actual CPU rebuild notification', async () =>
        (await ui()).notifications.find((text) => text.includes(fixture.expectedNotification)) || null);
      evidence = { status: 'passed', clicked: 'rebuildCodexMemory', notification,
        screenshot: await dashboardScreenshot('codex-recall-rebuild') };
    } else {
      const expected = cases[fixture.caseId]; assert.ok(expected, 'unknown semantic fixture action');
      assert.equal(fixture.kind, 'search'); assert.equal(fixture.query, expected[0]);
      assert.equal(fixture.expectedLabel, expected[1]); assert.equal(fixture.expectedDescription, expected[2] + ':1');
      const relative = path.relative(path.dirname(options.progress), fixture.expectedPath);
      assert.ok(path.isAbsolute(fixture.expectedPath) && relative && !relative.startsWith('..') && !path.isAbsolute(relative));
      assert.ok(fixture.expectedPath.replace(/\\/g, '/').endsWith('/memories/' + expected[2]));
      assert.equal(fixture.mode, fixture.caseId === 'search-fallback' ? 'lexical' : 'hybrid');
      assert.ok(typeof fixture.expectedText === 'string' && fixture.expectedText.startsWith('# ' + expected[1] + '\n'));
      assert.equal(dashboard.searchCodexMemory.text, 'Search native memory…');
      await dashboardClick('searchCodexMemory', 'button');
      const input = await exactPicker('AI Acolyte: Search Codex memory');
      await fillInput(input, fixture.query); await key('Enter', 'Enter', 13);
      const title = 'AI Acolyte: Codex memory matches' + (fixture.mode === 'hybrid' ? ' by meaning and keywords' : '');
      const picker = await waitFor('waiting for actual semantic search results', async () => {
        const state = await ui();
        assert.equal(state.dialogs.length, 0);
        if (!state.pickers.length || state.pickers[0].title === input.title) {
          const noMatches = state.notifications.find((text) => text.includes('No matching Codex memory passages.'));
          assert.equal(noMatches, undefined, 'WITNESS semantic zero-keyword search must produce a ranked passage');
          return null;
        }
        assert.equal(state.pickers.length, 1);
        assert.equal(state.pickers[0].title, title, 'WITNESS semantic search must report the actual retrieval mode');
        return state.pickers[0].rows.length ? state.pickers[0] : null;
      });
      const selected = picker.rows[0];
      assert.equal(selected.label, fixture.expectedLabel, 'WITNESS semantic paraphrase must rank the intended native passage first');
      assert.ok(selected.text.includes(fixture.expectedDescription));
      assert.equal(selected.checkbox, null);
      // QuickPick renders source newlines as visible return glyphs.
      assert.ok(selected.text.replace(/⏎/g, ' ').replace(/\s+/g, ' ').includes(fixture.expectedText.trim().replace(/\s+/g, ' ')));
      let warning;
      if (fixture.mode === 'lexical') {
        assert.equal(fixture.expectedWarning, 'AI Acolyte: Codex memory search is using keyword matches. The existing bge-small CPU model and vocabulary are unavailable. No download was attempted.');
        const warningDeadline = Date.now() + 15000;
        warning = await waitFor('waiting for explicit unavailable-model keyword warning', async () => {
          assert.ok(Date.now() < warningDeadline, 'WITNESS keyword fallback must visibly explain unavailable semantic assets');
          return (await ui()).notifications.find((text) => text.includes(fixture.expectedWarning)) || null;
        });
      }
      const pickerScreenshot = await dashboardScreenshot('codex-recall-' + fixture.caseId + '-result');
      await click(selected.point);
      await waitFor('waiting for actual selected native passage editor', async () => {
        const state = await ui();
        return !state.pickers.length && !state.dialogs.length && state.editors.some((text) =>
          text.replace(/\s+/g, ' ').includes(fixture.expectedText.trim().split('\n').at(-1)));
      });
      evidence = { status: 'passed', clicked: 'searchCodexMemory', mode: fixture.mode,
        selectedIndex: 0, selectedLabel: selected.label, selectedText: selected.text, pickerTitle: title,
        warning: warning || null, pickerScreenshot, screenshot: await dashboardScreenshot('codex-recall-' + fixture.caseId + '-editor') };
    }
    report.codexRecall.push({ caseId: fixture.caseId, ...evidence });
    ackRecall(evidence); activeRecall = null;
  }
  function ackNativeGates(value) {
    assert.equal(path.dirname(path.resolve(activeNativeGates.ackPath)), path.dirname(options.progress));
    fs.writeFileSync(activeNativeGates.ackPath, JSON.stringify({ caseId: activeNativeGates.caseId, ...value }, null, 2) + '\n');
  }
  async function driveNativeGates(fixture) {
    activeNativeGates = fixture;
    assert.equal(nativeGatesOnly, true); assert.equal(fixture.phase, 'codex-native-gates-action');
    assert.equal(path.dirname(path.resolve(fixture.ackPath)), path.dirname(options.progress));
    const statusCases = ['status-updated', 'status-zero', 'status-refilled', 'status-base', 'status-override',
      'held-scope', 'held-scope-repaired', 'held-marker', 'held-marker-repaired', 'held-utf8', 'status-off'];
    const decisions = { 'cancel-install': 'Cancel', install: 'Install gates', 'remove-unreadable': 'Remove gates', 'stale-install': 'Install gates' };
    let evidence;
    if (fixture.kind === 'status') {
      assert.ok(statusCases.includes(fixture.caseId));
      const expected = fixture.caseId === 'status-off' ? 'Native memory gates are off. Only explicitly marked global sections can be installed.'
        : ['held-scope', 'held-marker', 'held-utf8'].includes(fixture.caseId) ? 'Installed native Codex gates were retained: the source compilation is unreadable.'
          : `Native memory gates: ${fixture.caseId === 'status-zero' ? 0 : 1} sections; current.`;
      assert.equal(fixture.expectedStatus, expected);
      await memoryDashboardReady();
      const until = Date.now() + 15000;
      const state = await waitFor('waiting for actual native gate state ' + fixture.caseId, async () => {
        assert.ok(Date.now() < until, 'WITNESS actual native gate dashboard reports ' + fixture.caseId);
        const current = await dashboardState();
        return current?.codexMemory.nativeGateStatus === expected ? current : null;
      });
      assert.equal(state.codexMemoryGates.enabled, true);
      evidence = { status: 'passed', clicked: null, nativeGateStatus: state.codexMemory.nativeGateStatus,
        screenshot: await dashboardScreenshot('native-gates-' + fixture.caseId) };
    } else if (fixture.kind === 'mcp-readonly') {
      assert.equal(fixture.caseId, 'mcp-readonly');
      assert.match(fixture.expectedLabel, /^FixtureCase_[a-f0-9]{10} \/ ProbeCase$/);
      assert.equal(fixture.expectedReason, 'Config changed after this approval; restoration requires manual review');
      const relative = path.relative(path.dirname(options.progress), fixture.expectedPath);
      assert.ok(path.isAbsolute(fixture.expectedPath) && relative && !relative.startsWith('..') && !path.isAbsolute(relative));
      assert.equal(path.basename(fixture.expectedPath), 'config.toml');
      await dashboardClick('reviewCodexMcp', 'button');
      const until = Date.now() + 15000;
      const picker = await waitFor('waiting for saved read-only MCP approval', async () => {
        const state = await ui(); assert.equal(state.dialogs.length, 0);
        assert.ok(Date.now() < until, 'WITNESS saved MCP receipt remains visible after config changes');
        if (!state.pickers.length) return null;
        assert.equal(state.pickers.length, 1); assert.equal(state.pickers[0].title, 'Review Codex MCP approvals');
        return state.pickers[0].rows.length ? state.pickers[0] : null;
      });
      const rows = picker.rows.filter((row) => row.label === fixture.expectedLabel);
      assert.equal(rows.length, 1); const selected = rows[0];
      assert.ok(selected.text.includes('Saved approval needs review'));
      assert.ok(selected.text.includes(fixture.expectedReason));
      const pickerScreenshot = await dashboardScreenshot('native-gates-mcp-readonly-picker');
      await click(selected.point);
      const warning = await waitFor('waiting for changed MCP receipt reason', async () => {
        const state = await ui(); assert.equal(state.dialogs.length, 0, 'read-only MCP receipt must not open a writer confirmation');
        return !state.pickers.length && state.notifications.find((text) => text.includes('AI Acolyte: ' + fixture.expectedReason));
      });
      evidence = { status: 'passed', clicked: 'reviewCodexMcp', selectedLabel: selected.label, selectedText: selected.text,
        warning, pickerScreenshot, screenshot: await dashboardScreenshot('native-gates-mcp-readonly-warning') };
    } else {
      assert.equal(fixture.kind, 'review'); assert.ok(decisions[fixture.caseId]);
      assert.equal(fixture.expectedDecision, decisions[fixture.caseId]);
      assert.equal(fixture.expectedOn, fixture.caseId === 'remove-unreadable');
      assert.equal(fixture.expectedComplete, fixture.caseId !== 'remove-unreadable');
      const relative = path.relative(path.dirname(options.progress), fixture.expectedPath);
      assert.ok(path.isAbsolute(fixture.expectedPath) && relative && !relative.startsWith('..') && !path.isAbsolute(relative));
      assert.equal(path.basename(fixture.expectedPath), ['cancel-install', 'install'].includes(fixture.caseId) ? 'AGENTS.md' : 'AGENTS.override.md');
      const dashboard = await memoryDashboardReady();
      assert.equal(dashboard.codexMemoryGates.text, 'Review native memory gates…'); assert.equal(dashboard.codexMemoryGates.enabled, true);
      await dashboardClick('codexMemoryGates', 'button');
      const title = fixture.expectedOn ? 'Review native Codex memory gates' : 'Install native Codex memory gates?';
      const dialog = await waitFor('waiting for full native gate review modal', async () => {
        const state = await ui(); if (!state.dialogs.length) return null;
        assert.equal(state.dialogs.length, 1); const current = state.dialogs[0]; assert.equal(current.title, title);
        assert.ok(current.detail.includes(fixture.expectedPath));
        if (fixture.expectedComplete) assert.ok(fixture.expectedBody && current.detail.includes(fixture.expectedBody), 'WITNESS native gate modal shows the complete compiled body');
        else assert.ok(current.detail.includes('Current sources are unreadable. The installed instructions have been retained; they can still be removed.'));
        for (const clause of ['Only explicitly marked global sections are compiled.',
          'edits to those annotations automatically update this installed block.', 'Remove stops automatic updates.',
          'Native source files and other instruction blocks are preserved.', 'Start a new Codex session to load instruction changes.']) assert.ok(current.detail.includes(clause));
        assert.deepEqual(current.buttons.map((button) => button.text).filter(Boolean).sort(),
          ['Cancel', fixture.expectedOn ? 'Remove gates' : 'Install gates'].sort());
        return current;
      });
      const screenshot = await dashboardScreenshot('native-gates-' + fixture.caseId);
      if (fixture.caseId === 'stale-install') {
        for (const file of [fixture.readyPath, fixture.continuePath]) assert.equal(path.dirname(path.resolve(file)), path.dirname(options.progress));
        fs.writeFileSync(fixture.readyPath, JSON.stringify({ caseId: fixture.caseId, modalVisible: true }));
        await waitFor('waiting for owned stale native gate source edit', () => fs.existsSync(fixture.continuePath));
      }
      await click(dialog.buttons.find((button) => button.text === fixture.expectedDecision).point);
      await waitFor('waiting for native gate review dismissal', async () => !(await ui()).dialogs.length);
      let warning;
      if (fixture.caseId === 'stale-install') {
        assert.equal(fixture.expectedWarning, 'AI Acolyte: Native Codex gate review is stale; inspect the current sources and instruction targets again.');
        warning = await waitFor('waiting for native gate stale-review refusal', async () =>
          (await ui()).notifications.find((text) => text.includes(fixture.expectedWarning)) || null);
      }
      evidence = { status: 'passed', clicked: 'codexMemoryGates', modalDecision: fixture.expectedDecision,
        dialogText: title + '\n' + dialog.detail, warning: warning || null, screenshot };
    }
    report.codexNativeGates.push({ caseId: fixture.caseId, ...evidence });
    ackNativeGates(evidence); activeNativeGates = null;
  }
  function ackApproval(value) {
    assert.equal(path.dirname(path.resolve(activeApproval.ackPath)), path.dirname(options.progress));
    fs.writeFileSync(activeApproval.ackPath, JSON.stringify({ caseId: activeApproval.caseId, ...value }, null, 2) + '\n');
  }
  async function driveApproval(fixture) {
    activeApproval = fixture;
    assert.equal(approvalsOnly, true, 'reviewed-rule actions need explicit focused mode');
    assert.equal(fixture.phase, 'codex-approval-action');
    const cases = {
      'widen-cancel': ['stored-widening', 'Cancel'], 'widen-apply': ['stored-widening', 'Apply change'],
      'import-cancel': ['project-import', 'Cancel'], 'import-apply': ['project-import', 'Apply change'],
      'inspect-unsupported': ['stored-widening', null], 'stale-apply': ['stored-widening', 'Apply change'],
      'finish-interrupted': ['stored-widening', 'Finish change'],
    };
    const expected = cases[fixture.caseId];
    assert.ok(expected, 'unexpected reviewed-rule fixture action');
    assert.equal(fixture.kind, expected[0]); assert.equal(fixture.expectedDecision, expected[1]);
    assert.match(fixture.suffix, /^[a-f0-9]{10}$/);
    report.approvalSuffix ??= fixture.suffix;
    assert.equal(fixture.suffix, report.approvalSuffix);
    const fixtureRoot = path.dirname(options.progress);
    assert.ok(path.isAbsolute(fixture.expectedPath));
    const relative = path.relative(fixtureRoot, fixture.expectedPath);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'reviewed source escapes the owned fixture');
    const base = path.basename(fixture.expectedPath);
    const expectedBase = fixture.caseId.startsWith('widen-') ? `acolyte-stored-${fixture.suffix}.rules`
      : fixture.caseId.startsWith('import-') ? `acolyte-project-${fixture.suffix}.rules`
      : fixture.caseId === 'inspect-unsupported' ? `acolyte-computed-${fixture.suffix}.rules`
      : fixture.caseId === 'stale-apply' ? `acolyte-stale-${fixture.suffix}.rules` : `acolyte-recovery-${fixture.suffix}.rules`;
    assert.equal(base, expectedBase);
    if (fixture.caseId.startsWith('widen-')) assert.equal(fixture.expectedLabel, '["git","status"]');
    if (fixture.caseId.startsWith('import-')) assert.equal(fixture.expectedLabel, JSON.stringify([`acolyte-import-${fixture.suffix}.cmd`]));
    if (fixture.caseId === 'stale-apply') assert.equal(fixture.expectedLabel, '["git","rev-parse"]');
    if (fixture.caseId === 'inspect-unsupported') assert.equal(fixture.expectedLabel, fixture.expectedPath);
    const button = fixture.kind === 'project-import' ? 'permissionsImport' : 'runNow';
    const title = fixture.kind === 'project-import' ? 'Import project Codex rules' : 'Review Codex approvals';
    const before = await waitFor('waiting for reviewed-rule dashboard controls', async () => {
      const value = await dashboardState(); return value?.[button] ? value : null;
    });
    assert.equal(before[button].enabled, true);
    if (fixture.kind === 'project-import') assert.equal(before[button].text, 'Import project permissions…');
    else assert.match(before[button].text, /^⟳\s+Optimize permissions$/);
    let countsBefore;
    if (fixture.expectedCounts) {
      const counted = await waitFor('waiting for actual shared permission totals', async () => {
        const current = await dashboardState();
        return current && Object.entries(fixture.expectedCounts).every(([name, value]) => current.permissions[name] === String(value)) ? current : null;
      });
      countsBefore = counted.permissions;
      assert.match(countsBefore.totalTitle, /not a count of commands or effective access/);
      assert.match(countsBefore.codexTitle, /1 prompt and 1 forbidden declarations are excluded/,
        'WITNESS restrictive Codex declarations are described but excluded from saved allow totals');
      assert.equal(countsBefore.coverage, '');
      report.permissionSummaryScreenshot = await dashboardScreenshot('shared-permission-counts');
    }
    const manualText = 'ai-acolyte: Claude permissions already optimal';
    if (fixture.requireManualClaude) assert.equal((await ui()).statusbar.some((text) => text.includes(manualText)), false,
      'WITNESS manual Claude status must be absent before the shared primary click');
    const clicked = await dashboardClick(fixture.kind === 'project-import' ? 'importCodexRules' : 'runNow', 'button');
    let manualClaude;
    if (fixture.requireManualClaude) {
      manualClaude = await waitFor('waiting for the shared primary action to run Claude optimization', async () =>
        (await ui()).statusbar.find((text) => text.includes(manualText)) || null);
    }
    let selected;
    let dialog;
    let screenshot;
    if (fixture.caseId !== 'finish-interrupted') {
      const picker = await exactPicker(title);
      await fillInput(picker, fixture.expectedLabel);
      selected = await waitFor('waiting for exact reviewed-rule proposal', async () => {
        const current = await exactPicker(title);
        const matches = current.rows.filter((item) => item.label === fixture.expectedLabel);
        assert.ok(matches.length <= 1, 'reviewed-rule selection must be unambiguous');
        if (!matches.length) return null;
        assert.equal(matches[0].checkbox, null);
        assert.ok(matches[0].text.includes(fixture.expectedDescription));
        if (fixture.caseId !== 'inspect-unsupported') assert.ok(matches[0].text.includes(fixture.expectedPath));
        return matches[0];
      });
      await click(selected.point);
    }
    if (fixture.expectedDecision !== null) {
      const expectedTitle = fixture.caseId === 'finish-interrupted'
        ? 'Finish interrupted Codex reviewed change?' : 'Apply this reviewed Codex rule change?';
      assert.equal(fixture.expectedTitle, expectedTitle);
      dialog = await waitFor('waiting for full reviewed-rule confirmation', async () => {
        const state = await ui();
        if (!state.dialogs.length) return null;
        assert.equal(state.dialogs.length, 1); assert.equal(state.dialogs[0].title, expectedTitle);
        for (const clause of fixture.expectedDetailIncludes) assert.ok(state.dialogs[0].detail.includes(clause), 'reviewed-rule confirmation missing: ' + clause);
        const action = fixture.caseId === 'finish-interrupted' ? 'Finish change' : 'Apply change';
        assert.deepEqual(state.dialogs[0].buttons.map((item) => item.text).filter(Boolean).sort(), ['Cancel', action].sort());
        return state.dialogs[0];
      });
      screenshot = await dashboardScreenshot('codex-approval-' + fixture.caseId);
      if (fixture.caseId === 'stale-apply') {
        for (const file of [fixture.readyPath, fixture.continuePath]) assert.equal(path.dirname(path.resolve(file)), fixtureRoot);
        fs.writeFileSync(fixture.readyPath, JSON.stringify({ caseId: fixture.caseId, status: 'modal-open', dialogText: dialog.detail }) + '\n');
        await waitFor('waiting for the owned source edit while review is open', () => {
          if (!fs.existsSync(fixture.continuePath)) return null;
          const marker = JSON.parse(fs.readFileSync(fixture.continuePath, 'utf8'));
          assert.equal(marker.caseId, fixture.caseId); assert.equal(marker.status, 'continue'); return true;
        });
      }
      const choice = dialog.buttons.filter((item) => item.text === fixture.expectedDecision);
      assert.equal(choice.length, 1); await click(choice[0].point);
    }
    await waitFor('waiting for reviewed-rule picker and modal dismissal', async () => {
      const state = await ui(); return !state.dialogs.length && !state.pickers.length;
    });
    let warning;
    if (fixture.expectedWarning) {
      warning = await waitFor('waiting for actual reviewed-rule refusal notice', async () => {
        const state = await ui();
        return state.notifications.find((text) => text.includes('AI Acolyte:') && text.includes(fixture.expectedWarning));
      });
      screenshot = await dashboardScreenshot('codex-approval-' + fixture.caseId + '-warning');
    }
    let countsAfter;
    if (fixture.expectedCountsAfter) {
      const counted = await waitFor('waiting for shared counts after reviewed action', async () => {
        const current = await dashboardState();
        return current && Object.entries(fixture.expectedCountsAfter).every(([name, value]) => current.permissions[name] === String(value)) ? current : null;
      });
      countsAfter = counted.permissions;
    }
    const evidence = { status: 'passed', clicked, manualClaude, countsBefore, countsAfter, selectedLabel: selected?.label || null,
      selectedText: selected?.text || null, modalDecision: fixture.expectedDecision, dialogText: dialog?.detail || null, warning, screenshot };
    report.codexApprovals.push({ caseId: fixture.caseId, ...evidence });
    ackApproval(evidence); activeApproval = null;
  }
  function ackMcp(value) {
    assert.equal(path.dirname(path.resolve(activeMcp.ackPath)), path.dirname(options.progress));
    fs.writeFileSync(activeMcp.ackPath, JSON.stringify({ caseId: activeMcp.caseId, ...value }, null, 2) + '\n');
  }
  async function driveMcp(fixture) {
    activeMcp = fixture;
    assert.equal(mcpOnly, true); assert.equal(fixture.phase, 'codex-mcp-action');
    const cases = {
      'cancel-tool': ['Approve this exact Codex MCP tool?', 'Cancel', 'Review exact tool approval'],
      'approve-tool': ['Approve this exact Codex MCP tool?', 'Approve tool', 'Review exact tool approval'],
      'undo-tool': ['Undo this Codex MCP approval?', 'Undo approval', 'Undo saved tool approval'],
      'stale-tool': ['Approve this exact Codex MCP tool?', 'Approve tool', 'Review exact tool approval'],
      'recover-unwritten': ['Resolve interrupted Codex MCP change?', 'Resolve change', null],
      'recover-written': ['Resolve interrupted Codex MCP change?', 'Resolve change', null],
    };
    const expected = cases[fixture.caseId]; assert.ok(expected, 'unexpected native MCP action');
    assert.equal(fixture.expectedTitle, expected[0]); assert.equal(fixture.expectedDecision, expected[1]);
    assert.equal(fixture.expectedDescription, expected[2]);
    assert.match(fixture.serverName, /^FixtureCase_[a-f0-9]{10}$/); assert.equal(fixture.tool, 'ProbeCase');
    report.mcpServerName ??= fixture.serverName; assert.equal(fixture.serverName, report.mcpServerName);
    assert.equal(fixture.expectedLabel, `${fixture.serverName} / ProbeCase`);
    const fixtureRoot = path.dirname(options.progress);
    assert.ok(path.isAbsolute(fixture.expectedPath)); assert.equal(path.basename(fixture.expectedPath), 'config.toml');
    const relative = path.relative(fixtureRoot, fixture.expectedPath);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'MCP config escapes owned fixture');
    const before = await waitFor('waiting for actual MCP review dashboard button', async () => {
      const current = await dashboardState(); return current?.reviewCodexMcp ? current : null;
    });
    assert.equal(before.reviewCodexMcp.enabled, true); assert.equal(before.reviewCodexMcp.text, 'Review Codex MCP approvals…');
    await dashboardClick('reviewCodexMcp', 'button');
    let selected;
    if (!fixture.caseId.startsWith('recover-')) {
      const title = 'Review Codex MCP approvals';
      const picker = await exactPicker(title); await fillInput(picker, fixture.expectedLabel);
      selected = await waitFor('waiting for exact MCP identity and action row', async () => {
        const current = await exactPicker(title);
        // A reviewed candidate and its saved receipt intentionally share a
        // label. The action description distinguishes Review from Undo.
        const matches = current.rows.filter((item) => item.label === fixture.expectedLabel && item.text.includes(fixture.expectedDescription));
        assert.ok(matches.length <= 1, 'MCP identity/action row must be unambiguous');
        if (!matches.length) return null;
        assert.equal(matches[0].checkbox, null);
        if (fixture.caseId === 'undo-tool') assert.ok(matches[0].text.includes(fixture.expectedPath));
        else assert.ok(matches[0].text.includes('3 successful, 1 failed, 0 unknown runs'));
        return matches[0];
      });
      await click(selected.point);
    }
    const dialog = await waitFor('waiting for the full exact MCP capability confirmation', async () => {
      const state = await ui(); if (!state.dialogs.length) return null;
      assert.equal(state.dialogs.length, 1); const current = state.dialogs[0];
      assert.equal(current.title, fixture.expectedTitle);
      assert.ok(current.detail.includes(fixture.expectedLabel)); assert.ok(current.detail.includes(fixture.expectedPath));
      for (const clause of fixture.expectedDetailIncludes) assert.ok(current.detail.includes(clause), 'MCP confirmation missing: ' + clause);
      const affirmative = fixture.caseId.startsWith('recover-') ? 'Resolve change' : fixture.caseId === 'undo-tool' ? 'Undo approval' : 'Approve tool';
      assert.deepEqual(current.buttons.map((item) => item.text).filter(Boolean).sort(), ['Cancel', affirmative].sort());
      return current;
    });
    const modalScreenshot = await dashboardScreenshot('codex-mcp-' + fixture.caseId);
    if (fixture.caseId === 'stale-tool') {
      for (const file of [fixture.readyPath, fixture.continuePath]) assert.equal(path.dirname(path.resolve(file)), fixtureRoot);
      fs.writeFileSync(fixture.readyPath, JSON.stringify({ caseId: fixture.caseId, status: 'modal-open', dialogText: dialog.detail }) + '\n');
      await waitFor('waiting for owned config edit while exact MCP review is open', () => {
        if (!fs.existsSync(fixture.continuePath)) return null;
        const marker = JSON.parse(fs.readFileSync(fixture.continuePath, 'utf8'));
        assert.equal(marker.caseId, fixture.caseId); assert.equal(marker.status, 'continue'); return true;
      });
    }
    const button = dialog.buttons.filter((item) => item.text === fixture.expectedDecision);
    assert.equal(button.length, 1); await click(button[0].point);
    await waitFor('waiting for actual MCP picker and modal dismissal', async () => {
      const state = await ui(); return !state.pickers.length && !state.dialogs.length;
    });
    let warning;
    let warningScreenshot;
    if (fixture.expectedWarning) {
      warning = await waitFor('waiting for actual stale MCP config refusal', async () =>
        (await ui()).notifications.find((text) => text.includes('AI Acolyte:') && text.includes(fixture.expectedWarning)));
      warningScreenshot = await dashboardScreenshot('codex-mcp-' + fixture.caseId + '-warning');
    }
    const evidence = { status: 'passed', clicked: 'reviewCodexMcp', selectedLabel: selected?.label || null,
      selectedText: selected?.text || null, modalDecision: fixture.expectedDecision, dialogText: dialog.detail,
      modalScreenshot, warning, warningScreenshot };
    report.codexMcp.push({ caseId: fixture.caseId, ...evidence }); ackMcp(evidence); activeMcp = null;
  }
  async function dismissOwnedUiAfterFailure() {
    if (!client) return;
    const state = await ui();
    if (state.dialogs.length === 1) {
      const dialog = state.dialogs[0];
      let label;
      if (dialog.title === 'Grant 1 command family?' && report.candidateLabel && dialog.detail.includes(report.candidateLabel)) label = 'Cancel';
      else if (dialog.title === 'Codex execpolicy analysis' && activeDiagnostic && dialog.detail.includes(activeDiagnostic.expectedArgv?.[0])) label = 'OK';
      else if (activeDashboard && ['Remove shell-style guidance?', 'Remove memory gates?'].includes(dialog.title) &&
          activeDashboard.expectedDisplayedPaths?.every((file) => dialog.detail.includes(file))) label = 'Cancel';
      else if (activePrune && dialog.detail.includes(activePrune.expectedDisplayedPath)) {
        if (dialog.title === 'Remove this Codex allow rule?' && dialog.detail.includes(activePrune.expectedLabel)) label = 'Cancel';
        else if (dialog.title === 'Codex rule (read-only)') label = 'OK';
      }
      else if (activePrune?.caseId === 'finish-interrupted' && dialog.title === 'Finish interrupted Codex removal?' &&
          dialog.detail.includes('This finishes the previously confirmed removal')) label = 'Cancel';
      else if (activeRestore && dialog.title === 'Restore this Codex rule?' &&
          dialog.detail.includes(activeRestore.expectedPath) && dialog.detail.includes(activeRestore.expectedLabel)) label = 'Cancel';
      else if (activeRestore?.caseId === 'inspect-excluded' && dialog.title === 'Excluded by an intentional removal' &&
          dialog.detail.includes(activeRestore.expectedPath)) label = 'OK';
      else if (activeRestore?.caseId === 'finish-interrupted' && dialog.title === 'Finish interrupted Codex restore?' &&
          dialog.detail.includes('Finish the restore you already confirmed.')) label = 'Cancel';
      else if (activeDerived && dialog.title === activeDerived.expectedLabel &&
          dialog.detail.includes('this is not a count of historical approval prompts')) label = 'Cancel';
      else if (activeFeature?.kind === 'hook' && dialog.title === activeFeature.expectedTitle &&
          dialog.detail.includes(activeFeature.expectedPath) && dialog.detail.includes(activeFeature.expectedCommand)) label = 'Cancel';
      else if (activeApproval && dialog.title === activeApproval.expectedTitle &&
          (dialog.detail.includes(activeApproval.expectedPath) || (activeApproval.caseId === 'finish-interrupted' &&
            dialog.detail.includes('Finish the exact rule change you already confirmed.')))) label = 'Cancel';
      else if (activeMcp && dialog.title === activeMcp.expectedTitle && dialog.detail.includes(activeMcp.expectedLabel)
          && dialog.detail.includes(activeMcp.expectedPath)) label = 'Cancel';
      else if (activeNativeGates?.kind === 'review' && ['Install native Codex memory gates?', 'Review native Codex memory gates'].includes(dialog.title)
          && dialog.detail.includes(activeNativeGates.expectedPath)) label = 'Cancel';
      const buttons = dialog.buttons.filter((button) => button.text === label);
      if (label && buttons.length === 1) { await click(buttons[0].point); report.failureUiDismissed = dialog.title; }
    } else if (!state.dialogs.length && state.pickers.length === 1 &&
        (/^(Auto Learn candidates|Which agent showed the approval prompt\?|Which shell syntax should Auto Learn parse\?|Why did Codex prompt\?)/.test(state.pickers[0].title) ||
          ((activePrune || activeDashboard?.caseId === 'saved-permissions-mixed') && state.pickers[0].title === 'Saved permissions · Claude + Codex') ||
          (activeRestore && ['Restore Codex rules', 'Restore permissions'].includes(state.pickers[0].title)) ||
          (activeDerived && (/^Derived guidance\b/.test(state.pickers[0].title) || state.pickers[0].title === activeDerived.expectedLabel)) ||
          (activeFeature?.kind === 'search' && ['AI Acolyte: Search Codex memory', 'AI Acolyte: Codex memory matches'].includes(state.pickers[0].title)) ||
          (activeApproval && ['Review Codex approvals', 'Import project Codex rules', 'Import project permissions'].includes(state.pickers[0].title)) ||
          (activeMcp && state.pickers[0].title === 'Review Codex MCP approvals') ||
          (activeRecall && ['AI Acolyte: Search Codex memory', 'AI Acolyte: Codex memory matches', 'AI Acolyte: Codex memory matches by meaning and keywords'].includes(state.pickers[0].title)) ||
          (activeNativeGates?.kind === 'mcp-readonly' && state.pickers[0].title === 'Review Codex MCP approvals'))) {
      await key('Escape', 'Escape', 27);
      report.failureUiDismissed = state.pickers[0].title;
    }
  }
  function ownedPicker(state) {
    assert.equal(state.dialogs.length, 0, 'unexpected modal appeared before the candidate picker was accepted');
    if (!state.pickers.length) return null;
    assert.equal(state.pickers.length, 1, 'multiple visible pickers are ambiguous');
    const picker = state.pickers[0];
    assert.match(picker.title, /^Auto Learn candidates(?:\b|$)/, 'refusing an unrelated QuickPick');
    return picker;
  }
  try {
    assert.equal(process.env.ACOLYTE_ACCEPTANCE_REVIEW_RUNTIME, '1', 'real UI automation requires ACOLYTE_ACCEPTANCE_REVIEW_RUNTIME=1');
    let fixture = await waitFor('waiting for requested review or dashboard UI', () =>
      (nativeGatesOnly ? progress?.phase === 'codex-native-gates-action' : recallOnly ? progress?.phase === 'codex-recall-action' : mcpOnly ? progress?.phase === 'codex-mcp-action' : approvalsOnly ? progress?.phase === 'codex-approval-action' : featuresOnly ? progress?.phase === 'codex-feature-action' : progress?.phase === 'review-open' ||
        (dashboardEnabled && progress?.phase === 'dashboard-autolearn-action')) ? { ...progress } : null);
    const completedAutoLearn = new Set();
    const target = await waitFor('connecting to owned workbench', async () => {
      let targets;
      try {
        const response = await fetch(`http://127.0.0.1:${options.port}/json/list`, {
          signal: AbortSignal.timeout(2000), redirect: 'error',
        });
        if (!response.ok) return null;
        targets = await response.json();
      } catch { return null; }
      const workbenches = targets.filter((item) => item.type === 'page' && /\/workbench(?:-dev)?\.html(?:[?#]|$)/i.test(item.url || ''));
      const matching = workbenches.filter((item) => String(item.title || '').includes(options.windowTitle));
      assert.ok(matching.length <= 1, 'multiple workbench targets claim the fixture title');
      return matching[0] || null;
    });
    report.targetUrl = target.url;
    report.targetId = target.id;
    client = await connect(target.webSocketDebuggerUrl, options.port);
    await client.call('Runtime.enable');
    if (nativeGatesOnly) {
      assert.ok(!recallOnly && !mcpOnly && !approvalsOnly && !featuresOnly && !pruneEnabled && !restoreEnabled && !derivedEnabled && !dashboardEnabled);
      const completed = new Set();
      await waitFor('waiting for focused native gate UI actions', async () => {
        if (progress?.phase === 'codex-native-gates-action' && !completed.has(progress.caseId)) {
          const action = { ...progress }; await driveNativeGates(action); completed.add(action.caseId);
        }
        return progress?.phase === 'codex-native-gates-complete';
      });
      assert.deepEqual([...completed].sort(), ['cancel-install', 'install', 'status-updated', 'status-zero', 'status-refilled',
        'status-base', 'status-override', 'held-scope', 'held-scope-repaired', 'held-marker', 'held-marker-repaired', 'held-utf8',
        'remove-unreadable', 'status-off', 'stale-install', 'mcp-readonly'].sort());
      report.hostCompleted = true; report.phase = 'complete'; report.status = 'passed'; return;
    }
    if (recallOnly) {
      assert.ok(!mcpOnly && !approvalsOnly && !featuresOnly && !pruneEnabled && !restoreEnabled && !derivedEnabled && !dashboardEnabled);
      const completed = new Set();
      await waitFor('waiting for focused semantic recall UI actions', async () => {
        if (progress?.phase === 'codex-recall-action' && !completed.has(progress.caseId)) {
          const action = { ...progress }; await driveRecall(action); completed.add(action.caseId);
        }
        return progress?.phase === 'codex-recall-complete';
      });
      assert.deepEqual([...completed].sort(), ['rebuild', 'search-fallback', 'search-registry', 'search-rollout', 'search-skill']);
      report.hostCompleted = true; report.phase = 'complete'; report.status = 'passed'; return;
    }
    if (mcpOnly) {
      assert.ok(!approvalsOnly && !featuresOnly && !pruneEnabled && !restoreEnabled && !derivedEnabled && !dashboardEnabled,
        'focused MCP mode must not silently skip other groups');
      const completed = new Set();
      await waitFor('waiting for focused exact MCP UI actions', async () => {
        if (progress?.phase === 'codex-mcp-action' && !completed.has(progress.caseId)) {
          const action = { ...progress }; await driveMcp(action); completed.add(action.caseId);
        }
        return progress?.phase === 'codex-mcp-complete';
      });
      assert.deepEqual([...completed].sort(), ['approve-tool', 'cancel-tool', 'recover-unwritten', 'recover-written', 'stale-tool', 'undo-tool'],
        'success requires every actual exact MCP UI route');
      report.hostCompleted = true; report.phase = 'complete'; report.status = 'passed';
      return;
    }
    if (approvalsOnly) {
      assert.ok(!featuresOnly && !pruneEnabled && !restoreEnabled && !derivedEnabled && !dashboardEnabled,
        'focused approvals must not silently skip other requested groups');
      const completed = new Set();
      await waitFor('waiting for focused reviewed-rule actions', async () => {
        if (progress?.phase === 'codex-approval-action' && !completed.has(progress.caseId)) {
          const action = { ...progress }; await driveApproval(action); completed.add(action.caseId);
        }
        return progress?.phase === 'codex-approvals-complete';
      });
      assert.deepEqual([...completed].sort(), ['finish-interrupted', 'import-apply', 'import-cancel', 'inspect-unsupported',
        'stale-apply', 'widen-apply', 'widen-cancel'], 'success requires every actual reviewed-rule UI path');
      report.hostCompleted = true; report.phase = 'complete'; report.status = 'passed';
      return;
    }
    if (featuresOnly) {
      assert.ok(!pruneEnabled && !restoreEnabled && !derivedEnabled, 'focused feature mode must not silently skip other requested groups');
      const completedFeatures = new Set();
      await waitFor('waiting for focused native Codex feature actions', async () => {
        if (progress?.phase === 'codex-feature-action' && !completedFeatures.has(progress.caseId)) {
          const action = { ...progress }; await driveFeature(action); completedFeatures.add(action.caseId);
        }
        return progress?.phase === 'codex-features-complete';
      });
      assert.deepEqual([...completedFeatures].sort(), ['hook-cancel', 'hook-configure', 'hook-remove', 'memory-empty', 'memory-inspect',
        'memory-search', 'memory-search-bom-first', 'memory-search-bom-later'],
        'focused feature success requires all actual hook and native-memory UI paths');
      report.hostCompleted = true; report.phase = 'complete'; report.status = 'passed';
      return;
    }
    while (fixture.phase === 'dashboard-autolearn-action') {
      await driveAutoLearn(fixture);
      completedAutoLearn.add(fixture.caseId);
      fixture = await waitFor('waiting for the next Auto Learn UI action', () => {
        if (progress?.phase === 'review-open' || (progress?.phase === 'dashboard-autolearn-action' && !completedAutoLearn.has(progress.caseId))) return { ...progress };
        return null;
      });
    }
    assert.ok(Array.isArray(fixture.prefix) && fixture.prefix.length === 1, 'fixture must name one harmless command prefix');
    assert.match(fixture.prefix[0], /^acolyte-review-[a-z0-9-]+\.cmd$/i, 'refusing a command outside this fixture');
    assert.equal(fixture.expectedTarget, 'codex');
    assert.ok(typeof fixture.candidateKey === 'string' && fixture.candidateKey.endsWith(':' + fixture.prefix[0]));
    assert.ok(typeof fixture.candidateLabel === 'string' && fixture.candidateLabel.includes(fixture.prefix[0]));
    assert.equal(!!fixture.viaDashboard, dashboardEnabled, 'dashboard flow must open Review through its actual button');
    report.candidateKey = fixture.candidateKey;
    report.candidateLabel = fixture.candidateLabel;
    report.commandName = fixture.prefix[0];
    let reviewButtonsBefore;
    if (fixture.viaDashboard) {
      activeAutoLearn = fixture;
      assert.equal(fixture.caseId, 'actual-history-review');
      assert.equal(path.dirname(path.resolve(fixture.ackPath)), path.dirname(options.progress));
      const before = await autoLearnReady(fixture.expectedBeforeButtons);
      assert.equal(before.autoLearn.buttons.alReview.enabled, true, 'Review must become enabled before its actual click');
      reviewButtonsBefore = autoLearnButtons(before);
      await dashboardClick('autoLearn', 'alReview');
    }
    const candidateRow = (picker) => {
      const matches = picker.rows.filter((row) => row.label.startsWith(fixture.candidateLabel + ' [pending:'));
      assert.ok(matches.length <= 1, 'candidate label matched more than one visible row');
      if (!matches.length) return null;
      const row = matches[0];
      const targets = row.label.match(/\[pending:\s*([^\]]+)\]/)?.[1] || '';
      assert.match(targets, /\bcodex\b/i, 'candidate row does not offer the Codex target');
      assert.ok(row.checkbox, 'candidate row has no visible checkbox');
      return row;
    };
    const picker = await waitFor('waiting for actual candidate picker', async () => ownedPicker(await ui()));
    assert.equal(picker.rows.filter((row) => row.checked).length, 0, 'fixture picker must start with no selected candidates');
    await fillInput(picker, fixture.prefix[0]);
    const row = await waitFor('locating exact candidate and Codex target', async () => {
      const current = ownedPicker(await ui());
      return current && candidateRow(current);
    });
    report.observations.push({ phase: 'candidate-visible', title: picker.title, label: row.label, detail: row.text });
    assert.equal(row.checked, false, 'candidate was already checked before the sidecar selected it');
    await click(row.checkbox);
    const checkedPicker = await waitFor('verifying actual checked candidate', async () => {
      const current = ownedPicker(await ui());
      return current && candidateRow(current)?.checked ? current : null;
    });
    assert.equal(checkedPicker.rows.filter((entry) => entry.checked).length, 1, 'more than one visible candidate is selected');
    report.checkboxChecked = true;
    const okay = checkedPicker.buttons.filter((button) => button.text === 'OK');
    assert.equal(okay.length, 1, 'expected exactly one visible QuickPick OK button');
    await click(okay[0].point);
    report.pickerAccepted = true;
    const dialog = await waitFor('waiting for actual Grant confirmation', async () => {
      const state = await ui();
      if (!state.dialogs.length) return null;
      assert.equal(state.dialogs.length, 1, 'multiple visible dialogs are ambiguous');
      const current = state.dialogs[0];
      assert.equal(current.title, 'Grant 1 command family?', 'refusing an unrelated confirmation dialog');
      assert.ok(current.detail.includes(fixture.candidateLabel), 'Grant dialog does not name the selected candidate');
      return current;
    });
    report.observations.push({ phase: 'grant-confirmation-visible', title: dialog.title, detail: dialog.detail });
    const grant = dialog.buttons.filter((button) => button.text === 'Grant');
    assert.equal(grant.length, 1, 'expected exactly one Grant button');
    await click(grant[0].point);
    report.grantClicked = true;
    if (fixture.viaDashboard) {
      const evidence = { status: 'passed', clicked: 'alReview', buttonsBefore: reviewButtonsBefore,
        checkboxChecked: report.checkboxChecked, pickerAccepted: report.pickerAccepted, grantClicked: report.grantClicked };
      report.autoLearn.push({ caseId: fixture.caseId, ...evidence });
      ackAutoLearn(evidence);
      completedAutoLearn.add(fixture.caseId);
      activeAutoLearn = null;
    }
    const completedDiagnostics = new Set();
    const completedDashboard = new Set();
    const completedPrune = new Set();
    const completedRestore = new Set();
    const completedDerived = new Set();
    await waitFor('waiting for host runtime and diagnostic assertions', async () => {
      if (progress?.phase === 'dashboard-autolearn-action' && !completedAutoLearn.has(progress.caseId)) {
        const action = { ...progress };
        await driveAutoLearn(action);
        completedAutoLearn.add(action.caseId);
      }
      if (progress?.phase === 'diagnostic-open' && !completedDiagnostics.has(progress.caseId)) {
        const diagnostic = { ...progress };
        await driveDiagnostic(diagnostic);
        completedDiagnostics.add(diagnostic.caseId);
      }
      if (['dashboard-open', 'dashboard-action', 'dashboard-saved-permissions'].includes(progress?.phase) && !completedDashboard.has(progress.caseId)) {
        const action = { ...progress };
        await driveDashboard(action);
        completedDashboard.add(action.caseId);
      }
      if (progress?.phase === 'codex-prune-action' && !completedPrune.has(progress.caseId)) {
        const action = { ...progress };
        await drivePrune(action);
        completedPrune.add(action.caseId);
      }
      if (progress?.phase === 'codex-restore-action' && !completedRestore.has(progress.caseId)) {
        const action = { ...progress };
        await driveRestore(action);
        completedRestore.add(action.caseId);
      }
      if (progress?.phase === 'codex-derived-action' && !completedDerived.has(progress.caseId)) {
        const action = { ...progress };
        await driveDerived(action);
        completedDerived.add(action.caseId);
      }
      return progress?.phase === (derivedEnabled ? 'codex-derived-complete' : restoreEnabled ? 'codex-restore-complete'
        : pruneEnabled ? 'codex-prune-complete' : dashboardEnabled ? 'ui-complete' : 'review-runtime-complete');
    });
    assert.deepEqual([...completedDiagnostics].sort(), ['neighbor-declined', 'reviewed-allowed', 'undone-declined'],
      'passing requires all three real diagnostic dialogs');
    if (dashboardEnabled) {
      assert.deepEqual([...completedAutoLearn].sort(), ['actual-history-rescan', 'actual-history-review', 'actual-history-scan', 'actual-review-undo'],
        'passing requires actual Scan, rescan, Review and Undo dashboard buttons');
      assert.ok(report.diagnostics.every((item) => item.clicked === 'alWhy'), 'all three diagnostics must launch through the actual Why prompt button');
    }
    if (dashboardEnabled) assert.deepEqual([...completedDashboard].sort(),
      ['gates-add', 'gates-add-from-off', 'gates-cancel', 'gates-remove', 'gates-remove-after-off-add',
        'guidance-add', 'guidance-add-from-off', 'guidance-cancel', 'guidance-remove', 'guidance-remove-after-off-add', 'partial-codex-only', 'saved-permissions-mixed'],
      'passing requires the actual partial dashboard, all ten instruction actions and mixed saved permissions');
    if (pruneEnabled) assert.deepEqual([...completedPrune].sort(),
      ['cancel-allow', 'finish-interrupted', 'inspect-forbidden', 'inspect-prompt', 'inspect-unsupported', 'remove-allow'],
      'passing requires actual inventory Cancel, Remove, all three read-only dialogs and interrupted-removal recovery');
    if (restoreEnabled) assert.deepEqual([...completedRestore].sort(),
      ['cancel-missing', 'finish-interrupted', 'inspect-excluded', 'restore-missing'],
      'passing requires actual restore Cancel, Restore, excluded-rule inspection and interrupted-restore recovery');
    if (derivedEnabled) assert.deepEqual([...completedDerived].sort(), ['accept-derived', 'decline-derived'],
      'passing requires actual Codex derived-guidance Accept and Decline choices');
    report.hostCompleted = true;
    assert.ok(report.checkboxChecked && report.pickerAccepted && report.grantClicked && report.hostCompleted,
      'passing requires actual selection, confirmation and host runtime completion');
    report.phase = 'complete';
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed';
    report.error = String(error.stack || error);
    report.lastHostPhase = progress?.phase || null;
    if (activeNativeGates) {
      try { ackNativeGates({ status: 'failed', error: report.error }); }
      catch (ackError) { report.ackError = String(ackError.message || ackError); }
      if (client) {
        try { report.nativeGatesFailureScreenshot = await dashboardScreenshot('native-gates-failure'); }
        catch (screenshotError) { report.nativeGatesFailureScreenshotError = screenshotError.message; }
      }
    }
    if (activeRecall) {
      try { ackRecall({ status: 'failed', error: report.error }); }
      catch (ackError) { report.ackError = String(ackError.message || ackError); }
      if (client) {
        try { report.codexRecallFailureScreenshot = await dashboardScreenshot('codex-recall-failure'); }
        catch (screenshotError) { report.codexRecallFailureScreenshotError = screenshotError.message; }
      }
    }
    if (activeMcp) {
      try { ackMcp({ status: 'failed', error: report.error }); }
      catch (ackError) { report.ackError = String(ackError.message || ackError); }
      if (client) {
        try { report.codexMcpFailureScreenshot = await dashboardScreenshot('codex-mcp-failure'); }
        catch (screenshotError) { report.codexMcpFailureScreenshotError = screenshotError.message; }
      }
    }
    if (activeApproval) {
      try { ackApproval({ status: 'failed', error: report.error }); }
      catch (ackError) { report.ackError = String(ackError.message || ackError); }
      if (client) {
        try { report.codexApprovalFailureScreenshot = await dashboardScreenshot('codex-approval-failure'); }
        catch (screenshotError) { report.codexApprovalFailureScreenshotError = screenshotError.message; }
      }
    }
    if (activeFeature) {
      try { ackFeature({ status: 'failed', error: report.error }); }
      catch (ackError) { report.ackError = String(ackError.message || ackError); }
      if (client) {
        try { report.codexFeatureFailureScreenshot = await dashboardScreenshot('codex-feature-failure'); }
        catch (screenshotError) { report.codexFeatureFailureScreenshotError = screenshotError.message; }
      }
    }
    if (activeDiagnostic) {
      try { ackDiagnostic({ status: 'failed', error: report.error }); }
      catch (ackError) { report.ackError = String(ackError.message || ackError); }
    }
    if (activeAutoLearn) {
      try { ackAutoLearn({ status: 'failed', error: report.error }); }
      catch (ackError) { report.ackError = String(ackError.message || ackError); }
      if (client) {
        try { report.autoLearnFailureScreenshot = await dashboardScreenshot('autolearn-failure'); }
        catch (screenshotError) { report.autoLearnFailureScreenshotError = screenshotError.message; }
      }
    }
    if (activeDashboard) {
      try { ackDashboard({ status: 'failed', error: report.error }); }
      catch (ackError) { report.ackError = String(ackError.message || ackError); }
      if (client) {
        try { report.dashboardFailureScreenshot = await dashboardScreenshot('failure'); }
        catch (screenshotError) { report.dashboardFailureScreenshotError = screenshotError.message; }
      }
    }
    if (activePrune) {
      try { ackPrune({ status: 'failed', error: report.error }); }
      catch (ackError) { report.ackError = String(ackError.message || ackError); }
      if (client) {
        try { report.codexPruneFailureScreenshot = await dashboardScreenshot('codex-prune-failure'); }
        catch (screenshotError) { report.codexPruneFailureScreenshotError = screenshotError.message; }
      }
    }
    if (activeRestore) {
      try { ackRestore({ status: 'failed', error: report.error }); }
      catch (ackError) { report.ackError = String(ackError.message || ackError); }
      if (client) {
        try { report.codexRestoreFailureScreenshot = await dashboardScreenshot('codex-restore-failure'); }
        catch (screenshotError) { report.codexRestoreFailureScreenshotError = screenshotError.message; }
      }
    }
    if (activeDerived) {
      try { ackDerived({ status: 'failed', error: report.error }); }
      catch (ackError) { report.ackError = String(ackError.message || ackError); }
      if (client) {
        try { report.codexDerivedFailureScreenshot = await dashboardScreenshot('codex-derived-failure'); }
        catch (screenshotError) { report.codexDerivedFailureScreenshotError = screenshotError.message; }
      }
    }
    if (lastUi) report.lastUi = lastUi;
    try { await dismissOwnedUiAfterFailure(); }
    catch (dismissError) { report.failureUiDismissError = String(dismissError.message || dismissError); }
    process.exitCode = 1;
  } finally {
    dashboardClient?.close();
    client?.close();
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(options.report, JSON.stringify(report, null, 2) + '\n');
    console.log(`${report.status.toUpperCase()}: renderer ${report.phase}; ${options.report}`);
    if (report.error) console.error(report.error);
  }
}

if (require.main === module) main().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
