'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createCodexReviewedPlans } = require('../src/codex-reviewed-plans');
const { CODEX_BEGIN_MARKER } = require('../src/policy-exporters');

const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const rule = (pattern, decision = 'allow') => `prefix_rule(pattern=${JSON.stringify(pattern)},decision=${JSON.stringify(decision)})`;
const managed = (text) => `${CODEX_BEGIN_MARKER}\n${text}\n${CODEX_BEGIN_MARKER.replace('BEGIN ', 'END ')}\n`;

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-reviewed-plans-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const codexHome = path.join(root, 'codex');
  const workspaceRoot = path.join(root, 'workspace');
  const target = path.join(codexHome, 'rules', 'permission-wildcarding.rules');
  const destination = path.join(codexHome, 'rules', 'ai-acolyte-reviewed.rules');
  fs.mkdirSync(workspaceRoot);
  const removals = [];
  const { patternsOverlap } = require('../src/codex-rule-inventory');
  function snapshot(file) {
    try { const content = fs.readFileSync(file); return { exists: true, content, hash: hash(content) }; }
    catch (error) { if (error.code !== 'ENOENT') throw error; return { exists: false, content: Buffer.alloc(0), hash: hash(Buffer.alloc(0)) }; }
  }
  const options = { codexHome, workspaceRoot, target, snapshot, suppressed: (pattern) => removals.some((entry) => patternsOverlap(pattern, entry)) };
  const planner = createCodexReviewedPlans(options);
  function write(scope, name, text) {
    const file = scope === 'user' ? path.join(codexHome, 'rules', name) : scope === 'project'
      ? path.join(workspaceRoot, '.codex', 'rules', name) : path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file;
  }
  return { root, codexHome, workspaceRoot, target, destination, snapshot, removals, options, planner, write };
}

test('reviewed widening preserves every existing destination byte and returns an unwritten verified append', (t) => {
  const box = fixture(t);
  const source = box.write('user', 'default.rules', '# owner\r\n' + rule(['git', 'status', '--short']) + '\r\n');
  const before = '# destination owner\r\n' + rule(['whoami'], 'prompt');
  box.write('user', 'ai-acolyte-reviewed.rules', before);
  const inventory = box.planner.inventory('stored-widening');
  assert.equal(inventory.destination, box.destination);
  assert.equal(inventory.plans.length, 1, 'WITNESS authored narrow user approval has one reviewed wider proposal');
  const plan = inventory.plans[0];
  assert.equal(plan.source.path, source);
  assert.deepEqual(plan.target.pattern, ['git', 'status']);
  assert.equal(plan.autoApply, false);
  assert.equal(plan.reviewRequired, true);
  assert.deepEqual(JSON.parse(JSON.stringify(inventory)), inventory, 'inventory must be fully serializable');
  const prepared = box.planner.prepare({ kind: inventory.kind, id: plan.id });
  assert.equal(prepared.path, box.destination);
  assert.ok(Buffer.isBuffer(prepared.content));
  assert.equal(prepared.content.subarray(0, Buffer.byteLength(before)).toString(), before, 'WITNESS existing destination bytes are exact');
  assert.match(prepared.content.toString(), /\r\nprefix_rule\(pattern = \["git","status"\], decision = "allow"\)\r\n$/);
  assert.deepEqual(prepared.checks, [{ pattern: ['git', 'status'], decision: 'allow' }]);
  assert.equal(prepared.verify(), true);
  assert.equal(fs.readFileSync(box.destination, 'utf8'), before, 'prepare and verify must not write');
});

test('configured user target outside Codex home is included with strict parent and source snapshots', (t) => {
  const box = fixture(t);
  const target = box.write('outside', 'selected.rules', rule(['rg', '--files', '--hidden']));
  const planner = createCodexReviewedPlans({ ...box.options, target });
  const inventory = planner.inventory('stored-widening');
  assert.equal(inventory.plans.length, 1, 'WITNESS explicitly configured external target is visible');
  assert.equal(inventory.plans[0].source.path, target);
  assert.deepEqual(inventory.plans[0].target.pattern, ['rg', '--files']);
  assert.equal(fs.existsSync(box.destination), false);
  const prepared = planner.prepare({ kind: inventory.kind, id: inventory.plans[0].id });
  assert.equal(prepared.before.exists, false);
  assert.equal(prepared.before.hash, hash(Buffer.alloc(0)));
  assert.equal(prepared.verify(), true);
  assert.equal(fs.existsSync(path.join(box.codexHome, 'rules')), false, 'read-only planning does not create rule directories');
});

