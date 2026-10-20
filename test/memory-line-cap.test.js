'use strict';

// Claude Code loads the first 200 lines of MEMORY.md, or 25 KB, whichever comes first,
// and drops the remainder without reporting it. Nothing in this extension counted lines.
// fastLint measured bytes against a self-imposed 12000-byte budget, which is the wrong
// axis: the live store sits at 84 lines (42% of the line cap) and 6648 bytes (26% of the
// 25 KB one), and it grows by roughly a line per project while the byte count barely
// moves. So the card could read green while the tail of the index had already stopped
// being loaded into sessions.
//
// The off-by-one here is the part worth pinning. A file ending in a newline splits into a
// final empty element that is not a line, and counting it would report the cap breached a
// line early.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

// memoryLint requires 'vscode' at module scope. Nothing below touches the VS Code API, so
// the stub only has to exist; cfg() is bypassed by passing conf in directly.
function loadLint() {
  const modulePath = require.resolve('../vscode-extension/memoryLint');
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === 'vscode') {
      return { workspace: { getConfiguration: () => ({ get: () => undefined }) } };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[modulePath];
  const loaded = require(modulePath);
  Module._load = originalLoad;
  delete require.cache[modulePath];
  return loaded;
}

const CONF = { enabled: true, dir: '', lineBudget: 300, totalBudget: 12000, maxLines: 200 };

function store(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-linecap-'));
  fs.writeFileSync(path.join(dir, 'MEMORY.md'), body, 'utf8');
  return dir;
}

