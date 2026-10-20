'use strict';

// The MEMORY.md index guard (src/memory-index-guard.js): its measures, its one rule (blocked
// only when a measure ENDS past its budget AND is worse than before), the edit it reproduces,
// the path filter that runs first, and the hook entry point spawned the way Claude Code spawns
// it. Every fixture is synthetic.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const GUARD = path.resolve(__dirname, '..', 'src', 'memory-index-guard.js');
const {
  GUARD_REVISION, BUDGETS, measure, commentDefects, applyEdit, verdict, decide, isIndexPath, blockMessage,
} = require('../src/memory-index-guard');

// ── the file itself ──────────────────────────────────────────────────────────

// The installer copies this file out of the repository and the hook runs the copy, so a
// require of a sibling module would resolve here and fail there. Every require() call is
// parsed, including one built from a non-literal, which is refused outright.
// MUTATION: add `const { writeFileAtomicSync } = require('./permissions');` to the guard and
// this fails naming './permissions'.
test('the guard requires fs and path and nothing else, so its copy runs outside the repo', () => {
  const source = fs.readFileSync(GUARD, 'utf8');
  const calls = [...source.matchAll(/\brequire\s*\(([^)]*)\)/g)].map((match) => match[1].trim());
  assert.ok(calls.length >= 2, `precondition: the scan found the guard's own requires: ${calls.join(', ')}`);
  const named = calls.map((argument) => {
    const literal = /^(['"])([^'"]+)\1$/.exec(argument);
    assert.ok(literal, `a require() whose argument is not a string literal: require(${argument})`);
    return literal[2].replace(/^node:/, '');
  });
  assert.deepEqual([...new Set(named)].sort(), ['fs', 'path'], `unexpected requires: ${named.join(', ')}`);
  assert.doesNotMatch(source, /\bimport\s*\(/, 'no dynamic import either');
});

// The installer refreshes the stable copy only when the packaged GUARD_REVISION is higher than
// the copy's, so an edit to the guard WITHOUT a bump never reaches an installed hook. The sha is
// of the text with CRLF folded to LF, because the development tree is CRLF and the build is LF.
// When this fails: bump GUARD_REVISION in src/memory-index-guard.js, then add the new
// revision's sha below (the failure prints it). Earlier revisions stay listed.
// MUTATION: change any character of the guard (a comment will do) without a bump: this fails.
const GUARD_SHAS = {
  1: '46d6616be7b3bb8f9d31c406e376bc363ac6aafe4588e3878cf59d3a04fc6012',
};
test('the guard source is pinned to its GUARD_REVISION, so a change without a bump fails', () => {
  const text = fs.readFileSync(GUARD, 'utf8').replace(/\r\n/g, '\n');
  const sha = crypto.createHash('sha256').update(text, 'utf8').digest('hex');
  const revisions = Object.keys(GUARD_SHAS).map(Number);
  assert.equal(Math.max(...revisions), GUARD_REVISION,
    `GUARD_REVISION is ${GUARD_REVISION}; add its sha to GUARD_SHAS: ${GUARD_REVISION}: '${sha}'`);
  assert.equal(GUARD_SHAS[GUARD_REVISION], sha,
    `src/memory-index-guard.js changed without a GUARD_REVISION bump. Bump it to ${GUARD_REVISION + 1} `
    + `and pin ${GUARD_REVISION + 1}: '${sha}'`);
  assert.ok(Number.isInteger(GUARD_REVISION) && GUARD_REVISION > 0);
});

// ── measure ──────────────────────────────────────────────────────────────────

test('lines count like wc -l, in LF and CRLF alike, and bytes include the CRs', () => {
  assert.equal(measure('').lines, 0);
  assert.equal(measure('a').lines, 1);
  assert.equal(measure('a\nb\n').lines, 2, 'a trailing newline is not one more line');
  assert.equal(measure('a\r\nb\r\n').lines, 2);
  assert.equal(measure('a\r\nb\r\n').bytes, 6);
  assert.equal(measure('a\n\nb\n').lines, 3, 'a blank line inside the file is a line');
  assert.equal(measure('é\n').bytes, 3, 'bytes are UTF-8 bytes');
});

test('entries are the lines that start "- ", and only those', () => {
  const m = measure('# Index\n- one\n- two\n  - nested\n-three\n* star\n');
  assert.equal(m.entries, 2);
});

// The longest line in CODE POINTS, every line rather than only "- " entries, with CRs ignored.
// An astral emoji is one code point and two UTF-16 units, so 300 of them are exactly at the
// budget here and 600 to String.prototype.length.
// MUTATION: measure width with `line.length` and the 300-emoji line reads 600 and is blocked.
test('the longest line is measured in code points, on every line, ignoring CR', () => {
  const emoji = '\u{1F600}'.repeat(300);
  assert.equal(emoji.length, 600, 'precondition: the fixture is astral');
  assert.equal(measure(`# head\n${emoji}\n`).lineChars, 300);
  assert.equal(measure(`${'x'.repeat(301)}\r\n`).lineChars, 301, 'a heading or prose line counts, CR does not');
  assert.equal(verdict('', `${emoji}\n`).block, false, '300 code points is within the budget');
  assert.deepEqual(verdict('', `${emoji}\u{1F600}\n`).reasons.map((r) => r.metric), ['lineChars']);
});

// ── comment defects ──────────────────────────────────────────────────────────

test('well-formed comments, single-line and multi-line, are not defects', () => {
  assert.equal(commentDefects('<!-- one -->\n- a\n<!--\nheader\nlines\n-->\n- b <!-- inline --> c\n'), 0);
  assert.equal(commentDefects('<!-- a --><!-- b -->\n'), 0);
  assert.equal(commentDefects('<!---->\n'), 0);
  assert.equal(commentDefects('a --- b -> c\n'), 0, 'an arrow is not a comment marker');
});

// The defect that leaked a real index's header: the first `-->` closes both, and the text up to
// the second `-->` is loaded into every session.
test('a <!-- inside an open comment is a defect, and so is an orphan --> and an unclosed <!--', () => {
  const nested = '<!-- header\n  note: compiled from <!-- gate --> blocks\n  more header\n-->\n- entry\n';
  assert.equal(commentDefects(nested), 2, 'the inner <!-- and the --> it leaves orphaned');
  assert.equal(commentDefects('<!-- a <!-- b -->\n'), 1, 'nested, then closed once: the reopen alone');
  assert.equal(commentDefects('- entry -->\n'), 1, 'an orphan close');
  assert.equal(commentDefects('- entry\n<!-- never closed\n- hidden\n'), 1, 'open at the end of the file');
  assert.equal(commentDefects(nested.replace(/\n/g, '\r\n')), 2, 'CRLF reads the same');
});

test('markers inside fenced code and inline code spans are examples, not comments', () => {
  assert.equal(commentDefects('```\n<!-- not a comment\n-->\n```\n- a\n'), 0);
  assert.equal(commentDefects('~~~md\n<!--\n~~~\n'), 0);
  assert.equal(commentDefects('````\n```\n<!--\n````\n'), 0, 'a shorter fence does not close a longer one');
  assert.equal(commentDefects('- write `<!--` to open and `-->` to close\n'), 0);
  assert.equal(commentDefects('- ``code with ` and <!-- inside``\n'), 0);
  assert.equal(commentDefects('- a lone ` backtick then <!-- open\n'), 1, 'an unmatched backtick is literal');
  // Inside an open comment nothing is code: the comment ends at the first -->.
  assert.equal(commentDefects('<!-- a `-->` b -->\n'), 1, 'the backticked --> closes it, the second is orphaned');
  assert.equal(commentDefects('<!--\n```\n-->\n'), 0, 'a fence inside a comment does not hide its close');
});

// ── applyEdit ────────────────────────────────────────────────────────────────

test('Write is the new content; Edit replaces one occurrence literally', () => {
  assert.equal(applyEdit('old', 'Write', { file_path: 'x', content: 'new' }), 'new');
  assert.equal(applyEdit('old', 'Write', { file_path: 'x' }), null);
  assert.equal(applyEdit('a b c', 'Edit', { old_string: 'b', new_string: '$&$1' }), 'a $&$1 c',
    'the replacement is literal text, not a pattern');
  assert.equal(applyEdit('a b c', 'Read', { old_string: 'b', new_string: 'x' }), null, 'another tool is not reproduced');
  assert.equal(applyEdit('a', 'Edit', null), null);
});

test('replace_all replaces every occurrence; an ambiguous single replace fails open', () => {
  assert.equal(applyEdit('x-x-x', 'Edit', { old_string: 'x', new_string: 'yy', replace_all: true }), 'yy-yy-yy');
  assert.equal(applyEdit('x-x-x', 'Edit', { old_string: 'x', new_string: 'y' }), null);
  assert.equal(applyEdit('aaa', 'Edit', { old_string: 'aa', new_string: 'b' }), 'ba',
    'occurrences count as Claude Code counts them, without overlap');
});

test('a string that is not found fails open, after one retry with LF turned into CRLF', () => {
  assert.equal(applyEdit('one\ntwo\n', 'Edit', { old_string: 'three', new_string: 'x' }), null);
  const crlf = 'one\r\ntwo\r\nthree\r\n';
  assert.equal(applyEdit(crlf, 'Edit', { old_string: 'one\ntwo\n', new_string: 'one\nnew\ntwo\n' }),
    'one\r\nnew\r\ntwo\r\nthree\r\n', 'the retry converts both strings, so the file stays CRLF');
  assert.equal(applyEdit('', 'Edit', { old_string: '', new_string: 'fresh' }), 'fresh', 'an empty file takes an empty old_string');
  assert.equal(applyEdit('x', 'Edit', { old_string: '', new_string: 'fresh' }), null);
});

test('MultiEdit applies its edits in order, and one that cannot apply fails the whole call open', () => {
  const edits = [{ old_string: 'a', new_string: 'b' }, { old_string: 'b', new_string: 'c', replace_all: true }];
  assert.equal(applyEdit('a b', 'MultiEdit', { edits }), 'c c', 'the second edit sees the first one\'s result');
  assert.equal(applyEdit('a b', 'MultiEdit', { edits: [...edits, { old_string: 'zzz', new_string: 'q' }] }), null);
  assert.equal(applyEdit('a b', 'MultiEdit', { edits: [] }), null);
});

// ── verdict ──────────────────────────────────────────────────────────────────

// One fixture per budget, each a file that sits exactly AT that budget and one step past it,
// with every other measure well inside. Each must block on its own measure and nothing else.
// MUTATION (each, one at a time): raise any BUDGETS value by one, or drop a key from BUDGETS;
// the case for that measure stops blocking and this fails naming it.
const AT_BUDGET = {
  lines: [Array.from({ length: 140 }, (_, i) => `l${i}`).join('\n') + '\n', 'one more line\n'],
  bytes: [('b'.repeat(299) + '\n').repeat(40), 'd'],
  lineChars: ['x'.repeat(300) + '\n', 'y'],
  entries: [Array.from({ length: 16 }, (_, i) => `- e${i}`).join('\n') + '\n', '- one more\n'],
  commentDefects: ['- clean\n', '-->\n'],
};
test('each budget blocks on its own measure, one step past it, and not at it', () => {
  for (const [metric, [at, more]] of Object.entries(AT_BUDGET)) {
    const base = measure(at);
    assert.equal(base[metric], BUDGETS[metric], `precondition: the ${metric} fixture sits at its budget`);
    assert.equal(verdict('', at).block, false, `${metric} exactly at its budget passes`);
    const past = metric === 'lineChars' ? at.replace(/\n$/, more + '\n') : at + more;
    const result = verdict(at, past);
    assert.deepEqual(result.reasons.map((r) => r.metric), [metric], `${metric} one step past its budget blocks on it alone`);
    assert.equal(result.reasons[0].after, BUDGETS[metric] + 1);
  }
  assert.deepEqual(BUDGETS, { lines: 140, bytes: 12000, lineChars: 300, entries: 16, commentDefects: 0 });
});

// THE rule: past the budget is allowed when the edit does not make that measure worse.
// MUTATION: drop `&& now[metric] > was[metric]` from verdict and the equal and shrinking cases
// below block, and the compaction property fails on its first draw.
test('an index already past a budget accepts edits that do not make that measure worse', () => {
  const over = Array.from({ length: 150 }, (_, i) => `l${i}`).join('\n') + '\n';
  assert.equal(verdict(over, over.replace('l3\n', 'L3\n')).block, false, 'same line count, past the budget: allowed');
  assert.equal(verdict(over, over.replace('l3\n', '')).block, false, 'one fewer line: allowed');
  const grown = verdict(over, over + 'l150\n');
  assert.equal(grown.block, true, 'one more line on an index already past 140: blocked');
  assert.deepEqual(grown.reasons, [{ metric: 'lines', before: 150, after: 151, budget: 140 }]);
  assert.equal(verdict('', over).block, true, 'a new file written past the budget is worse than no file');
});

// "One in, one out": with the entry count at its budget, adding an entry is refused and swapping
// one for another is not.
test('the entry budget makes the index one in, one out', () => {
  const full = Array.from({ length: 16 }, (_, i) => `- e${i}`).join('\n') + '\n';
  assert.equal(verdict(full, full + '- e16\n').block, true);
  assert.equal(verdict(full, full.replace('- e0\n', '') + '- e16\n').block, false);
});

// Compaction always gets through. Deleting lines can only lower lines, bytes, the longest line
// and the entry count, so from any index without comments, however far past every budget, any
// deletion passes. Seeded, so a failure is reproducible.
test('deleting lines from an index past every budget is never blocked', () => {
  let seed = 7;
  const next = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let draw = 0; draw < 200; draw += 1) {
    const count = 150 + Math.floor(next() * 60);
    const lines = Array.from({ length: count }, (_, i) => (next() < 0.5 ? '- ' : '') + `entry ${i} `
      + 'w'.repeat(Math.floor(next() * 420)));
    const eol = next() < 0.5 ? '\n' : '\r\n';
    const before = lines.join(eol) + eol;
    const kept = lines.filter(() => next() < 0.7);
    const after = kept.length ? kept.join(eol) + eol : '';
    const was = measure(before);
    assert.ok(was.lines > BUDGETS.lines && was.bytes > BUDGETS.bytes, `precondition (draw ${draw}): past the budgets`);
    const result = verdict(before, after);
    assert.equal(result.block, false, `draw ${draw}: deleting lines was blocked: ${JSON.stringify(result.reasons)}`);
  }
});

// The one deliberate exception, recorded in the guard's header: deleting HALF of a comment
// leaks its body into context, and that deletion is refused; deleting the whole comment is not.
test('deleting half of a comment is refused, deleting all of it is not', () => {
  const index = '<!--\nprivate header\n-->\n- a\n';
  assert.deepEqual(verdict(index, index.replace('<!--\n', '')).reasons.map((r) => r.metric), ['commentDefects']);
  assert.equal(verdict(index, '- a\n').block, false);
});

test('the block message names each failed measure with value and budget, and the way out, in under 600 characters', () => {
  const reasons = [
    { metric: 'lines', before: 9998, after: 9999, budget: 140 },
    { metric: 'bytes', before: 999998, after: 999999, budget: 12000 },
    { metric: 'lineChars', before: 99998, after: 99999, budget: 300 },
    { metric: 'entries', before: 9998, after: 9999, budget: 16 },
    { metric: 'commentDefects', before: 98, after: 99, budget: 0 },
  ];
  const message = blockMessage(reasons);
  assert.ok(message.length <= 600, `${message.length} characters: ${message}`);
  for (const reason of reasons) assert.ok(message.includes(`${reason.after} (budget ${reason.budget}, was ${reason.before})`));
  assert.match(message, /Compact MEMORY\.md: move detail into the memory file; status goes in the memory file/);
  assert.match(message, /`wildcard-perms --memory-guard off`/);
  // The palette command it names is one the extension contributes, by its exact title.
  const titled = message.match(/AI Acolyte command "([^"]+)"/)[1];
  const titles = require('../vscode-extension/package.json').contributes.commands.map((entry) => entry.title);
  assert.ok(titles.includes(`AI Acolyte: ${titled}`), `no contributed command is titled "AI Acolyte: ${titled}"`);
});

