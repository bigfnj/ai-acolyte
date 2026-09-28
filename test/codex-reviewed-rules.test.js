'use strict';
// Killing mutations: omit effective checks or source recheck; omit durable
// intent or shared pending guard; bypass stale selection and removal suppression;
// drop restrictive dependencies; omit immediate backup after the reviewed write.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createAutoLearnManager } = require('../src/auto-learn-manager');
const { parseCodexRules } = require('../src/codex-rule-inventory');
const declaration = (pattern, decision = 'allow') => `prefix_rule(pattern=${JSON.stringify(pattern)}, decision="${decision}")`;

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-codex-reviewed-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const codexHome = path.join(home, 'selected');
  const workspaceRoot = path.join(home, 'workspace');
  const source = path.join(codexHome, 'rules', 'authored.rules');
  const project = path.join(workspaceRoot, '.codex', 'rules', 'project.rules');
  const destination = path.join(codexHome, 'rules', 'ai-acolyte-reviewed.rules');
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.mkdirSync(path.dirname(project), { recursive: true });
  const checks = [];
  const create = (extra = {}) => createAutoLearnManager({ home, codexHome, workspaceRoot,
    mode: 'recommend', claudeRoots: [], codexRoots: [], paths: { claudeSettings: null },
    managedPolicy: { present: false, unreadable: false },
    codexValidator: (text, context) => { checks.push(context); return { valid: true, decision: context.expectedDecision || 'allow' }; },
    ...extra });
  const select = (manager, kind = 'stored-widening', predicate = () => true) => {
    const view = manager.codexApprovalInventory(kind);
    const plan = view.plans.find(predicate);
    assert.ok(plan, JSON.stringify(view, null, 2));
    return { kind, id: plan.id };
  };
  return { home, codexHome, workspaceRoot, source, project, destination, checks, create, select };
}

test('reviewed widening adds one verified prefix, preserves authored bytes, and immediately backs up user rules', (t) => {
  const f = fixture(t);
  const original = '# exact authored bytes 🧭\r\n' + declaration(['git', 'status', '--short']) + '\r\n';
  fs.writeFileSync(f.source, original);
  const manager = f.create();
  const result = manager.approveCodexRules(f.select(manager));
  assert.equal(result.addedCount, 1);
  assert.equal(fs.readFileSync(f.source, 'utf8'), original, 'WITNESS source is preserved byte-for-byte');
  assert.deepEqual(parseCodexRules(fs.readFileSync(f.destination, 'utf8')).rules.map((rule) => rule.pattern), [['git', 'status']]);
  assert.deepEqual(f.checks.map((entry) => [entry.command, entry.expectedDecision]), [[['git', 'status'], 'allow']], 'WITNESS effective target prefix is actually checked');
  const backup = JSON.parse(fs.readFileSync(manager.paths.codexBackup));
  assert.ok(backup.files.some((file) => path.resolve(file.path).toLowerCase() === f.destination.toLowerCase()
    && file.rules.some((rule) => rule.pattern.join(' ') === 'git status')), 'WITNESS reviewed rule is retained immediately');
  assert.equal(manager.codexApprovalInventory('stored-widening').plans.length, 0, 'covered proposal is not repeated');
  assert.equal(fs.existsSync(path.join(f.home, '.claude', 'settings.json')), false);
});

test('reviewed project import carries cross-file restrictions and validates every alternative with its intended decision', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.project, declaration(['git']));
  const restrictions = path.join(path.dirname(f.project), 'restrictions.rules');
  const restrictedText = declaration(['git', ['push', 'reset']], 'forbidden') + '\n' + declaration(['git', 'commit'], 'prompt');
  fs.writeFileSync(restrictions, restrictedText);
  const manager = f.create();
  const selected = f.select(manager, 'project-import', (plan) => plan.target.decision === 'allow');
  const result = manager.approveCodexRules(selected);
  assert.equal(result.addedCount, 3);
  const rules = parseCodexRules(fs.readFileSync(f.destination, 'utf8')).rules;
  assert.deepEqual(rules.map((rule) => rule.decision).sort(), ['allow', 'forbidden', 'prompt'], 'WITNESS original restrictions travel with the allow');
  assert.equal(fs.readFileSync(restrictions, 'utf8'), restrictedText);
  const found = new Map(f.checks.map((entry) => [entry.command?.join(' '), entry.expectedDecision]));
  assert.equal(found.get('git'), 'allow');
  assert.equal(found.get('git push'), 'forbidden');
  assert.equal(found.get('git reset'), 'forbidden', 'WITNESS alternate argv is also checked');
  assert.equal(found.get('git commit'), 'prompt');
});

