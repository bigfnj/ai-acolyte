'use strict';

// The guidance block is written into the user's own instruction file, so the
// contract is narrow and absolute: it is fenced by markers, an unchanged block
// produces no write at all (this runs on every activation), a stale block is
// replaced rather than duplicated, and turning it off restores the file the user
// had byte for byte.

const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { removeDir } = require('./helpers/remove-dir');

const {
  BEGIN, END, guidanceBlock, hasGuidance, isCurrent, applyGuidance, guidanceStatus, setGuidance,
  guidanceTargets, installedGuidanceTargets, guidanceStatusAll, setGuidanceAll,
  createManagedBlock, escapeMarker, instructionLockPath,
} = require('../src/agent-guidance');
const { createPolicyLock } = require('../src/policy-lock');

const USER_TEXT = '# My global instructions\n\nAlways use the toolbox python.\n';

// Every scratch root this file creates, torn down once at the end. These three
// helpers are module-level and take no `t`, so a per-test t.after() would mean
// threading the context through every call site; one `after` hook over a registry
// is the smaller change. Measured before this: the suite left 3 directories in
// %TEMP% per run, and 798 had accumulated.
const scratchRoots = [];
after(async () => {
  for (const root of scratchRoots) {
    // removeDir waits out a Windows handle that can still be closing when we get here.
    try { await removeDir(root); }
    catch { /* a leaked temp dir must never fail the suite */ }
  }
});

function scratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-guidance-'));
  scratchRoots.push(root);
  return { root, file: path.join(root, 'CLAUDE.md'), backupDir: path.join(root, 'backups') };
}

test('the block is appended below the user text, and only once', () => {
  const first = applyGuidance(USER_TEXT, true);
  assert.equal(first.changed, true);
  assert.ok(first.text.startsWith(USER_TEXT), 'user text keeps its position at the top');
  assert.ok(hasGuidance(first.text));
  assert.ok(isCurrent(first.text));

  const again = applyGuidance(first.text, true);
  assert.equal(again.changed, false, 'an unchanged block must not produce a write');
  assert.equal(again.text, first.text);
  assert.equal(first.text.split(BEGIN).length - 1, 1, 'exactly one block');
});

test('a block from an older version is replaced, not duplicated', () => {
  const stale = `${USER_TEXT}\n${BEGIN}\n## Old wording that shipped in 1.0\n${END}\n`;
  assert.equal(hasGuidance(stale), true);
  assert.equal(isCurrent(stale), false);

  const refreshed = applyGuidance(stale, true);
  assert.equal(refreshed.changed, true);
  assert.equal(refreshed.text.split(BEGIN).length - 1, 1);
  assert.equal(isCurrent(refreshed.text), true);
  assert.ok(!refreshed.text.includes('Old wording'));
  assert.ok(refreshed.text.startsWith(USER_TEXT));
});

test('off is a byte-for-byte round trip of the user file', () => {
  const on = applyGuidance(USER_TEXT, true);
  const off = applyGuidance(on.text, false);
  assert.equal(off.changed, true);
  assert.equal(off.text, USER_TEXT);
  // Idempotent in that direction too.
  assert.equal(applyGuidance(off.text, false).changed, false);
});

test('an empty or absent file gets just the block', () => {
  const created = applyGuidance('', true);
  assert.equal(created.text, guidanceBlock());
  assert.equal(applyGuidance(created.text, false).text, '');
});

test('the block names the rules the generalizer cannot recover after the fact', () => {
  const block = guidanceBlock();
  assert.ok(block.startsWith(BEGIN));
  assert.ok(block.trimEnd().endsWith(END));
  for (const needle of ['One command per tool call', 'git -C', 'bare name', 'script']) {
    assert.ok(block.includes(needle), needle);
  }
  // Both agents are hurt by the same habit for different reasons, and the block
  // has to say why, or a Codex user reads it as someone else's rule.
  assert.ok(block.includes('argv prefix'), 'names the Codex mechanism');
  // It is loaded into every session, so it stays inside a MEMORY.md-sized budget.
  assert.ok(block.length < 2200, `block is ${block.length} bytes`);
});

test('a target is only written for an agent that is installed', (t) => {
  const box = scratch();
  const home = box.root;
  assert.deepEqual(guidanceTargets(home).map((target) => target.agent), ['claude', 'codex']);

  // A bare home has neither agent, so there is nothing to write to.
  assert.deepEqual(installedGuidanceTargets(home), []);
  assert.deepEqual(setGuidanceAll(true, { home, backupDir: box.backupDir }), []);

  // Claude only: ~/.codex is never conjured on a machine that has no Codex.
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  assert.deepEqual(installedGuidanceTargets(home).map((target) => target.agent), ['claude']);
  const claudeOnly = setGuidanceAll(true, { home, backupDir: box.backupDir });
  assert.deepEqual(claudeOnly.map((result) => result.agent), ['claude']);
  assert.equal(fs.existsSync(path.join(home, '.codex')), false);

  // Once Codex is present it gets the same block, and its own backup file.
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(home, '.codex', 'AGENTS.md'), '# Codex notes\n', 'utf8');
  const both = setGuidanceAll(true, { home, backupDir: box.backupDir });
  assert.deepEqual(both.map((result) => result.agent), ['claude', 'codex']);
  assert.equal(both[0].changed, false, 'Claude was already current');
  assert.equal(both[1].changed, true);
  assert.ok(hasGuidance(fs.readFileSync(path.join(home, '.codex', 'AGENTS.md'), 'utf8')));
  // Codex had content, so it was copied aside under its own name — the two files
  // must never share one backup slot. Claude's was created from nothing, so there
  // was nothing to preserve.
  assert.equal(
    fs.readFileSync(path.join(box.backupDir, 'AGENTS.md.pre-guidance'), 'utf8'),
    '# Codex notes\n'
  );
  assert.equal(fs.existsSync(path.join(box.backupDir, 'CLAUDE.md.pre-guidance')), false);

  const states = guidanceStatusAll(home);
  assert.deepEqual(states.map((state) => [state.agent, state.on, state.current]), [
    ['claude', true, true],
    ['codex', true, true],
  ]);

  // And off clears both, leaving each file as its owner had it.
  setGuidanceAll(false, { home, backupDir: box.backupDir });
  assert.equal(fs.readFileSync(path.join(home, '.codex', 'AGENTS.md'), 'utf8'), '# Codex notes\n');
  assert.deepEqual(guidanceStatusAll(home).map((state) => state.on), [false, false]);
});

