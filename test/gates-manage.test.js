'use strict';

// The shared planner for retiring and restoring single gates (src/gates-manage.js), ported from
// rampage e5c0ee7 and adapted to per-agent gates. Both the CLI and the extension run what it
// returns through their own process runner, so this is where the plan itself is pinned: which
// names are refused and why, which recall.py argument lists run and in what order, what each
// agent's instruction file loads afterwards, and what the confirmation and the failure say. No
// Python and no files: the module spawns nothing and reads nothing.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  parseGatesList, planGateChanges, gateSteps, describePlan,
  parseEditOutput, changedButFailed, formatGateList, markHidden,
} = require('../src/gates-manage');

const SOURCE = path.resolve(__dirname, '..', 'src', 'gates-manage.js');

// A listing in the shape recall.py --gates-list prints.
function gate(file, state, { title = `${file} title`, agents = ['claude', 'codex'], problem = null } = {}) {
  return {
    file, scope: state === 'retired' ? 'retired' : 'global', state,
    agents: state === 'excluded' ? [] : agents, problem: state === 'excluded' ? (problem || 'an unknown agent') : problem,
    title, text: `- **${title}**`, description: '',
  };
}
// Two active gates for both agents and one retired one: the single-set shape every corpus with
// no `agents:` key has.
const GATES = [gate('feedback_gadget.md', 'active'), gate('feedback_old_rule.md', 'retired'), gate('reference_widget.md', 'active')];
// A per-agent store: a shared gate, a Codex-only one, a Claude-only one, a retired Codex-only one,
// and one whose agents: line names an agent the compiler does not know.
const AGENT_GATES = [
  gate('a_shared.md', 'active'),
  gate('b_codex.md', 'active', { agents: ['codex'] }),
  gate('c_claude.md', 'active', { agents: ['claude'] }),
  gate('d_old_codex.md', 'retired', { agents: ['codex'] }),
  gate('e_unknown.md', 'excluded', { problem: '`agents:` names an agent this compiler does not know: gemini' }),
];

// ── parseGatesList ────────────────────────────────────────────────────────────

test('parseGatesList returns the store and the gates as recall.py printed them', () => {
  const printed = JSON.stringify({ store: '/tmp/store', gates: AGENT_GATES });
  assert.deepEqual(parseGatesList(`${printed}\r\n`), { store: '/tmp/store', gates: AGENT_GATES },
    'a CRLF tail, which Python prints on Windows, is not a parse failure');
  assert.deepEqual(parseGatesList(JSON.stringify({ store: '/tmp/store', gates: [] })).gates, []);
});