test('reviewed rule write refuses stale selection and a new cross-file constraint without policy changes', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.source, declaration(['git', 'status', '--short']));
  const manager = f.create();
  const selected = f.select(manager);
  fs.writeFileSync(path.join(path.dirname(f.source), 'new.rules'), declaration(['git', 'status'], 'prompt'));
  assert.throws(() => manager.approveCodexRules(selected), /stale|changed|read-only/i, 'WITNESS new sibling constraint invalidates the selected plan');
  assert.equal(fs.existsSync(f.destination), false);
  assert.equal(fs.existsSync(manager.paths.codexRemovals), false);
});

test('reviewed rule write rechecks sources after effective policy validation', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.source, declaration(['git', 'status', '--short']));
  const manager = f.create({ codexValidator: () => {
    fs.appendFileSync(f.source, '\n# concurrent edit\n');
    return { valid: true, decision: 'allow' };
  } });
  assert.throws(() => manager.approveCodexRules(f.select(manager)), /stale|changed/i, 'WITNESS post-validation edit prevents the write');
  assert.equal(fs.existsSync(f.destination), false);
  assert.equal(fs.existsSync(manager.paths.codexRemovals), false);
});

test('reviewed rule write refuses validator no-decision and contradictory restrictive outcomes before intent', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.source, declaration(['git', 'status', '--short']));
  const missing = f.create({ codexValidator: () => ({ valid: true }) });
  assert.throws(() => missing.approveCodexRules(f.select(missing)), /did not preserve/, 'WITNESS no-decision result cannot approve a rule');
  fs.writeFileSync(f.project, declaration(['git', 'push'], 'forbidden'));
  const weaker = f.create({ codexValidator: () => ({ valid: true, decision: 'prompt' }) });
  assert.throws(() => weaker.approveCodexRules(f.select(weaker, 'project-import')), /did not preserve/, 'WITNESS restrictive result cannot become weaker');
  assert.equal(fs.existsSync(f.destination), false);
  assert.equal(fs.existsSync(missing.paths.codexRemovals), false);
});

test('reviewed imports respect intentional removals across source scopes', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.source, declaration(['git', 'status']));
  fs.writeFileSync(f.project, declaration(['git']));
  const manager = f.create();
  manager.removeCodexRules({ rules: [manager.codexInventory().rules.find((rule) => rule.decision === 'allow')] });
  const view = manager.codexApprovalInventory('project-import');
  assert.equal(view.plans.filter((plan) => plan.target.decision === 'allow').length, 0, 'WITNESS wider imported allow cannot undo an intentional removal');
  assert.equal(fs.existsSync(f.destination), false);
});

