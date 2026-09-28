'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAutoLearnManager } = require('../src/auto-learn-manager');
const { derivedGuidanceItems, derivedGuidanceSummary } = require('../vscode-extension/autoLearnUi');

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-codex-derived-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const codexHome = path.join(home, 'selected-codex');
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), '# Existing Claude instructions\n');
  const bundlePath = path.join(codexHome, 'cloud-config-bundle-cache.json');
  const bundle = (decision = 'prompt') => JSON.stringify({ signed_payload: { bundle: { requirements_toml: {
    enterprise_managed: [{ contents: '[[rules.prefix_rules]]\npattern = [{ token = "git" }]\ndecision = "' + decision + '"\n' }],
  } } } });
  fs.writeFileSync(bundlePath, bundle());
  const manager = createAutoLearnManager({ home, codexHome, codexRulesPath: null, threshold: 1,
    managedPolicy: { present: false, unreadable: false },
    codexHistoryStore: () => ({ stale: false, inspected: 'unavailable', reasons: [], notes: [] }),
    historyScanner: () => ({ observations: [
      ...Array.from({ length: 50 }, (_, n) => ({ id: 'codex-' + n, source: 'codex', tool: 'Bash', command: 'git status', status: 'success' })),
      ...Array.from({ length: 70 }, (_, n) => ({ id: 'claude-' + n, source: 'claude', tool: 'Bash', command: 'git status', status: 'success' })),
    ], cursors: {}, files: [{ source: 'codex', mode: 'full' }] }),
  });
  manager.scan();
  return { home, codexHome, bundlePath, bundle, manager };
}

test('Codex derived review counts only Codex runs under current prompt policy and routes accepted guidance to selected home', (t) => {
  const env = fixture(t);
  const review = env.manager.derivedReview();
  assert.equal(review.pending.length, 1, 'WITNESS current Codex managed prompt policy produces a reviewable mitigation');
  const mitigation = review.pending[0];
  assert.equal(mitigation.agent, 'codex');
  assert.equal(mitigation.observedRuns, 50, 'WITNESS Claude successes do not inflate Codex evidence');
  assert.equal(mitigation.prompts, undefined);
  const item = derivedGuidanceItems(review)[0];
  assert.match(item.description, /Codex · 50 observed runs/);
  assert.doesNotMatch(item.description, /prompts/);
  const claudePath = path.join(env.home, '.claude', 'CLAUDE.md'); const before = fs.readFileSync(claudePath);
  const result = env.manager.decideDerived(mitigation.id, 'accept');
  assert.ok(result.targets.some((target) => target.agent === 'codex' && target.changed));
  assert.deepEqual(fs.readFileSync(claudePath), before, 'WITNESS accepting Codex advice cannot change Claude instructions');
  const installed = fs.readFileSync(path.join(env.codexHome, 'AGENTS.md'), 'utf8');
  assert.match(installed, /50/); assert.match(installed, /observed/i);
  assert.doesNotMatch(installed, /Measured 50 prompts/);
  env.manager.decideDerived(mitigation.id, 'decline');
  assert.doesNotMatch(fs.readFileSync(path.join(env.codexHome, 'AGENTS.md'), 'utf8'), /codex-reuse-repository-queries/);
});

test('Codex derived guidance excludes forbidden decisions and preserves accepted text while policy is unreadable or absent', (t) => {
  const env = fixture(t); const id = env.manager.derivedReview().pending[0].id;
  env.manager.decideDerived(id, 'accept');
  const instructions = path.join(env.codexHome, 'AGENTS.md'); const before = fs.readFileSync(instructions);
  fs.writeFileSync(env.bundlePath, '{broken');
  assert.equal(env.manager.derivedReview().policies.codex, 'unreadable');
  assert.equal(env.manager.decideDerived(id, 'decline').blocked, 'managed-policy-unreadable');
  assert.deepEqual(fs.readFileSync(instructions), before, 'WITNESS unreadable Codex policy must not delete accepted advice');
  fs.unlinkSync(env.bundlePath);
  assert.equal(env.manager.decideDerived(id, 'decline').blocked, 'managed-policy-absent');
  assert.deepEqual(fs.readFileSync(instructions), before);
  fs.writeFileSync(env.bundlePath, env.bundle('forbidden'));
  assert.equal(env.manager.derivedReview().pending.length, 0, 'WITNESS forbidden command rules do not generate repeat-prompt advice');
  env.manager.decideDerived(id, 'decline');
  assert.doesNotMatch(fs.readFileSync(instructions, 'utf8'), /codex-reuse-repository-queries/);
});

test('available Codex guidance remains visible when the other policy cannot be read', () => {
  const review = { policy: 'present', policies: { claude: 'unreadable', codex: 'present' }, degraded: true, pending: [{ id: 'codex-example' }], accepted: [] };
  assert.match(derivedGuidanceSummary(review), /1 to review/);
  assert.doesNotMatch(derivedGuidanceSummary(review), /nothing could be derived/);
});