test('parseGatesList throws a message naming the flag on output it cannot plan against', () => {
  assert.throws(() => parseGatesList('usage: recall.py [-h]\n'), /^Error: recall\.py --gates-list did not print JSON \(/);
  assert.throws(() => parseGatesList(''), /--gates-list did not print JSON/);
  assert.throws(() => parseGatesList('{"store": "/s"}'), /--gates-list printed JSON with no "gates" list/);
  assert.throws(() => parseGatesList('null'), /no "gates" list/);
  assert.throws(() => parseGatesList(JSON.stringify({ gates: [{ scope: 'global', state: 'active' }] })),
    /a gate with no "file" name/);
  // MUTATION: replace the try/catch around JSON.parse with a bare JSON.parse and the first
  // assertion fails on a SyntaxError that does not name --gates-list.
});

test('parseGatesList refuses a gate whose fields contradict each other', () => {
  const bad = (entry) => JSON.stringify({ store: '/s', gates: [{ ...gate('a.md', 'active'), ...entry }] });
  assert.throws(() => parseGatesList(bad({ scope: 'retired' })), /a\.md with state "active" and scope "retired", which do not agree/);
  assert.throws(() => parseGatesList(bad({ state: 'retired', scope: 'global' })), /do not agree/);
  assert.throws(() => parseGatesList(bad({ state: 'excluded', scope: 'retired' })), /do not agree/);
  assert.throws(() => parseGatesList(bad({ state: 'gone' })), /state "gone"/);
  assert.throws(() => parseGatesList(bad({ agents: ['gemini'] })), /agents \["gemini"\], which are not agents recall\.py compiles for/);
  assert.throws(() => parseGatesList(bad({ agents: 'codex' })), /which are not agents/);
  assert.throws(() => parseGatesList(bad({ agents: [] })), /state "active" and no agent it can be compiled for/);
  assert.throws(() => parseGatesList(bad({ problem: 'unreadable' })), /state "active" and no agent/);
  assert.throws(() => parseGatesList(bad({ state: 'excluded', agents: [], problem: null })), /state "excluded" and no reason/);
  assert.throws(() => parseGatesList(bad({ problem: '' })), /problem "", which is neither null nor a reason/);
  // A retired gate may carry a problem: a restore would leave it out, which the plan says.
  assert.equal(parseGatesList(bad({ state: 'retired', scope: 'retired', agents: [], problem: 'two agents: lines' })).gates.length, 1);
  // MUTATION: drop the `gate.scope !== SCOPE_OF[gate.state]` half of the first check and the
  // first two assertions fail: the planner would retire a gate the list itself calls retired.
  // MUTATION: drop the agents check and an unknown agent reaches the per-agent counts.
});

// ── planGateChanges ───────────────────────────────────────────────────────────

test('planGateChanges plans a retirement and counts the gates before and after', () => {
  const plan = planGateChanges(GATES, { retire: ['feedback_gadget'] });
  assert.deepEqual([plan.retire, plan.restore, plan.activeBefore, plan.activeAfter], [['feedback_gadget.md'], [], 2, 1]);
  const back = planGateChanges(GATES, { restore: ['feedback_old_rule.md'] });
  assert.deepEqual([back.retire, back.restore, back.activeBefore, back.activeAfter], [[], ['feedback_old_rule.md'], 2, 3]);
  const both = planGateChanges(GATES, { retire: ['reference_widget'], restore: ['feedback_old_rule'] });
  assert.deepEqual([both.retire, both.restore, both.activeAfter], [['reference_widget.md'], ['feedback_old_rule.md'], 2]);
  // With no agents: key every gate is for both agents, so both files change alike.
  assert.deepEqual(plan.agents.claude, { before: ['feedback_gadget.md', 'reference_widget.md'], after: ['reference_widget.md'], changed: true });
  assert.deepEqual(plan.agents.codex, plan.agents.claude);
});

test('planGateChanges computes what each agent loads: retiring a Codex-only gate changes AGENTS.md alone', () => {
  const codex = planGateChanges(AGENT_GATES, { retire: ['b_codex'] });
  assert.deepEqual(codex.agents.claude, { before: ['a_shared.md', 'c_claude.md'], after: ['a_shared.md', 'c_claude.md'], changed: false });
  assert.deepEqual(codex.agents.codex, { before: ['a_shared.md', 'b_codex.md'], after: ['a_shared.md'], changed: true });
  assert.deepEqual([codex.activeBefore, codex.activeAfter], [3, 2]);

  // Restoring a retired Codex-only gate returns it to Codex, never to Claude: it keeps its agents.
  const back = planGateChanges(AGENT_GATES, { restore: ['d_old_codex'] });
  assert.equal(back.agents.claude.changed, false);
  assert.deepEqual(back.agents.codex.after, ['a_shared.md', 'b_codex.md', 'd_old_codex.md']);

  // Retiring the shared gate changes both.
  const shared = planGateChanges(AGENT_GATES, { retire: ['a_shared'] });
  assert.deepEqual([shared.agents.claude.after, shared.agents.codex.after], [['c_claude.md'], ['b_codex.md']]);
  // MUTATION: count every active gate for every agent (drop `gate.agents.includes(agent)` in
  // loadsOf) and the first deepEqual fails: Claude would be told its file changes.
});

test('planGateChanges retires a gate left out for its agents: (it changes no agent), and refuses to restore one', () => {
  // recall.py allows the retire: it moves scope and nothing else, and silences the lint finding.
  const plan = planGateChanges(AGENT_GATES, { retire: ['e_unknown'] });
  assert.deepEqual(plan.retiredLeftOut, ['e_unknown.md']);
  assert.equal(plan.agents.claude.changed || plan.agents.codex.changed, false, 'it loaded for nobody, so nothing changes');
  assert.deepEqual([plan.activeBefore, plan.activeAfter], [3, 3]);
  // A restore of it is no change: it is scope: global already, and still loads nowhere.
  assert.match(planGateChanges(AGENT_GATES, { restore: ['e_unknown'] }).error,
    /^e_unknown\.md is already scope: global; it loads for no agent because its agents: line cannot be read \(`agents:` names an agent this compiler does not know: gemini\), and a restore cannot change that: fix the line in the memory$/);
  // The refusal quotes the memory's own text, so its control characters come out as ? (2026-10-20):
  // both front ends print it. MUTATION: quote gate.problem raw and this fails on the ESC.
  const esc = String.fromCharCode(27);
  const hostile = [gate('e_esc.md', 'excluded', { problem: `names ${esc}]0;T${String.fromCharCode(7)}` })];
  assert.equal(planGateChanges(hostile, { restore: ['e_esc'] }).error.includes(esc), false);
  assert.match(planGateChanges(hostile, { restore: ['e_esc'] }).error, /\(names \?\]0;T\?\)/);
  // A retired gate whose agents: cannot be read is restored, and the plan says it loads nowhere.
  const broken = [...GATES, gate('z_broken.md', 'retired', { agents: [], problem: 'more than one `agents:` line' })];
  const restored = planGateChanges(broken, { restore: ['z_broken'] });
  assert.deepEqual(restored.restoredLeftOut, [{ file: 'z_broken.md', problem: 'more than one `agents:` line' }]);
  assert.equal(restored.activeAfter, 2, 'restored, but not active');
  // MUTATION: make a restore always 'active' (drop the `gate.problem === null` test) and
  // activeAfter reads 3, so the compile would be planned without --gates-allow-empty where it
  // needed it, and the panel would promise a gate that loads nowhere.
});