test('interrupted reviewed write has durable intent, blocks all other policy writers and resumes exact bytes', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.source, declaration(['git', 'status', '--short']));
  const manager = f.create({ threshold: 1,
    historyScanner: () => ({ observations: [{ id: 'earlier-grant', source: 'codex', tool: 'Bash',
      command: 'rg --files', status: 'success', cwd: f.workspaceRoot }], cursors: {}, files: [{ source: 'codex', mode: 'full' }] }),
    codexHistoryStore: () => ({ stale: false, inspected: 'unavailable', reasons: [], notes: [] }),
  });
  manager.scan();
  assert.equal(manager.applyCodex().appliedCount, 1, 'fixture needs an earlier transaction for real Undo');
  const interrupted = f.create({ testHooks: { afterPolicyWrite: ({ kind }) => { if (kind === 'codex-approval') throw new Error('injected stop'); } } });
  assert.throws(() => interrupted.approveCodexRules(f.select(manager)), /injected stop/);
  assert.equal(manager.codexApprovalInventory().pendingApproval, true, 'WITNESS pending intent survives first policy write');
  assert.equal(manager.codexInventory().pendingRemoval, false);
  assert.equal(manager.codexRestoreInventory().pendingRestore, false);
  assert.throws(() => manager.applyCodex(), /interrupted Codex reviewed change/);
  assert.throws(() => manager.undo(), /interrupted Codex reviewed change/);
  assert.throws(() => manager.removeCodexRules({ resume: true }), /Review Codex approvals/);
  assert.throws(() => manager.restoreCodexRules({ resume: true }), /Review Codex approvals/);
  assert.equal(manager.approveCodexRules({ resume: true }).addedCount, 1);
  assert.equal(manager.codexApprovalInventory().pendingApproval, false);
  assert.equal(parseCodexRules(fs.readFileSync(f.destination, 'utf8')).rules.length, 1);
});

test('interrupted reviewed write preserves concurrent edits and keeps recovery pending', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.source, declaration(['git', 'status', '--short']));
  const manager = f.create();
  const interrupted = f.create({ testHooks: { afterPolicyWrite: ({ kind }) => { if (kind === 'codex-approval') throw new Error('stop'); } } });
  assert.throws(() => interrupted.approveCodexRules(f.select(manager)), /stop/);
  fs.appendFileSync(f.destination, '\n# concurrent edit\n');
  const before = fs.readFileSync(f.destination);
  assert.throws(() => manager.approveCodexRules({ resume: true }), /file changed/, 'WITNESS recovery refuses to erase edited policy');
  assert.deepEqual(fs.readFileSync(f.destination), before);
  assert.equal(manager.codexApprovalInventory().pendingApproval, true);
});

function pendingMcp(f) {
  const hash = (text) => crypto.createHash('sha256').update(text).digest('hex');
  const scope = process.platform === 'win32' ? f.codexHome.toLowerCase() : f.codexHome;
  const ledger = path.join(f.home, '.ai-acolyte', `codex-mcp.${hash(scope).slice(0, 16)}.json`);
  fs.mkdirSync(path.dirname(ledger), { recursive: true });
  fs.writeFileSync(ledger, JSON.stringify({ version: 1, scope, receipts: [], pending: {
    id: 'a'.repeat(32), action: 'approve', server: 'Fixture', tool: 'Inspect',
    path: path.join(f.codexHome, 'config.toml'), beforeHash: hash(''), beforeVersion: 'fixture-version',
    beforeApproval: { exists: false, value: null }, beforeSemanticHash: hash('{}'), afterSemanticHash: hash('{"fixture":true}'), desiredValue: 'approve',
    beforeStructure: { toolsExists: false, toolExists: false }, editLevel: 'approval',
  } }));
}

test('pending native MCP config change blocks reviewed shell writes and interrupted shell recovery', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.source, declaration(['git', 'status', '--short']));
  const manager = f.create();
  const selected = f.select(manager);
  const interrupted = f.create({ testHooks: { afterPolicyWrite: ({ kind }) => { if (kind === 'codex-approval') throw new Error('stop'); } } });
  assert.throws(() => interrupted.approveCodexRules(selected), /stop/);
  const before = fs.readFileSync(f.destination);
  pendingMcp(f);
  assert.throws(() => manager.approveCodexRules({ resume: true }), /MCP change.*pending/, 'WITNESS another policy journal blocks shell recovery too');
  assert.deepEqual(fs.readFileSync(f.destination), before);
  const fresh = fixture(t);
  fs.writeFileSync(fresh.source, declaration(['git', 'status', '--short']));
  const freshManager = fresh.create();
  const freshSelection = fresh.select(freshManager);
  pendingMcp(fresh);
  assert.throws(() => freshManager.approveCodexRules(freshSelection), /MCP change.*pending/, 'WITNESS another journal blocks a new shell write');
  assert.equal(fs.existsSync(fresh.destination), false);
});
