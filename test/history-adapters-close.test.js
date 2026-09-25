'use strict';

// `readRange`'s `finally` called `fs.closeSync(descriptor)` bare, so a close
// that threw REPLACED the error the read had already raised. That matters here
// more than it usually does: `scanHistoryFiles` catches per file and keeps
// `error.message` in `files[].error`, and that string is the only account
// anyone ever gets of why a transcript could not be read. Swapping an EACCES or
// an ERR_OUT_OF_RANGE for an EBADF from the close sends the reader after the
// wrong thing entirely, and the descriptor is unusable either way.
//
// `src/policy-lock.js:143` and `atomicWrite` in `src/auto-learn-manager.js`
// both already wrap theirs; this was the one that did not.
//
// MUTATION APPLIED: put the bare `fs.closeSync(descriptor);` back. This test
// fails, `files[0].error` reading `witness-close-failure` instead of
// `witness-read-failure`.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { scanHistoryFiles } = require('../src/history-adapters');

test('a close failure does not replace the read failure it happened during', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-wildcarding-close-'));
  t.after(() => { try { fs.rmSync(home, { recursive: true, force: true }); } catch {} });
  const root = path.join(home, 'projects', 'p');
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, 'session.jsonl');
  fs.writeFileSync(file, `${JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'one', name: 'Bash', input: { command: 'git status' } }] },
  })}\n`);

  const realRead = fs.readSync;
  const realClose = fs.closeSync;
  t.after(() => { fs.readSync = realRead; fs.closeSync = realClose; });

  let reads = 0;
  let closes = 0;
  fs.readSync = () => {
    reads += 1;
    const error = new Error('EACCES: permission denied, witness-read-failure');
    error.code = 'EACCES';
    throw error;
  };
  fs.closeSync = (descriptor) => {
    closes += 1;
    // Close the descriptor for real first, so a throwing stand-in cannot leak
    // one per call and turn this test into an EMFILE somewhere else.
    try { realClose(descriptor); } catch {}
    const error = new Error('EBADF: bad file descriptor, witness-close-failure');
    error.code = 'EBADF';
    throw error;
  };

  const scanned = scanHistoryFiles({ cursors: {}, claudeRoots: [path.join(home, 'projects')], codexRoots: [] });

  fs.readSync = realRead;
  fs.closeSync = realClose;

  // Preconditions. Without these a scan that never opened the file at all would
  // pass the assertion below by reporting some unrelated error, or no error.
  assert.ok(reads > 0, 'witness:read-range-close -- the read stand-in has to have been reached');
  assert.ok(closes > 0, 'witness:read-range-close -- and so does the close stand-in');
  assert.equal(scanned.files.length, 1,
    `witness:read-range-close -- one transcript, one report; got ${scanned.files.length}`);

  const [entry] = scanned.files;
  assert.equal(entry.mode, 'error', 'witness:read-range-close -- the file is reported as failed');
  assert.match(entry.error, /witness-read-failure/,
    `witness:read-range-close -- the read failure is the diagnostic; got "${entry.error}"`);
  assert.doesNotMatch(entry.error, /witness-close-failure/,
    `witness:read-range-close -- the close failure must not stand in for it; got "${entry.error}"`);
});