test('default guidance uses CODEX_HOME while explicit home stays isolated', (t) => {
  const box = scratch();
  const home = box.root;
  const profile = path.join(home, 'active-codex-profile');
  const defaultFile = path.join(home, '.codex', 'AGENTS.md');
  const customFile = path.join(profile, 'AGENTS.md');
  fs.mkdirSync(path.dirname(defaultFile), { recursive: true });
  fs.mkdirSync(profile);
  fs.writeFileSync(defaultFile, '# Default profile notes\n');
  fs.writeFileSync(customFile, '# Custom profile notes\n');
  t.mock.method(os, 'homedir', () => home);
  const prior = process.env.CODEX_HOME;
  process.env.CODEX_HOME = profile;
  t.after(() => {
    if (prior === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prior;
  });
  const active = setGuidanceAll(true).find((result) => result.agent === 'codex');
  assert.equal(active.path, customFile);
  assert.equal(active.error, null);
  assert.equal(guidanceStatusAll().find((state) => state.agent === 'codex').on, true);
  assert.equal(fs.readFileSync(defaultFile, 'utf8'), '# Default profile notes\n');
  assert.ok(fs.existsSync(path.join(home, '.claude', 'backups', 'AGENTS.md.pre-guidance')),
    'default backups belong to the selected user home');

  const explicit = setGuidanceAll(true, { home }).find((result) => result.agent === 'codex');
  assert.equal(explicit.path, defaultFile, 'explicit home must not follow the ambient profile');
  assert.ok(hasGuidance(fs.readFileSync(defaultFile, 'utf8')));
});

test('guidance moves its hidden base block into the active override and removes both copies on off', () => {
  const box = scratch();
  const profile = path.join(box.root, 'custom-codex');
  fs.mkdirSync(profile);
  const regular = path.join(profile, 'AGENTS.md');
  const override = path.join(profile, 'AGENTS.override.md');
  const overrideText = '# Temporary override\nKeep this user instruction.\n';
  fs.writeFileSync(regular, applyGuidance(USER_TEXT, true).text);
  fs.writeFileSync(override, overrideText);
  const options = { home: box.root, codexHome: profile };
  const before = guidanceStatusAll(options).find((state) => state.agent === 'codex');
  assert.equal(before.path, override);
  assert.equal(before.on, false, 'a hidden base block is not active guidance');
  assert.deepEqual(before.shadowedPaths, [regular]);
  const enabled = setGuidanceAll(true, options).find((result) => result.agent === 'codex');
  assert.equal(enabled.error, null);
  assert.equal(enabled.path, override);
  assert.equal(enabled.on, true);
  assert.equal(fs.readFileSync(regular, 'utf8'), USER_TEXT, 'only the hidden managed block is removed');
  assert.ok(fs.readFileSync(override, 'utf8').startsWith(overrideText));
  assert.equal(setGuidanceAll(true, options).find((result) => result.agent === 'codex').changed, false);
  assert.equal(guidanceStatusAll(options).find((state) => state.agent === 'codex').current, true);
  assert.ok(fs.existsSync(path.join(box.root, '.claude', 'backups', 'AGENTS.override.md.pre-guidance')));

  // A stale base copy from an older installation must not return after off.
  fs.writeFileSync(regular, applyGuidance(USER_TEXT, true).text);
  const disabled = setGuidanceAll(false, options).find((result) => result.agent === 'codex');
  assert.equal(disabled.error, null);
  assert.equal(disabled.on, false);
  assert.equal(fs.readFileSync(regular, 'utf8'), USER_TEXT);
  assert.equal(fs.readFileSync(override, 'utf8'), overrideText);
});

test('empty overrides remain empty so enabling guidance does not hide base instructions', () => {
  for (const empty of ['', ' \n\t\n']) {
    const box = scratch();
    const profile = path.join(box.root, '.codex');
    fs.mkdirSync(profile);
    const regular = path.join(profile, 'AGENTS.md');
    const override = path.join(profile, 'AGENTS.override.md');
    fs.writeFileSync(regular, USER_TEXT);
    fs.writeFileSync(override, empty);
    const result = setGuidanceAll(true, { home: box.root }).find((row) => row.agent === 'codex');
    assert.equal(result.path, regular);
    assert.equal(result.error, null);
    assert.ok(hasGuidance(fs.readFileSync(regular, 'utf8')));
    assert.equal(fs.readFileSync(override, 'utf8'), empty);
  }
});

test('an unreadable override is reported without writing a hidden fallback block', () => {
  const box = scratch();
  const profile = path.join(box.root, '.codex');
  const override = path.join(profile, 'AGENTS.override.md');
  const regular = path.join(profile, 'AGENTS.md');
  // A directory gives a deterministic read error on Windows without ACL changes.
  fs.mkdirSync(override, { recursive: true });
  fs.writeFileSync(regular, USER_TEXT);
  const status = guidanceStatusAll(box.root).find((row) => row.agent === 'codex');
  assert.equal(status.readable, false);
  assert.match(status.error, /cannot inspect Codex instruction override/);
  const result = setGuidanceAll(true, { home: box.root }).find((row) => row.agent === 'codex');
  assert.equal(result.changed, false);
  assert.match(result.error, /cannot inspect Codex instruction override/);
  assert.equal(fs.readFileSync(regular, 'utf8'), USER_TEXT);
});

test('off clears both files when removing the override block activates the base file', () => {
  const box = scratch();
  const profile = path.join(box.root, '.codex');
  fs.mkdirSync(profile);
  const regular = path.join(profile, 'AGENTS.md');
  const override = path.join(profile, 'AGENTS.override.md');
  fs.writeFileSync(regular, applyGuidance(USER_TEXT, true).text);
  fs.writeFileSync(override, guidanceBlock());
  const result = setGuidanceAll(false, { home: box.root }).find((row) => row.agent === 'codex');
  assert.equal(result.path, regular, 'empty override now falls through to the base');
  assert.equal(result.on, false);
  assert.equal(result.error, null);
  assert.equal(fs.readFileSync(override, 'utf8'), '');
  assert.equal(fs.readFileSync(regular, 'utf8'), USER_TEXT);
});

test('guidance cleanup preserves an override that becomes active after discovery', (t) => {
  const box = scratch();
  const profile = path.join(box.root, '.codex');
  fs.mkdirSync(profile);
  const regular = path.join(profile, 'AGENTS.md');
  const override = path.join(profile, 'AGENTS.override.md');
  const newOverride = applyGuidance('# Newly active override\n', true).text;
  fs.writeFileSync(regular, USER_TEXT);
  fs.writeFileSync(override, '');
  const read = fs.readFileSync;
  let injected = false;
  t.mock.method(fs, 'readFileSync', function(file, ...args) {
    const content = read.call(this, file, ...args);
    if (file === override && !injected && hasGuidance(read(regular, 'utf8'))) {
      // Discovery receives its previous empty read; another writer then makes
      // the override active before the inactive-file cleanup takes its lock.
      injected = true;
      fs.writeFileSync(override, newOverride);
    }
    return content;
  });
  const result = setGuidanceAll(true, { home: box.root }).find((row) => row.agent === 'codex');
  assert.equal(injected, true, 'the selection must actually change during this write');
  assert.match(result.error, /selection changed during the update/);
  assert.equal(fs.readFileSync(override, 'utf8'), newOverride,
    'cleanup must not remove the managed block from the newly active override');
});

test('setGuidance writes the file, backs up what was there, and reports state', () => {
  const box = scratch();
  fs.writeFileSync(box.file, USER_TEXT, 'utf8');

  assert.deepEqual(guidanceStatus(box.file), {
    path: box.file, readable: true, on: false, current: false,
  });

  const on = setGuidance(true, { file: box.file, backupDir: box.backupDir });
  assert.equal(on.changed, true);
  assert.equal(on.error, null);
  assert.ok(hasGuidance(fs.readFileSync(box.file, 'utf8')));
  assert.equal(fs.readFileSync(path.join(box.backupDir, 'CLAUDE.md.pre-guidance'), 'utf8'), USER_TEXT);

  const status = guidanceStatus(box.file);
  assert.equal(status.on, true);
  assert.equal(status.current, true);

  assert.equal(setGuidance(true, { file: box.file, backupDir: box.backupDir }).changed, false);

  const off = setGuidance(false, { file: box.file, backupDir: box.backupDir });
  assert.equal(off.changed, true);
  assert.equal(fs.readFileSync(box.file, 'utf8'), USER_TEXT);
});

// Five writers share ~/.claude/CLAUDE.md — `--guidance` and `--gates` from the CLI, the
// extension's two toggles, and the derived-guidance reconcile — and each of them reads the
// whole file, computes a whole new one and writes it back. A write landing inside another
// writer's read-to-write window is not merged, it is erased, and the single-slot backup
// then copies the damage over the good copy on the next toggle. So the contract is: a
// contended file is REPORTED and left exactly as it was.
test('a second writer of the same instruction file is refused, and changes nothing', () => {
  const box = scratch();
  fs.writeFileSync(box.file, USER_TEXT, 'utf8');
  const other = path.join(box.root, 'AGENTS.md');
  fs.writeFileSync(other, USER_TEXT, 'utf8');

  createPolicyLock({ lockPath: instructionLockPath(box.file) }).locked(() => {
    const blocked = setGuidance(true, { file: box.file, backupDir: box.backupDir });
    assert.equal(blocked.changed, false);
    assert.match(blocked.error, /being written by another/);
    assert.equal(fs.readFileSync(box.file, 'utf8'), USER_TEXT,
      'the contended file keeps every byte it had');
    assert.equal(fs.existsSync(box.backupDir), false,
      'and no backup was taken, so the good copy is still the good copy');

    // Per FILE, not one global lock: CLAUDE.md and AGENTS.md share no state, and
    // setGuidanceAll writes them in a loop. Serialising those would be a lock this
    // feature does not need.
    assert.equal(setGuidance(true, { file: other, backupDir: box.backupDir }).changed, true,
      'a different instruction file is not blocked by this one');
  });

  // Released with the callback, so the next attempt goes through.
  assert.equal(setGuidance(true, { file: box.file, backupDir: box.backupDir }).changed, true);
  assert.equal(fs.existsSync(instructionLockPath(box.file)), false,
    'the lock file does not outlive the write');
});

// The instruction-file lock is the one caller of policy-lock's `reclaimLiveWhenStale`. A
// holder killed mid-write leaves a lock whose pid can belong to an unrelated live process by
// the time anyone looks (rampage 7139659 measured it refusing every gates write for an hour).
// The work under this lock takes milliseconds, so past its 30 s window the lock goes.
test('an instruction lock older than its window is reclaimed even when its pid answers', () => {
  const box = scratch();
  fs.writeFileSync(box.file, USER_TEXT, 'utf8');
  const lockPath = instructionLockPath(box.file);
  const plant = (ageMs) => {
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, owner: 'reused-pid' }) + '\n');
    const when = new Date(Date.now() - ageMs);
    fs.utimesSync(lockPath, when, when);
  };
  plant(5_000);
  assert.match(setGuidance(true, { file: box.file, backupDir: box.backupDir }).error, /being written by another/,
    'inside the window the holder may be real');
  assert.equal(fs.readFileSync(box.file, 'utf8'), USER_TEXT);
  plant(60_000);
  const row = setGuidance(true, { file: box.file, backupDir: box.backupDir });
  assert.equal(row.error, null, 'a minute-old lock with a live pid is a dead holder\'s');
  assert.equal(row.changed, true);
  assert.equal(fs.existsSync(lockPath), false, 'and the reclaimed lock is released after the write');

  // MUTATION: drop `reclaimLiveWhenStale: true` from withInstructionLock in
  // src/agent-guidance.js and the second setGuidance reports "being written by another".
});

