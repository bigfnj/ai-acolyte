'use strict';

// The starter pack is a seed, so it has to hold two properties that are easy to
// break when folding a real machine's list back into it:
//
//   1. Every entry is already in final wildcarded form, so `processAllowList`
//      passes the whole list through untouched. An entry that its own pass would
//      prune (a narrow `Bash(claude setup-token *)` sitting under a later
//      `Bash(claude *)`) makes --seed report phantom churn on a fresh machine.
//   2. Nothing in it is machine-specific. It travels to other workstations, so an
//      absolute path or an env-var-prefixed command would seed a permission that
//      cannot match anything there.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { processAllowList } = require('../src/permissions');

const pack = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'patterns', 'starter-pack.json'), 'utf8')
);

test('the starter pack is a list of unique permission strings', () => {
  assert.ok(Array.isArray(pack) && pack.length > 200, `pack has ${pack.length} entries`);
  assert.equal(new Set(pack).size, pack.length, 'duplicate entries');
  for (const entry of pack) {
    assert.equal(typeof entry, 'string');
    assert.ok(
      /^[A-Za-z][\w-]*(\(.+\))?$/s.test(entry) || /^mcp__/.test(entry),
      `not a permission: ${entry}`
    );
  }
});

test('the pack passes through its own generalizer unchanged', () => {
  const processed = processAllowList(pack);
  const pruned = pack.filter((entry) => !processed.includes(entry));
  const rewritten = processed.filter((entry) => !pack.includes(entry));
  assert.deepEqual(pruned, [], 'entries a seed would immediately prune');
  assert.deepEqual(rewritten, [], 'entries the generalizer would rewrite');
  assert.deepEqual(processed, pack, 'order must be stable too');
});

