'use strict';

// RULE USAGE (src/rule-usage.js): how often each allow rule covered a call, over all Claude
// history. Its zeroes are offered for deletion, so the failure these tests are mostly about is a
// MISSED MATCH: a rule in use reported as having no use.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  ruleKey, allowFingerprint, trackedRule, probesFor, createRuleIndex, creditsFor,
  analyzeRuleUsage, countRuleUsage, summarizeRuleUsage, usesOf,
} = require('../src/rule-usage');
const { coversPermission } = require('../src/managed-policy');
const { scanHistoryFiles } = require('../src/history-adapters');

const call = (tool, command, extra = {}) => ({
  id: `obs-${Math.random().toString(36).slice(2)}`, source: 'claude', tool, command, status: 'success', ...extra,
});

test('a call becomes the permission strings Claude tests it against', () => {
  assert.deepEqual(probesFor(call('Bash', 'git status && npm test')), ['Bash(git status)', 'Bash(npm test)']);
  assert.deepEqual(probesFor(call('PowerShell', 'Get-ChildItem; Get-Date')), ['PowerShell(Get-ChildItem)', 'PowerShell(Get-Date)']);
  assert.deepEqual(probesFor(call('WebFetch', 'https://Docs.Example.com')), ['WebFetch(domain:docs.example.com)']);
  assert.deepEqual(probesFor(call('WebSearch', 'search')), ['WebSearch']);
  assert.deepEqual(probesFor(call('mcp__srv__tool', 'call')), ['mcp__srv__tool']);
  // A file-tool observation carries no path (src/tool-learn.js), so only the tool is known.
  assert.deepEqual(probesFor(call('Edit', 'file')), ['Edit']);
  assert.deepEqual(probesFor(call('Glob', 'x')), []);
  assert.deepEqual(probesFor(call('Bash', '   ')), []);
});

test('only rules a call can credit are tracked; the rest are never called unused', () => {
  for (const rule of ['Bash(git status *)', 'PowerShell(Get-Date)', 'Bash', 'mcp__srv__*', 'mcp__srv__tool',
    'WebSearch', 'WebFetch(domain:example.com)', 'WebFetch', 'Edit', 'Write']) {
    assert.equal(trackedRule(rule), true, rule);
  }
  // A path specifier needs the path the parser drops; Skill and the rest are not observed at all.
  for (const rule of ['Read(//c/Users/**)', 'Edit(src/**)', 'Skill(dataviz)', 'Glob', 'WebFetch(https://x)', '']) {
    assert.equal(trackedRule(rule), false, rule);
  }
});

test('a deny or ask rule, the user\'s or the managed policy\'s, takes the credit away from allow', () => {
  const allow = createRuleIndex(['Bash(git *)', 'Bash(npm test)']);
  const none = createRuleIndex([]);
  assert.deepEqual([...creditsFor(call('Bash', 'git push'), allow, none)], ['Bash(git *)']);
  assert.deepEqual([...creditsFor(call('Bash', 'git push'), allow, createRuleIndex(['Bash(git push *)']))], [],
    'witness:usage-blocked -- an allow rule was credited for a call a deny or ask rule decided');
  // Any segment, not all: `git status` is credited though `rm` prompted in the same call.
  const both = creditsFor(call('Bash', 'git status && rm -rf build'), allow, createRuleIndex(['Bash(rm *)']));
  assert.deepEqual([...both], ['Bash(git *)'],
    'witness:usage-any-segment -- a rule that allowed one segment was not credited because another prompted');
  // Once per call, however many segments it covered.
  assert.equal(creditsFor(call('Bash', 'git status; git log'), allow, none).size, 1);
});

test('a file-tool call credits a bare tool rule, and a managed verdict on its path blocks it', () => {
  const allow = createRuleIndex(['Edit', 'Write']);
  const none = createRuleIndex([]);
  assert.deepEqual([...creditsFor(call('Edit', 'file'), allow, none)], ['Edit']);
  assert.deepEqual([...creditsFor(call('Edit', 'file', { managedRule: 'Edit(**/*.ps1)' }), allow, none)], [],
    'a managed ask matched the path, so the prompt decided this call, not the bare rule');
});

