'use strict';

// Native command handlers with a scripted VS Code surface and worker boundary.
// No claim of native UI acceptance: these checks pin the selection, confirmation
// and stale-file contract. All activation paths see only this test's fake home.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const extensionPath = require.resolve('../vscode-extension/extension');
const rootSrc = path.resolve(__dirname, '..', 'src');
const realSetTimeout = global.setTimeout;
const disposable = () => ({ dispose() {} });

test('review and diagnostic removal explanations distinguish suppressed Codex grants', () => {
  const { codexRemovalExplanation, codexRemovalNote } = require('../vscode-extension/autoLearnUi');
  assert.equal(codexRemovalExplanation({ codexSuppressed: false }), null,
    'WITNESS only a suppressed Codex grant receives a removal explanation');
  assert.equal(codexRemovalNote([{ key: 'unchanged' }]), '');
  assert.match(codexRemovalExplanation({ codexSuppressed: true }), /overlaps a removed prefix/,
    'WITNESS the diagnostic must name removal instead of calling the grant already applied');
  assert.match(codexRemovalNote([{ codexSuppressed: true }, { codexSuppressed: false }]),
    /1 command family excluded from Codex by a prior rule removal/);
});

function purge() {
  for (const file of Object.keys(require.cache)) if (file.startsWith(rootSrc + path.sep) ||
    file.startsWith(path.dirname(extensionPath) + path.sep)) delete require.cache[file];
}