function withStore(body, run) {
  const dir = store(body);
  try {
    run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('a trailing newline does not count as an extra line', () => {
  const { fastLint } = loadLint();
  // Three lines, newline-terminated. `wc -l` says 3, and so must this.
  withStore('a\nb\nc\n', (dir) => {
    assert.equal(fastLint(dir, CONF).lineCount, 3);
  });
  // The same three lines without the trailing newline are still three.
  withStore('a\nb\nc', (dir) => {
    assert.equal(fastLint(dir, CONF).lineCount, 3);
  });
});

test('CRLF counts the same as LF, since the loader counts lines not bytes', () => {
  const { fastLint } = loadLint();
  withStore('a\r\nb\r\nc\r\n', (dir) => {
    const r = fastLint(dir, CONF);
    assert.equal(r.lineCount, 3);
    // Bytes still include the CRs. The two numbers measure different things on purpose.
    assert.equal(r.bytes, 9);
  });
});

test('linesOver trips one line past the cap, and not one line before it', () => {
  const { fastLint } = loadLint();
  const body = (n) => 'x\n'.repeat(n);

  withStore(body(200), (dir) => {
    const r = fastLint(dir, CONF);
    assert.equal(r.lineCount, 200);
    assert.equal(r.linesOver, false, 'exactly at the cap is still fully loaded');
  });

  withStore(body(201), (dir) => {
    const r = fastLint(dir, CONF);
    assert.equal(r.lineCount, 201);
    assert.equal(r.linesOver, true, 'one line past the cap is one line silently dropped');
  });
});

test('the line cap is independent of the byte budget', () => {
  const { fastLint } = loadLint();
  // 300 near-empty lines: far past the line cap, nowhere near 12000 bytes. This is the
  // case the byte gauge alone could never see, and the reason this check exists.
  withStore('x\n'.repeat(300), (dir) => {
    const r = fastLint(dir, CONF);
    assert.equal(r.linesOver, true);
    assert.equal(r.totalOver, false, 'still well under the byte budget');
    assert.ok(r.bytes < CONF.totalBudget);
  });

  // And the inverse: a handful of very long lines blows the byte budget while the line
  // count is trivial.
  withStore(('y'.repeat(4000) + '\n').repeat(4), (dir) => {
    const r = fastLint(dir, CONF);
    assert.equal(r.lineCount, 4);
    assert.equal(r.linesOver, false);
    assert.equal(r.totalOver, true);
  });
});

test('maxLines is configurable, so a change to the loader cap is a setting not a release', () => {
  const { fastLint } = loadLint();
  withStore('x\n'.repeat(120), (dir) => {
    assert.equal(fastLint(dir, { ...CONF, maxLines: 100 }).linesOver, true);
    assert.equal(fastLint(dir, { ...CONF, maxLines: 200 }).linesOver, false);
  });
});

test('an empty index reports zero lines rather than one', () => {
  const { fastLint } = loadLint();
  withStore('', (dir) => {
    const r = fastLint(dir, CONF);
    assert.equal(r.lineCount, 0);
    assert.equal(r.linesOver, false);
  });
});

// ── the MEMORY.md guard's rules, in the editor lint (2026-10-19) ──────────────
// The guard (src/memory-index-guard.js) blocks growth past 140 lines, a line past 300
// characters on ANY line, and a broken HTML comment. The lint reports the same three, from
// the guard's own scanner and constant; test/memory-guard-parity.test.js holds them together.

test('past the 140-line target is reported below the 200-line cap, and not at it', () => {
  const { fastLint } = loadLint();
  withStore('x\n'.repeat(140), (dir) => {
    const r = fastLint(dir, CONF);
    assert.equal(r.linesTarget, 140);
    assert.equal(r.linesOverTarget, false, 'exactly at the target');
  });
  withStore('x\n'.repeat(141), (dir) => {
    const r = fastLint(dir, CONF);
    assert.equal(r.linesOverTarget, true);
    assert.equal(r.linesOver, false, 'still inside the cap: the index loads whole');
  });
});

// MUTATION: restore `ln.startsWith('- ') &&` in fastLint and the heading below is not flagged;
// measure with `ln.length` and the 300-emoji line is.
test('every line is held to the width budget, in code points', () => {
  const { fastLint } = loadLint();
  const emoji = String.fromCodePoint(0x1F600);
  withStore(`# ${'h'.repeat(299)}\n${emoji.repeat(300)}\n- ${'e'.repeat(299)}\r\n`, (dir) => {
    const r = fastLint(dir, CONF);
    assert.deepEqual(r.over.map((o) => [o.line, o.len]), [[0, 301], [2, 301]],
      'the heading and the CRLF entry are 301 characters; 300 emoji are 300');
    assert.equal(r.over[1].end, 301, 'a Range ends at the UTF-16 column, CR excluded by the split');
  });
});

// MUTATION: return [] from commentDefectList's caller (drop `comments:` from fastLint) and the
// nested header goes unreported.
test('a broken HTML comment in the index is reported with its line and kind', () => {
  const { fastLint } = loadLint();
  withStore('<!-- header\n  <!-- nested -->\n  tail -->\n- [a](a.md)\n```\n<!-- example\n```\n', (dir) => {
    const r = fastLint(dir, CONF);
    assert.deepEqual(r.comments.map((c) => [c.line, c.kind]), [[1, 'nested'], [2, 'orphan']]);
  });
  withStore('<!-- one -->\n- [a](a.md)\n', (dir) => {
    assert.deepEqual(fastLint(dir, CONF).comments, []);
  });
});

// The resident "- " entries, counted by the guard's measure and never judged (1.9.5). From
// 1.9.1 to 1.9.4 past 16 was a warning that an index giving every memory a line could not clear.
// MUTATION: drop the `ln.startsWith('- ')` count in fastLint and the counts fail; put back a
// ceiling field and the "no verdict" assertion does.
test('the entry count is reported and carries no ceiling or verdict', () => {
  const { fastLint } = loadLint();
  const entries = (n) => Array.from({ length: n }, (_, i) => `- [m${i}](m${i}.md) hook`).join('\r\n') + '\r\n';
  withStore(`# Index\n-not an entry\n${entries(16)}`, (dir) => {
    assert.equal(fastLint(dir, CONF).entries, 16, 'CRLF entries count, and "-not" is not one');
  });
  withStore(`# Index\n${entries(60)}`, (dir) => {
    const r = fastLint(dir, CONF);
    assert.equal(r.entries, 60);
    for (const key of ['entriesCeiling', 'entriesOver', 'entryPastCeiling']) {
      assert.equal(Object.hasOwn(r, key), false, `no ${key}: the count is not a budget`);
    }
  });
});
