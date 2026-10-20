'use strict';

// One rule for MEMORY.md, in three places: the guard hook (src/memory-index-guard.js), the
// editor lint (vscode-extension/memoryLint.js) and `recall.py --lint`. The budgets are pinned
// together here, and the same synthetic indexes are measured by all three, so a change to one
// that the others do not follow fails here rather than as a gauge that disagrees with the hook.
//
// The extension's memory.* settings are window-scoped and tune the editor gauge only. The hook
// always runs on BUDGETS, which is why only the DEFAULTS are pinned to it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const ROOT = path.resolve(__dirname, '..');
const RECALL = path.join(ROOT, 'memory', 'recall.py');
const { BUDGETS, measure, commentDefectList } = require('../src/memory-index-guard');

function loadLint() {
  const modulePath = require.resolve('../vscode-extension/memoryLint');
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === 'vscode') return { workspace: { getConfiguration: () => ({ get: () => undefined }) } };
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[modulePath];
  try { return require(modulePath); }
  finally { Module._load = originalLoad; delete require.cache[modulePath]; }
}

// MUTATION: change LINT_LINES_WARN to 150 in recall.py (or any of the four), or a default in
// package.json, or a BUDGETS value: this fails naming the pair that moved apart.
test('the guard budgets, recall.py\'s lint constants and the extension defaults are the same numbers', () => {
  const source = fs.readFileSync(RECALL, 'utf8');
  const constant = (name) => {
    const found = new RegExp(`^${name} = (\\d+)\\b`, 'm').exec(source);
    assert.ok(found, `recall.py no longer defines ${name} at the start of a line`);
    return Number(found[1]);
  };
  assert.equal(constant('LINT_LINES_WARN'), BUDGETS.lines);
  assert.equal(constant('LINT_TOTAL_WARN'), BUDGETS.bytes);
  assert.equal(constant('LINT_LINE_WARN'), BUDGETS.lineChars);
  assert.equal(constant('LINT_ENTRY_WARN'), BUDGETS.entries);
  const properties = require('../vscode-extension/package.json').contributes.configuration.properties;
  assert.equal(properties['permissionWildcarding.memory.totalBudget'].default, BUDGETS.bytes);
  assert.equal(properties['permissionWildcarding.memory.lineBudget'].default, BUDGETS.lineChars);
  // memoryLint's fallbacks when the setting reads as nothing, beside the manifest defaults.
  const lintSource = fs.readFileSync(path.join(ROOT, 'vscode-extension', 'memoryLint.js'), 'utf8');
  assert.match(lintSource, new RegExp(`Number\\(c\\.get\\('memory\\.lineBudget'\\)\\) \\|\\| ${BUDGETS.lineChars}\\b`));
  assert.match(lintSource, new RegExp(`Number\\(c\\.get\\('memory\\.totalBudget'\\)\\) \\|\\| ${BUDGETS.bytes}\\b`));
  // And the descriptions say what those settings do not reach.
  for (const key of ['totalBudget', 'lineBudget']) {
    assert.match(properties[`permissionWildcarding.memory.${key}`].markdownDescription, /not the MEMORY\.md guard/,
      `memory.${key} has to say it tunes the gauge and not the hook`);
  }
});

