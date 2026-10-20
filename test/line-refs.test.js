'use strict';

// Every `file:line` reference this repo writes about itself must at least RESOLVE.
//
// The repo documents its own internals by line number, in BACKLOG.md and in code
// comments, and those numbers rot on the next edit. BACKLOG.md's own dead-code
// audit records "~60 stale file:line refs"; `scripts/check-line-refs.js` counts
// the real population at over 150. Two references written during a single change
// were wrong within hours, and two written while fixing THIS cluster were wrong
// within minutes, because a three-line edit to a module header moved everything
// several hundred lines below it.
//
// WHAT THIS ASSERTS, AND WHY IT IS DELIBERATELY NARROW.
//
// Only the objective half: the referenced file exists in the tree, and the
// referenced line exists inside it. Nothing here reads the prose.
//
// The checker's richer STALE verdict is NOT asserted, on purpose. That verdict
// depends on recovering the right anchor from surrounding prose, and it picks a
// neighbouring symbol often enough that asserting it would fail the suite on
// references that are perfectly correct — `bin/wildcard-perms:7-29#NOTE` was the
// standing example. A gate that cries wolf gets suppressed, and then the real
// signal goes with it. So the imprecise half stays a report you run by hand, and
// only the half that cannot false-positive is a test.
//
// It is also the half that catches the worst failure: a reference to a file that
// was renamed or deleted, or a line past the end of a file that shrank. Those
// send a reader somewhere that does not exist at all, rather than somewhere
// merely out of date.
//
// AN ANCHORED REFERENCE IS ASSERTED IN FULL (since 2026-10-13). One written
// `file:line#identifier` says which token belongs on the cited line, so checking it
// reads no prose and cannot cry wolf the way STALE does: the token is on the line or
// it is not. checkBounds therefore fails an anchored reference whose anchor has left
// its line, which is the drift the un-anchored half above is blind to. The tests
// below that build throwaway checkouts pin that check, the token rule, the parse,
// and --fix-anchored, which repoints a moved anchor only when it is on exactly one
// line now. Measured 2026-10-13 they cost about 2.4 s together, most of it six
// fixture `git init`s and two node child processes.
//
// Cost: ~0.13 s, because it resolves paths and counts lines and does no
// per-anchor scan of the target.
//
// ESCAPE HATCH: a line carrying the marker `line-refs` + `:ignore` has its
// references skipped. Documentation ABOUT the reference format has to contain
// references that dangle on purpose, and scripts/check-line-refs.js tripped this
// very test the moment it became tracked. The marker is LINE-scoped, not
// file-scoped, so a file that uses it for one illustration is still policed for
// its own real references. Reach for it only for an example, never to silence a
// reference that should have been fixed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const {
  checkBounds, checkVacuous, isVacuousSpan, collectRefs, tracked, stripRefs, anchorsFrom,
  anchorLines, fixAnchored,
} = require('../scripts/check-line-refs.js');

const CHECKER = path.join(__dirname, '..', 'scripts', 'check-line-refs.js');

// The anchored-reference RATCHET, in the style of the `>= 100` floors below. Anchoring
// is a migration done a reference at a time, and the failure it guards against is the
// quiet one: an edit that rewrites a sentence and drops its `#anchor`, or an extractor
// change that stops parsing the group, leaves every remaining test green while the
// citation slides back into the unchecked population. Raise this as references are
// migrated; never lower it to make a failure go away. 1 on 2026-10-13: the citation in
// memory/recall.py of the `.slice(0, 300)` that cuts the gate compiler's stderr. 193 later
// the same day, when the migration finished and every collected citation was anchored;
// from then on the test below the floor test also refuses a NEW un-anchored citation.
const ANCHORED_FLOOR = 193;

// A throwaway checkout, for the tests that need a corpus of their own: one that MUST
// hold a broken reference (the real tree must not), or one --fix-anchored may rewrite.
// The checker enumerates with `git ls-files`, so the files go into an index. Nothing is
// committed, so no identity is needed, and autocrlf/safecrlf are pinned off so that a
// machine-wide setting can neither refuse the add nor matter: the checker and the fixer
// read the WORKING TREE, which is exactly the bytes written here.
function fixtureRepo(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'line-refs-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
  const git = (...args) => execFileSync(
    'git', ['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', ...args],
    { cwd: root, stdio: 'pipe' }
  );
  git('init', '-q');
  git('add', '-A');
  return root;
}