test('cross-file visible user restrictions and removal suppression prevent reviewed widening', (t) => {
  const box = fixture(t);
  box.write('user', 'default.rules', rule(['git', 'status', '--short']));
  const constraint = box.write('user', 'restrict.rules', rule(['git', 'status', '--long'], 'forbidden'));
  let inventory = box.planner.inventory('stored-widening');
  assert.equal(inventory.plans.length, 0, 'WITNESS restrictive sibling blocks a wider stored allow');
  assert.ok(inventory.skipped.some((item) => /restrictive user rule/.test(item.reason)));
  fs.unlinkSync(constraint);
  box.removals.push(['git', 'status', '--long']);
  inventory = box.planner.inventory('stored-widening');
  assert.equal(inventory.plans.length, 0, 'WITNESS overlap suppression blocks regrant');
  assert.ok(inventory.skipped.some((item) => /intentional Codex removal/.test(item.reason)));
  box.removals.length = 0;
  assert.equal(box.planner.inventory('stored-widening').plans.length, 1);
});

test('unreadable computed and linked visible inputs refuse allows instead of producing partial safe-looking proposals', (t) => {
  const box = fixture(t);
  box.write('user', 'default.rules', rule(['git', 'status', '--short']));
  const bad = box.write('project', 'computed.rules', 'value = ["git"]\n');
  let inventory = box.planner.inventory('stored-widening');
  assert.equal(inventory.plans.length, 0, 'WITNESS unsupported project constraint visibility blocks user widening');
  assert.equal(inventory.files.find((file) => file.path === bad).supported, false);
  fs.unlinkSync(bad);
  fs.mkdirSync(bad);
  assert.equal(box.planner.inventory('stored-widening').plans.length, 0, 'WITNESS non-file rules entries cannot disappear from safety inventory');
  fs.rmdirSync(bad);
  const external = path.join(box.root, 'external-project-rules'); fs.mkdirSync(external);
  fs.writeFileSync(path.join(external, 'rule.rules'), rule(['git'], 'forbidden'));
  const directory = path.dirname(bad); fs.rmdirSync(directory);
  fs.symlinkSync(external, directory, process.platform === 'win32' ? 'junction' : 'dir');
  inventory = box.planner.inventory('stored-widening');
  assert.equal(inventory.plans.length, 0, 'WITNESS linked project directory is refused before policy reads');
  assert.ok(inventory.files.some((file) => file.path === directory && file.supported === false));
});

test('destination computed malformed linked and generated ownership are never append targets', (t) => {
  const box = fixture(t);
  box.write('user', 'default.rules', rule(['git', 'status', '--short']));
  for (const text of ['unknown()\n', managed(''), managed(rule(['whoami'])), CODEX_BEGIN_MARKER + '\n']) {
    box.write('user', 'ai-acolyte-reviewed.rules', text);
    const inventory = box.planner.inventory('stored-widening');
    assert.equal(inventory.plans.length, 0, 'WITNESS reviewed destination must remain ordinary authored literal policy');
    assert.equal(typeof inventory.reason, 'string');
    assert.equal(fs.readFileSync(box.destination, 'utf8'), text);
  }
});

