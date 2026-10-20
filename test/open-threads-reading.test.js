'use strict';

// What a memory is to the open threads, read by vscode-extension/memoryLint.js threadOf (2026-10-19),
// the JavaScript copy of recall.py's _thread that the Claude memory card counts with and
// activation asks "is there anything to compile". test/threads-compile.sh holds the two readers
// together memory by memory over a generated corpus wherever a Python with recall.py's runtime
// exists; this file pins the documented forms in JavaScript alone, so every CI leg checks the
// reading without Python. indexHealth, the INDEX line's three budgets, is pinned the same way.

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

// memoryLint.js requires 'vscode' at module scope and touches nothing on it until a MemoryLint is
// constructed, so an empty stand-in is enough. Reached as memoryLint.threadOf, the shape
// test/dead-exports.test.js counts.
const modulePath = require.resolve('../vscode-extension/memoryLint');
const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'vscode') return {};
  return originalLoad.call(this, request, parent, isMain);
};
delete require.cache[modulePath];
const memoryLint = require(modulePath);
Module._load = originalLoad;
delete require.cache[modulePath];

const read = (text) => {
  const t = memoryLint.threadOf(text);
  return t === null ? null : [t.kind, t.status, t.text];
};
const memory = (frontmatter, body = '<!-- status -->\nWaiting on the owner.\n<!-- /status -->\n') => `---\n${frontmatter}---\n\n${body}`;
const BLOCK = '<!-- status -->\nWaiting on the owner.\n<!-- /status -->\n';
const ch = (code) => String.fromCharCode(code);

test('the documented status forms, and the ones that must not list', () => {
  const cases = [
    ['absent', 'name: a\n', BLOCK, null],
    ['flat', 'status: open\n', BLOCK, ['listed', 'open', 'Waiting on the owner.']],
    ['nested under metadata', 'metadata:\n  type: project\n  status: awaiting\n', BLOCK, ['listed', 'awaiting', 'Waiting on the owner.']],
    ['case', 'status: BLOCKED\n', BLOCK, ['listed', 'blocked', 'Waiting on the owner.']],
    ['quoted', 'status: "deferred"\n', BLOCK, ['listed', 'deferred', 'Waiting on the owner.']],
    ['a trailing comment', 'status: open  # the owner decides\n', BLOCK, ['listed', 'open', 'Waiting on the owner.']],
    ['spaced key', 'status : open\n', BLOCK, ['listed', 'open', 'Waiting on the owner.']],
    ['every closed value is silent', 'status: Shipped\n', BLOCK, ['closed', 'shipped', null]],
    ['an unknown value is kept as written', 'status: WIP\n', BLOCK, ['unknown', 'WIP', null]],
    ['an empty value is unknown', 'status:\n', BLOCK, ['unknown', '', null]],
    ['two status lines', 'status: open\nmetadata:\n  status: done\n', BLOCK, ['duplicate', null, null]],
    ['not the key', 'statuses: open\nstatus_note: open\n', BLOCK, null],
    ['listed with no block', 'status: open\n', 'No block here.\n', ['no-block', 'open', null]],
    ['the block only as a fenced example', 'status: open\n', `\`\`\`\n${BLOCK}\`\`\`\n`, ['no-block', 'open', null]],
    ['a fence that never closes hides what follows', 'status: open\n', `~~~\n${BLOCK}`, ['no-block', 'open', null]],
    ['a backtick info string with a backtick is not a fence', 'status: open\n', `\`\`\` a\`b\n${BLOCK}\`\`\`\n`, ['listed', 'open', 'Waiting on the owner.']],
    ['four spaces of indent is not a marker', 'status: open\n', '    <!-- status -->\nx\n    <!-- /status -->\n', ['no-block', 'open', null]],
    ['text after a marker is not a marker', 'status: open\n', '<!-- status --> x\ny\n<!-- /status -->\n', ['no-block', 'open', null]],
    ['the last opening marker before the closing one', 'status: open\n', '<!-- status -->\ndropped\n<!-- status -->\nkept\n<!-- /status -->\n', ['listed', 'open', 'kept']],
  ];
  for (const [name, frontmatter, body, expected] of cases) {
    assert.deepEqual(read(memory(frontmatter, body)), expected, name);
  }
  // A CRLF file, and one with a lone CR, read like their LF twin, as Python's universal newlines make them.
  const lf = memory('status: open\n');
  assert.deepEqual(read(lf.replace(/\n/g, '\r\n')), read(lf));
  assert.deepEqual(read(lf.replace(/\n/g, '\r')), read(lf));
  // A byte-order mark and blank lines before the fence, as _frontmatter_block skips them.
  assert.deepEqual(read(`${ch(0xfeff)}\n\n${lf}`), read(lf));
  // MUTATION: in threadOf, test THREAD_STATUSES before THREAD_CLOSED with a widened list, or drop
  // the duplicate check, and the cases above name the one that moved.
});

test('the text is collapsed with Python\'s whitespace, its comment markers neutralised, and a leading # escaped', () => {
  // U+001C and U+0085 are Python whitespace and not JavaScript's; U+FEFF is JavaScript's and not Python's.
  const body = `<!-- status -->\n  # Heading${ch(0x1c)}like${ch(0x85)}text\twith <!-- a --> comment${ch(0xfeff)}kept\n<!-- /status -->\n`;
  assert.deepEqual(read(memory('status: open\n', body)),
    ['listed', 'open', `${String.fromCharCode(92)}# Heading like text with &lt;!-- a --&gt; comment${ch(0xfeff)}kept`]);
  // The value too: Python strips U+001C, and does not strip U+FEFF.
  assert.deepEqual(read(memory(`status: ${ch(0x1c)}open\n`))[0], 'listed');
  assert.deepEqual(read(memory(`status: ${ch(0xfeff)}open\n`))[0], 'unknown');
  // MUTATION: collapse with /\s+/ or strip with trim() and these fail.
});

test('indexHealth names each of the three budgets MEMORY.md is past, and nothing else', () => {
  const fast = (lineCount, bytes, longestLine) => ({ lineCount, bytes, longestLine });
  assert.deepEqual(memoryLint.indexHealth(fast(140, 12000, 300)), [], 'at every budget is within');
  assert.deepEqual(memoryLint.indexHealth(fast(141, 12001, 301)), [
    '141 lines (budget 140)', '12001 bytes (budget 12000)', '301 characters on its longest line (budget 300)']);
  assert.deepEqual(memoryLint.indexHealth(null), [], 'no index, nothing to say');
  // The real fastLint counts the longest line in code points: 300 astral characters are 600 UTF-16 units.
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-index-health-'));
  try {
    fs.writeFileSync(path.join(dir, 'MEMORY.md'), `short\n${String.fromCodePoint(0x1f600).repeat(300)}\r\n`);
    const report = memoryLint.fastLint(dir, { lineBudget: 300, totalBudget: 12000, maxLines: 200 });
    assert.equal(report.longestLine, 300);
    assert.deepEqual(memoryLint.indexHealth(report), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // MUTATION: `>=` for `>` in indexHealth, or `ln.length` for Array.from in fastLint, and these fail.
});