test('planGateChanges names one memory once, with or without .md', () => {
  // recall.py re-checks each file just before its own write, so a duplicate would fail that
  // re-check after the first write, half way through the command.
  const plan = planGateChanges(GATES, { retire: ['feedback_gadget', 'feedback_gadget.md', 'feedback_gadget'] });
  assert.deepEqual(plan.retire, ['feedback_gadget.md']);
  assert.equal(plan.activeAfter, 1, 'counted once, too');
  // MUTATION: map the names without the Set in uniqueNames and the deepEqual fails with three
  // entries (activeAfter -1).
});

test('planGateChanges plans a name exactly as spelled: a leading space is part of the name', () => {
  // ' lead.md' is a legal Windows file name. A trim planned it as 'lead.md' (rampage), so
  // retiring the first retired its twin, and with no twin the first could not be retired at all.
  const twins = [gate(' lead.md', 'active'), gate('lead.md', 'active')];
  assert.deepEqual(planGateChanges(twins, { retire: [' lead'] }).retire, [' lead.md']);
  assert.deepEqual(planGateChanges(twins, { retire: ['lead.md'] }).retire, ['lead.md']);
  assert.match(planGateChanges(twins, { retire: [' lead '] }).error, /^ lead \.md is not a gate memory/, 'no trim at either end');
  assert.match(planGateChanges([gate(' lead.md', 'active')], { retire: ['lead'] }).error, /^lead\.md is not a gate memory/,
    'without the twin, the trimmed spelling names nothing');
  assert.deepEqual(gateSteps(planGateChanges(twins, { retire: [' lead'] }), { gatesOn: true }).steps[0],
    ['--gates-retire= lead.md'], 'and recall.py is asked for that exact name');
  // MUTATION: put `.trim()` in normaliseName and the first deepEqual fails with 'lead.md'.
});

test('planGateChanges refuses an unknown name, a name already in the wanted state, and a name in both lists', () => {
  const unknown = planGateChanges(GATES, { retire: ['nope'] });
  assert.equal(unknown.error, 'nope.md is not a gate memory (no memory by that name in the compile store holds a gate block with scope global or retired)');
  assert.equal(unknown.retire, undefined, 'a refusal carries no plan');

  assert.equal(planGateChanges(GATES, { retire: ['feedback_old_rule'] }).error, 'feedback_old_rule.md is already retired');
  assert.equal(planGateChanges(GATES, { restore: ['feedback_gadget'] }).error, 'feedback_gadget.md is already active');
  assert.equal(planGateChanges(GATES, { retire: ['feedback_gadget'], restore: ['feedback_gadget.md'] }).error,
    'feedback_gadget.md is named both to retire and to restore', 'said once, not once per list');
  assert.match(planGateChanges(GATES, {}).error, /^nothing to retire or restore/);
  assert.match(planGateChanges(GATES, { retire: [], restore: [] }).error, /^nothing to retire or restore/);
  // Case is not folded: the planner matches recall.py's listing exactly.
  assert.match(planGateChanges(GATES, { retire: ['Feedback_Gadget'] }).error, /^Feedback_Gadget\.md is not a gate memory/);
  // MUTATIONS: drop the `gate.scope === 'retired'` test and the "already retired" assertion
  // fails; drop the both-lists check and that assertion fails on "already active" instead.
});

test('planGateChanges refuses the whole request over one bad name, and names every bad one', () => {
  const plan = planGateChanges(GATES, { retire: ['feedback_gadget', 'nope', 'feedback_old_rule', 'reference_widget'] });
  assert.equal(plan.retire, undefined, 'the good names are not planned either');
  assert.deepEqual(plan.problems, [
    'nope.md is not a gate memory (no memory by that name in the compile store holds a gate block with scope global or retired)',
    'feedback_old_rule.md is already retired',
  ]);
  assert.equal(plan.error, plan.problems.join('; '));
});

// ── gateSteps ─────────────────────────────────────────────────────────────────

const ON = { gatesOn: true };
const OFF = { gatesOn: false };

test('gateSteps runs the edit as one invocation, then the compile, then installs', () => {
  assert.deepEqual(gateSteps(planGateChanges(GATES, { retire: ['feedback_gadget'] }), ON), {
    steps: [['--gates-retire=feedback_gadget.md'], ['--gates-compile']], install: 'on',
  });
  assert.deepEqual(gateSteps(planGateChanges(GATES, { restore: ['feedback_old_rule'] }), ON), {
    steps: [['--gates-restore=feedback_old_rule.md'], ['--gates-compile']], install: 'on',
  });
  // Both directions in ONE recall.py run: one snapshot, one validation pass for the lot.
  assert.deepEqual(gateSteps(planGateChanges(GATES, { retire: ['reference_widget'], restore: ['feedback_old_rule'] }), ON), {
    steps: [['--gates-retire=reference_widget.md', '--gates-restore=feedback_old_rule.md'], ['--gates-compile']],
    install: 'on',
  });
});