async function harness(t, options = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-codex-inventory-ui-'));
  const codexHome = path.join(home, 'custom-codex');
  const rulesPath = path.join(codexHome, 'rules', 'fixture.rules');
  fs.mkdirSync(path.dirname(rulesPath), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(home, 'workspace'));
  fs.writeFileSync(rulesPath, '# isolated UI fixture\n');
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{"permissions":{"allow":["Bash(git *)"]}}\n');
  const rule = { id: 'declaration-1', path: rulesPath, fileHash: 'a'.repeat(64), pattern: ['git', 'status'],
    decision: 'allow', owned: true, removable: true };
  const inventory = { files: [{ path: rulesPath, fileHash: rule.fileHash, supported: true }],
    rules: [rule], suppressionCount: 2,
    blindSpots: ['Managed and system rules are not listed.', 'Session approvals and sandbox restrictions are outside this inventory.'],
    ...options.inventory };
  if (options.rule) inventory.rules = [{ ...rule, ...options.rule }];
  const restoreRule = { id: 'saved-declaration-1', pattern: ['git', 'status'], decision: 'allow',
    text: 'prefix_rule(pattern = ["git", "status"], decision = "allow")', managed: false,
    ...options.restoreRule };
  const restoreFile = { path: rulesPath, supported: true, exists: true, beforeHash: 'b'.repeat(64),
    restore: [restoreRule], suppressed: [], conflicts: [], ...options.restoreFile };
  const restoreInventory = { backupPath: path.join(home, 'codex-rule-backup.json'), pendingRestore: false,
    pendingRemoval: false, files: [restoreFile], ...options.restoreInventory };
  const commands = new Map();
  const calls = [];
  const pickers = [];
  const messages = [];
  const pendingWarnings = [];
  const pendingRestores = [];
  const executed = [];
  let provider;
  const vscode = {
    ConfigurationTarget: { Global: 1 }, StatusBarAlignment: { Right: 2 },
    ThemeColor: class ThemeColor {}, RelativePattern: class RelativePattern {},
    Uri: { file: (fsPath) => ({ fsPath }) },
    commands: {
      registerCommand(id, callback) { commands.set(id, callback); return disposable(); },
      executeCommand(id) { executed.push(id); },
    },
    window: {
      createStatusBarItem() { return { hide() {}, show() {}, dispose() {} }; },
      registerWebviewViewProvider(_id, value) { provider = value; return disposable(); },
      setStatusBarMessage() {},
      showQuickPick(items, config) {
        pickers.push({ items, config });
        return Promise.resolve(options.pick === false ? undefined :
          options.pick ? options.pick(items) : items.find((item) => item.rule));
      },
      showInformationMessage(message, config, ...actions) {
        messages.push({ level: 'info', message, config, actions });
        return Promise.resolve(undefined);
      },
      showWarningMessage(message, config, ...actions) {
        messages.push({ level: 'warning', message, config, actions });
        return options.deferWarning ? new Promise((resolve) => pendingWarnings.push(resolve))
          : Promise.resolve(options.choice);
      },
      showErrorMessage(message) { messages.push({ level: 'error', message }); },
    },
    workspace: {
      isTrusted: true, workspaceFolders: [{ uri: { fsPath: path.join(home, 'workspace') } }],
      createFileSystemWatcher() { return { onDidChange() {}, onDidCreate() {}, onDidDelete() {}, dispose() {} }; },
      getConfiguration() { return { get: (key, fallback) => ({
        'autoLearn.enabled': false, 'autoLearn.codexScope': 'off', 'guidance.enabled': false, 'gates.enabled': false,
      })[key] ?? fallback, inspect: () => ({}), update: async () => {} }; },
      onDidChangeConfiguration: disposable, onDidChangeWorkspaceFolders: disposable,
    },
  };
  const originalLoad = Module._load;
  const originalEnv = Object.fromEntries(['HOME', 'USERPROFILE', 'CODEX_HOME'].map((key) => [key, process.env[key]]));
  Object.assign(process.env, { HOME: home, USERPROFILE: home, CODEX_HOME: codexHome });
  Module._load = function load(request, parent, isMain) {
    if (request === 'vscode') return vscode;
    if (request === 'os') return { ...os, homedir: () => home };
    if (parent?.filename === extensionPath && request === './autoLearnWorkerRunner') return {
      createAutoLearnWorkerRunner: ({ optionsProvider, onMutation }) => ({
        async run(operation, ...args) {
          calls.push({ operation, args, options: optionsProvider() });
          if (operation === 'codexInventory') return inventory;
          if (operation === 'codexRestoreInventory') return restoreInventory;
          if (operation === 'restoreCodexRules') {
            if (options.restoreError) throw new Error(options.restoreError);
            if (options.deferRestore) return new Promise((resolve) => pendingRestores.push(resolve));
            onMutation();
            return options.restoreResult || { changed: true, restoredCount: 1, paths: [rulesPath] };
          }
          assert.equal(operation, 'removeCodexRules', 'inventory UI must not scan or apply grants');
          if (options.removeError) throw new Error(options.removeError);
          onMutation();
          return options.removeResult || { changed: true, removedCount: 1, paths: [rulesPath], suppressedCount: 1 };
        },
        async deactivate() {},
      }),
    };
    if (parent?.filename === extensionPath && request.startsWith('./src/')) {
      return originalLoad.call(this, path.join(rootSrc, request.slice('./src/'.length)), parent, isMain);
    }
    // Inventory tests script worker calls explicitly. The independent gate watcher
    // has its own controller tests and native editor coverage.
    if (parent?.filename === extensionPath && request === './codexMemoryGatesUi') return {
      createCodexMemoryGatesUi: () => ({ activate() {}, dispose() {}, review() {}, status() { return {}; } }),
    };
    if (parent?.filename === extensionPath && request === './memoryLint') return {
      MemoryLint: class MemoryLint { activate() {} onReconcile() { return disposable(); } },
      memoryReport: () => ({ conf: {}, dir: null, report: null }),
      cfg: () => ({ enabled: false, dir: '', lineBudget: 300, totalBudget: 12000, maxLines: 200 }), discoverDirs: () => [],
    };
    return originalLoad.call(this, request, parent, isMain);
  };
  purge();
  assert.equal(Object.keys(require.cache).filter((file) => file.startsWith(rootSrc + path.sep) ||
    file.startsWith(path.dirname(extensionPath) + path.sep)).length, 0, 'fixture must load fresh project modules');
  const extension = require(extensionPath);
  const subscriptions = [];
  t.after(async () => {
    await extension.deactivate();
    for (const entry of subscriptions) entry.dispose?.();
    Module._load = originalLoad;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    purge();
    assert.ok(path.resolve(home).startsWith(path.resolve(os.tmpdir()) + path.sep), 'cleanup remains inside temp directory');
    fs.rmSync(home, { recursive: true, force: true });
  });
  extension.activate({ subscriptions });
  assert.ok(commands.has('permission-wildcarding.showCodexRules'), 'Codex inventory command must be registered');
  return { home, codexHome, rule, rulesPath, inventory, restoreRule, restoreFile, restoreInventory,
    commands, calls, pickers, messages, pendingWarnings, pendingRestores, executed,
    extension, provider, run: () => commands.get('permission-wildcarding.showCodexRules')(),
    restore: () => commands.get('permission-wildcarding.restoreCodexRules')() };
}

