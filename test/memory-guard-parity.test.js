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

// Synthetic indexes, each aimed at one rule, and one that is clean.
const BODIES = {
  clean: '# Memory Index\n\n- [a](a.md) hook\n',
  crlfNestedHeader: '<!-- header\r\n  compiled from <!-- gate --> blocks\r\n  tail -->\r\n# Memory Index\r\n- [a](a.md) hook\r\n',
  fencedMarkers: '# Index\n```\n--> an orphan, as an example\n<!-- a <!-- b -->\n```\n- write `<!--` and `-->` in code\n<!-- open at the end\n',
  astral: `# Index\n${'\u{1F600}'.repeat(300)}\n${'\u{1F600}'.repeat(301)}\n`,
  longProse: `# Index\n${'p'.repeat(301)}\n- ${'h'.repeat(298)}\n`,
  manyLines: Array.from({ length: 150 }, (_, i) => (i < 20 ? `- [a](a.md) hook ${i}` : `note ${i}`)).join('\n') + '\n',
};

function guardView(body) {
  const m = measure(body);
  const lines = body.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return {
    lines: m.lines,
    entries: m.entries,
    longLines: lines.filter((line) => Array.from(line.replace(/\r/g, '')).length > BUDGETS.lineChars).length,
    comments: commentDefectList(body).map((defect) => `${defect.line + 1}:${defect.kind}`),
  };
}

test('the editor lint reads every fixture exactly as the guard does', () => {
  const { fastLint } = loadLint();
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
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  // The fixtures are not degenerate: every rule fires somewhere and is quiet somewhere.
  const views = Object.values(BODIES).map(guardView);
  assert.ok(views.some((v) => v.comments.length) && views.some((v) => !v.comments.length));
  assert.ok(views.some((v) => v.longLines) && views.some((v) => !v.longLines));
  assert.ok(views.some((v) => v.lines > BUDGETS.lines) && views.some((v) => v.lines <= BUDGETS.lines));
  assert.deepEqual(guardView(BODIES.astral).longLines, 1, '300 emoji pass, 301 do not');
  assert.deepEqual(guardView(BODIES.crlfNestedHeader).comments, ['2:nested', '3:orphan']);
  assert.deepEqual(guardView(BODIES.fencedMarkers).comments, ['7:unclosed']);
});

const PYTHON = process.env.TOOLBOX_PYTHON
  || path.join(process.env.LOCALAPPDATA || '', 'DevToolbox', 'python', '.venv', 'Scripts', 'python.exe');

// recall.py needs the toolbox Python, which CI does not have. Where it is missing this says so
// on every run rather than passing in silence.
test('recall.py --lint reads every fixture exactly as the guard does', async (t) => {
  if (!fs.existsSync(PYTHON)) {
    t.skip(`DEGRADED: no toolbox Python at ${PYTHON}, so the recall.py half of the parity check did not run`);
    return;
  }
  const run = promisify(execFile);
  const results = await Promise.all(Object.entries(BODIES).map(async ([name, body]) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-parity-py-'));
    try {
      const store = path.join(home, 'memory');
      fs.mkdirSync(store);
      fs.writeFileSync(path.join(store, 'MEMORY.md'), body);
      fs.writeFileSync(path.join(store, 'a.md'), '---\nname: a\n---\nbody\n');
      const root = path.parse(home).root;
      const { stdout } = await run(PYTHON, [RECALL, '--lint'], { encoding: 'utf8', windowsHide: true, env: {
        ...process.env, HOME: home, USERPROFILE: home, HOMEDRIVE: root.replace(/[\\/]$/, ''),
        HOMEPATH: home.slice(root.length - 1), RECALL_MEMORY_DIR: store, RECALL_REEXEC: '1', PYTHONIOENCODING: 'utf-8' } });
      return { name, body, stdout };
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }));
  for (const { name, body, stdout } of results) {
    const g = guardView(body);
    const number = (re) => { const m = re.exec(stdout); return m ? Number(m[1]) : 0; };
    assert.equal(number(/^ {2}(\d+) lines, target 140/m), g.lines, `${name}: lines\n${stdout}`);
    assert.equal(number(/^ {2}(\d+) resident index entries/m), g.entries, `${name}: entries`);
    assert.equal(number(/^ {2}(\d+) index line\(s\) over 300 chars/m), g.longLines, `${name}: long lines`);
    assert.equal(number(/^ {2}! (\d+) broken HTML comment/m), g.comments.length, `${name}: comment defects\n${stdout}`);
    assert.equal(/^ {2}! \d+ line\(s\) past the 140-line target/m.test(stdout), g.lines > BUDGETS.lines, `${name}: target`);
    assert.equal(/clean:/.test(stdout), name === 'clean', `${name}: the clean verdict`);
  }
});
