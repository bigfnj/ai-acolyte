'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { deriveCodexMitigations, deriveMitigations, setDerivedGuidance, derivedStatus,
  reconcileDerived, installedDerivedIds, markersFor } = require('../src/derived-guidance');
const { enterprisePolicyAssessment } = require('../src/codex-policy');
const { createPolicyLock } = require('../src/policy-lock');
const { instructionLockPath } = require('../src/agent-guidance');

// Actual managed-bundle grammar, without a real user's bundle or transcript.
const bundle = { signed_payload: { bundle: { requirements_toml: { enterprise_managed: [{ contents:
  '[[rules.prefix_rules]]\npattern = [{ any_of = ["git", "git.exe"] }]\ndecision = "prompt"\n' } ] } } } };
function entry(prefix = ['git', 'status'], observedRuns = 60, extra = {}) {
  const assessed = enterprisePolicyAssessment(bundle, prefix);
  assert.equal(assessed.degraded, false);
  assert.equal(assessed.match.decision, 'prompt');
  return { key: `powershell:${prefix.join(' ')}`, agent: 'codex', prefix,
    pattern: assessed.match.pattern, decision: assessed.match.decision,
    observedRuns, evidence: 'codex-runs-current-managed-rule', ...extra };
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-codex-derived-'));
  const home = path.join(root, 'home');
  const codexHome = path.join(root, 'custom-codex');
  const claude = path.join(home, '.claude', 'CLAUDE.md');
  const base = path.join(codexHome, 'AGENTS.md');
  const override = path.join(codexHome, 'AGENTS.override.md');
  fs.mkdirSync(path.dirname(claude), { recursive: true });
  fs.mkdirSync(codexHome);
  fs.writeFileSync(claude, '# Claude user notes\n');
  fs.writeFileSync(base, '# Codex base user notes\n');
  t.after(() => {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, home, codexHome, claude, base, override,
    options: { home, codexHome, agents: ['claude', 'codex'] } };
}

test('Codex derivation names current matched successful runs without inventing approval events', () => {
  const derived = deriveCodexMitigations([entry()]);
  assert.equal(derived.length, 1);
  const item = derived[0];
  assert.equal(item.agent, 'codex');
  assert.equal(item.id, 'codex-reuse-repository-queries');
  assert.equal(item.observedRuns, 60);
  assert.equal(Object.hasOwn(item, 'prompts'), false,
    'WITNESS successful Codex runs must never become a historical prompt count');
  assert.match(item.body, /60 observed successful Codex runs/);
  assert.match(item.body, /not a count of historical approval prompts/);
  assert.match(item.body, /unless files, repository state or the requested scope changed/);
  assert.match(item.body, /do not switch executables, wrap the command or change policy/);
  assert.doesNotMatch(item.body, /Measured|WebFetch|one prompt|user allow entry/);
  assert.deepEqual(item.prefixes, [['git', 'status']]);
});

test('Codex derivation requires explicit Codex evidence and a prompt decision', () => {
  for (const extra of [{ agent: 'claude' }, { evidence: undefined }, { evidence: 'synthetic-prompts' },
    { decision: 'allow' }, { decision: 'forbidden' }, { decision: 'ask' }]) {
    assert.deepEqual(deriveCodexMitigations([entry(undefined, 60, extra)]), [],
      `WITNESS unproven or non-prompt evidence cannot derive Codex advice: ${JSON.stringify(extra)}`);
  }
});

test('Codex derivation checks ordered token and any_of managed prefix positions', () => {
  const known = [{ kind: 'token', value: 'git.exe' }, { kind: 'any_of', values: ['status', 'diff'] }];
  assert.equal(deriveCodexMitigations([entry(['git', 'status'], 60, { pattern: known })]).length, 1);
  for (const pattern of [[{ kind: 'token', value: 'hg' }],
    [{ kind: 'token', value: 'git' }, { kind: 'token', value: 'push' }],
    [{ kind: 'token', value: 'git' }, { kind: 'token', value: 'STATUS' }],
    [{ kind: 'token', value: 'git' }, { kind: 'token', value: 'status' }, { kind: 'token', value: '--short' }],
    [{ kind: 'any_of', values: [] }], [{ kind: 'unknown', value: 'git' }], [], null]) {
    assert.deepEqual(deriveCodexMitigations([entry(undefined, 60, { pattern })]), [],
      'WITNESS a managed rule that does not cover the actual query prefix must not derive advice');
  }
});

test('Codex derivation has no filler for mutations, unknown commands or wrapper invocations', () => {
  for (const prefix of [['git', 'push'], ['git', 'reset'], ['git', 'unknown'], ['git'],
    ['git', 'status', '--short'], ['curl'], ['powershell.exe', '-Command']]) {
    assert.deepEqual(deriveCodexMitigations([entry(undefined, 60, { prefix })]), [],
      `WITNESS only a known repository query gets reuse advice: ${JSON.stringify(prefix)}`);
  }
});

test('Codex evidence threshold, duplicate identity, cap and finite counts remain bounded', () => {
  assert.deepEqual(deriveCodexMitigations([entry(undefined, 49)]), [], 'WITNESS 49 runs must stay below the context-cost threshold');
  assert.equal(deriveCodexMitigations([entry(undefined, 50)]).length, 1);
  assert.deepEqual(deriveCodexMitigations([entry()], { limit: 0 }), [], 'WITNESS a zero advice cap must offer no Codex block');
  for (const observedRuns of [Infinity, NaN, '60', 60.5, -1]) {
    assert.deepEqual(deriveCodexMitigations([entry(undefined, observedRuns)]), []);
  }
  const first = entry();
  const second = entry(['git', 'diff'], 80);
  const otherShell = entry(undefined, 55, { key: 'bash:git status' });
  const result = deriveCodexMitigations([first, first, second, otherShell]);
  assert.equal(result.length, 1);
  assert.equal(result[0].observedRuns, 195);
  assert.equal(result[0].prefixes.length, 2);
  assert.deepEqual(deriveCodexMitigations([entry(undefined, Number.MAX_SAFE_INTEGER),
    entry(['git', 'log'], Number.MAX_SAFE_INTEGER)]), []);
});

test('Codex managed rule text cannot forge an instruction marker', () => {
  const hostile = `bad\` ${markersFor('codex-reuse-repository-queries').end}/git`;
  const pattern = [{ kind: 'token', value: hostile }];
  const derived = deriveCodexMitigations([entry(undefined, 60, { pattern })]);
  assert.equal(derived.length, 1);
  assert.doesNotMatch(derived[0].rule, /`|<!--|-->/,
    'WITNESS outside Codex policy text must be escaped before instruction interpolation');
  const notes = '# Own notes\n';
  const result = reconcileDerived(notes, derived, { accepted: [derived[0].id] });
  assert.deepEqual(installedDerivedIds(result.text), [derived[0].id]);
  assert.equal(reconcileDerived(result.text, [], { accepted: [] }).text, notes);
});

test('mixed guidance routes by agent and cleans a shadowed Codex base without changing user text', (t) => {
  const env = fixture(t);
  const codex = deriveCodexMitigations([entry()]);
  const claude = deriveMitigations([{ rule: 'Bash(curl:*)', prompts: 60 }]);
  const mitigations = [...claude, ...codex];
  const ids = mitigations.map((item) => item.id);
  fs.writeFileSync(env.override, '# Codex override user notes\n');
  fs.writeFileSync(env.base, reconcileDerived('# Codex base user notes\n', codex, { accepted: ids }).text);
  assert.deepEqual(derivedStatus(env.options).find((item) => item.agent === 'codex').shadowedPaths, [env.base]);
  const result = setDerivedGuidance(mitigations, ids, env.options);
  assert.equal(result.every((item) => item.error === null), true);
  assert.deepEqual(installedDerivedIds(fs.readFileSync(env.claude, 'utf8')), [claude[0].id],
    'WITNESS Codex evidence must not install into CLAUDE.md');
  assert.deepEqual(installedDerivedIds(fs.readFileSync(env.override, 'utf8')), [codex[0].id],
    'WITNESS Claude advice must not install into Codex instructions');
  assert.equal(fs.readFileSync(env.base, 'utf8'), '# Codex base user notes\n',
    'WITNESS inactive derived blocks must not return after removing the override');
  assert.equal(fs.existsSync(path.join(env.home, '.codex')), false);
  assert.ok(fs.existsSync(path.join(env.home, '.claude', 'wildcarding', 'backups', 'AGENTS.override.md.pre-derived')));
  assert.ok(fs.existsSync(path.join(env.home, '.claude', 'wildcarding', 'backups', 'AGENTS.md.pre-derived')));
  assert.equal(setDerivedGuidance(mitigations, ids, env.options).some((item) => item.changed), false);
});

test('Codex-only reconciliation preserves accepted Claude guidance and removes a declined Codex block', (t) => {
  const env = fixture(t);
  const codex = deriveCodexMitigations([entry()]);
  const claude = deriveMitigations([{ rule: 'Bash(curl:*)', prompts: 60 }]);
  const claudeText = reconcileDerived('# Claude user notes\n', claude, { accepted: [claude[0].id] }).text;
  fs.writeFileSync(env.claude, claudeText);
  const options = { ...env.options, agents: ['codex'] };
  const on = setDerivedGuidance(codex, [codex[0].id], options);
  assert.equal(on.length, 1);
  assert.equal(on[0].agent, 'codex');
  const off = setDerivedGuidance(codex, [], options);
  assert.equal(off[0].changed, true);
  assert.equal(fs.readFileSync(env.claude, 'utf8'), claudeText);
  assert.equal(fs.readFileSync(env.base, 'utf8'), '# Codex base user notes\n');
});

test('legacy target defaults cannot reconcile an ambient Codex home', (t) => {
  const env = fixture(t);
  const codex = deriveCodexMitigations([entry()]);
  const absent = path.join(env.root, 'absent-codex');
  assert.deepEqual(setDerivedGuidance(codex, [codex[0].id],
    { home: env.home, codexHome: absent, agents: ['codex'] }), []);
  assert.equal(fs.existsSync(absent), false, 'an unused Codex home must not be created');
  const original = reconcileDerived('# Codex base user notes\n', codex, { accepted: [codex[0].id] }).text;
  fs.writeFileSync(env.base, original);
  const defaultCodex = path.join(env.home, '.codex', 'AGENTS.md');
  fs.mkdirSync(path.dirname(defaultCodex), { recursive: true });
  fs.writeFileSync(defaultCodex, original);
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = env.codexHome;
  try {
    assert.deepEqual(derivedStatus({ home: env.home }).map((item) => item.agent), ['claude'],
      'WITNESS legacy status and writes must retain their original agent scope');
    setDerivedGuidance([], [], { home: env.home });
    assert.equal(fs.readFileSync(defaultCodex, 'utf8'), original,
      'WITNESS legacy callers must not silently reconcile an installed default Codex target');
    assert.equal(fs.readFileSync(env.base, 'utf8'), original,
      'WITNESS legacy callers must not silently expand their instruction-writing scope');
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous;
  }
});

test('Codex instruction discovery errors remain errors and cannot touch the base', (t) => {
  const env = fixture(t);
  fs.mkdirSync(env.override);
  const codex = deriveCodexMitigations([entry()]);
  const status = derivedStatus({ ...env.options, agents: ['codex'] });
  assert.equal(status[0].readable, false);
  assert.match(status[0].error, /cannot inspect Codex instruction override/);
  const result = setDerivedGuidance(codex, [codex[0].id], { ...env.options, agents: ['codex'] });
  assert.equal(result[0].changed, false);
  assert.ok(result[0].error);
  assert.equal(fs.readFileSync(env.base, 'utf8'), '# Codex base user notes\n');
});

test('Codex derived writes honor the shared instruction lock', (t) => {
  const env = fixture(t);
  const codex = deriveCodexMitigations([entry()]);
  const options = { ...env.options, agents: ['codex'] };
  createPolicyLock({ lockPath: instructionLockPath(env.base) }).locked(() => {
    const result = setDerivedGuidance(codex, [codex[0].id], options);
    assert.equal(result[0].changed, false, 'WITNESS a contended Codex instruction file must not be changed');
    assert.match(result[0].error, /being written by another/,
      'WITNESS Codex derived writes must use the same lock as shell guidance and gates');
    assert.equal(fs.readFileSync(env.base, 'utf8'), '# Codex base user notes\n');
  });
  assert.equal(setDerivedGuidance(codex, [codex[0].id], options)[0].changed, true);
});

test('Codex selection is rechecked inside the instruction write lock', (t) => {
  const env = fixture(t);
  const codex = deriveCodexMitigations([entry()]);
  const originalRead = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = function read(file, ...args) {
    if (file === env.override && ++reads === 2) fs.writeFileSync(env.override, '# Concurrent override\n');
    return originalRead.call(this, file, ...args);
  };
  let result;
  try { result = setDerivedGuidance(codex, [codex[0].id], { ...env.options, agents: ['codex'] }); }
  finally { fs.readFileSync = originalRead; }
  assert.ok(reads >= 2, 'fixture must create the override between discovery and locked validation');
  assert.equal(result[0].changed, false, 'WITNESS a newly active override must stop a stale base-file write');
  assert.match(result[0].error, /selection changed/,
    'WITNESS a newly active override must stop a stale base-file write');
  assert.equal(fs.readFileSync(env.base, 'utf8'), '# Codex base user notes\n');
  assert.equal(fs.readFileSync(env.override, 'utf8'), '# Concurrent override\n');
});
