'use strict';

// The manager's risk table is the classifier's (2026-10-14). Until then src/auto-learn-manager.js
// held an identical copy of src/auto-learn.js RISK_RANK, and its candidate loader resets a risk
// it does not know to 'unknown' on every reload (`RISK_RANK.has(value.risk) ? value.risk :
// 'unknown'`). Identical copies hide nothing today; the defect is the next class added to the
// classifier alone, which every reload would have quietly downgraded, from wherever it ranked
// to the rank below 'complex'. Every family below is synthetic.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { RISK_RANK } = require('../src/auto-learn');
const { createAutoLearnManager } = require('../src/auto-learn-manager');

function storedState(risks) {
  const candidates = {};
  for (const risk of risks) {
    const key = `bash:fixture-${risk}`;
    candidates[key] = {
      key, tool: 'Bash', kind: 'shell', shell: 'bash', root: `fixture-${risk}`, prefix: [`fixture-${risk}`],
      claudePermission: null, permissions: [], risk, baseAutoSafe: false, complex: false, reasons: [],
      sources: ['claude'], counts: { success: 1, failed: 0, unknown: 0, total: 1 },
    };
  }
  return {
    version: 3, mode: 'recommend', threshold: 3, candidates, observationHashes: {}, cursors: {},
    applied: { claude: [], codex: [] }, reviewed: { claude: [], codex: [] }, codexTargets: {}, managedClaude: {},
    lastScanAt: null, lastScanStats: null, lastApplication: null,
  };
}

function reloadedRisks(t, risks) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-risk-rank-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const statePath = path.join(home, '.claude', 'wildcarding', 'auto-learn-state.json');
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, `${JSON.stringify(storedState(risks), null, 2)}\n`);
  const learn = createAutoLearnManager({ home, statePath, codexRulesPath: null, threshold: 3,
    historyScanner: () => ({ observations: [], cursors: {}, files: [] }) });
  return Object.fromEntries(learn.listCandidates().map((item) => [item.key.slice('bash:fixture-'.length), item.risk]));
}

test('the manager keeps every risk class the classifier ranks across a reload', (t) => {
  const risks = [...RISK_RANK.keys()];
  assert.ok(risks.length >= 9 && risks.includes('destructive'), `precondition: the classifier's table (${risks})`);
  assert.deepEqual(reloadedRisks(t, risks), Object.fromEntries(risks.map((risk) => [risk, risk])));
  // Control: a risk no table ranks is still reset, which is the loader's job.
  assert.deepEqual(reloadedRisks(t, ['not-a-risk']), { 'not-a-risk': 'unknown' });
});

test('a risk class added to the classifier alone is not downgraded by the manager on reload', (t) => {
  // MUTATION: restore the manager's own copy of the table (the four-line Map that stood at
  // src/auto-learn-manager.js before 2026-10-14). The added class reloads as 'unknown' and this
  // fails. Confirmed 2026-10-14.
  RISK_RANK.set('fixture-class', 9);
  try {
    assert.deepEqual(reloadedRisks(t, ['fixture-class', 'admin']), { 'fixture-class': 'fixture-class', admin: 'admin' });
  } finally {
    RISK_RANK.delete('fixture-class');
  }
  assert.equal(RISK_RANK.has('fixture-class'), false, 'the shared table is restored for every other test');
});