test('Codex inventory confirmation names the exact rule and source before sending the displayed snapshot', async (t) => {
  const app = await harness(t, { choice: 'Remove' });
  await app.run();
  assert.deepEqual(app.calls.map((call) => call.operation), ['codexInventory', 'removeCodexRules']);
  assert.equal(app.calls[0].options.codexHome, app.codexHome, 'inventory must use custom CODEX_HOME even when learning is off');
  assert.equal(app.calls[0].options.codexRulesPath, null, 'fixture must reach the Codex-off configuration');
  const row = app.pickers[0].items.find((item) => item.rule);
  assert.match(row.description, /Codex · allow · Acolyte/);
  assert.ok(row.detail.includes('custom-codex'), 'source file must be visible in the inventory');
  const modal = app.messages.find((item) => item.level === 'warning');
  assert.equal(modal.message, 'Remove this Codex allow rule?');
  assert.equal(modal.config.modal, true);
  assert.ok(modal.config.detail.includes(JSON.stringify(app.rule.pattern)));
  assert.ok(modal.config.detail.includes(app.rulesPath.replace(app.home, '~')));
  assert.match(modal.config.detail, /Current Auto Learn builds will not re-add overlapping prefixes in any workspace/);
  assert.match(modal.config.detail, /active sessions may cache rules/);
  assert.doesNotMatch(modal.config.detail, /Managed and system rules are not listed/);
  assert.equal(modal.config.detail.split('active sessions may cache rules').length - 1, 1);
  assert.match(app.pickers[0].items.find((item) => item.about).detail, /Managed and system rules are not listed/);
  assert.deepEqual(app.calls[1].args, [{ rules: [{ id: app.rule.id, path: app.rulesPath, fileHash: app.rule.fileHash }] }],
    'WITNESS remove must carry the selected declaration and original inventory hash');
  assert.match(app.messages.at(-1).message, /removed 1 Codex allow rule/);
});

test('cancelling a Codex removal performs no mutation', async (t) => {
  const app = await harness(t, { choice: undefined });
  await app.run();
  assert.equal(app.messages.filter((item) => item.level === 'warning').length, 1, 'fixture must reach the removal confirmation');
  assert.deepEqual(app.calls.map((call) => call.operation), ['codexInventory'],
    'WITNESS Cancel must not dispatch removeCodexRules');
});

for (const decision of ['prompt', 'forbidden']) {
  test(`${decision} decisions remain read-only even if the worker marks them removable`, async (t) => {
    const app = await harness(t, { rule: { decision, removable: true }, choice: 'Remove' });
    await app.run();
    assert.deepEqual(app.calls.map((call) => call.operation), ['codexInventory'],
      'WITNESS a non-allow decision must not dispatch removeCodexRules');
    assert.equal(app.messages.some((item) => item.level === 'warning'), false,
      'WITNESS a non-allow decision must never offer removal');
    assert.equal(app.messages.at(-1).message, 'Codex rule (read-only)');
    assert.match(app.messages.at(-1).config.detail, /Only allow rules can be removed here/);
  });
}

test('unsupported Codex files stay visible and offer no removal', async (t) => {
  const app = await harness(t, { pick: (items) => items.find((item) => item.file), choice: 'Remove' });
  app.inventory.files[0].supported = false;
  app.inventory.files[0].reason = 'Computed rule expressions require manual editing.';
  await app.run();
  assert.equal(app.pickers[0].items.find((item) => item.rule).removable, false,
    'WITNESS an unsupported file must not expose a removable declaration');
  assert.deepEqual(app.calls.map((call) => call.operation), ['codexInventory']);
  assert.match(app.messages.at(-1).config.detail, /Computed rule expressions require manual editing/);
});