function snapshot(root, files) {
  return Object.fromEntries(Object.keys(files).map((rel) => [rel, fs.readFileSync(path.join(root, rel)).toString('base64')]));
}

test('every file:line reference resolves to a real file and a line inside it', () => {
  const broken = checkBounds();
  const detail = broken.map((b) => `  ${b.where}\n      ${b.reason}`).join('\n');
  assert.equal(
    broken.length,
    0,
    `${broken.length} file:line reference(s) point at nothing:\n${detail}\n\n` +
      'Run `node scripts/check-line-refs.js --detail` for the full report, ' +
      'including the weaker STALE candidates this test deliberately does not assert.'
  );
});

// A count floor. Without it the test above passes trivially if the extractor
// regex ever stops matching — zero references found is zero broken references,
// and the guard would go quiet in exactly the way that looks like success.
// The number is a floor, not an equality, so adding documentation never fails it.
test('the reference extractor still finds the corpus it is meant to police', () => {
  const refs = collectRefs(tracked());
  assert.ok(
    refs.length >= 100,
    `expected at least 100 file:line references across the tree, found ${refs.length}. ` +
      'If documentation really did shrink that much, lower the floor deliberately; ' +
      'otherwise the extractor in scripts/check-line-refs.js has stopped matching.'
  );
  // Both populations must be represented, so a regression that silently drops one
  // whole class of reference cannot hide behind the other's count.
  assert.ok(refs.some((r) => r.kind === 'doc'), 'no references found in tracked .md files');
  assert.ok(refs.some((r) => r.kind === 'comment'), 'no references found in source comments');
});

// The predicate, pinned directly. The corpus assertion below cannot do this job: the
// tree has zero offenders, so emptying VACUOUS_LINE or flipping `every` to `some` leaves
// it green. Every case here is one the corpus reached at some point during the
// 2026-09-14 pass.
test('the vacuous-line predicate accepts exactly what nobody could have meant', () => {
  assert.equal(isVacuousSpan(['']), true, 'a blank line');
  assert.equal(isVacuousSpan(['    ']), true, 'whitespace only');
  assert.equal(isVacuousSpan(['  }']), true, 'a bare closing brace');
  assert.equal(isVacuousSpan(['      };']), true, 'with a semicolon');
  assert.equal(isVacuousSpan(['  });']), true, 'a closing call');
  assert.equal(isVacuousSpan(['', '  }', '   ']), true, 'a range of nothing but those');

  // The other side, which is what stops this gate eating real references.
  assert.equal(isVacuousSpan(['const VERSION = 1;']), false, 'real code');
  assert.equal(isVacuousSpan(['  // a comment is a legitimate target here']), false,
    'this repo documents itself in comments, so a comment line is a real target');
  assert.equal(isVacuousSpan(['}', 'const x = 1;']), false,
    'a range that STARTS on a brace but covers real code is a reference to that code');
  assert.equal(isVacuousSpan([]), false, 'an empty span is checkBounds business, not this');
});

// The SECOND objective check, and the only other one that can be asserted.
//
// checkBounds catches a reference to a line that does not exist. This catches one that
// exists and says nothing: a blank line, or punctuation that only closes a block. No
// anchor, no prose, no judgement — nobody documents a closing brace, so a reference
// that lands on one is wrong however the sentence around it reads. That is exactly why
// it can be a test while the STALE verdict stays a report.
//
// Reachable, not theoretical. The tree held 13 of these when the 2026-09-14 correction
// pass began, including one written an hour earlier in that same session. They are at
// zero now, which is what makes this a gate rather than a backlog entry.
//
// A range counts only when EVERY line in it is vacuous. Testing just the start line
// called two references wrong whose ranges go on to cover real code.
test('no file:line reference points at a blank line or a bare closing brace', () => {
  // A floor first, for the reason the sibling test above spells out: zero references
  // examined is zero offenders and a green run, and this assertion would go quiet in
  // exactly the way that looks like success.
  const examined = collectRefs(tracked()).length;
  assert.ok(
    examined >= 100,
    `only ${examined} references were extracted, so this test proved nothing`
  );

  const bad = checkVacuous();
  const detail = bad.map((b) => `  ${b.where}\n      ${b.reason}`).join('\n');
  assert.equal(
    bad.length,
    0,
    `${bad.length} reference(s) point at a line that says nothing:\n${detail}\n\n` +
      'Find what the prose actually meant and cite that line. If the code it named was ' +
      'deleted rather than moved, say so in the prose instead of pointing at the gap.'
  );
});