// ── the path filter ──────────────────────────────────────────────────────────

function configFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-memory-guard-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = path.join(root, 'config');
  const memory = path.join(config, 'projects', 'D--some-project', 'memory');
  fs.mkdirSync(memory, { recursive: true });
  return { root, config, memory, index: path.join(memory, 'MEMORY.md') };
}

test('only <config>/projects/<slug>/memory/MEMORY.md is the index', (t) => {
  const f = configFixture(t);
  const env = { CLAUDE_CONFIG_DIR: f.config };
  const reads = [];
  const readFile = (file) => { reads.push(file); throw Object.assign(new Error('no'), { code: 'ENOENT' }); };
  assert.equal(isIndexPath(f.index, { env, readFile }), true);
  assert.equal(isIndexPath(path.join(f.memory, 'memory.md'), { env, readFile }), false, 'the basename is exact');
  assert.equal(isIndexPath(path.join(f.memory, 'other.md'), { env, readFile }), false);
  assert.equal(isIndexPath(path.join(f.config, 'projects', 'memory', 'MEMORY.md'), { env, readFile }), false, 'a slug is required');
  assert.equal(isIndexPath(path.join(f.root, 'repo', 'memory', 'MEMORY.md'), { env, readFile }), false);
  assert.equal(isIndexPath(path.join(f.memory, 'sub', 'MEMORY.md'), { env, readFile }), false);
  if (process.platform === 'win32') {
    assert.equal(isIndexPath(f.index.toUpperCase().replace(/MEMORY\.MD$/, 'MEMORY.md'), { env, readFile }), true,
      'Windows paths compare without case');
  }
  // Without CLAUDE_CONFIG_DIR the config dir is <home>/.claude, home read the way os.homedir() reads it.
  const home = path.join(f.root, 'home');
  const homeIndex = path.join(home, '.claude', 'projects', 'slug', 'memory', 'MEMORY.md');
  assert.equal(isIndexPath(homeIndex, { env: { HOME: home, USERPROFILE: home }, readFile }), true);
  assert.equal(isIndexPath(f.index, { env: { HOME: home, USERPROFILE: home }, readFile }), false);
});