test('stale inventory rejection is surfaced without a removal success message', async (t) => {
  const app = await harness(t, { choice: 'Remove', removeError: 'Codex rules changed since the inventory was shown.' });
  await app.run();
  assert.equal(app.calls.at(-1).operation, 'removeCodexRules', 'fixture must reach the rejecting worker');
  assert.equal(app.messages.at(-1).level, 'error');
  assert.match(app.messages.at(-1).message, /changed since the inventory was shown/);
  assert.equal(app.messages.some((item) => item.level === 'info' && /removed/.test(item.message)), false);
});

test('a no-op worker response cannot claim that a Codex rule was removed', async (t) => {
  const app = await harness(t, { choice: 'Remove', removeResult: { changed: false, removedCount: 0 } });
  await app.run();
  assert.equal(app.calls.at(-1).operation, 'removeCodexRules');
  assert.match(app.messages.at(-1).message, /no Codex rule was removed/,
    'WITNESS lack of an exception is not evidence of removal');
  assert.equal(app.messages.at(-1).level, 'warning');
});

test('a confirmation answered after deactivation cannot start a Codex removal', async (t) => {
  const app = await harness(t, { deferWarning: true });
  const pending = app.run();
  await new Promise((resolve) => realSetTimeout(resolve, 20));
  assert.equal(app.pendingWarnings.length, 1, 'fixture must reach the deferred confirmation');
  await app.extension.deactivate();
  app.pendingWarnings[0]('Remove');
  await pending;
  assert.deepEqual(app.calls.map((call) => call.operation), ['codexInventory'],
    'WITNESS a late answer must not dispatch a post-teardown removal');
});

test('interrupted removal has an explicit confirmation and dispatches only resume', async (t) => {
  const app = await harness(t, { inventory: { pendingRemoval: true, reason: 'One selected file remains to be updated.' },
    pick: (items) => items.find((item) => item.resume), choice: 'Finish removal' });
  await app.run();
  assert.equal(app.pickers[0].items[0].label, 'Finish interrupted Codex removal');
  assert.equal(app.pickers[0].items.find((item) => item.rule).removable, false);
  const modal = app.messages.find((item) => item.level === 'warning');
  assert.equal(modal.message, 'Finish interrupted Codex removal?');
  assert.ok(modal.config.detail.includes('One selected file remains to be updated.'));
  assert.deepEqual(app.calls[1].args, [{ resume: true }], 'resume must replay the saved removal, not invent a new selection');
});

test('empty inventory exposes suppression and scope information', async (t) => {
  const app = await harness(t, { inventory: { files: [], rules: [], suppressionCount: 1 }, pick: (items) => items.find((item) => item.about) });
  await app.run();
  const detail = app.messages.at(-1).config.detail;
  assert.match(detail, /0 Codex rules in 0 files/);
  assert.match(detail, /overlapping 1 removed prefix across workspaces/);
  assert.match(detail, /Session approvals and sandbox restrictions/);
  assert.deepEqual(app.calls.map((call) => call.operation), ['codexInventory']);
});