test('project allow import bundles transitive exact restrictive dependencies from all project files and no other allows', (t) => {
  const box = fixture(t);
  const source = box.write('project', 'allow.rules', rule(['git', 'status']) + '\n' + rule(['git', 'push']));
  const prompt = 'prefix_rule(\r\n pattern=["git",["status","push"],"--short"], decision="prompt", justification="keep café",\r\n)';
  const promptPath = box.write('project', 'prompt.rules', prompt);
  const forbidden = rule(['git', 'push'], 'forbidden');
  const forbiddenPath = box.write('project', 'forbidden.rules', forbidden);
  const inventory = box.planner.inventory('project-import');
  const plan = inventory.plans.find((item) => item.source.path === source && item.source.start === 0);
  assert.ok(plan, 'WITNESS portable allow remains reviewable with bundled restrictions');
  assert.deepEqual(plan.dependencies.map((item) => item.path).sort(), [forbiddenPath, promptPath].sort(),
    'WITNESS overlap closure includes restrictions reached only through another restriction');
  assert.deepEqual(plan.additions.map((item) => item.decision).sort(), ['allow', 'forbidden', 'prompt']);
  assert.equal(plan.additions.filter((item) => item.decision === 'allow').length, 1, 'WITNESS no extra project allow is bundled');
  const prepared = box.planner.prepare({ kind: 'project-import', id: plan.id });
  assert.ok(prepared.content.includes(Buffer.from(prompt)), 'WITNESS dependency declaration CRLF and Unicode remain exact');
  assert.ok(prepared.content.includes(Buffer.from(forbidden)));
  assert.equal(prepared.checks.length, 3);
  assert.equal(prepared.verify(), true);
  assert.equal(fs.existsSync(box.destination), false);
});

test('generated or nonportable overlapping project restrictions block an allow bundle', (t) => {
  const box = fixture(t);
  const source = box.write('project', 'allow.rules', rule(['git', 'status']));
  const constraint = box.write('project', 'constraint.rules', managed(rule(['git', 'status', '--short'], 'prompt')));
  for (const text of [managed(rule(['git', 'status', '--short'], 'prompt')), rule(['git', 'status', 'private.txt'], 'forbidden')]) {
    fs.writeFileSync(constraint, text);
    const inventory = box.planner.inventory('project-import');
    assert.equal(inventory.plans.filter((item) => item.source.path === source).length, 0,
      'WITNESS uncopyable overlapping restriction refuses an unsafe partial import');
    assert.ok(inventory.skipped.some((item) => /generated or nonportable/.test(item.reason)));
  }
});

test('fully restricted project allows are skipped and restrictive imports remain explicit review choices', (t) => {
  const box = fixture(t);
  box.write('project', 'allow.rules', rule(['git', 'status']));
  const restrictive = box.write('project', 'forbidden.rules', rule(['git'], 'forbidden'));
  const inventory = box.planner.inventory('project-import');
  assert.equal(inventory.plans.length, 1);
  assert.equal(inventory.plans[0].source.path, restrictive);
  assert.equal(inventory.plans[0].target.decision, 'forbidden');
  assert.ok(inventory.skipped.some((item) => /covers this allow completely/.test(item.reason)));
});

test('equivalent user declarations suppress redundant proposals and dependency appends', (t) => {
  const box = fixture(t);
  box.write('project', 'allow.rules', rule(['git', 'status']));
  const restriction = rule(['git', 'status', '--short'], 'prompt');
  box.write('project', 'constraint.rules', restriction);
  box.write('user', 'existing.rules', restriction);
  const inventory = box.planner.inventory('project-import');
  assert.equal(inventory.plans.length, 1, 'WITNESS equivalent existing restrictive import is not offered again');
  assert.equal(inventory.plans[0].dependencies.length, 1);
  assert.deepEqual(inventory.plans[0].additions.map((item) => item.decision), ['allow'],
    'WITNESS an already-covered restrictive dependency is verified but not appended again');
  assert.deepEqual(inventory.plans[0].checks.map((item) => item.decision), ['prompt', 'allow'],
    'WITNESS existing restrictive dependency remains a final effective-policy check');
  box.write('user', 'existing-allow.rules', rule(['git']));
  assert.equal(box.planner.inventory('project-import').plans.length, 0, 'WITNESS broader user allow suppresses an already covered import');
});