test('autoMemoryDirectory from <config>/settings.json is the index directory too', (t) => {
  const f = configFixture(t);
  const custom = path.join(f.root, 'elsewhere', 'mem');
  const home = path.join(f.root, 'home');
  const settings = (value) => (file) => {
    assert.equal(file, path.join(f.config, 'settings.json'));
    return JSON.stringify({ autoMemoryDirectory: value });
  };
  const env = { CLAUDE_CONFIG_DIR: f.config, HOME: home, USERPROFILE: home };
  assert.equal(isIndexPath(path.join(custom, 'MEMORY.md'), { env, readFile: settings(custom) }), true);
  assert.equal(isIndexPath(path.join(home, 'notes', 'MEMORY.md'), { env, readFile: settings('~/notes') }), true);
  assert.equal(isIndexPath(path.join(custom, 'MEMORY.md'), { env, readFile: settings('relative/dir') }), false);
  assert.equal(isIndexPath(path.join(custom, 'MEMORY.md'), { env, readFile: () => '{not json' }), false);
});

// The filter runs FIRST: an edit to any other file in the session is answered with no read at
// all, and an edit to a MEMORY.md that is not the index never reads that file.
// MUTATION: make isIndexPath return true for any MEMORY.md (or for any path) and the reads below
// include the edited file, and the spawned non-index test further down exits 2.
test('a file that is not the index is answered without reading it', (t) => {
  const f = configFixture(t);
  const env = { CLAUDE_CONFIG_DIR: f.config };
  const reads = [];
  const readFile = (file) => { reads.push(file); return 'x\n'.repeat(500); };
  const payload = (file) => JSON.stringify({ tool_name: 'Write', tool_input: { file_path: file, content: 'y\n'.repeat(900) } });
  assert.deepEqual(decide(payload(path.join(f.memory, 'note.md')), { env, readFile }), { code: 0, stderr: '' });
  assert.deepEqual(reads, [], 'another file in the memory dir: no read at all');
  const stray = path.join(f.root, 'repo', 'MEMORY.md');
  assert.deepEqual(decide(payload(stray), { env, readFile }), { code: 0, stderr: '' });
  assert.ok(!reads.includes(stray), `a MEMORY.md outside the store was read: ${reads.join(', ')}`);
  assert.deepEqual(reads, [path.join(f.config, 'settings.json')], 'only the autoMemoryDirectory lookup');
  assert.equal(decide(payload(f.index), { env, readFile }).code, 2, 'WITNESS: the same write to the index blocks');
});

