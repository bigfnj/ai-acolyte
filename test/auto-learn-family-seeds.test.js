'use strict';

// The family tables in src/auto-learn.js are a BRAKE, not a grant list.
//
// `family-subcommand-unknown` fires when a root listed in FAMILY_ROOTS appears without a
// subcommand FAMILY_SUBCOMMANDS recognises, and that reason bars the candidate from
// auto-apply. So a subcommand-shaped tool that is MISSING from these tables does not fail
// safe: it generalizes to a bare `Bash(<root> *)`, the broadest rule the generalizer can
// emit, with nothing marking it for review.
//
// `pipx`, `rclone`, `uv` and `uvx` were added 2026-09-25 after the development box's real
// allow list was read: all four already held exactly that bare root grant. These tests pin
// the behaviour rather than the table contents, so they fail on the mutation that matters
// (deleting an entry) and not on an unrelated edit to the list.
//
// Each assertion names the mutation that kills it, and every one was made in turn and
// confirmed to fail exactly the named test.
//
// A sixth assertion was WRITTEN AND THEN DELETED: "none of these roots became
// auto-applicable". It passes, and it survived every single-edit mutation tried, including
// adding the root to AUTO_SUFFIX_CLOSED_ROOTS and to READ_ONLY_ROOTS. `autoSafe` is
// over-determined here (src/auto-learn.js:674 needs read-only risk AND knownReadOnly AND
// no structural block, and the family reasons gate it again downstream), so no one edit
// flips it. A test nothing can break reads as coverage without being coverage, which is
// worse than its absence.

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyInvocation } = require('../src/auto-learn');

const classify = (command, tool = 'Bash') =>
  classifyInvocation({ tool, command, source: 'claude' });

// root -> [a real subcommand, the rule it must produce]
const NARROWED = {
  uv: ['pip install ruff', 'Bash(uv pip *)'],
  pipx: ['install black', 'Bash(pipx install *)'],
  rclone: ['copy src dst', 'Bash(rclone copy *)'],
};

test('a recognised subcommand narrows the rule instead of granting the whole root', () => {
  for (const [root, [args, expected]] of Object.entries(NARROWED)) {
    const item = classify(`${root} ${args}`);
    // MUTATION: drop `${root}` from FAMILY_SUBCOMMANDS. prefixFor then falls back to
    // [root] and this becomes `Bash(${root} *)`, which is the pre-2026-09-25 behaviour.
    assert.equal(item.claudePermission, expected, `${root} must narrow to its subcommand`);
  }
});

test('an unrecognised subcommand is refused outright, not widened to the root', () => {
  for (const root of Object.keys(NARROWED)) {
    const item = classify(`${root} frobnicate whatever`);
    // MUTATION: drop `${root}` from FAMILY_ROOTS. `family-subcommand-unknown` stops
    // firing and claudePermission becomes `Bash(${root} *)` instead of null, silently
    // turning an unknown verb into a whole-root grant.
    assert.ok(
      item.reasons.includes('family-subcommand-unknown'),
      `${root} with an unknown subcommand must flag family-subcommand-unknown`,
    );
    assert.equal(item.claudePermission, null, `${root} must not fall back to a root rule`);
  }
});

test('uvx is a runner, classified like npx rather than as a root of its own', () => {
  const item = classify('uvx ruff check .');
  // MUTATION: drop 'uvx' from SHELL_WRAPPERS. risk falls back to 'unknown' and the
  // 'shell-wrapper' reason disappears, so `Bash(uvx *)` stops being held back at all.
  assert.equal(item.risk, 'shell', 'uvx fetches and runs an arbitrary package');
  assert.ok(item.reasons.includes('shell-wrapper'), 'uvx must be recognised as a wrapper');
});

test('rclone counts as a network root, like scp and the cloud CLIs', () => {
  const item = classify('rclone copy src dst');
  // MUTATION: drop 'rclone' from NETWORK_ROOTS. risk falls back to 'unknown', losing the
  // signal that this command moves data off the machine.
  assert.equal(item.risk, 'network');
});

test('the additions did not disturb an existing family', () => {
  // MUTATION: a stray edit to FAMILY_SUBCOMMANDS.docker while adding neighbours. This is
  // the regression guard for the edit itself, not for the new entries.
  assert.equal(classify('docker ps').claudePermission, 'Bash(docker ps *)');
  assert.equal(classify('git status').claudePermission, 'Bash(git status *)');
});

// `duckdb`, `hyperfine`, `just` and `make` were added to SHELL_WRAPPERS 2026-10-13, the
// BACKLOG entry "Three roots that fit neither family table" plus `make`. Until then all
// four classified as risk 'unknown' with only `unknown-command`, measured that day:
// `just build` -> `Bash(just *)`, unknown. Each runs work named by its argument (a
// recipe, a benchmarked command, SQL with `.shell`), so the executable that matters is
// not the root. The per-root evidence is in the comment above the table.
//
// One test per root, each checked in both shells and, for PowerShell, in the `.exe`
// spelling that normalizeRoot folds away. The permission is still emitted; what changes
// is that risk 'shell' and `shell-wrapper` hold it out of auto-apply and mark it for
// review, which is all SHELL_WRAPPERS membership has ever done.
const RUNNERS = {
  duckdb: '-c "SELECT 1"',
  hyperfine: "'sleep 1'",
  just: 'build',
  make: 'all',
};
for (const [root, args] of Object.entries(RUNNERS)) {
  test(`${root} is a runner in both shells, not an unknown root`, () => {
    for (const [tool, spelling] of [['Bash', root], ['PowerShell', root], ['PowerShell', `${root}.exe`]]) {
      const item = classify(`${spelling} ${args}`, tool);
      // MUTATION: drop '${root}' from SHELL_WRAPPERS (src/auto-learn.js). risk falls back
      // to 'unknown', `shell-wrapper` disappears and `unknown-command` comes back, so the
      // root grant is no longer held back for review. Confirmed 2026-10-13, one root at a
      // time: each removal failed this test for that root and no other.
      assert.ok(item.reasons.includes('shell-wrapper'),
        `${tool} ${spelling} must be recognised as a wrapper, got ${item.reasons.join(',')}`);
      assert.equal(item.risk, 'shell', `${tool} ${spelling} runs arbitrary work`);
      // No `autoSafe === false` assertion, for the reason recorded at the top of this
      // file: autoSafe is over-determined for these roots and no single edit flips it.
    }
  });
}

test('a root that merely contains a runner name is not a runner', () => {
  // The control for the four above. `cmake` contains `make` and is a real build tool
  // (the exporter's CLAUDE_REVIEWABLE_ROOTS lists it); it must stay an ordinary unknown
  // root, and so must an unrelated one.
  // MUTATION: match SHELL_WRAPPERS by suffix (`[...SHELL_WRAPPERS].some((w) =>
  // normalized.endsWith(w))`) instead of by membership. `cmake` then reads as `make`
  // and this fails. Confirmed 2026-10-13.
  for (const command of ['cmake --build build', 'tokei .']) {
    const item = classify(command);
    assert.equal(item.risk, 'unknown', `${command} must not be reclassified`);
    assert.ok(item.reasons.includes('unknown-command'), command);
    assert.ok(!item.reasons.includes('shell-wrapper'), command);
  }
});