test('nothing in the pack is tied to one machine', () => {
  for (const entry of pack) {
    const inner = /^[A-Za-z][\w-]*\((.*)\)$/s.exec(entry)?.[1] ?? '';
    assert.ok(!/^[~/]/.test(inner), `absolute or home path: ${entry}`);
    assert.ok(!/^[A-Za-z]:[\\/]/.test(inner), `drive-letter path: ${entry}`);
    assert.ok(!/^["']/.test(inner), `quoted program: ${entry}`);
    assert.ok(!/^[A-Za-z_][A-Za-z0-9_]*=/.test(inner), `env-var prefix: ${entry}`);
  }
});

// Bash sits under Claude Code's built-in read-only set and, in an enterprise,
// a managed allow list; PowerShell has neither, so a user rule is the only
// layer that decides there. A pack weighted toward Bash spends its entries on
// the half where they matter least, so the two halves are kept in step by
// scripts/mirror-pack.js and this asserts the pack is closed under that rule.
test('the PowerShell half is in step with the Bash half', () => {
  const { mirrorTargets } = require('../scripts/mirror-pack');
  const { missing } = mirrorTargets(pack);
  assert.deepEqual(missing, [],
    `run "node scripts/mirror-pack.js --write" to add: ${missing.join(', ')}`);
});

test('mirroring never carries an interpreter or a bare family prefix across', () => {
  const { mirrorTargets, NEVER_MIRROR } = require('../scripts/mirror-pack');
  // Feed the rule entries it must refuse, and confirm it proposes nothing.
  const dangerous = [
    'Bash(bash *)', 'Bash(python *)', 'Bash(node *)', 'Bash(npx *)',
    'Bash(sudo *)', 'Bash(rm *)', 'Bash(curl *)', 'Bash(sops *)',
    'Bash(docker *)', 'Bash(pip *)', 'Bash(./build.sh *)',
  ];
  const { missing } = mirrorTargets(dangerous);
  assert.deepEqual(missing, [], 'none of these may gain a PowerShell twin');

  // And the refusal is a rule, not a coincidence: a plain cross-platform tool
  // in the same list does get mirrored.
  const mixed = mirrorTargets(['Bash(bash *)', 'Bash(ffprobe *)']);
  assert.deepEqual(mixed.missing, ['PowerShell(ffprobe *)']);
  assert.ok(NEVER_MIRROR.has('bash'));
});

// Decided 2026-10-13, one entry at a time (patterns/starter-pack.md, "Wrapper entries").
// Claude Code strips its fixed wrapper set before matching a Bash rule (docs, "Wrappers"),
// and its allow matcher also tries each rule against the command as written (read out of
// the 2.1.296 binary). So a rule naming a stripped wrapper adds nothing for a command the
// pack already allows, and for any other command it grants whatever the wrapper runs.
// The engineering record's "13 blanket wrapper grants" (bash, sh, python, node, npx,
// pwsh, powershell, PowerShell's `&`, ...) are the maintainer's call and are not touched.
test('the pack seeds no grant for a wrapper Claude Code strips, except the forms it keeps', () => {
  const { ruleMatches } = require('../src/permission-match');
  // MUTATION: put `Bash(timeout *)` back into patterns/starter-pack.json. This fails
  // naming it. Confirmed 2026-10-13.
  for (const wrapper of ['timeout', 'time', 'nice', 'nohup', 'stdbuf', 'builtin', 'noglob', 'command']) {
    assert.ok(!pack.includes(`Bash(${wrapper} *)`), `Bash(${wrapper} *) is a grant for whatever it wraps`);
  }
  // Their legitimate use is served by the inner command's own rule, which the pack seeds.
  assert.ok(pack.includes('Bash(npm *)'), 'precondition: the pack seeds npm');
  assert.equal(ruleMatches('Bash(npm *)', 'Bash(timeout 30 npm test)'), true);
  assert.equal(ruleMatches('Bash(npm *)', 'Bash(nohup npm start)'), true);
  assert.equal(ruleMatches('Bash(npm *)', 'Bash(command npm test)'), true);
  // Kept, because Claude Code matches these forms as themselves, so only such a rule covers
  // them. MUTATION: restore `Bash(command *)` in place of `Bash(command -v *)`. Both
  // assertions on it fail. Confirmed 2026-10-13.
  assert.ok(pack.includes('Bash(command -v *)'), 'the lookup form is not stripped');
  assert.equal(ruleMatches('Bash(command -v *)', 'Bash(command -v rg)'), true);
  assert.equal(ruleMatches('Bash(command -v *)', 'Bash(command rm -rf x)'), false, 'and runs nothing');
  assert.ok(pack.includes('Bash(xargs *)'), 'a flagged xargs is matched as xargs');
  assert.equal(ruleMatches('Bash(grep *)', 'Bash(xargs -0 grep x)'), false,
    'precondition: no inner rule covers a flagged xargs, which is why Bash(xargs *) stays');
  // Control: the maintainer-decided blanket grants are untouched. Read from the over-broad
  // diagnostic's own list since 2026-10-14 (the next test), so there is one copy of the 13.
  const { overBroadShellGrants } = require('../src/permission-summary');
  const { kept } = overBroadShellGrants(pack);
  assert.equal(kept.length, 13, `the pack holds every maintainer-kept grant: ${JSON.stringify(kept)}`);
});

// The pack seeds nothing the dashboard's over-broad-grant count then flags (2026-10-14).
// `Bash(export *)` had been in the pack since v1.0.0 and that count flagged it
// (`reserved-keyword`: `export` sets variables, `PATH` and `LD_PRELOAD` among them, for the
// next command on the line), so a fresh seed reported a problem the seed had created. The 13
// blanket grants the maintainer kept are not counted (src/permission-summary.js
// MAINTAINER_KEPT_GRANTS), and this is the drift guard for that list: it must expand to exactly
// the record's 13 and each must be in the pack.
test('the pack seeds no grant its own over-broad count flags, and the 13 kept grants are the record\'s', () => {
  const { overBroadShellGrants } = require('../src/permission-summary');
  // MUTATION: put "Bash(export *)" back into patterns/starter-pack.json. This fails naming
  // it. Confirmed 2026-10-14.
  assert.ok(!pack.includes('Bash(export *)'), 'Bash(export *) is a grant keyed on shell grammar');
  const report = overBroadShellGrants(pack);
  assert.deepEqual(report.entries, [], 'the over-broad count flags these seeded entries');
  // The record's heading, expanded: `Bash(bash|sh *)` is two grants.
  const record = fs.readFileSync(path.join(__dirname, '..', 'docs', 'engineering-record.md'), 'utf8');
  const section = /### The 13 blanket wrapper grants[^\r\n]*\r?\n\r?\n([\s\S]*?)\. Each is/.exec(record);
  assert.ok(section, 'precondition: the record still has its "The 13 blanket wrapper grants" entry');
  const decided = [...section[1].matchAll(/`(Bash|PowerShell)\(([^`]+) \*\)`/g)]
    .flatMap(([, tool, heads]) => heads.split('|').map((head) => `${tool}(${head} *)`));
  // MUTATION: drop 'PowerShell(node *)' from MAINTAINER_KEPT_GRANTS. 12 are kept and this
  // fails, as does the control in the test above. Confirmed 2026-10-14.
  assert.equal(decided.length, 13);
  assert.deepEqual([...report.kept].sort(), decided.sort());
});