// Fail open on anything the guard cannot read. Only a missing file reads as empty.
// MUTATION: treat every read error as an empty file (drop the ENOENT test in decide) and the
// directory case blocks a write it cannot judge.
test('a missing index reads as empty, and an unreadable one fails open', (t) => {
  const f = configFixture(t);
  const env = { CLAUDE_CONFIG_DIR: f.config };
  const big = JSON.stringify({ tool_name: 'Write', tool_input: { file_path: f.index, content: 'z\n'.repeat(141) } });
  assert.equal(decide(big, { env, readFile: () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }); } }).code, 2);
  assert.equal(decide(big, { env, readFile: () => { throw Object.assign(new Error('dir'), { code: 'EISDIR' }); } }).code, 0);
  assert.equal(decide(big, { env, readFile: () => { throw new Error('sharing violation'); } }).code, 0);
  assert.equal(decide('{"tool_name":"Write","tool_input":null}', { env }).code, 0);
  assert.equal(decide('null', { env }).code, 0);
});

// ── the hook, spawned ────────────────────────────────────────────────────────

function runHook(input, env) {
  return spawnSync(process.execPath, [GUARD], { input, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, CLAUDE_CONFIG_DIR: '', ...env }, maxBuffer: 32 * 1024 * 1024 });
}