test('every source dependency destination and visible file-set change invalidates the reviewed proposal', (t) => {
  const box = fixture(t);
  const source = box.write('project', 'allow.rules', rule(['git', 'status']));
  const dependency = box.write('project', 'constraint.rules', rule(['git', 'status', '--short'], 'prompt'));
  const mutations = [
    () => fs.appendFileSync(source, '\n# changed source'),
    () => fs.appendFileSync(dependency, '\n# changed dependency'),
    () => box.write('project', 'new-constraint.rules', rule(['git', 'status', '--long'], 'forbidden')),
    () => box.write('user', 'new-user.rules', rule(['whoami'], 'prompt')),
    () => box.write('user', 'ai-acolyte-reviewed.rules', '# new destination\n'),
    () => box.removals.push(['git', 'status']),
  ];
  for (const mutate of mutations) {
    const inventory = box.planner.inventory('project-import');
    const plan = inventory.plans.find((item) => item.target.decision === 'allow');
    assert.ok(plan);
    const prepared = box.planner.prepare({ kind: inventory.kind, id: plan.id });
    assert.equal(prepared.verify(), true);
    mutate();
    assert.throws(() => prepared.verify(), /changed before writing/, 'WITNESS all visible signatures must be rechecked before intent/write');
    assert.throws(() => box.planner.prepare({ kind: inventory.kind, id: plan.id }), /stale or unavailable/);
  }
});

test('parent link replacement after inventory is stale even when linked file bytes are identical', (t) => {
  const box = fixture(t);
  const source = box.write('project', 'allow.rules', rule(['git', 'status']));
  const inventory = box.planner.inventory('project-import');
  const prepared = box.planner.prepare({ kind: inventory.kind, id: inventory.plans[0].id });
  const originalDirectory = path.dirname(source);
  const moved = path.join(box.root, 'moved-rules'); fs.renameSync(originalDirectory, moved);
  fs.symlinkSync(moved, originalDirectory, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => prepared.verify(), /changed before writing/, 'WITNESS identical bytes behind a new linked parent are refused');
  assert.equal(fs.existsSync(box.destination), false);
});

test('lossy UTF-8 snapshots and invalid callback hashes never yield partial allow plans', (t) => {
  const box = fixture(t);
  const source = box.write('user', 'default.rules', rule(['git', 'status', '--short']));
  const invalid = box.write('user', 'bad.rules', Buffer.from([0xC3, 0x28]));
  let inventory = box.planner.inventory('stored-widening');
  assert.equal(inventory.plans.length, 0);
  assert.match(inventory.files.find((file) => file.path === invalid).reason, /UTF-8/);
  fs.unlinkSync(invalid);
  const planner = createCodexReviewedPlans({ ...box.options, snapshot: (file) => {
    const value = box.snapshot(file); return file === source ? { ...value, hash: '0'.repeat(64) } : value;
  } });
  inventory = planner.inventory('stored-widening');
  assert.equal(inventory.plans.length, 0);
  assert.match(inventory.files.find((file) => file.path === source).reason, /content hash/);
});

test('stored approvals remain reviewable without an open workspace and project imports explicitly require one', (t) => {
  const box = fixture(t);
  box.write('user', 'default.rules', rule(['git', 'status', '--short']));
  const planner = createCodexReviewedPlans({ ...box.options, workspaceRoot: null });
  const stored = planner.inventory('stored-widening');
  assert.equal(stored.plans.length, 1, 'WITNESS user-scope stored approvals do not require a workspace');
  assert.equal(planner.prepare({ kind: stored.kind, id: stored.plans[0].id }).verify(), true);
  const project = planner.inventory('project-import');
  assert.deepEqual(project.plans, []);
  assert.match(project.reason, /Select a workspace/);
});

test('a policy changing during the snapshot read is refused before a proposal is exposed', (t) => {
  const box = fixture(t);
  const source = box.write('user', 'default.rules', rule(['git', 'status', '--short']));
  const planner = createCodexReviewedPlans({ ...box.options, snapshot: (file) => {
    const value = box.snapshot(file);
    if (file === source) fs.appendFileSync(file, '\n# concurrent writer');
    return value;
  } });
  const inventory = planner.inventory('stored-widening');
  assert.equal(inventory.plans.length, 0, 'WITNESS an in-read source change cannot produce a reviewed approval');
  assert.match(inventory.files.find((file) => file.path === source).reason, /changed while being read/);
});