test('a missing CLAUDE.md is created rather than treated as an error', () => {
  const box = scratch();
  const result = setGuidance(true, { file: box.file, backupDir: box.backupDir });
  assert.equal(result.changed, true);
  assert.equal(result.error, null);
  assert.equal(fs.readFileSync(box.file, 'utf8'), guidanceBlock());
  // Nothing to back up when there was no file.
  assert.equal(fs.existsSync(box.backupDir), false);
});

// ── Removal arithmetic ────────────────────────────────────────────────────────
// Both newline sweeps used to eat EVERY adjacent newline and only the
// end-of-file case put one back, so a block with the user's own text above AND
// below it fused two of their lines into one. It read as harmless because the
// block this repo installs lands at line 1 on the author's machine, where the
// leading sweep is a no-op; any content above the block arms it.

const count = (text, needle) => text.split(needle).length - 1;

// A stand-in for the gates block: same plumbing, its own marker pair. Used
// rather than agent-gates so these assertions do not depend on a compiled
// corpus existing anywhere.
const SECOND = createManagedBlock({
  begin: '<!-- BEGIN permission-wildcarding: second block (managed) -->',
  end: '<!-- END permission-wildcarding: second block -->',
  body: () => '## A second managed block\n\nInstalled below the first one.',
});

test('removal keeps exactly one separator wherever the block sits', () => {
  // Mid-file, the measured failure: "my own notesmore of my notes\n".
  const middle = `my own notes\n\n${BEGIN}\nMANAGED\n${END}\n\nmore of my notes\n`;
  assert.equal(applyGuidance(middle, false).text, 'my own notes\n\nmore of my notes\n');

  // Single-newline separation stays single: a blank line the user did not have
  // must not be invented either.
  const tight = `top\n${BEGIN}\nMANAGED\n${END}\nbottom\n`;
  assert.equal(applyGuidance(tight, false).text, 'top\nbottom\n');

  // Start of file: nothing above to separate from, so the run below the block
  // was all the block's own and the file must not open with a blank line.
  const first = `${BEGIN}\nMANAGED\n${END}\n\nmy own notes\n`;
  assert.equal(applyGuidance(first, false).text, 'my own notes\n');
  assert.equal(applyGuidance(`${BEGIN}\nMANAGED\n${END}\n`, false).text, '');

  // End of file: a text file keeps its final newline, and exactly one.
  const last = `my own notes\n\n${BEGIN}\nMANAGED\n${END}\n`;
  assert.equal(applyGuidance(last, false).text, 'my own notes\n');

  // No block, no write.
  assert.deepEqual(applyGuidance('my own notes\n', false),
    { changed: false, text: 'my own notes\n' });
});