test('gateSteps passes each name as its own --flag=value, so a name that starts with a dash is a name', () => {
  // Spaced out, argparse reads `-dash.md` as an option and recall.py refuses the whole command
  // with a usage error; `--gates-retire=-dash.md` is taken verbatim, and action="extend" gathers
  // every one.
  const gates = [gate('-dash.md', 'active'), gate('alpha.md', 'active'), gate('-old.md', 'retired')];
  assert.deepEqual(gateSteps(planGateChanges(gates, { retire: ['-dash', 'alpha'], restore: ['-old'] }), ON).steps[0],
    ['--gates-retire=-dash.md', '--gates-retire=alpha.md', '--gates-restore=-old.md']);
  // MUTATION: emit `'--gates-retire', ...plan.retire` (the spaced form) and this deepEqual fails.
});

test('gateSteps with no gate left active compiles with --gates-allow-empty and removes the blocks', () => {
  const plan = planGateChanges(GATES, { retire: ['feedback_gadget', 'reference_widget'] });
  assert.equal(plan.activeAfter, 0);
  assert.deepEqual(gateSteps(plan, ON), {
    steps: [['--gates-retire=feedback_gadget.md', '--gates-retire=reference_widget.md'], ['--gates-compile', '--gates-allow-empty']],
    install: 'off',
  });
  // One gate left is not zero: no allow-empty, and the block is installed.
  const one = gateSteps(planGateChanges(GATES, { retire: ['feedback_gadget'] }), ON);
  assert.deepEqual(one.steps[1], ['--gates-compile']);
  assert.equal(one.install, 'on');
  // Per agent: an agent left with no gates is NOT zero for the compile while the other agent
  // still has one. The install is 'on', and setGatesAll removes that agent's block itself.
  const claudeEmpty = gateSteps(planGateChanges(AGENT_GATES, { retire: ['a_shared', 'c_claude'] }), ON);
  assert.deepEqual(claudeEmpty, { steps: [['--gates-retire=a_shared.md', '--gates-retire=c_claude.md'], ['--gates-compile']], install: 'on' });
  // A gate left out for its agents: does not count as active, so retiring the last active one
  // beside it still empties the compile.
  const lastBesideExcluded = planGateChanges([gate('only.md', 'active'), gate('x.md', 'excluded')], { retire: ['only'] });
  assert.deepEqual(gateSteps(lastBesideExcluded, ON).steps[1], ['--gates-compile', '--gates-allow-empty']);
  // MUTATIONS: drop the `activeAfter === 0` allow-empty and the first deepEqual fails (recall.py
  // would refuse to empty the compiled file); make install always 'on' and it fails again
  // (setGatesAll refuses an empty compile, so the retirement would end in an install error).
});

test('gateSteps with gates switched off edits and compiles, and installs nothing', () => {
  // A retire or restore never switches gates on: it used to install the block whatever the
  // state (rampage), which undid a `--gates off` and wrote a block into a file that never had one.
  assert.deepEqual(gateSteps(planGateChanges(GATES, { retire: ['feedback_gadget'] }), OFF), {
    steps: [['--gates-retire=feedback_gadget.md'], ['--gates-compile']], install: 'none',
  });
  assert.deepEqual(gateSteps(planGateChanges(GATES, { restore: ['feedback_old_rule'] }), OFF).install, 'none');
  // Nor off: with no block to remove, `none` at zero too, and the compile still empties the file.
  assert.deepEqual(gateSteps(planGateChanges(GATES, { retire: ['feedback_gadget', 'reference_widget'] }), OFF), {
    steps: [['--gates-retire=feedback_gadget.md', '--gates-retire=reference_widget.md'], ['--gates-compile', '--gates-allow-empty']],
    install: 'none',
  });
  // MUTATION: drop the `!state.gatesOn ? 'none'` arm and the first deepEqual fails on 'on'.
});

test('gateSteps refuses a refusal, a plan with nothing in it, and a call with no state', () => {
  assert.throws(() => gateSteps(planGateChanges(GATES, { retire: ['nope'] }), ON), /not a refusal/);
  assert.throws(() => gateSteps(null, ON), /not a refusal/);
  assert.throws(() => gateSteps({ retire: [], restore: [], activeBefore: 1, activeAfter: 1 }, ON), /retires or restores something/);
  // Required, not defaulted: either default is wrong for half the callers.
  const plan = planGateChanges(GATES, { retire: ['feedback_gadget'] });
  assert.throws(() => gateSteps(plan), /^Error: gateSteps needs the current state, \{ gatesOn: true \| false \}/);
  assert.throws(() => gateSteps(plan, {}), /needs the current state/);
  assert.throws(() => gateSteps(plan, { gatesOn: 'yes' }), /needs the current state/);
  // MUTATION: default a missing state to { gatesOn: true } and the first of these stops throwing.
});

// ── describePlan ──────────────────────────────────────────────────────────────

