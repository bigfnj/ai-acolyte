'use strict';

// ONE rename-retry policy for every atomic writer in the product.
//
// Found by the v1.6.2 audit, fixed 2026-10-14: four writers retried a refused rename
// and each carried its own copy of which error codes to retry and for how long, and the
// copies had already drifted. src/permissions.js (writeFileAtomicSync) and
// src/auto-learn-manager.js (atomicWrite) retried ETXTBSY; src/codex-memory-gates.js
// (strictWrite, 597b4f7) and the model download in vscode-extension/extension.js
// (b4271f3) did not, and each re-typed "ten attempts, 20 ms more each time, 0.9 s".
// src/permissions.js now exports the codes, the attempt count and the backoff step,
// and the other three import the codes from it (one line each, because two of those
// files are edited by other work in parallel). Where a writer still spells its own
// attempt bound or backoff step, this file holds the number to the shared one.
//
// The census runs over git's view of the tree, so the generated
// vscode-extension/src/ copy of src/ is not counted as a fifth writer.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const {
  RETRYABLE_RENAME_CODES, RENAME_RETRY_ATTEMPTS, renameRetryDelayMs,
} = require('../src/permissions');

// The writers this file exists for, and how each names the shared set locally.
const WRITERS = {
  'src/permissions.js': 'RETRYABLE_RENAME_CODES',
  'src/auto-learn-manager.js': 'RETRY_RENAME',
  'src/codex-memory-gates.js': 'HELD_RENAME',
  'vscode-extension/extension.js': 'MODEL_RENAME_HELD',
};

function productFiles() {
  let listed;
  try {
    listed = execFileSync('git', ['-C', ROOT, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\0').filter(Boolean);
  } catch {
    listed = [
      ...fs.readdirSync(path.join(ROOT, 'src')).map((name) => `src/${name}`),
      ...fs.readdirSync(path.join(ROOT, 'vscode-extension')).map((name) => `vscode-extension/${name}`),
      'bin/wildcard-perms',
    ];
  }
  return [...new Set(listed)]
    .filter((rel) => /^(src|vscode-extension)\/[^/]+\.js$/.test(rel) || rel === 'bin/wildcard-perms')
    .filter((rel) => fs.existsSync(path.join(ROOT, rel)));
}

test('the shared policy is the one the writers were measured against', () => {
  assert.deepEqual([...RETRYABLE_RENAME_CODES].sort(), ['EACCES', 'EBUSY', 'EPERM', 'ETXTBSY']);
  assert.ok(!RETRYABLE_RENAME_CODES.has('EXDEV'), 'a cross-device rename is permanent, never retried');
  assert.equal(RENAME_RETRY_ATTEMPTS, 10);
  const waits = Array.from({ length: RENAME_RETRY_ATTEMPTS - 1 }, (_, k) => renameRetryDelayMs(k + 1));
  assert.deepEqual(waits, [20, 40, 60, 80, 100, 120, 140, 160, 180], 'no wait after the last attempt');
  assert.equal(waits.reduce((a, b) => a + b, 0), 900, 'the 0.9 s budget every writer documents');
});

test('no product file spells its own set of rename codes', () => {
  // A Set literal holding EPERM and another of the transient codes: how all four
  // copies were written. Only src/permissions.js may hold one.
  const own = [];
  for (const rel of productFiles()) {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    for (const match of text.matchAll(/new Set\(\[([^\]]*)\]\)/g)) {
      const codes = match[1];
      if (/'EPERM'|"EPERM"/.test(codes) && /'(EACCES|EBUSY|ETXTBSY)'|"(EACCES|EBUSY|ETXTBSY)"/.test(codes)) {
        own.push(`${rel}:${text.slice(0, match.index).split('\n').length}`);
      }
    }
  }
  assert.deepEqual(own, ['src/permissions.js:' + String(lineOfSharedSet())],
    `a rename-code Set outside src/permissions.js: ${own.join(', ')}. Import RETRYABLE_RENAME_CODES instead.`);
});

function lineOfSharedSet() {
  const text = fs.readFileSync(path.join(ROOT, 'src', 'permissions.js'), 'utf8');
  return text.slice(0, text.indexOf('const RETRYABLE_RENAME_CODES = new Set([')).split('\n').length;
}

test('every rename-retry writer takes the shared set, and its own numbers agree with the shared ones', () => {
  // Discovery as well as the list above: a file that renames and tests an error code
  // against a held-file set is a writer, whatever it is called.
  const found = productFiles().filter((rel) => {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    return /renameSync\(/.test(text) && /\b[A-Z_]*(?:RENAME|RENAME_CODES)[A-Z_]*\.has\(/.test(text);
  }).sort();
  assert.deepEqual(found, Object.keys(WRITERS).sort(), 'WITNESS: the census finds exactly the known writers');

  for (const [rel, local] of Object.entries(WRITERS)) {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    if (rel !== 'src/permissions.js') {
      const imports = new RegExp(String.raw`const\s*\{\s*RETRYABLE_RENAME_CODES\s*:\s*${local}\s*\}\s*=\s*require\('\.(?:/src)?/permissions'\)`);
      assert.match(text, imports, `${rel} must take ${local} from src/permissions.js`);
    }
    assert.match(text, new RegExp(String.raw`\b${local}\.has\(`), `${rel} retries on ${local}`);
    // Its own spelling of the budget, where it keeps one: `ATTEMPTS = N` or
    // `attempt < N`, and the step in `N * attempt` / `N * (attempt + 1)`.
    for (const match of text.matchAll(/\b[A-Z_]*ATTEMPTS\s*=\s*(\d+)|\battempt\s*<\s*(\d+)/g)) {
      assert.equal(Number(match[1] || match[2]), RENAME_RETRY_ATTEMPTS, `${rel}: an attempt bound of ${match[0]}`);
    }
    for (const match of text.matchAll(/\b(\d+)\s*\*\s*\(?\s*attempt\b/g)) {
      assert.equal(Number(match[1]), renameRetryDelayMs(1), `${rel}: a backoff step of ${match[0]}`);
    }
  }
});