// memoryLint.js's indexHealth budgets are the guard's BUDGETS, not a second copy of the numbers
// (2026-10-20): loaded against a guard whose budgets moved, the INDEX phrases move with them.
// MUTATION: write `lines: 140` back into INDEX_BUDGETS and the moved line budget is not followed.
test('the editor lint\'s INDEX budgets follow the guard\'s BUDGETS', () => {
  const realGuard = require('../src/memory-index-guard');
  const moved = Object.freeze({ ...realGuard.BUDGETS, lines: 5, bytes: 50, lineChars: 7, entries: 2 });
  const modulePath = require.resolve('../vscode-extension/memoryLint');
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === 'vscode') return { workspace: { getConfiguration: () => ({ get: () => undefined }) } };
    if (parent?.filename === modulePath && /memory-index-guard\.js$/.test(request)) return { ...realGuard, BUDGETS: moved };
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[modulePath];
  let lint;
  try { lint = require(modulePath); } finally { Module._load = originalLoad; delete require.cache[modulePath]; }
  const over = { lineCount: 6, bytes: 51, longestLine: 8 };
  assert.deepEqual(lint.indexHealth(over), ['6 lines (budget 5)', '51 bytes (budget 50)',
    '8 characters on its longest line (budget 7)']);
  assert.deepEqual(lint.indexHealth({ lineCount: 5, bytes: 50, longestLine: 7 }), [], 'at each budget is within it');
  assert.deepEqual(loadLint().indexHealth(over), [], 'precondition: the real budgets do not flag the same figures');
});

// Synthetic indexes, each aimed at one rule, and one that is clean.
const BODIES = {
  clean: '# Memory Index\n\n- [a](a.md) hook\n',
  crlfNestedHeader: '<!-- header\r\n  compiled from <!-- gate --> blocks\r\n  tail -->\r\n# Memory Index\r\n- [a](a.md) hook\r\n',
  fencedMarkers: '# Index\n```\n--> an orphan, as an example\n<!-- a <!-- b -->\n```\n- write `<!--` and `-->` in code\n<!-- open at the end\n',
  astral: `# Index\n${'\u{1F600}'.repeat(300)}\n${'\u{1F600}'.repeat(301)}\n`,
  longProse: `# Index\n${'p'.repeat(301)}\n- ${'h'.repeat(298)}\n`,
  manyLines: Array.from({ length: 150 }, (_, i) => (i < 20 ? `- [a](a.md) hook ${i}` : `note ${i}`)).join('\n') + '\n',
  // Characters a universal-newline read or str.splitlines() ends a line at and the guard does not
  // (2026-10-20). The guard counts 2 entries here; recall.py's `mem.splitlines()` counted 4.
  lineSeparators: `# x\n- a${String.fromCharCode(0x2028)}- b\n- c${String.fromCharCode(0x0c)}- d\n`,
  // 300 characters a reader sees and one interior CR: within the width budget to the guard, so no
  // INDEX line. fastLint's longestLine and recall.py's _index_health both read it as 301.
  interiorCr: `# Index\n- ${'a'.repeat(150)}\r${'b'.repeat(148)}\n`,
};

// Bodies whose recall.py --lint ends `clean:`. The two above are in it on purpose: a lint that
// counted the CR as a character would report the 300-character line and lose the verdict.
const CLEAN = new Set(['clean', 'lineSeparators', 'interiorCr']);

// The phrases of an INDEX line ("141 lines (budget 140)", ...), keyed by the budget each names.
function indexVerdicts(phrases) {
  return {
    lines: phrases.some((p) => /^\d+ lines \(budget \d+\)$/.test(p)),
    bytes: phrases.some((p) => /^\d+ bytes \(budget \d+\)$/.test(p)),
    lineChars: phrases.some((p) => /^\d+ characters on its longest line \(budget \d+\)$/.test(p)),
  };
}

function guardView(body) {
  const m = measure(body);
  const lines = body.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return {
    lines: m.lines,
    entries: m.entries,
    longLines: lines.filter((line) => Array.from(line.replace(/\r/g, '')).length > BUDGETS.lineChars).length,
    comments: commentDefectList(body).map((defect) => `${defect.line + 1}:${defect.kind}`),
    // What the guard would hold the INDEX line to: past a budget, judged by its own measure.
    index: { lines: m.lines > BUDGETS.lines, bytes: m.bytes > BUDGETS.bytes, lineChars: m.lineChars > BUDGETS.lineChars },
  };
}