test('describePlan says what changes, that a snapshot comes first, and what each file loads next session', () => {
  assert.equal(describePlan(planGateChanges(GATES, { retire: ['feedback_gadget'] }), { gatesOn: true, loadedNow: { claude: 2, codex: 2 } }),
    'Retire 1 gate: feedback_gadget.md\n'
    + 'A snapshot of the memory folder is taken first.\n'
    + 'From the next session:\n'
    + '  CLAUDE.md: 1 gate will load (2 now).\n'
    + '  AGENTS.md: 1 gate will load (2 now).');
  assert.equal(describePlan(planGateChanges(GATES, { retire: ['reference_widget'], restore: ['feedback_old_rule'] }),
    { gatesOn: true, loadedNow: { claude: 2, codex: 2 } }),
  'Retire 1 gate: reference_widget.md\n'
    + 'Restore 1 gate: feedback_old_rule.md\n'
    + 'A snapshot of the memory folder is taken first.\n'
    + 'From the next session:\n'
    + '  CLAUDE.md: 2 gates will load (2 now).\n'
    + '  AGENTS.md: 2 gates will load (2 now).');
  assert.equal(describePlan(planGateChanges(GATES, { retire: ['feedback_gadget', 'reference_widget'] }), { gatesOn: true, loadedNow: { claude: 2, codex: 2 } }),
    'Retire 2 gates: feedback_gadget.md, reference_widget.md\n'
    + 'A snapshot of the memory folder is taken first.\n'
    + 'From the next session:\n'
    + '  CLAUDE.md: no gates will load (2 now), and its gates block is removed.\n'
    + '  AGENTS.md: no gates will load (2 now), and its gates block is removed.');
});

test('describePlan is per agent: retiring a Codex-only gate says CLAUDE.md is not changed', () => {
  const text = describePlan(planGateChanges(AGENT_GATES, { retire: ['b_codex'] }), { gatesOn: true, loadedNow: { claude: 2, codex: 2 } });
  assert.equal(text, 'Retire 1 gate: b_codex.md\n'
    + 'A snapshot of the memory folder is taken first.\n'
    + 'From the next session:\n'
    + '  CLAUDE.md: not changed by this, 2 gates (2 now).\n'
    + '  AGENTS.md: 1 gate will load (2 now).');
  // The last gate leaving one agent takes that agent's block, and only that one.
  const claudeOut = describePlan(planGateChanges(AGENT_GATES, { retire: ['a_shared', 'c_claude'] }), { gatesOn: true, loadedNow: { claude: 2, codex: 2 } });
  assert.match(claudeOut, /\n {2}CLAUDE\.md: no gates will load \(2 now\), and its gates block is removed\.\n {2}AGENTS\.md: 1 gate will load \(2 now\)\.$/);
  // A machine with no Codex is told nothing about an AGENTS.md it does not have.
  assert.doesNotMatch(describePlan(planGateChanges(AGENT_GATES, { retire: ['b_codex'] }), { gatesOn: true, targets: ['claude'] }), /AGENTS\.md/);
  // MUTATION: word every agent from plan.activeAfter instead of plan.agents[agent] and the
  // first assertEqual fails: CLAUDE.md would be told it loads 2 gates as if it changed.
});

test('describePlan names a gate that loads for no agent, on either side of the change', () => {
  assert.match(describePlan(planGateChanges(AGENT_GATES, { retire: ['e_unknown'] }), ON),
    /\ne_unknown\.md loads for no agent today \(its agents: line cannot be read\), so retiring it changes no instruction file\.$/);
  const broken = [...GATES, gate('z_broken.md', 'retired', { agents: [], problem: 'more than one `agents:` line' })];
  assert.match(describePlan(planGateChanges(broken, { restore: ['z_broken'] }), ON),
    /\nz_broken\.md is restored, but its agents: line cannot be read \(more than one `agents:` line\), so it loads for no agent until that line is fixed\.$/);
});

test('describePlan counts "now" from what the caller says is loaded, not from the scope:global memories', () => {
  // Two scope:global memories, and a block that holds a stale three: "now" is the three.
  const plan = planGateChanges(GATES, { retire: ['feedback_gadget'] });
  assert.equal(plan.activeBefore, 2);
  assert.match(describePlan(plan, { gatesOn: true, loadedNow: { claude: 3, codex: 3 } }), /\n {2}CLAUDE\.md: 1 gate will load \(3 now\)\./);
  assert.match(describePlan(plan, { gatesOn: true, loadedNow: { claude: 0, codex: 0 } }), /\(0 now\)\./);
  // A count the caller could not read is left out, never guessed.
  assert.match(describePlan(plan, ON), /\n {2}CLAUDE\.md: 1 gate will load\.\n/);
  assert.match(describePlan(plan, { gatesOn: true, loadedNow: { claude: -1 } }), /CLAUDE\.md: 1 gate will load\.\n/);
  assert.throws(() => describePlan(plan), /describePlan needs the current state/);
  // MUTATION: print `(${plan.activeBefore} now)` and the first match fails on "(2 now)".
});