// A reference is stripped out of the prose before the anchor hunt, so that the file
// name inside the reference cannot serve as its own anchor. Stripping the token but
// NOT the backticks around it left an orphan backtick, which paired with the opening
// backtick of the next real anchor and shifted every code span after it. The anchor
// that mattered was then never extracted, and a correct reference was reported STALE
// or UNVERIFIABLE with no way to tell that from "the prose names nothing literal".
//
// This is the exact string that exposed it during the correction pass of 2026-09-14.
// Two agents hit the same bug independently on different files, and both worked around
// it by moving the symbol ahead of the citation, which is why it looked like a writing
// convention rather than a defect.
test('an anchor written AFTER a backticked reference is still extracted', () => {
  const prose = 'The walk at `src/history-adapters.js:939` queues `entry.isSymbolicLink()` children.';
  const anchors = anchorsFrom(stripRefs(prose)).map((a) => a.text);

  assert.ok(
    anchors.includes('entry.isSymbolicLink()'),
    'the code span after the reference was eaten by an orphan backtick, so the anchor ' +
      `hunt never saw it. Extracted: ${JSON.stringify(anchors)}`
  );

  // The other half of the contract, so a "fix" that simply stopped stripping would
  // fail here rather than pass the assertion above by doing nothing.
  assert.ok(
    !anchors.some((a) => a.includes('history-adapters.js')),
    `the reference survived the strip and can now anchor itself: ${JSON.stringify(anchors)}`
  );

  // A reference written WITHOUT backticks must still be removed, and must not take a
  // neighbouring span with it. Without this, consuming an optional backtick on each
  // side could eat the opening backtick of an adjacent anchor and reintroduce the bug
  // from the other direction.
  const bare = 'See src/history-adapters.js:939 and `COMMAND_TOOLS` for the rest.';
  const bareAnchors = anchorsFrom(stripRefs(bare)).map((a) => a.text);
  assert.ok(bareAnchors.includes('COMMAND_TOOLS'), JSON.stringify(bareAnchors));
  assert.ok(!bareAnchors.some((a) => a.includes('history-adapters.js')), JSON.stringify(bareAnchors));
});

// ---------------------------------------------------------------------------
// Declared anchors, 2026-10-13. See the block above ANCHOR_RE in
// scripts/check-line-refs.js for the grammar and the semantics these pin.
// ---------------------------------------------------------------------------

test('the tree keeps at least ANCHORED_FLOOR anchored references', () => {
  const anchored = collectRefs(tracked()).filter((r) => r.declaredRaw != null);
  assert.ok(
    anchored.length >= ANCHORED_FLOOR,
    `expected at least ${ANCHORED_FLOOR} anchored file:line#identifier references, found ` +
      `${anchored.length}. Either an edit dropped an anchor (find it and put it back) or the ` +
      'extractor in scripts/check-line-refs.js stopped parsing them.'
  );
});

// The gate is exact only while EVERY citation is. The migration finished 2026-10-13 with
// all 193 collected citations anchored; before it, 61 of 160 were STALE and nothing could
// fail on them. An un-anchored citation added after that day goes back through the
// heuristic, which by design never fails the suite, so it would rot unseen exactly as the
// old corpus did. A citation that must stay as written (history, a quoted defect) carries
// a `line-refs:ignore` marker and is not collected at all.
test('every collected file:line citation declares an anchor', () => {
  const bare = collectRefs(tracked()).filter((r) => r.declaredRaw == null);
  assert.deepEqual(
    bare.map((r) => `${r.source}:${r.sourceLine} -> ${r.raw}`),
    [],
    `${bare.length} citation(s) have no #anchor. Write them as file:line#identifier, naming a ` +
      'token that is on the cited line (see scripts/check-line-refs.js), or mark a deliberately ' +
      'historical one with line-refs:ignore.'
  );
});