test('dashboard Codex inventory route is distinct from the existing Claude wildcard command', async (t) => {
  const app = await harness(t, { pick: false });
  let receive;
  const view = { visible: true, webview: { options: {}, html: '', postMessage() {},
    onDidReceiveMessage(callback) { receive = callback; return disposable(); } },
  onDidDispose() {}, onDidChangeVisibility() {} };
  app.provider.resolveWebviewView(view);
  assert.match(view.webview.html, /id="codexRules"/);
  assert.match(view.webview.html, /View \/ remove Codex rules/);
  const script = view.webview.html.match(/<script\b[^>]*>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script, 'dashboard script must be reachable');
  const listeners = new Map();
  const document = { querySelectorAll: () => [], getElementById: (id) => ({
    addEventListener(event, callback) { listeners.set(`${id}/${event}`, callback); },
  }) };
  const api = { getState() {}, setState() {}, postMessage: (message) => receive(message) };
  new Function('document', 'window', 'acquireVsCodeApi', script)(document, { addEventListener() {} }, () => api);
  assert.ok(listeners.has('codexRules/click'), 'Codex inventory button must register its click handler');
  listeners.get('codexRules/click')();
  receive({ type: 'showWildcards' });
  assert.deepEqual(app.executed, ['permission-wildcarding.showCodexRules', 'permission-wildcarding.showWildcards'],
    'WITNESS the dashboard click must route to Codex inventory while the Claude route remains intact');
  await app.commands.get('permission-wildcarding.showWildcards')();
  assert.equal(app.pickers.at(-1).config.title, 'Tracked wildcards (1 of 1 allow entries)', 'Claude inventory remains available');
});

test('Codex restore confirms the exact rule and sends only the displayed file snapshot and saved identity', async (t) => {
  const app = await harness(t, { choice: 'Restore' });
  assert.ok(app.commands.has('permission-wildcarding.restoreCodexRules'), 'restore command must be registered');
  await app.restore();
  assert.deepEqual(app.calls.map((call) => call.operation), ['codexRestoreInventory', 'restoreCodexRules']);
  assert.equal(app.calls[0].options.codexHome, app.codexHome, 'restore must honor custom CODEX_HOME while learning is off');
  assert.equal(app.pickers[0].config.title, 'Restore Codex rules');
  const row = app.pickers[0].items.find((item) => item.rule);
  assert.equal(row.label, JSON.stringify(app.restoreRule.pattern));
  assert.equal(row.description, 'Codex · allow · missing rule');
  assert.equal(row.detail, app.rulesPath);
  const modal = app.messages.find((item) => item.level === 'warning');
  assert.equal(modal.message, 'Restore this Codex rule?');
  assert.equal(modal.config.modal, true);
  assert.ok(modal.config.detail.includes(`Prefix: ${JSON.stringify(app.restoreRule.pattern)}`));
  assert.ok(modal.config.detail.includes('Decision: allow'));
  assert.ok(modal.config.detail.includes(`File: ${app.rulesPath}`));
  assert.match(modal.config.detail, /preserving current rules/);
  assert.match(modal.config.detail, /Restart Codex/);
  assert.deepEqual(app.calls[1].args, [{ path: app.rulesPath, expectedHash: app.restoreFile.beforeHash,
    expectedExists: true, ids: [app.restoreRule.id] }],
  'WITNESS restore must carry the selected saved identity and original existence/hash, never declaration text');
  assert.match(app.messages.at(-1).message, /restored 1 Codex rule/);
});

test('Codex restore preserves an absent-file snapshot instead of treating it as an existing empty file', async (t) => {
  const emptyHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  const app = await harness(t, { choice: 'Restore', restoreFile: { exists: false, beforeHash: emptyHash } });
  await app.restore();
  assert.deepEqual(app.calls.at(-1).args, [{ path: app.rulesPath, expectedHash: emptyHash,
    expectedExists: false, ids: [app.restoreRule.id] }],
  'WITNESS absent restore target must stay absent in the reviewed snapshot');
});

for (const decision of ['prompt', 'forbidden']) {
  test(`Codex restore presents a missing ${decision} declaration without converting its decision`, async (t) => {
    const app = await harness(t, { choice: 'Restore', restoreRule: { decision } });
    await app.restore();
    assert.equal(app.pickers[0].items[0].description, `Codex · ${decision} · missing rule`);
    assert.ok(app.messages.find((item) => item.level === 'warning').config.detail.includes(`Decision: ${decision}`),
      'WITNESS restrictive saved decision must be visible in the restore confirmation');
    assert.deepEqual(app.calls.at(-1).args[0].ids, [app.restoreRule.id]);
  });
}

test('cancelling the Codex restore picker never opens a confirmation or dispatches a write', async (t) => {
  const app = await harness(t, { pick: false, choice: 'Restore' });
  await app.restore();
  assert.equal(app.pickers.length, 1);
  assert.deepEqual(app.calls.map((call) => call.operation), ['codexRestoreInventory'],
    'WITNESS cancelling the restore picker must not dispatch a write');
  assert.equal(app.messages.length, 0);
});