test('describePlan retiring the last gate with gates on and no block installed removes nothing', () => {
  // The extension's gates are on whenever gates.enabled is, so the setting can be on with no
  // block in an instruction file (before the first install, or after `--gates off`). The modal
  // then claimed a removal from a file that held nothing to remove (rampage).
  const plan = planGateChanges(GATES, { retire: ['feedback_gadget', 'reference_widget'] });
  assert.equal(describePlan(plan, { gatesOn: true, loadedNow: { claude: 0, codex: 2 } }),
    'Retire 2 gates: feedback_gadget.md, reference_widget.md\n'
    + 'A snapshot of the memory folder is taken first.\n'
    + 'From the next session:\n'
    + '  CLAUDE.md: no gates load now, and none will; it holds no gates block, so nothing is removed.\n'
    + '  AGENTS.md: no gates will load (2 now), and its gates block is removed.');
  // A count it could not read is not a zero: the block may be there, so the removal is still said.
  assert.match(describePlan(plan, ON), /CLAUDE\.md: no gates will load, and its gates block is removed\./);
  // MUTATION: test `!loaded` instead of `loaded === 0` and the second assertion fails, since ON
  // carries no count; drop the zero branch and the first fails on "is removed".
});

test('describePlan with gates switched off says nothing is installed and when the change takes effect', () => {
  assert.equal(describePlan(planGateChanges(GATES, { retire: ['feedback_gadget'] }), { gatesOn: false, loadedNow: { claude: 5, codex: 5 } }),
    'Retire 1 gate: feedback_gadget.md\n'
    + 'A snapshot of the memory folder is taken first.\n'
    + 'Gates are switched off, so nothing is installed and no gates load now. '
    + 'The change takes effect when gates are turned on: CLAUDE.md will load 1 gate, AGENTS.md will load 1 gate.');
  assert.match(describePlan(planGateChanges(AGENT_GATES, { restore: ['d_old_codex'] }), OFF),
    /turned on: CLAUDE\.md will load 2 gates, AGENTS\.md will load 3 gates\.$/);
  assert.match(describePlan(planGateChanges(GATES, { retire: ['feedback_gadget', 'reference_widget'] }), OFF),
    /no gates load now\. With no gate left active, none will load when gates are turned on either\.$/);
  assert.doesNotMatch(describePlan(planGateChanges(GATES, { retire: ['feedback_gadget', 'reference_widget'] }), OFF),
    /block is removed/, 'there is no block to remove');
  // MUTATION: drop the `!state.gatesOn` branch and the first assertEqual fails on "(5 now)".
});

// ── parseEditOutput and the failure contract ──────────────────────────────────

test('parseEditOutput reads the snapshot and each file written, LF or CRLF', () => {
  assert.deepEqual(parseEditOutput('snapshot /s/20261009T101500Z-retire+restore\r\nretired a.md\r\nrestored b.md\r\n'),
    { snapshot: '/s/20261009T101500Z-retire+restore', retired: ['a.md'], restored: ['b.md'] });
  assert.deepEqual(parseEditOutput('[recall] a warning\nsnapshot C:\\snap shots\\x\nretired a.md\n'),
    { snapshot: 'C:\\snap shots\\x', retired: ['a.md'], restored: [] }, 'a path with a space survives');
  assert.deepEqual(parseEditOutput(undefined), { snapshot: null, retired: [], restored: [] });
});

test('changedButFailed says the memories changed, names the snapshot, and points at refresh', () => {
  const plan = planGateChanges(GATES, { retire: ['feedback_gadget'], restore: ['feedback_old_rule'] });
  const text = changedButFailed({ stage: 'compile', detail: '[recall] refused', snapshot: '/s/x-retire',
    retired: ['feedback_gadget.md'], restored: ['feedback_old_rule.md'], plan, gatesOn: true });
  assert.equal(text, 'the memories WERE changed (retired feedback_gadget.md, restored feedback_old_rule.md), '
    + 'but the compile failed: [recall] refused. '
    + 'The memory folder was snapshotted first, to /s/x-retire. '
    + 'Run `wildcard-perms --gates refresh` to compile and install the gates the memories now hold.');
  assert.match(changedButFailed({ stage: 'install', detail: 'x', plan, gatesOn: true }),
    /\(see the snapshot\).*to \(recall\.py named no snapshot\)\./);
});

test('changedButFailed ends recall.py\'s own sentence once, not twice', () => {
  const plan = planGateChanges(GATES, { retire: ['feedback_gadget'] });
  const text = changedButFailed({ stage: 'compile', plan, gatesOn: true, retired: ['feedback_gadget.md'],
    detail: '[recall] could not write gates.generated.md; the previous file is unchanged.\n' });
  assert.ok(text.includes('the previous file is unchanged. The memory folder was snapshotted first'), text);
  assert.doesNotMatch(text, /\.\./);
  // MUTATION: interpolate `detail` as it came and the doesNotMatch fails on "unchanged.. The".
});