// The run of newlines immediately above the block's begin marker.
const runAbove = (text) => {
  const at = text.indexOf(BEGIN);
  let run = 0;
  while (at - run - 1 >= 0 && text[at - run - 1] === '\n') run += 1;
  return run;
};

// The one round trip that is NOT byte-exact, pinned so it stays a decision rather than a
// surprise. The suite header above claims "turning it off restores the file the user had
// byte for byte", and for a file whose last line is blank that is false by construction.
test('a trailing blank line is normalised away, and the install is why it must be', () => {
  const blankAtEnd = 'my own notes\n\n';
  const installed = applyGuidance(blankAtEnd, true);
  assert.equal(installed.text, `${blankAtEnd}${guidanceBlock()}`,
    'the install reuses the blank line the file already ended with, adding none of its own');
  assert.equal(applyGuidance(installed.text, false).text, 'my own notes\n');

  // A file ending with a single newline round-trips exactly...
  const oneNewline = 'my own notes\n';
  const tidy = applyGuidance(oneNewline, true);
  assert.equal(tidy.text, `my own notes\n\n${guidanceBlock()}`);
  assert.equal(applyGuidance(tidy.text, false).text, oneNewline);

  // ...and this is the whole reason the other cannot. Both spellings reach removal with
  // the same run above the block, so no removal rule can send them to different places:
  // exactness for one is a lost byte for the other, and the single trailing newline wins.
  assert.equal(runAbove(installed.text), runAbove(tidy.text),
    'the two inputs are indistinguishable by the time removal sees them');
});

test('off with a second managed block below it leaves that block on its own line', () => {
  // `--guidance off` while the gates or a derived block is installed is a
  // documented, supported combination, and it produced
  // "user preamble<!-- BEGIN ...": the removal ate the blank line AND the
  // newline that ended the user's own last line, so the surviving block's begin
  // marker was appended mid-line, where it is no longer a marker at all.
  const preamble = '# my own instructions\n\nAlways use the toolbox python.\n';
  const withShell = applyGuidance(preamble, true).text;
  const withBoth = SECOND.apply(withShell, true).text;
  assert.ok(withBoth.startsWith(preamble));

  const shellGone = applyGuidance(withBoth, false);
  assert.equal(shellGone.changed, true);
  assert.equal(hasGuidance(shellGone.text), false);
  assert.ok(SECOND.has(shellGone.text));
  // Byte-identical to having installed only the second block: removing the
  // first is a true round trip even with a managed block adjacent to it.
  assert.equal(shellGone.text, SECOND.apply(preamble, true).text);
  assert.ok(shellGone.text.startsWith(`${preamble}\n<!-- BEGIN permission-wildcarding: second block`));
  // And the survivor comes off leaving the user's own file, byte for byte.
  assert.equal(SECOND.apply(shellGone.text, false).text, preamble);
  // Removing the LAST of the two is the end-of-file case, and restores the
  // file as it stood with only the first block installed.
  assert.equal(SECOND.apply(withBoth, false).text, withShell);
});

test('a body that quotes the markers cannot truncate its own block', () => {
  // The gates body is compiled from the user's memory corpus and a derived body
  // embeds managed rule text, so a body documenting this very feature quotes the
  // markers. `blockRange` took the FIRST end marker after begin, so the range
  // stopped inside the body: a rewrite replaced only the truncated range and
  // left the rest of the old body plus an orphaned end marker behind, and since
  // the reinstalled body carried that inner marker again, every pass appended
  // another copy. `off` removed only as far as the first inner marker, which
  // made the junk permanent.
  const hostile = `## Gate: managed blocks\n\n- The fence is ${BEGIN} ... ${END} and nothing else.`;
  const block = createManagedBlock({ begin: BEGIN, end: END, body: () => hostile });

  const on = block.apply(USER_TEXT, true);
  assert.equal(on.changed, true);
  assert.equal(count(on.text, BEGIN), 1, 'exactly one begin marker survives the body');
  assert.equal(count(on.text, END), 1, 'and exactly one end marker');
  // Neutralised, not dropped: refusing the block would cost a user whose memory
  // documents this feature all of their gates, so the text stays readable.
  assert.ok(on.text.includes(escapeMarker(BEGIN)), 'the quoted begin marker is still legible');
  assert.ok(on.text.includes(escapeMarker(END)));
  assert.ok(block.isCurrent(on.text));

  // The accumulation: every later pass used to append another body tail.
  const second = block.apply(on.text, true);
  assert.equal(second.changed, false, 'a marker-carrying body must still settle');
  assert.equal(block.apply(second.text, true).text, on.text);
  assert.equal(count(on.text, END), 1);

  // And it is removable, which the truncated range made impossible.
  assert.equal(block.apply(on.text, false).text, USER_TEXT);
});