function event(toolName, toolInput) {
  return JSON.stringify({ session_id: 'synthetic', transcript_path: '/tmp/none.jsonl', cwd: os.tmpdir(),
    permission_mode: 'default', hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: toolInput });
}

const OVER = Array.from({ length: 150 }, (_, i) => `- hook ${i}`).join('\n') + '\n';

test('the hook exits 2 with the reason on stderr when an edit grows an index already past its budget', (t) => {
  const f = configFixture(t);
  fs.writeFileSync(f.index, OVER);
  const run = runHook(event('Edit', { file_path: f.index, old_string: '- hook 3\n', new_string: '- hook 3\n- hook 3b\n' }),
    { CLAUDE_CONFIG_DIR: f.config });
  assert.equal(run.status, 2, run.stderr);
  assert.match(run.stderr, /lines 151 \(budget 140, was 150\)/);
  assert.match(run.stderr, /"- " entries 151 \(budget 16, was 150\)/);
  assert.equal(fs.readFileSync(f.index, 'utf8'), OVER, 'the guard never writes the file');
});

test('the hook exits 0, silently, for an edit that compacts or keeps the index level', (t) => {
  const f = configFixture(t);
  fs.writeFileSync(f.index, OVER.replace(/\n/g, '\r\n'));
  const shrink = runHook(event('Edit', { file_path: f.index, old_string: '- hook 3\n- hook 4\n', new_string: '- hooks 3-4\n' }),
    { CLAUDE_CONFIG_DIR: f.config });
  assert.equal(shrink.status, 0, shrink.stderr);
  assert.equal(shrink.stderr, '');
  // Every old_string is unique in the file, so the guard reproduces this call and the exit 0 is
  // its verdict, not a fail-open. `- hook 2` alone would also match hooks 20 to 29.
  // MUTATION: shorten the second old_string to '- hook 2' and the reproduction check fails.
  const level = [{ old_string: '- hook 1\r\n', new_string: '' }, { old_string: '- hook 2\r\n', new_string: '- hook 2 and 1\r\n' }];
  assert.notEqual(applyEdit(OVER.replace(/\n/g, '\r\n'), 'MultiEdit', { edits: level }), null,
    'precondition: the MultiEdit fixture can be reproduced');
  const multi = runHook(event('MultiEdit', { file_path: f.index, edits: level }), { CLAUDE_CONFIG_DIR: f.config });
  assert.equal(multi.status, 0, multi.stderr);
});