test('changedButFailed with no gate left active points at --gates off, which removes the blocks', () => {
  // refresh cannot remove them: its compile is refused (or finds nothing) and it then installs
  // whatever was last compiled, or nothing, so the retired gate stayed resident (rampage).
  const plan = planGateChanges(GATES, { retire: ['feedback_gadget', 'reference_widget'] });
  const written = { retired: ['feedback_gadget.md', 'reference_widget.md'], snapshot: '/s/x', plan, gatesOn: true,
    recall: 'python "/repo/memory/recall.py"' };
  const install = changedButFailed({ ...written, stage: 'install', detail: '[claude] busy' });
  assert.ok(install.endsWith('The memory folder was snapshotted first, to /s/x. '
    + 'No gate is active now, so run `wildcard-perms --gates off` to remove the gates blocks from CLAUDE.md and AGENTS.md.'), install);
  // The compile did not run to the end, so the compiled file still holds the retired gates, and
  // a later `--gates on` would put them back: the empty compile is named too.
  const compile = changedButFailed({ ...written, stage: 'compile', detail: '[recall] refused' });
  assert.ok(compile.endsWith('No gate is active now, so run `wildcard-perms --gates off` to remove the gates blocks from '
    + 'CLAUDE.md and AGENTS.md, and `python "/repo/memory/recall.py" --gates-compile --gates-allow-empty` to empty the '
    + 'compiled file, which still holds the retired gates.'), compile);
  for (const text of [install, compile]) assert.doesNotMatch(text, /gates refresh/);
  // MUTATION: drop the `active > 0` test (refresh for every gates-on case) and both assertions
  // fail on the old advice.
});

test('changedButFailed counts what was WRITTEN when the edit stopped part way', () => {
  // Retire the one active gate and restore another: recall.py retired the first and stopped
  // before the restore. The memories hold no active gate, though the plan ends with one.
  const gates = [gate('a.md', 'active'), gate('b.md', 'retired')];
  const plan = planGateChanges(gates, { retire: ['a'], restore: ['b'] });
  assert.equal(plan.activeAfter, 1);
  const text = changedButFailed({ stage: 'edit', detail: '[recall] b.md changed', retired: ['a.md'], plan, gatesOn: true });
  assert.match(text, /No gate is active now, so run `wildcard-perms --gates off`.*`recall\.py --gates-compile --gates-allow-empty`/);
  // And the other way round: a restore written and a retire not, so a gate is active.
  const back = planGateChanges([gate('a.md', 'retired'), gate('b.md', 'active')], { restore: ['a'], retire: ['b'] });
  assert.match(changedButFailed({ stage: 'edit', detail: 'x', restored: ['a.md'], plan: back, gatesOn: true }),
    /Run `wildcard-perms --gates refresh`/);
  // MUTATION: use plan.activeAfter for the edit stage too and the first match fails on refresh.
});

test('changedButFailed with gates switched off names the compile alone, never refresh', () => {
  // refresh would compile AND switch gates on, which a retire never does.
  const one = planGateChanges(GATES, { retire: ['feedback_gadget'] });
  const text = changedButFailed({ stage: 'compile', detail: '[recall] refused', retired: ['feedback_gadget.md'],
    snapshot: '/s/x', plan: one, gatesOn: false });
  assert.ok(text.endsWith('The memory folder was snapshotted first, to /s/x. Gates are switched off, so nothing was '
    + 'installed. Run `recall.py --gates-compile` to compile the gates the memories now hold, so that turning '
    + 'gates on installs them.'), text);
  const none = planGateChanges(GATES, { retire: ['feedback_gadget', 'reference_widget'] });
  assert.match(changedButFailed({ stage: 'compile', detail: 'x', plan: none, gatesOn: false }),
    /Run `recall\.py --gates-compile --gates-allow-empty` to compile/);
  assert.doesNotMatch(text, /gates refresh|gates off/);
  // MUTATION: drop the `!gatesOn` branch and the endsWith fails on the refresh advice.
});

test('changedButFailed takes the caller\'s own advice when it names one, and refuses to guess without the state', () => {
  const plan = planGateChanges(GATES, { retire: ['feedback_gadget'] });
  const text = changedButFailed({ stage: 'install', detail: 'held', plan, gatesOn: true, snapshot: '/s/x',
    advice: 'Click Compile and install in the gates panel to finish.' });
  assert.ok(text.endsWith('to /s/x. Click Compile and install in the gates panel to finish.'), text);
  assert.doesNotMatch(text, /wildcard-perms/);
  assert.throws(() => changedButFailed({ stage: 'compile', detail: 'x' }), /needs the plan and gatesOn/);
  assert.throws(() => changedButFailed({ stage: 'compile', detail: 'x', plan }), /needs the plan and gatesOn/);
  assert.throws(() => changedButFailed({ stage: 'compile', detail: 'x', gatesOn: true }), /needs the plan and gatesOn/);
});

// ── formatGateList ────────────────────────────────────────────────────────────