// ── Ported from rampage 7139659 (test/managed-block.test.js) ─────────────────────
// Rampage hardened its copy of this module after it split off. The cases below are its
// tests, driven through this module's API: setGuidance and guidanceStatus for the file
// plumbing, the shell block's apply for the arithmetic. Not ported: the legacy-marker and
// `escape` cases (AI Acolyte has no legacy block to migrate), requireBlock (this API
// defaults the block), and "a real symbolic link survives the write", which needs the
// symlink privilege Windows reserves for an elevated or Developer Mode session; the two
// stand-in symlink tests below cover the same code path without it.

// A busy lock on Windows is not always EEXIST: a lock its holder has just unlinked is
// delete-pending until the last handle closes, and creating it then fails with EPERM.
// That used to escape the writer as an uncaught throw (rampage: 7 crashes in 480 racing
// CLI writes).
test('a lock that cannot be created for a sharing reason is a busy row, not a crash', (t) => {
  const box = scratch();
  fs.writeFileSync(box.file, USER_TEXT, 'utf8');
  const lockPath = instructionLockPath(box.file);
  const realOpen = fs.openSync;
  t.mock.method(fs, 'openSync', (target, ...rest) => {
    if (path.resolve(String(target)) === lockPath) {
      throw Object.assign(new Error(`EPERM: operation not permitted, open '${lockPath}'`), { code: 'EPERM' });
    }
    return realOpen(target, ...rest);
  });
  const row = setGuidance(true, { file: box.file, backupDir: box.backupDir });
  assert.equal(row.changed, false);
  assert.match(row.error, /being written by another permission-wildcarding process \(EPERM creating the lock\)/);
  assert.equal(fs.readFileSync(box.file, 'utf8'), USER_TEXT);
  assert.equal(fs.existsSync(box.backupDir), false);

  // MUTATION: make isContended in src/policy-lock.js answer EEXIST alone (the pre-port rule)
  // and setGuidance throws the EPERM instead of returning this row.
});

test('a file that is not UTF-8 text is refused byte for byte, and nothing is backed up', () => {
  // Measured by rampage before the fix: the decode swapped each invalid byte for U+FFFD and
  // the write-back carried it into the user's text and into the backup, so the original
  // bytes could not be recovered from either.
  const cases = {
    // Windows PowerShell 5.1 Set-Content's ANSI: "Café".
    cp1252: Buffer.concat([Buffer.from('# notes\r\n\r\nCaf'), Buffer.from([0xe9]), Buffer.from(' au lait\r\n')]),
    // Its Out-File default, and Notepad's "Unicode".
    utf16le: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('# notes\r\n\r\nMy rules\r\n', 'utf16le')]),
    // UTF-16 with no byte-order mark is valid UTF-8 byte by byte, NULs and all.
    utf16leNoMark: Buffer.from('# notes\r\n\r\nMy rules\r\n', 'utf16le'),
  };
  for (const [name, bytes] of Object.entries(cases)) {
    const box = scratch();
    fs.writeFileSync(box.file, bytes);
    const status = guidanceStatus(box.file);
    assert.equal(status.readable, false, `${name}: status says it cannot be read as text`);
    assert.match(status.error, /is not UTF-8 text/, name);
    for (const on of [true, false]) {
      const row = setGuidance(on, { file: box.file, backupDir: box.backupDir });
      assert.equal(row.changed, false, name);
      assert.match(row.error, /is not UTF-8 text.*save it as UTF-8/, name);
    }
    assert.deepEqual(fs.readFileSync(box.file), bytes, `${name}: every byte is where it was`);
    assert.equal(fs.existsSync(box.backupDir), false, `${name}: and no backup was taken`);
  }

  // A UTF-8 file with a byte-order mark and CRLF lines is UTF-8: written, and both backups
  // hold its exact bytes.
  const box = scratch();
  const bytes = Buffer.from(`${String.fromCharCode(0xfeff)}# notes\r\n\r\nCafé\r\n`, 'utf8');
  fs.writeFileSync(box.file, bytes);
  assert.equal(setGuidance(true, { file: box.file, backupDir: box.backupDir }).error, null);
  assert.deepEqual(fs.readFileSync(path.join(box.backupDir, 'CLAUDE.md.pre-guidance')), bytes);
  assert.deepEqual(fs.readFileSync(path.join(box.backupDir, 'CLAUDE.md.pre-guidance-prev')), bytes);

  // MUTATION: drop the `Buffer.from(text, 'utf8').equals(raw)` test from readInstructionFile
  // and the cp1252 and utf16le cases are written. Drop `raw.includes(0)` instead and only
  // utf16leNoMark is.
});

// AI Acolyte's adaptation: Codex reads AGENTS.override.md OR AGENTS.md, and setGuidanceAll
// sweeps the inactive one for a stale copy of the block. Refusing every non-UTF-8 file
// outright would have let an inactive UTF-16 AGENTS.md, which holds no block, stop guidance
// being installed in the active override at all.
test('an inactive Codex file that is not UTF-8 and holds no block blocks nothing', () => {
  const box = scratch();
  const profile = path.join(box.root, '.codex');
  fs.mkdirSync(profile);
  const regular = path.join(profile, 'AGENTS.md');
  const override = path.join(profile, 'AGENTS.override.md');
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('# base notes\r\n', 'utf16le')]);
  fs.writeFileSync(regular, utf16);
  fs.writeFileSync(override, '# Active override\n');
  const status = guidanceStatusAll(box.root).find((row) => row.agent === 'codex');
  assert.equal(status.error, undefined, 'status reads the active override and is not stopped by the base');
  const row = setGuidanceAll(true, { home: box.root }).find((r) => r.agent === 'codex');
  assert.equal(row.error, null);
  assert.equal(row.path, override);
  assert.ok(hasGuidance(fs.readFileSync(override, 'utf8')));
  assert.deepEqual(fs.readFileSync(regular), utf16, 'the inactive file keeps every byte');
  assert.equal(setGuidanceAll(false, { home: box.root }).find((r) => r.agent === 'codex').error, null,
    'and off, which sweeps both files, is not stopped by it either');
  assert.deepEqual(fs.readFileSync(regular), utf16);

  // MUTATION: make blocksCleanup in src/agent-guidance.js return `!state.readable` and the
  // install reports "is not UTF-8 text" for the file it was never going to write.
});