// The same reproduction, growing the index: the MultiEdit path judges, it does not only fail open.
// MUTATION: make applyEdit return null for MultiEdit and this exits 0.
test('the hook exits 2 for a MultiEdit that grows an index already past its budget', (t) => {
  const f = configFixture(t);
  fs.writeFileSync(f.index, OVER.replace(/\n/g, '\r\n'));
  const run = runHook(event('MultiEdit', { file_path: f.index, edits: [
    { old_string: '- hook 2\r\n', new_string: '- hook 2\r\n- hook 2b\r\n' },
    { old_string: '- hook 5\r\n', new_string: '- hook 5\r\n- hook 5b\r\n' }] }), { CLAUDE_CONFIG_DIR: f.config });
  assert.equal(run.status, 2, run.stderr);
  assert.match(run.stderr, /lines 152 \(budget 140, was 150\)/);
});

test('the hook resolves the index from HOME when CLAUDE_CONFIG_DIR is unset', (t) => {
  const f = configFixture(t);
  const home = path.join(f.root, 'home');
  const index = path.join(home, '.claude', 'projects', 'p', 'memory', 'MEMORY.md');
  fs.mkdirSync(path.dirname(index), { recursive: true });
  const run = runHook(event('Write', { file_path: index, content: OVER }), { HOME: home, USERPROFILE: home });
  assert.equal(run.status, 2, run.stderr);
});

