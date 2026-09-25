'use strict';

// `defaultCodexValidator` wrote its temp rules file ABOVE the `try` whose
// `finally` unlinks it, so a create-then-throw left the file behind. It is
// created with `wx`, so the orphan is not only litter: the next validation that
// draws the same pid and random suffix fails EEXIST.
//
// The throw has to land BETWEEN the create and the return, which no ordinary
// input can arrange -- a bad `text` is rejected before the file is opened, and
// an existing temp fails `wx` before anything is created. So `writeFileSync` is
// stood in for, doing the create and then failing the write the way ENOSPC or a
// quota stop does. That stand-in is the only artificial part; everything else,
// including which directory the temp lands in, is the real code path.
//
// MUTATION APPLIED: move `fs.writeFileSync(temp, ...)` back above the `try`.
// This test fails with the orphaned
// `.permission-wildcarding-validate.<pid>.<hex>.rules` named in the message.

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

test('a validator temp file that fails mid-write is not left behind', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-wildcarding-validator-temp-'));
  t.after(() => { try { fs.rmSync(home, { recursive: true, force: true }); } catch {} });
  const history = path.join(home, '.claude', 'projects', 'p', 'session.jsonl');
  const rules = path.join(home, '.codex', 'rules', 'permission-wildcarding.rules');
  fs.mkdirSync(path.dirname(history), { recursive: true });
  fs.mkdirSync(path.dirname(rules), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'),
    `${JSON.stringify({ permissions: { allow: [] } }, null, 2)}\n`);
  fs.writeFileSync(history, jsonl(
    { type: 'session_meta', payload: { id: 'v', cwd: 'D:\\work' } },
    call('one', 'git status --short'), result('one'),
    call('two', 'git status --porcelain'), result('two'),
    call('three', 'git status --branch'), result('three'),
  ));

  // No `codexValidator` option, so the real `defaultCodexValidator` runs. It
  // never reaches the spawn: the write fails first.
  const manager = createAutoLearnManager({ home, threshold: 3, codexRulesPath: rules });
  manager.scan({ platform: 'win32' });

  const real = fs.writeFileSync;
  let intercepted = 0;
  t.after(() => { fs.writeFileSync = real; });
  fs.writeFileSync = (target, data, options) => {
    if (typeof target === 'string' && path.basename(target).startsWith('.permission-wildcarding-validate')) {
      intercepted += 1;
      // The create half succeeds, exactly as it does on a disk that fills
      // between the open and the write.
      real(target, '', options);
      const error = new Error('ENOSPC: no space left on device, write');
      error.code = 'ENOSPC';
      throw error;
    }
    return real(target, data, options);
  };

  assert.throws(() => manager.apply(), /ENOSPC/,
    'witness:validator-temp -- the apply has to fail closed on an unwritable rules file');
  assert.equal(intercepted, 1,
    'witness:validator-temp -- the stand-in has to have been the thing that threw, or this '
    + 'test proves nothing about the validator at all');

  const orphans = fs.readdirSync(path.dirname(rules))
    .filter((name) => name.startsWith('.permission-wildcarding-validate'));
  assert.deepEqual(orphans, [],
    `witness:validator-temp -- the temp file outlived the call that made it: ${orphans.join(', ')}`);
  assert.equal(fs.existsSync(rules), false,
    'witness:validator-temp -- and nothing unvalidated was written');
});