// The two mocks below stand a regular file in for the link, so this runs without the
// privilege Windows wants for creating a symbolic link.
function pretendSymlink(t, link, target) {
  const realLstat = fs.lstatSync;
  const realRealpath = fs.realpathSync;
  const isLink = (file) => path.resolve(String(file)) === path.resolve(link);
  t.mock.method(fs, 'lstatSync', (file, ...rest) => (isLink(file)
    ? { isSymbolicLink: () => true } : realLstat(file, ...rest)));
  t.mock.method(fs, 'realpathSync', (file, ...rest) => {
    if (!isLink(file)) return realRealpath(file, ...rest);
    if (target === null) throw Object.assign(new Error(`ENOENT: no such file, realpath '${link}'`), { code: 'ENOENT' });
    return target;
  });
}

test('a symlinked instruction file is written through to its target, and locked there', (t) => {
  const box = scratch();
  const target = path.join(box.root, 'dotfiles', 'CLAUDE.md');
  fs.mkdirSync(path.dirname(target));
  fs.writeFileSync(target, USER_TEXT, 'utf8');
  fs.writeFileSync(box.file, 'the link itself\n', 'utf8');
  pretendSymlink(t, box.file, target);

  assert.equal(instructionLockPath(box.file), `${target}.wildcarding.lock`,
    'the lock sits beside the file the write lands in, whichever name a writer used');
  createPolicyLock({ lockPath: `${target}.wildcarding.lock` }).locked(() => {
    assert.match(setGuidance(true, { file: box.file, backupDir: box.backupDir }).error,
      /being written by another/);
  });

  const row = setGuidance(true, { file: box.file, backupDir: box.backupDir });
  assert.deepEqual([row.changed, row.error, row.path], [true, null, box.file], 'reported under the name it was given');
  assert.ok(hasGuidance(fs.readFileSync(target, 'utf8')), 'the target holds the block');
  assert.equal(fs.readFileSync(box.file, 'utf8'), 'the link itself\n', 'and the link was not replaced');
  assert.equal(fs.readFileSync(path.join(box.backupDir, 'CLAUDE.md.pre-guidance'), 'utf8'), USER_TEXT,
    'the backup is the target\'s content, under the link\'s name');
  assert.deepEqual(fs.readdirSync(path.dirname(target)), ['CLAUDE.md'], 'no temp file left beside the target');

  // MUTATION: make writablePath return `resolved` without following the link, and the
  // stand-in file is overwritten while the target keeps no block.
});

test('a symbolic link to a missing file is refused, not replaced by a regular file', (t) => {
  const box = scratch();
  pretendSymlink(t, box.file, null);
  const row = setGuidance(true, { file: box.file, backupDir: box.backupDir });
  assert.equal(row.changed, false);
  assert.match(row.error, /symbolic link to a file that does not exist/);
  assert.equal(fs.existsSync(box.file), false, 'nothing was created where the link is');

  // MUTATION: delete the `raw === null && isSymbolicLink(file)` refusal in setGuidance and a
  // regular file is created in the link's place.
});

test('the first-ever backup is kept for good, and a rolling one holds the file before the last change', () => {
  // One slot rewritten on every change made damage permanent at the next automatic write:
  // the extension's recompile and `--gates refresh` both write unasked, and each copied the
  // damaged file over the only good copy.
  const box = scratch();
  fs.writeFileSync(box.file, USER_TEXT, 'utf8');
  const first = path.join(box.backupDir, 'CLAUDE.md.pre-test');
  const prev = path.join(box.backupDir, 'CLAUDE.md.pre-test-prev');
  const read = (file) => fs.readFileSync(file, 'utf8');
  const options = { file: box.file, backupDir: box.backupDir, backupName: 'CLAUDE.md.pre-test' };

  setGuidance(true, options);
  assert.equal(read(first), USER_TEXT);
  assert.equal(read(prev), USER_TEXT);
  const installed = read(box.file);

  // A recompile: same markers, a new body, written without the user asking.
  const recompiled = createManagedBlock({ begin: BEGIN, end: END, body: 'recompiled' });
  setGuidance(true, { ...options, block: recompiled });
  assert.equal(read(first), USER_TEXT, 'the original survives every later write');
  assert.equal(read(prev), installed, 'and the rolling slot is one change behind');
  const refreshed = read(box.file);

  setGuidance(false, { ...options, block: recompiled });
  assert.equal(read(first), USER_TEXT);
  assert.equal(read(prev), refreshed);
  assert.deepEqual(fs.readdirSync(box.backupDir).sort(), ['CLAUDE.md.pre-test', 'CLAUDE.md.pre-test-prev']);

  // MUTATION: drop the `fs.existsSync(first)` test in setGuidance and the first assertion
  // after the recompile fails: the original is overwritten with the installed file.
});

// AI Acolyte's decision on the in-place fallback (rampage writes its own way): the
// unattended writers pass `inPlaceFallback: false` through setGuidanceAll, so a file held
// through every rename attempt is left byte-identical and reported, never truncated and
// refilled while a session may be reading it. The default keeps the fallback.
test('inPlaceFallback: false leaves a held instruction file untouched and says so', (t) => {
  const box = scratch();
  fs.mkdirSync(path.join(box.root, '.claude'));
  const file = path.join(box.root, '.claude', 'CLAUDE.md');
  fs.writeFileSync(file, USER_TEXT, 'utf8');
  const realRename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (path.resolve(String(to)) === path.resolve(file)) {
      throw Object.assign(new Error(`EPERM: operation not permitted, rename '${from}' -> '${to}'`), { code: 'EPERM' });
    }
    return realRename(from, to);
  });
  t.mock.method(process, 'emitWarning', () => {});
  const [strict] = setGuidanceAll(true, { home: box.root, inPlaceFallback: false });
  assert.match(strict.error, /stayed held through \d+ rename attempts/);
  assert.equal(strict.changed, false);
  assert.equal(fs.readFileSync(file, 'utf8'), USER_TEXT, 'the held file keeps every byte');
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith('.tmp')), [],
    'and its temp file is gone');

  // The default, for the interactive toggles and the CLI's on/off: written in place.
  const [lenient] = setGuidanceAll(true, { home: box.root });
  assert.equal(lenient.error, null);
  assert.ok(hasGuidance(fs.readFileSync(file, 'utf8')));

  // MUTATION: drop `{ inPlaceFallback }` from setGuidance's write of the instruction file
  // and the strict call writes in place too: its error is null.
});