// MUTATION: count `Array.from(ln)` again in fastLint's longestLine (CRs kept) and interiorCr's
// INDEX verdict fails here; `ln.length` instead of code points and astral's does.
test('the editor lint reads every fixture exactly as the guard does', () => {
  const { fastLint, indexHealth } = loadLint();
  const conf = { enabled: true, dir: '', lineBudget: 300, totalBudget: 12000, maxLines: 200 };
  for (const [name, body] of Object.entries(BODIES)) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-parity-'));
    try {
      fs.writeFileSync(path.join(dir, 'MEMORY.md'), body);
      fs.writeFileSync(path.join(dir, 'a.md'), 'body\n');
      const r = fastLint(dir, conf);
      const g = guardView(body);
      assert.equal(r.lineCount, g.lines, `${name}: lines`);
      assert.equal(r.over.length, g.longLines, `${name}: lines past ${BUDGETS.lineChars} characters`);
      assert.deepEqual(r.comments.map((defect) => `${defect.line + 1}:${defect.kind}`), g.comments, `${name}: comment defects`);
      assert.equal(r.linesTarget, BUDGETS.lines);
      assert.equal(r.linesOverTarget, g.lines > BUDGETS.lines, `${name}: the 140-line target`);
      assert.equal(r.entries, g.entries, `${name}: resident entries`);
      assert.equal(r.entriesOver, g.entries > BUDGETS.entries, `${name}: the entry ceiling`);
      // The open threads' INDEX line, from fastLint, against the guard's own verdicts.
      assert.deepEqual(indexVerdicts(indexHealth(r)), g.index, `${name}: the INDEX line\n${indexHealth(r).join('; ')}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  // The fixtures are not degenerate: every rule fires somewhere and is quiet somewhere.
  const views = Object.values(BODIES).map(guardView);
  assert.ok(views.some((v) => v.comments.length) && views.some((v) => !v.comments.length));
  assert.ok(views.some((v) => v.longLines) && views.some((v) => !v.longLines));
  assert.ok(views.some((v) => v.lines > BUDGETS.lines) && views.some((v) => v.lines <= BUDGETS.lines));
  assert.ok(views.some((v) => v.index.lineChars) && views.some((v) => !v.index.lineChars));
  assert.ok(views.some((v) => v.entries > BUDGETS.entries) && views.some((v) => v.entries <= BUDGETS.entries));
  assert.deepEqual(guardView(BODIES.astral).longLines, 1, '300 emoji pass, 301 do not');
  assert.deepEqual(guardView(BODIES.crlfNestedHeader).comments, ['2:nested', '3:orphan']);
  assert.deepEqual(guardView(BODIES.fencedMarkers).comments, ['7:unclosed']);
  // The two separator bodies hold what they are for: 2 entries to the guard where splitlines()
  // sees 4, and a 300-character line that is 301 with its CR counted.
  assert.equal(guardView(BODIES.lineSeparators).entries, 2);
  const crLine = BODIES.interiorCr.split('\n')[1];
  assert.equal(Array.from(crLine).length, BUDGETS.lineChars + 1, 'precondition: the CR is in the line');
  assert.equal(measure(BODIES.interiorCr).lineChars, BUDGETS.lineChars);
});

const PYTHON = process.env.TOOLBOX_PYTHON
  || path.join(process.env.LOCALAPPDATA || '', 'DevToolbox', 'python', '.venv', 'Scripts', 'python.exe');

// recall.py needs a Python with numpy and onnxruntime, which the node matrix in CI does not have.
// Where it is missing this says so on every run rather than passing in silence, and where the run
// says one IS there (ACOLYTE_REQUIRE_PYTHON, set by the gates-manage job in .github/workflows/
// test.yml, which installs both) a missing one is a failure, so that step cannot pass having run
// nothing.
test('recall.py --lint and --threads-compile read every fixture exactly as the guard does', async (t) => {
  if (!fs.existsSync(PYTHON)) {
    assert.ok(!process.env.ACOLYTE_REQUIRE_PYTHON,
      `ACOLYTE_REQUIRE_PYTHON is set but there is no Python at ${PYTHON}, so the recall.py half did not run`);
    t.skip(`DEGRADED: no toolbox Python at ${PYTHON}, so the recall.py half of the parity check did not run`);
    return;
  }
  const { fastLint, indexHealth } = loadLint();
  const conf = { enabled: true, dir: '', lineBudget: 300, totalBudget: 12000, maxLines: 200 };
  const run = promisify(execFile);
  const results = await Promise.all(Object.entries(BODIES).map(async ([name, body]) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-parity-py-'));
    try {
      const store = path.join(home, 'memory');
      fs.mkdirSync(store);
      fs.mkdirSync(path.join(home, '.claude'));
      fs.writeFileSync(path.join(store, 'MEMORY.md'), body);
      fs.writeFileSync(path.join(store, 'a.md'), '---\nname: a\n---\nbody\n');
      const root = path.parse(home).root;
      const options = { encoding: 'utf8', windowsHide: true, env: {
        ...process.env, HOME: home, USERPROFILE: home, HOMEDRIVE: root.replace(/[\\/]$/, ''),
        HOMEPATH: home.slice(root.length - 1), RECALL_MEMORY_DIR: store, RECALL_REEXEC: '1', PYTHONIOENCODING: 'utf-8' } };
      const { stdout } = await run(PYTHON, [RECALL, '--lint'], options);
      await run(PYTHON, [RECALL, '--threads-compile'], options);
      const threads = fs.readFileSync(path.join(home, '.claude', 'open-threads.generated.md'), 'utf8');
      return { name, body, stdout, threads, js: indexHealth(fastLint(store, conf)) };
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }));
  for (const { name, body, stdout, threads, js } of results) {
    const g = guardView(body);
    const number = (re) => { const m = re.exec(stdout); return m ? Number(m[1]) : 0; };
    assert.equal(number(/^ {2}(\d+) lines, target 140/m), g.lines, `${name}: lines\n${stdout}`);
    assert.equal(number(/^ {2}(\d+) resident index entries/m), g.entries, `${name}: entries`);
    assert.equal(number(/^ {2}(\d+) index line\(s\) over 300 chars/m), g.longLines, `${name}: long lines`);
    assert.equal(number(/^ {2}! (\d+) broken HTML comment/m), g.comments.length, `${name}: comment defects\n${stdout}`);
    assert.equal(/^ {2}! \d+ line\(s\) past the 140-line target/m.test(stdout), g.lines > BUDGETS.lines, `${name}: target`);
    assert.equal(/clean:/.test(stdout), CLEAN.has(name), `${name}: the clean verdict\n${stdout}`);
    // The INDEX line _index_health writes: its phrases are memoryLint.js indexHealth's, word for
    // word, and say what the guard's own measure says about each budget.
    // MUTATION: put back `line[:-1] if line.endswith("\r") else line` in _index_health and
    // interiorCr gains a 301-character phrase here.
    // Since 1.9.1 the line names the index it measured (home-relative here: the fixture's store is
    // <home>/memory), so an agent in another project is not told to compact its own index.
    const found = /^- \*\*INDEX\*\* (\S*)MEMORY\.md is (.*): compact it before adding anything/m.exec(threads);
    if (found) assert.equal(found[1], '~/memory/', `${name}: the INDEX line names the measured index\n${threads}`);
    const phrases = found ? found[2].split('; ') : [];
    assert.deepEqual(phrases, js, `${name}: the INDEX line, Python against JavaScript\n${threads}`);
    assert.deepEqual(indexVerdicts(phrases), g.index, `${name}: the INDEX line against the guard\n${threads}`);
  }
  assert.ok(results.some((r) => r.js.length) && results.some((r) => !r.js.length),
    'precondition: some fixture writes an INDEX line and some does not');
});
