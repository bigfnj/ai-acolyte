'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseBackupText, purgeLegacyBackupCopies } = require('../src/legacy-backup-cleanup');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-wildcarding-backup-cleanup-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

test('strict backup cleanup purges each copy independently and preserves deny and unknown fields', (t) => {
  const root = tempDir(t);
  const primary = path.join(root, 'primary.json');
  const mirror = path.join(root, 'mirror.json');
  write(primary, { allow: ['Bash(*)', 'Bash(git *)'], deny: ['Bash(*)'], stamp: 'primary' });
  write(mirror, { allow: ['PowerShell(*)', 'Bash(rg *)'], deny: ['PowerShell(*)'], stamp: 'mirror' });

  const result = purgeLegacyBackupCopies(
    [primary, mirror],
    ['Bash(*)', 'PowerShell(*)'],
    { writeFile: (file, content) => fs.writeFileSync(file, content) },
  );

  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(primary, 'utf8')), {
    allow: ['Bash(git *)'], deny: ['Bash(*)'], stamp: 'primary',
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(mirror, 'utf8')), {
    allow: ['Bash(rg *)'], deny: ['PowerShell(*)'], stamp: 'mirror',
  });
});

test('strict backup cleanup reports a failed mirror and does not claim success', (t) => {
  const root = tempDir(t);
  const primary = path.join(root, 'primary.json');
  const mirror = path.join(root, 'mirror.json');
  write(primary, { allow: ['Bash(*)'], deny: [] });
  write(mirror, { allow: ['Bash(*)'], deny: [] });

  const result = purgeLegacyBackupCopies([primary, mirror], ['Bash(*)'], {
    writeFile(file, content) {
      if (file === mirror) throw new Error('mirror held open');
      fs.writeFileSync(file, content);
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].file, mirror);
  assert.deepEqual(JSON.parse(fs.readFileSync(mirror, 'utf8')).allow, ['Bash(*)']);
});

test('strict backup cleanup detects a concurrent writer that reintroduces a retired grant', (t) => {
  const root = tempDir(t);
  const primary = path.join(root, 'primary.json');
  write(primary, { allow: ['Bash(*)', 'Bash(git *)'], deny: [] });

  const result = purgeLegacyBackupCopies([primary], ['Bash(*)'], {
    writeFile(file, content) {
      fs.writeFileSync(file, content);
      write(file, { allow: ['Bash(*)', 'Bash(git *)', 'Bash(rg *)'], deny: [] });
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.failures[0].error, 'verification-mismatch');
});

test('strict backup cleanup fails closed on unreadable or malformed backups', () => {
  const unreadable = 'unreadable.json';
  const malformed = 'malformed.json';
  const fakeFs = {
    readFileSync(file) {
      if (file === unreadable) {
        const error = new Error('access denied');
        error.code = 'EACCES';
        throw error;
      }
      return '{not json';
    },
  };
  const result = purgeLegacyBackupCopies([unreadable, malformed], ['Bash(*)'], {
    fs: fakeFs,
    writeFile() { throw new Error('must not write'); },
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.failures.map((entry) => entry.error), [
    'read:access denied',
    'invalid-backup',
  ]);
});

test('legacy array backups keep their original shape', () => {
  assert.deepEqual(parseBackupText('["Bash(*)","Bash(git *)"]'), {
    value: ['Bash(*)', 'Bash(git *)'],
    allow: ['Bash(*)', 'Bash(git *)'],
    deny: [],
    legacyArray: true,
  });
});
