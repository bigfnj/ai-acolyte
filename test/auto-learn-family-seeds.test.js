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