test('cancelling a Codex restore confirmation performs no mutation', async (t) => {
  const app = await harness(t);
  await app.restore();
  assert.equal(app.messages.filter((item) => item.level === 'warning').length, 1);
  assert.deepEqual(app.calls.map((call) => call.operation), ['codexRestoreInventory'],
    'WITNESS Cancel must not dispatch restoreCodexRules');
});

for (const [kind, description] of [
  ['suppressed', 'Excluded by an intentional removal'], ['conflicts', 'Changed rule needs review'],
]) {
  test(`Codex restore keeps ${kind} declarations visible and read-only`, async (t) => {
    const app = await harness(t, { choice: 'Restore', pick: (items) => items.find((item) => item.description === description),
      restoreFile: { restore: [], [kind]: [{ id: 'excluded-1', pattern: ['git', 'push'], decision: 'allow',
        reason: 'The live declaration has a different decision.' }] } });
    await app.restore();
    assert.equal(app.pickers[0].items[0].label, '["git","push"]');
    assert.equal(app.messages.at(-1).message, description);
    assert.deepEqual(app.calls.map((call) => call.operation), ['codexRestoreInventory'],
      'WITNESS excluded restore row must not dispatch a write');
    assert.equal(app.messages.some((item) => item.level === 'warning'), false,
      'WITNESS excluded restore row must not offer confirmation');
  });
}

test('unsupported restore files cannot dispatch restoration even if the worker includes a saved rule', async (t) => {
  const app = await harness(t, { choice: 'Restore', restoreFile: { supported: false, reason: 'Computed rules need review.' } });
  await app.restore();
  assert.equal(app.pickers[0].items.find((item) => item.description === 'Read-only').detail, 'Computed rules need review.');
  assert.deepEqual(app.calls.map((call) => call.operation), ['codexRestoreInventory'],
    'WITNESS unsupported restore file must not dispatch a write');
  assert.equal(app.messages.some((item) => item.level === 'warning'), false);
});

test('pending removal blocks Codex restore before selection', async (t) => {
  const app = await harness(t, { choice: 'Restore', restoreInventory: { pendingRemoval: true } });
  await app.restore();
  assert.equal(app.pickers.length, 0, 'WITNESS pending removal must block restore selection');
  assert.deepEqual(app.calls.map((call) => call.operation), ['codexRestoreInventory']);
  assert.match(app.messages.at(-1).message, /Finish the interrupted removal/);
});

test('empty Codex restore inventory reports the backup location and performs no mutation', async (t) => {
  const app = await harness(t, { restoreInventory: { files: [] } });
  await app.restore();
  assert.equal(app.pickers.length, 0);
  assert.equal(app.messages.at(-1).message, 'No missing Codex rules to restore.');
  assert.ok(app.messages.at(-1).config.detail.includes(app.restoreInventory.backupPath));
  assert.deepEqual(app.calls.map((call) => call.operation), ['codexRestoreInventory']);
});

test('stale Codex restore rejection is surfaced without a success message', async (t) => {
  const app = await harness(t, { choice: 'Restore', restoreError: 'Codex rules changed since restore inventory was shown.' });
  await app.restore();
  assert.equal(app.calls.at(-1).operation, 'restoreCodexRules');
  assert.equal(app.messages.at(-1).level, 'error');
  assert.match(app.messages.at(-1).message, /changed since restore inventory was shown/,
    'WITNESS stale restore error must remain visible');
  assert.equal(app.messages.some((item) => item.level === 'info' && /restored/.test(item.message)), false);
});

test('interrupted Codex restore confirms and sends only the saved transaction resume request', async (t) => {
  const app = await harness(t, { choice: 'Finish restore', restoreInventory: { pendingRestore: true } });
  await app.restore();
  assert.equal(app.pickers.length, 0);
  const modal = app.messages.find((item) => item.level === 'warning');
  assert.equal(modal.message, 'Finish interrupted Codex restore?');
  assert.equal(modal.config.modal, true);
  assert.match(modal.config.detail, /Changed files are preserved/);
  assert.deepEqual(app.calls.at(-1).args, [{ resume: true }],
    'WITNESS interrupted restore must replay the saved transaction without inventing a new selection');
});