// Mid-merge, `git ls-files` lists a conflicted path once per index stage; the checker
// must still see one file. Built with three real index stages for one path.
test('an unmerged path is enumerated once, not once per index stage', (t) => {
  const root = fixtureRepo(t, { 'a.md': 'see `b.js:1#x`\n', 'b.js': 'const x = 1;\n' });
  const blob = execFileSync('git', ['-C', root, 'hash-object', '-w', 'a.md'], { encoding: 'utf8' }).trim();
  execFileSync('git', ['-C', root, 'update-index', '--force-remove', 'a.md']);
  execFileSync('git', ['-C', root, 'update-index', '--index-info'], {
    input: [1, 2, 3].map((stage) => `100644 ${blob} ${stage}\ta.md\n`).join(''),
  });
  const raw = execFileSync('git', ['-C', root, 'ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  assert.equal(raw.filter((f) => f === 'a.md').length, 3, 'precondition: git lists the unmerged path three times');
  assert.deepEqual(tracked(root).filter((f) => f === 'a.md'), ['a.md']);
  assert.equal(collectRefs(tracked(root), root).length, 1, 'one citation, counted once');
});

// The parse, line by line. Rows 1, 5 and 6 are the CONTROL: a reference with no anchor,
// and the two spellings of a `#` that is not one, must come out exactly as they did
// before anchors existed, raw text included, or the un-anchored half of the corpus has
// silently changed meaning.
test('a declared anchor parses after a line or a range, and a stray # is still not one', (t) => {
  const root = fixtureRepo(t, {
    'src/a.js': "'use strict';\nfunction fooBar() {}\n",
    'notes.md': [
      '- plain `src/a.js:2` stays un-anchored',
      '- line `src/a.js:2#fooBar` anchors fooBar',
      '- range src/a.js:1-2#fs.realpathSync. at the end of a sentence',
      '- colon src/a.js:2#fooBar: and more prose',
      '- spaced src/a.js:2 #fooBar is prose after a reference, not an anchor',
      '- digit src/a.js:2#3 is not an anchor either',
      '- malformed src/a.js:2#foo-bar is captured whole, so it can be reported',
      '',
    ].join('\n'),
  });
  const refs = collectRefs(['notes.md'], root);
  assert.deepEqual(
    refs.map((r) => [r.sourceLine, r.target, r.start, r.end, r.declaredRaw, r.declaredAnchor]),
    [
      [1, 'src/a.js', 2, 2, null, null],
      [2, 'src/a.js', 2, 2, 'fooBar', 'fooBar'],
      [3, 'src/a.js', 1, 2, 'fs.realpathSync.', 'fs.realpathSync'],
      [4, 'src/a.js', 2, 2, 'fooBar:', 'fooBar'],
      [5, 'src/a.js', 2, 2, null, null],
      [6, 'src/a.js', 2, 2, null, null],
      [7, 'src/a.js', 2, 2, 'foo-bar', null],
    ]
  );
  assert.deepEqual([refs[0].raw, refs[4].raw, refs[5].raw], ['src/a.js:2', 'src/a.js:2', 'src/a.js:2']);
});

// The token rule is the whole of what makes the anchored check exact, so it is pinned
// case by case rather than through a corpus. Each line below is a way to be wrong.
test('an anchor matches only as a whole token, and a citation of it is not an occurrence', () => {
  const lines = [
    'function scanTrouble() {}',       // 1  a longer identifier
    'this.scan(x);',                   // 2  a member access: matches
    'const $scan = _scan;',            // 3  `$` and `_` are identifier characters
    'fs.realpathSync(p);',             // 4
    'fs.realpathSync.native(p);',      // 5  a dotted anchor is a prefix of the chain
    'xfs.realpathSync(p);',            // 6
    '// see src/a.js:2#scan',          // 7  a CITATION of the anchor, masked out
    "const name = 'scan';",            // 8  inside a string: still the token
    // 9: the dot is literal, not a wildcard. The literal anchor has to be on the line
    // too (here inside a longer name), or the substring fast exit skips the line before
    // the regex runs and an unescaped dot is never exercised: the first draft of this
    // case was `fs_realpathSync(p);` alone, and the escape mutation survived it.
    'fs_realpathSync(p); // fs.realpathSyncAsync',
    'const $scope = 1;',               // 10 `$` is literal too, not an end-of-input assertion
  ];
  assert.deepEqual(anchorLines('scan', lines), [2, 8]);
  assert.deepEqual(anchorLines('fs.realpathSync', lines), [4, 5]);
  assert.deepEqual(anchorLines('realpathSync', lines), [4, 5, 6]);
  assert.deepEqual(anchorLines('$scope', lines), [10]);
  assert.deepEqual(anchorLines('Scan', lines), [], 'case-sensitive');
});

test('an anchored reference whose anchor left the cited line fails the bounds gate', (t) => {
  const root = fixtureRepo(t, {
    'src/a.js': "'use strict';\nfunction fooBar() {}\nfunction other() {}\n",
    'lib/x.js': 'const dupe = 1;\n',
    'pkg/x.js': 'const dupe = 2;\n',
    'notes.md': [
      '- right: `src/a.js:2#fooBar`',
      '- right, anywhere in a range: `src/a.js:1-3#fooBar`',
      '- moved: `src/a.js:3#fooBar`',
      '- gone: `src/a.js:2#notThere`',
      '- malformed: `src/a.js:2#foo-bar`',
      '- ambiguous file: `x.js:1#dupe`',
      '- ambiguous file, un-anchored: `x.js:1`, which this gate skips as it always has',
      '',
    ].join('\n'),
  });
  const broken = checkBounds(root);
  const by = Object.fromEntries(broken.map((b) => [b.sourceLine, b.reason]));
  assert.deepEqual(Object.keys(by).map(Number), [3, 4, 5, 6], JSON.stringify(by, null, 2));
  assert.match(by[3], /#fooBar is not on line 3; it occurs only on line 2/);
  assert.match(by[4], /#notThere occurs nowhere in src\/a\.js/);
  assert.match(by[5], /malformed anchor #foo-bar/);
  assert.match(by[6], /ambiguous basename/);
});

// Row 1 and row 4 are the CONTROL for "un-anchored verdicts are unchanged": the same
// prose with no anchor, or with a `#` that is not one, still goes to the heuristic and
// still comes back STALE with a `suggest`. Rows 2 and 3 carry the same misleading prose
// and an anchor, and are judged on the anchor alone: OK where the prose would have said
// STALE, BROKEN where it would have said STALE, and never a `suggest`.
test('an anchored reference is judged on its anchor alone, never by the prose heuristic', (t) => {
  const target = ["'use strict';", 'function fooBar() {}'];
  while (target.length < 9) target.push('// padding, so the prose anchor is past TOLERANCE');
  target.push('function elsewhereFn() {}', '');
  const root = fixtureRepo(t, {
    'src/a.js': target.join('\n'),
    'notes.md': [
      '- the prose names `elsewhereFn` at `src/a.js:2`',
      '- the prose names `elsewhereFn` at `src/a.js:2#fooBar`',
      '- the prose names `fooBar` at `src/a.js:10#fooBar`',
      '- the prose names `elsewhereFn` at src/a.js:2#3',
      '',
    ].join('\n'),
  });
  const run = spawnSync(process.execPath, [CHECKER, '--json', '--root', root], { encoding: 'utf8' });
  assert.equal(run.status, 1, `exit ${run.status}; an anchored BROKEN row must fail the run\n${run.stderr}`);
  const report = JSON.parse(run.stdout);
  assert.deepEqual(
    report.results.map((r) => [r.sourceLine, r.verdict, r.suggest, r.anchor, r.occurs]),
    [
      [1, 'STALE', [10], null, null],
      [2, 'OK', null, 'fooBar', [2]],
      [3, 'BROKEN', null, 'fooBar', [2]],
      [4, 'STALE', [10], null, null],
    ]
  );
  assert.equal(report.anchored, 2);
});

// One corpus for the fixer tests. Target first, 14 lines, LF:
//   4 uniqueMover   7-8 twin (twice)   9 rangeHead   12 nearEnd
// The citing files are CRLF, which is what this tree's working copy is on Windows.
const MOD_JS = [
  "'use strict';", '// padding', '// padding',
  'function uniqueMover() {', '  return 1;', '}',
  'function twin() { return 2; }', 'const again = twin();',
  'function rangeHead(a) {', '  return a + 1;', '}',
  'function nearEnd() {', '  return 3;', '}', '',
].join('\n');
const NOTES_BEFORE = [
  '# Notes',
  '',
  '- moved: `src/mod.js:1#uniqueMover`',
  '- range moved: `src/mod.js:2-4#rangeHead`',
  '- ambiguous: `src/mod.js:1#twin`',
  '- missing: `src/mod.js:1#vanished`',
  '- a range that cannot shift: `src/mod.js:3-6#nearEnd`',
  '- already right: `src/mod.js:12#nearEnd`',
  '- two on a line: `src/mod.js:99#uniqueMover` and `src/mod.js:1-2#rangeHead`',
  '- un-anchored, never touched: `src/mod.js:1` names `uniqueMover`',
  '',
].join('\r\n');
const USE_JS_BEFORE = [
  "'use strict';",
  '// Calls the helper at src/mod.js:2#uniqueMover, which has moved.',
  'module.exports = 1;',
  '',
].join('\r\n');
const FIX_FIXTURE = { 'src/mod.js': MOD_JS, 'notes.md': NOTES_BEFORE, 'src/use.js': USE_JS_BEFORE };

test('--fix-anchored repoints a unique moved anchor exactly, and leaves everything else', (t) => {
  const root = fixtureRepo(t, FIX_FIXTURE);
  const report = fixAnchored(root);

  assert.deepEqual(
    report.fixed.map((f) => `${f.where} ${f.raw} -> ${f.to}`),
    [
      'notes.md:3 src/mod.js:1#uniqueMover -> 4',
      'notes.md:4 src/mod.js:2-4#rangeHead -> 9-11',
      'notes.md:9 src/mod.js:99#uniqueMover -> 4',
      'notes.md:9 src/mod.js:1-2#rangeHead -> 9-10',
      'src/use.js:2 src/mod.js:2#uniqueMover -> 4',
    ]
  );
  assert.deepEqual(report.left.map((l) => [l.where, l.kind]), [
    ['notes.md:5', 'AMBIGUOUS'],
    ['notes.md:6', 'MISSING'],
    ['notes.md:7', 'UNFIXABLE'],
  ]);
  assert.match(report.left[0].reason, /#twin occurs on 2 lines: 7, 8/);
  assert.match(report.left[2].reason, /would end at 15, past the end of src\/mod\.js \(14 lines\)/);
  assert.deepEqual(report.written.slice().sort(), ['notes.md', 'src/use.js']);

  const notes = fs.readFileSync(path.join(root, 'notes.md'), 'utf8');
  // Line endings first, so a fixer that re-joins lines fails with a message about
  // exactly that rather than as an opaque whole-file mismatch below.
  assert.equal(notes.split('\r\n').length, NOTES_BEFORE.split('\r\n').length, 'CRLF count changed');
  assert.ok(!/(^|[^\r])\n/.test(notes), 'a bare LF appeared in a CRLF file');
  assert.equal(notes, NOTES_BEFORE
    .replace('src/mod.js:1#uniqueMover`\r\n', 'src/mod.js:4#uniqueMover`\r\n')
    .replace('src/mod.js:2-4#rangeHead', 'src/mod.js:9-11#rangeHead')
    .replace('src/mod.js:99#uniqueMover', 'src/mod.js:4#uniqueMover')
    .replace('src/mod.js:1-2#rangeHead', 'src/mod.js:9-10#rangeHead'));
  assert.equal(
    fs.readFileSync(path.join(root, 'src/use.js'), 'utf8'),
    USE_JS_BEFORE.replace('src/mod.js:2#uniqueMover', 'src/mod.js:4#uniqueMover')
  );
  assert.equal(fs.readFileSync(path.join(root, 'src/mod.js'), 'utf8'), MOD_JS, 'the target was written');

  // What it refused is still BROKEN, so the gate goes on failing until a person decides.
  assert.deepEqual(checkBounds(root).map((b) => `${b.source}:${b.sourceLine}`),
    ['notes.md:5', 'notes.md:6', 'notes.md:7']);
});

test('a second --fix-anchored run changes nothing', (t) => {
  const root = fixtureRepo(t, FIX_FIXTURE);
  fixAnchored(root);
  const once = snapshot(root, FIX_FIXTURE);
  const again = fixAnchored(root);
  assert.deepEqual(again.fixed.map((f) => f.where), [], 'the second run found more to fix');
  assert.deepEqual(again.written, []);
  assert.deepEqual(snapshot(root, FIX_FIXTURE), once, 'the second run changed bytes');
  assert.deepEqual(again.left.map((l) => l.where), ['notes.md:5', 'notes.md:6', 'notes.md:7']);
});

test('the --fix-anchored CLI reports the run and exits 1 while anything is left BROKEN', (t) => {
  const root = fixtureRepo(t, FIX_FIXTURE);
  const run = spawnSync(process.execPath, [CHECKER, '--fix-anchored', '--root', root], { encoding: 'utf8' });
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stdout,
    /--fix-anchored: 5 fixed, 1 ambiguous, 1 missing, 1 unfixable, of 9 anchored references/);
  assert.match(run.stdout, /FIXED\s+notes\.md:4\s+src\/mod\.js:2-4#rangeHead\s+->\s+:9-11\s+\(range re-headed/);
  // The CLI wrote what the in-process call writes.
  assert.equal(fs.readFileSync(path.join(root, 'src/use.js'), 'utf8'),
    USE_JS_BEFORE.replace('src/mod.js:2#uniqueMover', 'src/mod.js:4#uniqueMover'));
});

// THE DIFF TIE-BREAK (2026-10-16). An anchor on several lines used to be AMBIGUOUS
// whatever had happened, and a release that inserted a block above a much-cited
// identifier left 60 of them for a person. Now a citation that was RIGHT AT HEAD is
// carried through `git diff HEAD` to where its line is now, both ends of a range
// mapped. Everything the diff cannot place stays AMBIGUOUS: a citation already wrong
// at HEAD, and one whose cited line was itself edited.
//
// This fixture is COMMITTED, unlike fixtureRepo's, because the tie-break reads HEAD.
// The identity and the signing setting are pinned for the reason fixtureRepo pins
// autocrlf: a throwaway repository, where a machine-wide setting must not matter.
const DUP_HEAD = [
  "'use strict';", 'function twin() { return 2; }', 'const again = twin();',
  'const third = twin();', '// tail', 'function last() {}', '',
].join('\n');
const DUP_NOW = [
  "'use strict';", '// pad', '// pad', '// pad', 'function twin() { return 2; }',
  'const again = twin();', 'const third = twin() * 1;', '// tail', 'function last() {}', '',
].join('\n');
const DUP_NOTES = [
  '- right at HEAD: `src/dup.js:2#twin`',
  '- the second, right at HEAD: `src/dup.js:3#twin`',
  '- a range, right at HEAD: `src/dup.js:2-3#twin`',
  '- its cited line was edited: `src/dup.js:4#twin`',
  '- already wrong at HEAD: `src/dup.js:1#twin`',
  '- unique, the old rule: `src/dup.js:6#last`',
  '',
].join('\n');

function committedRepo(t, files) {
  const root = fixtureRepo(t, files);
  execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'fixture'], { cwd: root, stdio: 'pipe' });
  return root;
}

test('--fix-anchored carries an ambiguous anchor that was right at HEAD through the diff, and only that', (t) => {
  const root = committedRepo(t, { 'src/dup.js': DUP_HEAD, 'notes.md': DUP_NOTES });
  fs.writeFileSync(path.join(root, 'src/dup.js'), DUP_NOW);

  const report = fixAnchored(root);
  assert.deepEqual(report.fixed.map((f) => `${f.where} ${f.raw} -> ${f.to}`), [
    'notes.md:1 src/dup.js:2#twin -> 5',
    'notes.md:2 src/dup.js:3#twin -> 6',
    'notes.md:3 src/dup.js:2-3#twin -> 5-6',
    'notes.md:6 src/dup.js:6#last -> 9',
  ], 'witness:diff-tie-break -- a citation that was right at HEAD was not carried to where its line is now');
  // The controls: nothing the diff cannot place is guessed at.
  assert.deepEqual(report.left.map((l) => [l.where, l.kind]), [
    ['notes.md:4', 'AMBIGUOUS'],
    ['notes.md:5', 'AMBIGUOUS'],
  ]);
  assert.equal(fs.readFileSync(path.join(root, 'notes.md'), 'utf8'), DUP_NOTES
    .replace('src/dup.js:2#twin', 'src/dup.js:5#twin').replace('src/dup.js:3#twin', 'src/dup.js:6#twin')
    .replace('src/dup.js:2-3#twin', 'src/dup.js:5-6#twin').replace('src/dup.js:6#last', 'src/dup.js:9#last'));

  // The report run names the route, so a reader can see why the fixer would act.
  const hinted = JSON.parse(spawnSync(process.execPath, [CHECKER, '--json', '--root', root], { encoding: 'utf8' }).stdout);
  assert.match(hinted.results.find((r) => r.sourceLine === 4).detail, /#twin occurs on 3 lines: 5, 6, 7; repoint by hand/);
});

test('without a commit the tie-break has no HEAD to read, and an ambiguous anchor stays ambiguous', (t) => {
  const root = fixtureRepo(t, { 'src/dup.js': DUP_NOW, 'notes.md': DUP_NOTES });
  const report = fixAnchored(root);
  assert.deepEqual(report.fixed.map((f) => f.where), ['notes.md:6']);
  assert.deepEqual(report.left.map((l) => l.kind), ['AMBIGUOUS', 'AMBIGUOUS', 'AMBIGUOUS', 'AMBIGUOUS', 'AMBIGUOUS']);
});

// THE WEAK-ANCHOR REPORT (2026-10-20). An anchor on many lines of its target lets a citation
// drift onto another occurrence and still read OK, so every check run counts those (5 or more
// lines) and lists the worst (10 or more), and never fails on them. Target, LF:
//   1-10 `many` on ten lines   11-15 `some` on five   16 `once` alone
// MUTATION: make weakAnchors return [] (or compare `> min`). This fails on the counts below.
test('the checker reports anchors that occur on many lines of their target, and does not fail on them', (t) => {
  const target = [
    ...Array.from({ length: 10 }, (_, i) => `const v${i} = many;`),
    ...Array.from({ length: 5 }, (_, i) => `const w${i} = some;`),
    'function once() {}', '',
  ];
  const root = fixtureRepo(t, {
    'src/a.js': target.join('\n'),
    'notes.md': ['- see `src/a.js:3#many`', '- see `src/a.js:12#some`', '- see `src/a.js:16#once`', ''].join('\n'),
  });
  const json = spawnSync(process.execPath, [CHECKER, '--json', '--root', root], { encoding: 'utf8' });
  assert.equal(json.status, 0, `a weak anchor is reported, never a failure\n${json.stderr}`);
  const report = JSON.parse(json.stdout);
  assert.deepEqual(report.results.map((r) => r.verdict), ['OK', 'OK', 'OK'], 'precondition: all three resolve');
  assert.deepEqual(report.weakAnchors.map((w) => [w.where, w.anchor, w.lines]),
    [['notes.md:1', 'many', 10], ['notes.md:2', 'some', 5]], 'the 10-line and 5-line anchors, worst first; not the 1-line one');
  const text = spawnSync(process.execPath, [CHECKER, '--root', root], { encoding: 'utf8' });
  assert.equal(text.status, 0);
  assert.match(text.stdout, /weak anchors \(reported, not failed\): 2 OK anchored references name an anchor on 5 or more lines of their target, 1 on 10 or more/);
  assert.match(text.stdout, /^ {2}\s*10 lines {2}#many in src\/a\.js {2}<- notes\.md:1$/m, 'the worst are listed by default');
  assert.doesNotMatch(text.stdout, /#some in/, 'a 5-line anchor is counted, and listed only under --detail');
  const quiet = spawnSync(process.execPath, [CHECKER, '--quiet', '--root', root], { encoding: 'utf8' });
  assert.match(quiet.stdout, /weak anchors \(reported, not failed\): 2 /, 'the count is printed under --quiet too');
  assert.doesNotMatch(quiet.stdout, /#many in/);
  const detail = spawnSync(process.execPath, [CHECKER, '--detail', '--root', root], { encoding: 'utf8' });
  assert.match(detail.stdout, /5 lines {2}#some in src\/a\.js {2}<- notes\.md:2/);
});