// ── Removal arithmetic, CRLF and the byte-order mark ──────────────────────────────

test('removal between CRLF lines gives every CRLF back whole', () => {
  // Written for an instruction file whose user text is CRLF while the block is LF. The
  // sweeps count a CRLF as one terminator and keep the user's own bytes, so the bare-LF
  // blank line an install put above the block goes and every CRLF stays.
  const crlf = `top\r\n\r\n\n${BEGIN}\nMANAGED\n${END}\n\r\nbottom\r\n`;
  const removed = applyGuidance(crlf, false).text;
  assert.equal(removed, 'top\r\n\r\n\r\nbottom\r\n');
  assert.equal(removed.replace(/\r\n/g, '').includes('\r'), false, 'no CR was orphaned');
  assert.equal(count(removed, '\r\n'), count(crlf, '\r\n'), 'every CRLF the user had is still there');
});

test('a file an editor saves as CRLF does not grow over on/off cycles', () => {
  // The editor turns every line ending in the file into CRLF, the block's own included.
  // Sweeping bare `\n` stopped at each `\r`, so `off` kept the block's CRLF terminator and
  // the CRLF blank line above it as user bytes: "top\r\n" grew to three CRLFs after one
  // cycle, five after two, seven after three.
  const editorSave = (text) => text.replace(/\r?\n/g, '\r\n');
  let text = 'top\r\n';
  for (let cycle = 1; cycle <= 3; cycle += 1) {
    text = applyGuidance(editorSave(applyGuidance(text, true).text), false).text;
    assert.equal(text, 'top\r\n', `after cycle ${cycle}`);
  }
  // Mid-file, the user's own blank line below the block is theirs and stays.
  assert.equal(applyGuidance(editorSave(`top\n\n${guidanceBlock()}\nbottom\n`), false).text, 'top\r\n\r\nbottom\r\n');

  // MUTATION: make terminatorsBefore and terminatorsAfter in src/agent-guidance.js step over
  // a bare `\n` only, and this fails at cycle 1 with 'top\r\n\r\n\r\n'.
});

test('only the install\'s own blank line goes, wherever the block sits', () => {
  // At the end of the file the user's blank lines below the block are theirs, and stay.
  assert.equal(applyGuidance(`notes\n\n${BEGIN}\nM\n${END}\n\n\n`, false).text, 'notes\n\n\n');
  // The install writes its blank line with `\n`, like the block. A CRLF blank line right
  // above an LF block is the user's, so it stays too.
  assert.equal(applyGuidance(`top\r\n\r\n${BEGIN}\nM\n${END}\n`, false).text, 'top\r\n\r\n');

  // MUTATION: set `inserted` in apply to `up.run.length > 1`, ignoring how the line is
  // spelled, and the second assertion fails with 'top\r\n'.
});

test('a byte-order mark is not user text above the block', () => {
  const BOM = String.fromCharCode(0xfeff);
  const top = `${BOM}${BEGIN}\nstale\n${END}\n\nmy notes\n`;
  assert.equal(hasGuidance(top), true, 'a block on the first line after the mark is found');
  assert.equal(applyGuidance(top, false).text, `${BOM}my notes\n`, 'and removed as at the start of a file');
  // A file holding only the mark takes the block straight after it and gets back exactly
  // the mark: it used to come back as the mark plus a newline.
  const on = applyGuidance(BOM, true).text;
  assert.equal(on, `${BOM}${guidanceBlock()}`);
  assert.equal(applyGuidance(on, false).text, BOM);

  // MUTATION: drop the byte-order-mark case from markerLineAt and `hasGuidance(top)` fails.
  // MUTATION: drop `head === BYTE_ORDER_MARK` from apply's removal separator and the
  // removal yields the mark, a newline, then the notes.
  // MUTATION: drop `current === BYTE_ORDER_MARK` from apply's install separator and the
  // block lands two blank lines below the mark.
});

// The live ~/.codex/AGENTS.md on the development box opens with a byte-order mark and has
// CRLF lines, so this is that file's round trip through the real writer: on, status, off.
test('an AGENTS.md that opens with a byte-order mark and CRLF lines round-trips byte for byte', () => {
  const box = scratch();
  const profile = path.join(box.root, '.codex');
  fs.mkdirSync(profile);
  const agents = path.join(profile, 'AGENTS.md');
  const original = Buffer.from(`${String.fromCharCode(0xfeff)}# Codex notes\r\n\r\n- Prefer the toolbox python.\r\n`, 'utf8');
  fs.writeFileSync(agents, original);

  const on = setGuidanceAll(true, { home: box.root }).find((row) => row.agent === 'codex');
  assert.equal(on.error, null);
  const installed = fs.readFileSync(agents);
  assert.deepEqual(installed.subarray(0, original.length), original, 'the user text, mark included, is untouched');
  const state = guidanceStatusAll(box.root).find((row) => row.agent === 'codex');
  assert.deepEqual([state.on, state.current], [true, true]);
  assert.equal(setGuidanceAll(true, { home: box.root }).find((row) => row.agent === 'codex').changed, false,
    'and a second install is a no-op');

  const off = setGuidanceAll(false, { home: box.root }).find((row) => row.agent === 'codex');
  assert.equal(off.error, null);
  assert.deepEqual(fs.readFileSync(agents), original, 'off gives back the exact bytes, mark and CRLFs');

  // The same file after an editor saved it whole as CRLF, block included.
  fs.writeFileSync(agents, Buffer.from(installed.toString('utf8').replace(/\r?\n/g, '\r\n'), 'utf8'));
  setGuidanceAll(false, { home: box.root });
  assert.deepEqual(fs.readFileSync(agents), original, 'and so does an editor-saved CRLF copy');

  // A block at the very top, right after the mark, with the user's text below it.
  const topBlock = Buffer.from(`${String.fromCharCode(0xfeff)}${guidanceBlock()}\r\n# Codex notes\r\n`, 'utf8');
  fs.writeFileSync(agents, topBlock);
  setGuidanceAll(false, { home: box.root });
  assert.deepEqual(fs.readFileSync(agents), Buffer.from(`${String.fromCharCode(0xfeff)}# Codex notes\r\n`, 'utf8'));

  // MUTATION: revert apply's removal to the bare-`\n` sweeps (the pre-port code) and the
  // editor-saved copy keeps two CRLFs of the block's own; drop the mark from markerLineAt
  // and the top block is never found.
});