test('cancelling an interrupted Codex restore never resumes the transaction', async (t) => {
  const app = await harness(t, { restoreInventory: { pendingRestore: true } });
  await app.restore();
  assert.equal(app.messages.at(-1).message, 'Finish interrupted Codex restore?');
  assert.deepEqual(app.calls.map((call) => call.operation), ['codexRestoreInventory'],
    'WITNESS Cancel must not resume the interrupted restore');
});

test('a no-op or invalid restore count never claims that Codex rules were restored', async (t) => {
  const app = await harness(t, { choice: 'Restore', restoreResult: { changed: false, restoredCount: 0 } });
  await app.restore();
  assert.equal(app.calls.at(-1).operation, 'restoreCodexRules');
  assert.equal(app.messages.at(-1).level, 'warning');
  assert.match(app.messages.at(-1).message, /no Codex rule was restored/,
    'WITNESS a no-op restore must not claim success');
});

test('a positive changed flag with an invalid restored count does not report success', async (t) => {
  const app = await harness(t, { choice: 'Restore', restoreResult: { changed: true, restoredCount: 1.5 } });
  await app.restore();
  assert.equal(app.messages.at(-1).level, 'warning', 'WITNESS restore count must be a positive integer');
  assert.match(app.messages.at(-1).message, /no Codex rule was restored/);
});

test('a restore confirmation answered after deactivation cannot start a write', async (t) => {
  const app = await harness(t, { deferWarning: true });
  const pending = app.restore();
  await new Promise((resolve) => realSetTimeout(resolve, 20));
  assert.equal(app.pendingWarnings.length, 1);
  await app.extension.deactivate();
  app.pendingWarnings[0]('Restore');
  await pending;
  assert.deepEqual(app.calls.map((call) => call.operation), ['codexRestoreInventory'],
    'WITNESS a late restore confirmation must not dispatch after teardown');
  assert.equal(app.messages.length, 1,
    'WITNESS a late restore confirmation must not emit an error into a successor host');
});

test('a restore completed after deactivation does not emit a stale success notification', async (t) => {
  const app = await harness(t, { choice: 'Restore', deferRestore: true });
  const pending = app.restore();
  await new Promise((resolve) => realSetTimeout(resolve, 20));
  assert.equal(app.pendingRestores.length, 1, 'fixture must reach the pending restore worker');
  const messageCount = app.messages.length;
  await app.extension.deactivate();
  app.pendingRestores[0]({ changed: true, restoredCount: 1 });
  await pending;
  assert.equal(app.messages.length, messageCount,
    'WITNESS restore completion after teardown must not claim success in a successor host');
});

test('dashboard restore button routes to the Codex restore command', async (t) => {
  const app = await harness(t, { pick: false });
  let receive;
  const view = { visible: true, webview: { options: {}, html: '', postMessage() {},
    onDidReceiveMessage(callback) { receive = callback; return disposable(); } },
  onDidDispose() {}, onDidChangeVisibility() {} };
  app.provider.resolveWebviewView(view);
  assert.match(view.webview.html, /id="codexRestore"/);
  assert.match(view.webview.html, /Restore Codex rules/);
  const script = view.webview.html.match(/<script\b[^>]*>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  const listeners = new Map();
  const document = { querySelectorAll: () => [], getElementById: (id) => ({
    addEventListener(event, callback) { listeners.set(`${id}/${event}`, callback); },
  }) };
  const api = { getState() {}, setState() {}, postMessage: (message) => receive(message) };
  new Function('document', 'window', 'acquireVsCodeApi', script)(document, { addEventListener() {} }, () => api);
  assert.ok(listeners.has('codexRestore/click'));
  listeners.get('codexRestore/click')();
  assert.deepEqual(app.executed, ['permission-wildcarding.restoreCodexRules'],
    'WITNESS the dashboard restore click must reach the registered Codex restore route');
});