// The index may only narrow by what coversPermission also requires. Every probe here is tested
// against the index and against a full scan of the same rules; any difference fails.
const DIFF_RULES = [
  'Bash(git status *)', 'Bash(git:*)', 'Bash(git)', 'Bash(rg *)', 'Bash(grep *)', 'Bash(* --version)',
  'Bash(npm*)', 'Bash(./build.sh *)', 'Bash("C:/Program Files/x.exe" *)', 'Bash(PYTHONPATH=src python *)',
  'Bash(cd *)', 'Bash', 'PowerShell(Get-ChildItem *)', 'PowerShell(get-date)', 'PowerShell(& *)',
  'mcp__srv__*', 'mcp__other__tool', 'WebSearch', 'WebFetch(domain:*.example.com)', 'WebFetch(domain:docs.example.com)',
  'Edit', 'Write',
];
const DIFF_PROBES = [
  'Bash(git status --short)', 'Bash(git log)', 'Bash(git)', 'Bash(timeout 5 rg needle)', 'Bash(xargs grep -l x)',
  'Bash(node --version)', 'Bash(npm test)', 'Bash(npx vitest)', 'Bash(./build.sh --release)',
  'Bash("C:/Program Files/x.exe" --flag)', 'Bash(PYTHONPATH=src python -m pytest)', 'Bash(cd /tmp)',
  'Bash(GIT_TRACE=1 git status)', 'Bash(nohup ./build.sh)', 'Bash(GIT status)', 'PowerShell(Get-ChildItem -Force)',
  'PowerShell(Get-Date)', 'PowerShell(& "C:/x.exe")', 'mcp__srv__run', 'mcp__other__tool', 'mcp__other__else',
  'WebSearch', 'WebFetch(domain:a.example.com)', 'WebFetch(domain:docs.example.com)', 'WebFetch(domain:evil.com)',
  'Edit', 'Write', 'Read',
];

test('the index finds exactly what a full scan finds, on every probe', () => {
  const index = createRuleIndex(DIFF_RULES);
  let matched = 0;
  for (const probe of DIFF_PROBES) {
    const full = DIFF_RULES.filter((rule) => coversPermission(rule, probe)).sort();
    const fast = index.covering(probe).slice().sort();
    assert.deepEqual(fast, full, `witness:usage-index -- the index and a full scan disagree on ${probe}`);
    assert.equal(index.covers(probe), full.length > 0, probe);
    matched += full.length ? 1 : 0;
  }
  assert.ok(matched >= 20, `precondition: the corpus exercises matches, not just misses (${matched})`);
  // The case a first-word bucket alone misses: Claude strips `timeout 5` before matching.
  assert.ok(index.covering('Bash(timeout 5 rg needle)').includes('Bash(rg *)'),
    'witness:usage-stripped -- a wrapped command did not credit the rule Claude matches it with');
});

function writeTranscript(file, calls) {
  const records = [];
  calls.forEach(([id, command, outcome, timestamp], index) => {
    records.push({ type: 'assistant', timestamp, message: { role: 'assistant', content: [
      { type: 'tool_use', id, name: 'Bash', input: { command } }] } });
    if (outcome) {
      records.push({ type: 'user', timestamp, message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: id, is_error: outcome === 'failed', content: `${'pad '.repeat(40)}${index}` }] } });
    }
  });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
}

function tempHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-rule-usage-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

test('a pass counts finished calls once, reads a capped file to its end, and stores no rule text', (t) => {
  const home = tempHome(t);
  const file = path.join(home, 'projects', 'p', 's1.jsonl');
  const calls = [];
  for (let i = 0; i < 60; i += 1) calls.push([`c${i}`, i % 2 ? 'git status' : 'npm test', 'success', `2026-10-0${1 + (i % 9)}T10:00:00Z`]);
  calls.push(['pending', 'git log', null, '2026-10-09T10:00:00Z']);
  writeTranscript(file, calls);
  const allow = ['Bash(git *)', 'Bash(npm test)', 'Bash(never used *)', 'Skill(x)'];
  const whole = analyzeRuleUsage({ allow, files: [file], scanner: scanHistoryFiles, ingestBytes: 0, now: 'T' });
  // A small cap makes the scanner stop part-way, so the pass has to resume from the cursor.
  const capped = analyzeRuleUsage({ allow, files: [file], scanner: scanHistoryFiles, ingestBytes: 2048, now: 'T' });
  assert.ok(fs.statSync(file).size > 4 * 2048, 'precondition: the file needs several capped passes');
  assert.deepEqual(capped.rules, whole.rules,
    'witness:usage-capped -- a file past the per-scan cap was counted short, or a call twice');
  assert.equal(whole.calls, 60, 'the call with no result is not counted');
  assert.equal(whole.rules[ruleKey('Bash(git *)')].uses, 30);
  assert.equal(whole.rules[ruleKey('Bash(npm test)')].uses, 30);
  assert.equal(whole.rules[ruleKey('Bash(never used *)')].uses, 0);
  assert.equal(whole.rules[ruleKey('Skill(x)')], undefined, 'an untracked rule is not counted at all');
  assert.equal(whole.since, '2026-10-01T10:00:00Z');
  assert.equal(whole.rules[ruleKey('Bash(git *)')].lastUsedAt, '2026-10-09T10:00:00Z');
  const text = JSON.stringify(whole);
  for (const leak of ['git', 'npm', 'never used', 'Skill', home]) assert.ok(!text.includes(leak), `the result carries "${leak}"`);
});