// ── Where a marker counts ─────────────────────────────────────────────────────

// The user's own text, ending in one newline so that every round trip below is exact.
const QUOTING = '# notes\n\nThis tool opens its block with `' + BEGIN + '`.\n\n## My important section\n\n'
  + '- rule one\n- rule two\n';

test('a marker quoted in the user\'s prose is not a fence', () => {
  // Measured by rampage before the fix: a quoted begin marker above an installed block made
  // `on` replace everything from the quote to the block's end, the section and its rules
  // with it, and `off` deleted the same span.
  const stale = `${QUOTING}\n${BEGIN}\nstale\n${END}\n`;
  assert.equal(isCurrent(stale), false);
  assert.equal(applyGuidance(stale, true).text, `${QUOTING}\n${guidanceBlock()}`, 'refreshed where it stands, quote and section kept');
  assert.equal(applyGuidance(stale, false).text, QUOTING, 'and off removes the block alone');

  // Both markers quoted in one sentence, and no block: nothing here is a block.
  const sentence = 'The fence is `' + BEGIN + '` and `' + END + '`; keep this note.\nNext line.\n';
  assert.equal(hasGuidance(sentence), false);
  const on = applyGuidance(sentence, true).text;
  assert.equal(on, `${sentence}\n${guidanceBlock()}`, 'the block is appended and the sentence is untouched');
  assert.equal(applyGuidance(on, false).text, sentence);

  // A marker with anything else on its line is not a whole line either.
  for (const line of [`  ${BEGIN}`, `${BEGIN} trailing`, `> ${BEGIN}`]) {
    assert.equal(hasGuidance(`${line}\nbody\n${END}\n`), false, JSON.stringify(line));
  }
  // A line ending in CRLF still counts, or an editor's save would hide the block.
  assert.equal(hasGuidance(`notes\r\n\r\n${BEGIN}\r\nbody\r\n${END}\r\n`), true);

  // MUTATION: make markerLineAt in src/agent-guidance.js return `text.indexOf(marker, from)`
  // and the first assertion fails: the refresh replaces the quote and the section.
});

test('a begin line left on its own above the block does not pull the user\'s text into it', () => {
  const orphan = `notes\n${BEGIN}\nmy section\n\n${BEGIN}\nstale\n${END}\n`;
  assert.equal(applyGuidance(orphan, true).text, `notes\n${BEGIN}\nmy section\n\n${guidanceBlock()}`);
  assert.equal(applyGuidance(orphan, false).text, `notes\n${BEGIN}\nmy section\n`);

  // MUTATION: delete the loop in blockRange that moves `start` to the last begin line before
  // the end line, and the first assertion fails: "my section" is replaced along with the block.
});

test('a marker pair inside a closed code fence is a documented example, not a block', () => {
  const doc = '# notes\n\nExample:\n\n```markdown\n' + BEGIN + '\n(example body)\n' + END + '\n```\n\nmore notes\n';
  assert.equal(hasGuidance(doc), false);
  const on = applyGuidance(doc, true).text;
  assert.equal(on, `${doc}\n${guidanceBlock()}`, 'the example keeps its own body and the real block is appended');
  assert.equal(applyGuidance(on, true).changed, false, 'and the real block below it settles');
  assert.equal(applyGuidance(on, false).text, doc);

  // A tilde fence, an indented one, and a longer fence whose example holds a shorter one.
  assert.equal(hasGuidance(`~~~\n${BEGIN}\nx\n${END}\n~~~\n`), false, 'tilde');
  assert.equal(hasGuidance('  ```\n' + BEGIN + '\nx\n' + END + '\n  ```\n'), false, 'indented up to three spaces');
  assert.equal(hasGuidance('````md\n```\n' + BEGIN + '\nx\n' + END + '\n```\n````\n'), false, 'only as long a run closes');
  // A tilde line does not close a backtick fence.
  assert.equal(hasGuidance('```\n~~~\n' + BEGIN + '\nx\n' + END + '\n```\n'), false, 'only the same character closes');
  // A backtick run with a backtick after it is inline code, not a fence, so the trailing
  // fence line below the pair is an unclosed opener and hides nothing.
  assert.equal(hasGuidance('```inline```\n' + BEGIN + '\nx\n' + END + '\n```\n'), true, 'inline code is no fence');

  // MUTATION: make blockRange ignore the fences (`const example = null`) and the first
  // assertion fails: the example reads as the block, and `on` replaces its body. In
  // fencedSpans, drop ` {0,3}` from COMMONMARK_FENCE_OPEN, the length test, the same-character test
  // or the backtick-info test, and the matching labelled assertion fails.
});

test('a fence can hide only a pair it encloses, and an unclosed fence hides nothing', () => {
  // A fence the user never closed: CommonMark would run it to end of file, but a stray
  // fence line must not make the real block invisible, or every `on` appends another copy.
  const unclosed = `notes\n\n\`\`\`\nleft open\n\n${BEGIN}\nstale\n${END}\n`;
  assert.equal(hasGuidance(unclosed), true);
  assert.equal(count(applyGuidance(unclosed, true).text, BEGIN), 1);

  // A gate's own code fence closing one the user left open above: the fence ends between
  // the markers, so it encloses neither the block nor its end, and the block is real.
  const fencedBody = createManagedBlock({ begin: BEGIN, end: END, body: 'gate\n```bash\nls\n```' });
  const installed = fencedBody.apply('notes\n```\nleft open\n', true).text;
  assert.equal(fencedBody.has(installed), true);
  assert.equal(fencedBody.apply(installed, true).changed, false, 'it settles rather than appending a copy');
  assert.equal(fencedBody.apply(installed, false).text, 'notes\n```\nleft open\n');

  // MUTATION: treat an opener with no closer as running to end of file (in fencedSpans,
  // push [opener, text.length] instead of skipping it) and the first assertion fails.
  // MUTATION: in blockRange, test only `open < start && start < close` (drop the end
  // marker's half of the condition) and the fenced-body block reads as absent.
});