test('the hook lets through a write to any other file, however large', (t) => {
  const f = configFixture(t);
  const stray = path.join(f.root, 'repo', 'MEMORY.md');
  fs.mkdirSync(path.dirname(stray), { recursive: true });
  fs.writeFileSync(stray, OVER);
  const run = runHook(event('Write', { file_path: stray, content: OVER + OVER }), { CLAUDE_CONFIG_DIR: f.config });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr, '');
});

test('the hook fails open on garbage, on an empty payload, and on a payload past the 8 MiB cap', (t) => {
  const f = configFixture(t);
  for (const input of ['', 'not json', '[1,2]', '{"tool_name":"Write"}']) {
    const run = runHook(input, { CLAUDE_CONFIG_DIR: f.config });
    assert.equal(run.status, 0, `${JSON.stringify(input)}: ${run.stderr}`);
    assert.equal(run.stderr, '');
  }
  // 9 MiB of index content: a violation on every measure, which the cap must let through
  // rather than parse. MUTATION: raise STDIN_CAP above 9 MiB and this exits 2.
  const huge = event('Write', { file_path: f.index, content: '- x\n'.repeat(9 * 1024 * 1024 / 4) });
  assert.ok(Buffer.byteLength(huge) > 9 * 1024 * 1024);
  const run = runHook(huge, { CLAUDE_CONFIG_DIR: f.config });
  assert.equal(run.status, 0, run.stderr);
  const small = runHook(event('Write', { file_path: f.index, content: '- x\n'.repeat(200) }), { CLAUDE_CONFIG_DIR: f.config });
  assert.equal(small.status, 2, 'WITNESS: the same write under the cap blocks');
});

test('the hook fails open when MEMORY.md is a directory or the edit cannot be reproduced', (t) => {
  const f = configFixture(t);
  fs.mkdirSync(f.index);
  const dir = runHook(event('Write', { file_path: f.index, content: OVER }), { CLAUDE_CONFIG_DIR: f.config });
  assert.equal(dir.status, 0, dir.stderr);
  fs.rmdirSync(f.index);
  fs.writeFileSync(f.index, OVER);
  const missing = runHook(event('Edit', { file_path: f.index, old_string: 'absent', new_string: OVER }), { CLAUDE_CONFIG_DIR: f.config });
  assert.equal(missing.status, 0, missing.stderr);
  const ambiguous = runHook(event('Edit', { file_path: f.index, old_string: '- hook 1', new_string: OVER }), { CLAUDE_CONFIG_DIR: f.config });
  assert.equal(ambiguous.status, 0, 'an old_string matching "- hook 1" and "- hook 10".. is ambiguous: fail open');
});