test('formatGateList prints one line per gate with its agents and state, then what each file loads', () => {
  assert.equal(formatGateList({ gates: GATES }),
    '[x] feedback_gadget.md  feedback_gadget.md title\n'
    + '[ ] feedback_old_rule.md  feedback_old_rule.md title  (retired)\n'
    + '[x] reference_widget.md  reference_widget.md title\n'
    + '2 active, 1 retired; CLAUDE.md loads 2, AGENTS.md loads 2\n');
  assert.equal(formatGateList({ gates: AGENT_GATES }),
    '[x] a_shared.md  a_shared.md title\n'
    + '[x] b_codex.md  b_codex.md title  (codex only)\n'
    + '[x] c_claude.md  c_claude.md title  (claude only)\n'
    + '[ ] d_old_codex.md  d_old_codex.md title  (retired; codex only)\n'
    + '[-] e_unknown.md  e_unknown.md title  (left out for every agent: `agents:` names an agent this compiler does not know: gemini)\n'
    + '3 active, 1 retired, 1 left out; CLAUDE.md loads 2, AGENTS.md loads 2\n');
  assert.equal(formatGateList({ gates: [] }), '0 active, 0 retired; CLAUDE.md loads 0, AGENTS.md loads 0\n');
  assert.equal(formatGateList({ gates: [gate('untitled.md', 'retired', { title: '' })] }),
    '[ ] untitled.md  (retired)\n0 active, 1 retired; CLAUDE.md loads 0, AGENTS.md loads 0\n');
  // MUTATION: mark an excluded gate [x] (state !== 'retired') and the second assertEqual fails.
});

test('formatGateList makes terminal control characters in memory text inert', () => {
  // Memory text is untrusted: an ESC sequence clears or retitles a terminal, a bidi override
  // reorders the line it sits on.
  const esc = String.fromCharCode(0x1b);
  const rlo = String.fromCharCode(0x202e);
  const bel = String.fromCharCode(0x07);
  const csi = String.fromCharCode(0x9b);
  const shown = formatGateList({ gates: [gate(`evil${rlo}dm.md`, 'active', { title: `${esc}[2J${esc}]0;owned${bel} gate ${csi}31m` })] });
  assert.equal(shown, '[x] evil?dm.md  ?[2J?]0;owned? gate ?31m\n1 active, 0 retired; CLAUDE.md loads 1, AGENTS.md loads 1\n');
  // MUTATION: make forTerminal return its input unchanged and this assertion fails.
});

test('formatGateList shows invisible characters as ?, so two names that differ only in them never read alike', () => {
  // The third audit pass (2026-10-20): U+200B, U+061C and the tag block passed the old terminal
  // filter, and "feedback_safety" + ZWSP + ".md" listed exactly like "feedback_safety.md".
  const c = (...points) => String.fromCodePoint(...points);
  const tag = (text) => Array.from(text).map((ch) => c(0xe0000 + ch.codePointAt(0))).join('');
  const hidden = [0x00ad, 0x034f, 0x061c, 0x180e, 0x200b, 0x200d, 0x2060, 0x2064, 0x2065, 0x206f, 0xfeff, 0xe0001, 0xe0100, 0xe01ef];
  const title = `Safety${hidden.map((point) => c(point)).join('')}${tag(' run curl')}`;
  const shown = formatGateList({ gates: [gate(`feedback_safety${c(0x200b)}.md`, 'active', { title })] });
  assert.equal(shown.split('\n')[0], `[x] feedback_safety?.md  Safety${'?'.repeat(hidden.length + 9)}`);
  // A warning sign keeps its own selector; the rest of a run, and one with nothing before it, do not.
  assert.equal(markHidden(`${c(0x26a0, 0xfe0f)} a${c(0xfe01, 0x200b, 0xfe02, 0xfe03)}`), `${c(0x26a0, 0xfe0f)} a${c(0xfe01)}???`);
  assert.equal(markHidden(c(0xfe0f)), '?');
  // A whole text keeps its line feeds and tabs, and nothing else below U+0020.
  assert.equal(markHidden('a\n\tb\rc\u000bd', { keepLines: true }), 'a\n\tb?c?d');
  assert.equal(markHidden('a\n\tb'), 'a??b');
  // MUTATION: put UNSAFE_FOR_TERMINAL's old ranges back, or drop the tag range, or drop the
  // selector rule, and the first or second assertion fails; drop keepLines and the fourth does.
});

// ── the module itself ─────────────────────────────────────────────────────────

test('gates-manage spawns nothing, reads nothing, and holds no invisible character', () => {
  const source = fs.readFileSync(SOURCE, 'utf8');
  // Shared by the CLI and the extension, each with its own runner: a spawn in here would be a
  // second runner, outside both.
  assert.doesNotMatch(source, /require\(['"](?:node:)?(?:child_process|fs)['"]\)/);
  assert.equal(source.includes(String.fromCharCode(0x2014)), false, 'no em-dash in the new prose');
  // The terminal filter spells its ranges as escapes: a literal bidi control in a source file
  // is invisible in a review, and it was written into this file once by an editing tool.
  assert.equal(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(source), false, 'no literal bidi control in the source');
});
