'use strict';

// Policy backups, and the two ways a pruner for them goes wrong.
//
// `backup()` writes one `.bak` per changed target per apply and nothing has ever
// removed one. Measured on a real install: 44 files, 562 KB, about 1.2 a day, in
// the single directory where every other structure -- managedHits, candidates,
// cursors, observation hashes, candidate tombstones -- carries an explicit cap.
//
// The interesting half is not the cap. It is that `undo()` restores from
// `lastApplication.targets[].backupPath` and REFUSES OUTRIGHT when one of those
// files is missing or altered, so a pruner going by age alone eventually deletes
// the files that make the last apply reversible. The `backupLimit: 0` test below
// is that case turned all the way up.
//
// MUTATIONS APPLIED, and what each one killed:
//   * delete the `if (keep.has(name)) continue;` guard in `pruneBackups`
//     -> "undo survives a prune that would otherwise take its own backup" fails
//        with "Refusing to undo because the Auto Learn backup is missing".
//   * make `pruneBackups` return before its loop
//     -> "old policy backups are capped" fails, 7 files against 2.
//   * widen `BACKUP_NAME` to /\.bak$|.*/
//     -> "a sibling structure in the same directory is not swept up" fails,
//        the `.pre-derived` copy of the user's CLAUDE.md having been deleted.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createAutoLearnManager } = require('../src/auto-learn-manager');

function jsonl(...records) {
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
}
function call(id, command) {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] },
  };
}
function result(id) {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, is_error: false, content: 'ok' }],
    },
  };
}

// Five backups from 2020, which sort before anything this run writes, plus one
// file that belongs to a DIFFERENT structure in the same directory:
// `setDerivedGuidance` writes `<name>.pre-derived` beside these, and it is the
// only copy of the user's CLAUDE.md from before a derived block was installed.
const STALE = 5;
const SIBLING = 'CLAUDE.md.pre-derived';
function fixture(t, prefix) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `permission-wildcarding-${prefix}-`));
  t.after(() => { try { fs.rmSync(home, { recursive: true, force: true }); } catch {} });
  const history = path.join(home, '.claude', 'projects', 'p', 'session.jsonl');
  fs.mkdirSync(path.dirname(history), { recursive: true });
  fs.writeFileSync(history, jsonl(
    { type: 'session_meta', payload: { id: 'v', cwd: 'D:\\work' } },
    call('one', 'git status --short'), result('one'),
    call('two', 'git status --porcelain'), result('two'),
    call('three', 'git status --branch'), result('three'),
  ));
  const settings = path.join(home, '.claude', 'settings.json');
  fs.writeFileSync(settings, `${JSON.stringify({ permissions: { allow: [] } }, null, 2)}\n`);
  const backupDir = path.join(home, '.claude', 'wildcarding', 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  for (let index = 1; index <= STALE; index += 1) {
    fs.writeFileSync(
      path.join(backupDir, `2020-01-01T00-00-0${index}-000Z-claude-deadbeef.bak`),
      '{"permissions":{"allow":[]}}\n');
  }
  fs.writeFileSync(path.join(backupDir, SIBLING), '# the user own notes\n');
  return { home, settings, backupDir };
}
function build(home, extra = {}) {
  return createAutoLearnManager({
    home, threshold: 3, codexRulesPath: null,
    codexValidator: () => ({ valid: true, decision: 'allow' }),
    ...extra,
  });
}
function backups(dir) {
  return fs.readdirSync(dir).filter((name) => name.endsWith('.bak')).sort();
}

test('old policy backups are capped, newest kept', (t) => {
  const env = fixture(t, 'backup-cap');
  const learn = build(env.home, { backupLimit: 2 });
  learn.scan({ platform: 'win32' });

  const before = backups(env.backupDir);
  assert.equal(before.length, STALE,
    'witness:backup-retention -- the stale files are in place before the apply');

  const applied = learn.apply();
  assert.ok(applied.changed, 'witness:backup-retention -- the apply has to have written something');
  assert.ok(applied.backupsPruned > 0,
    `witness:backup-retention -- the prune has to have removed something; got ${applied.backupsPruned}`);
  assert.equal(applied.backupsUnremovable, 0,
    'witness:backup-retention -- and none of the removals failed');

  const after = backups(env.backupDir);
  assert.equal(after.length, 2,
    `witness:backup-retention -- capped at 2, found ${after.length}: ${after.join(', ')}`);
  assert.ok(after.every((name) => name.startsWith('2026') || !name.startsWith('2020')),
    `witness:backup-retention -- the 2020 files are the ones that go: ${after.join(', ')}`);
  assert.equal(applied.backupsKept, after.length,
    'witness:backup-retention -- and the reported count is the real one');
});