test('the summary sorts the live list into used, no use, untracked and not counted yet', () => {
  const saved = analyzeRuleUsage({
    allow: ['Bash(a *)', 'Bash(b *)'], files: ['f'], now: '2026-10-16T00:00:00Z',
    scanner: () => ({ cursors: {}, files: [{ mode: 'full' }], observations: [
      call('Bash', 'a 1', { id: 'x', timestamp: '2026-08-01T00:00:00Z' })] }),
  });
  const live = ['Bash(a *)', 'Bash(b *)', 'Bash(c *)', 'Read(//x/**)'];
  const summary = summarizeRuleUsage(live, saved, { now: Date.parse('2026-10-16T00:00:00Z') });
  assert.deepEqual([summary.used, summary.noUse, summary.untracked, summary.notCounted], [1, 1, 1, 1]);
  assert.deepEqual(summary.noUseRules, ['Bash(b *)']);
  assert.equal(summary.notLately, 1, 'last used in August, over 30 days before');
  assert.equal(summary.current, false, 'the list gained a rule since the count');
  assert.equal(summarizeRuleUsage(['Bash(a *)', 'Bash(b *)'], saved).current, true);
  assert.equal(usesOf('Bash(a *)', saved), 1);
  assert.equal(usesOf('Bash(c *)', saved), null);
  assert.equal(allowFingerprint(['Bash(b *)', 'Bash(a *)']), allowFingerprint(['Bash(a *)', 'Bash(b *)']), 'order-free');
  assert.equal(summarizeRuleUsage(live, null).counted, false);
});

test('countRuleUsage reads the live settings and the managed policy\'s ask and deny', (t) => {
  const home = tempHome(t);
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ permissions: {
    allow: ['Bash(git *)', 'Bash(curl *)'], deny: [], ask: [] } }));
  fs.writeFileSync(path.join(home, '.claude', 'remote-settings.json'), JSON.stringify({ permissions: { ask: ['Bash(curl *)'] } }));
  writeTranscript(path.join(home, '.claude', 'projects', 'p', 's.jsonl'), [
    ['a', 'git status', 'success', '2026-10-01T00:00:00Z'], ['b', 'curl https://x', 'success', '2026-10-01T00:00:00Z']]);
  const result = countRuleUsage({ home });
  assert.equal(result.managedPolicy, 'present');
  assert.equal(result.rules[ruleKey('Bash(git *)')].uses, 1);
  assert.equal(result.rules[ruleKey('Bash(curl *)')].uses, 0,
    'a managed ask decided the curl call, so the allow rule beneath it did nothing');
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{ not json');
  assert.throws(() => countRuleUsage({ home }), /JSON/, 'no rules to count against is an error, not a list of zeroes');
});

test('the pass runs on its own thread, and a thread ended early rejects instead of hanging', async (t) => {
  const { countOffThread } = require('../src/rule-usage');
  const home = tempHome(t);
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(git *)'] } }));
  writeTranscript(path.join(home, '.claude', 'projects', 'p', 's.jsonl'), [['a', 'git status', 'success', '2026-10-01T00:00:00Z']]);
  const result = await countOffThread({ home }).promise;
  assert.equal(result.rules[ruleKey('Bash(git *)')].uses, 1);
  assert.equal(result.calls, 1);
  // Teardown ends a pass in flight (extension.js deactivate); its promise must settle.
  const ended = countOffThread({ home });
  ended.terminate();
  await assert.rejects(ended.promise, /exited|terminat/i);
  // A settings file that cannot be read is an error on the thread too, not a list of zeroes.
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{');
  await assert.rejects(countOffThread({ home }).promise, /JSON/);
});

test('a call handed back again by a later pass is counted once', () => {
  // The scanner can return a finished call twice when a later slice re-reads an overlap or a
  // reconcile widens backwards (scanHistoryFiles); the pass dedupes by observation id per file.
  const finishedCall = call('Bash', 'git status', { id: 'same-call', timestamp: '2026-10-01T00:00:00Z' });
  const passes = [
    { cursors: { k: 1 }, files: [{ mode: 'partial' }], observations: [finishedCall] },
    { cursors: { k: 2 }, files: [{ mode: 'append' }], observations: [{ ...finishedCall }] },
  ];
  let pass = 0;
  const result = analyzeRuleUsage({ allow: ['Bash(git *)'], files: ['f'], scanner: () => passes[pass++] });
  assert.equal(pass, 2, 'precondition: the partial pass was followed by another');
  assert.equal(result.rules[ruleKey('Bash(git *)')].uses, 1,
    'witness:usage-dedupe -- a call returned by two passes was counted twice');
  assert.equal(result.calls, 1);
});