test('a sibling structure in the same directory is not swept up', (t) => {
  const env = fixture(t, 'backup-sibling');
  const learn = build(env.home, { backupLimit: 0 });
  learn.scan({ platform: 'win32' });
  learn.apply();

  assert.equal(fs.existsSync(path.join(env.backupDir, SIBLING)), true,
    'witness:backup-retention -- a `.pre-derived` copy of the user\'s own instruction file '
    + 'lives in this directory and is not this cap\'s to delete');
});

test('undo survives a prune that would otherwise take its own backup', (t) => {
  const env = fixture(t, 'backup-undo');
  // Zero, so every `.bak` in the directory is over the cap, including the two
  // this apply is about to write. Only the protection can save them.
  const learn = build(env.home, { backupLimit: 0 });
  learn.scan({ platform: 'win32' });

  const applied = learn.apply();
  assert.ok(applied.changed, 'witness:backup-retention -- there has to be something to undo');
  const allow = JSON.parse(fs.readFileSync(env.settings, 'utf8')).permissions.allow;
  assert.ok(allow.length > 0, 'witness:backup-retention -- the grant landed');

  const surviving = backups(env.backupDir);
  assert.ok(surviving.length > 0,
    'witness:backup-retention -- the backups this apply needs are held past a cap of zero');
  assert.equal(surviving.some((name) => name.startsWith('2020')), false,
    `witness:backup-retention -- and nothing else is: ${surviving.join(', ')}`);

  const undone = learn.undo();
  assert.equal(undone.undone, true,
    'witness:backup-retention -- a prune must never be what makes the last apply irreversible');
  assert.deepEqual(JSON.parse(fs.readFileSync(env.settings, 'utf8')).permissions.allow, [],
    'witness:backup-retention -- and the undo really restored the file');
});

test('an undo sweeps the backups it has just stopped protecting', (t) => {
  // The asymmetry: `apply()` pruned and `undo()` did not, so the files an apply held
  // past the cap BECAUSE they made it reversible stayed held after the thing they made
  // reversible was reversed. Nothing swept them until the next apply happened to run,
  // and the directory sat over its cap in the meantime — by the number of targets the
  // undone application touched, which is two here and can be three with Codex.
  //
  // Safe because undo is single level: `lastApplication` is null by this point, the
  // manager refuses a second undo, and the bytes in those `.bak` files are exactly what
  // the restore has just written back into the live files.
  //
  // THE MUTATION: delete `const backupsPruned = pruneBackups([]);` from undo() in
  // src/auto-learn-manager.js. This fails with 2 surviving files against 0.
  const env = fixture(t, 'backup-undo-prune');
  const learn = build(env.home, { backupLimit: 0 });
  learn.scan({ platform: 'win32' });
  const applied = learn.apply();
  assert.ok(applied.changed, 'witness:backup-retention -- there has to be something to undo');

  const held = backups(env.backupDir);
  assert.ok(held.length > 0,
    'witness:backup-retention -- the apply is holding its own backups past a cap of zero');

  const undone = learn.undo();
  assert.equal(undone.undone, true);
  assert.equal(undone.backupsUnremovable, 0,
    'witness:backup-retention -- and the sweep did not run degraded');
  assert.equal(undone.backupsPruned, held.length,
    `the undo reported ${undone.backupsPruned} removals against ${held.length} held files`);
  assert.deepEqual(backups(env.backupDir), [],
    'the undone application\u2019s backups are still protected by a lastApplication that no '
    + 'longer exists, so the directory sits over its cap until the next apply');
  assert.equal(undone.backupsKept, 0);

  // The sibling structure is still not this cap's to delete, on the undo path either.
  assert.equal(fs.existsSync(path.join(env.backupDir, SIBLING)), true);
});
