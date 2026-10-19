'use strict';

// The Claude memory card's Search and Inspect (vscode-extension/claudeMemoryUi.js), and the Codex
// card's new figures, added 2026-10-19 so the two memory cards have the same features. The UI is
// driven with fakes: the search runner and the sources report are injected, so no Python runs.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createClaudeMemoryUi } = require('../vscode-extension/claudeMemoryUi');
const { codexFeatureStatus } = require('../vscode-extension/codexFeaturesUi');
const { codexRecallIndexCount } = require('../src/codex-recall');

function fakeVscode(seen, { query = 'kettle', pick = (items) => items[0] } = {}) {
  return {
    Uri: { file: (file) => ({ fsPath: file }) },
    ProgressLocation: { Notification: 15 },
    workspace: { async openTextDocument(value) {
      seen.opened.push(value);
      const text = value.content ?? fs.readFileSync(value.fsPath, 'utf8');
      const lines = text.split('\n');
      return { getText: () => text, lineCount: lines.length, lineAt: (line) => ({ range: { line } }) };
    } },
    window: {
      async showInputBox() { return query; },
      async showQuickPick(items, options) { seen.items = items; seen.pickOptions = options; return pick(items); },
      async withProgress(options, task) { seen.progress.push(options.title); return task(); },
      showWarningMessage(message) { seen.warnings.push(message); },
      async showTextDocument(document, options) { seen.shown.push({ document, options }); },
    },
  };
}

function temp(t, label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `acolyte-claude-memory-${label}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('Search opens the picked memory at the line of its best match', async (t) => {
  const dir = temp(t, 'search');
  const file = path.join(dir, 'kettle.md');
  fs.writeFileSync(file, '---\nname: kettle\n---\n\nFill it with vinegar.\nThe descaling cycle runs twelve minutes.\n');
  const seen = { opened: [], shown: [], warnings: [], progress: [], queries: [] };
  const ui = createClaudeMemoryUi(fakeVscode(seen), {
    search: async (query) => { seen.queries.push(query); return { mode: 'hybrid', results: [
      { name: 'kettle.md', path: file, description: 'how the kettle descales', line: 6, excerpt: 'The descaling cycle runs twelve minutes.' }] }; },
    sources: async () => ({}),
  });
  await ui.searchMemory();
  assert.deepEqual(seen.queries, ['kettle']);
  assert.match(seen.progress[0], /searching Claude memory on CPU/);
  assert.equal(seen.items[0].label, 'kettle');
  assert.equal(seen.items[0].description, 'line 6');
  assert.match(seen.items[0].detail, /how the kettle descales · The descaling cycle/);
  assert.match(seen.pickOptions.title, /by meaning and keywords/);
  assert.equal(seen.opened[0].fsPath, file);
  assert.deepEqual(seen.shown[0].options.selection, { line: 5 },
    'witness:claude-search-line -- the memory did not open at its matching line');
  assert.deepEqual(seen.warnings, []);
});

test('Search says why when it cannot search, falls back to keywords aloud, and reports no match', async (t) => {
  const seen = { opened: [], shown: [], warnings: [], progress: [] };
  let answer = { unavailable: 'the DevToolbox Python was not found at X.' };
  const ui = createClaudeMemoryUi(fakeVscode(seen), { search: async () => answer, sources: async () => ({}) });
  await ui.searchMemory();
  assert.match(seen.warnings.at(-1), /Claude memory search is unavailable: the DevToolbox Python was not found/);
  answer = { mode: 'lexical', reason: 'The CPU model is not installed.', results: [] };
  await ui.searchMemory();
  assert.ok(seen.warnings.some((w) => /using keyword matches\. The CPU model is not installed\./.test(w)),
    'the keyword fallback is said, as the Codex search says it');
  assert.match(seen.warnings.at(-1), /No matching Claude memories/);
  assert.equal(seen.shown.length, 0);
});

test('Inspect reports every store, marks the one the card shows, and lists its issues and gates', async (t) => {
  const seen = { opened: [], shown: [], warnings: [], progress: [] };
  const ui = createClaudeMemoryUi(fakeVscode(seen), { search: async () => ({}), sources: async () => ({
    primary: '~/.claude/projects/a/memory',
    stores: [
      { dir: '~/.claude/projects/a/memory', files: 59, lines: 61, tokens: 2600, primary: true },
      { dir: '~/.claude/projects/b/memory', files: 1, lines: 3, tokens: 40, primary: false },
    ],
    issues: ['MEMORY.md line 4 links to gone.md, which does not exist'],
    gates: '13 compiled, installed and current',
  }) });
  await ui.inspectMemory();
  const text = seen.opened[0].content;
  assert.match(text, /^Claude Code memory\n~\/\.claude\/projects\/a\/memory\n/);
  assert.match(text, /Stores found: 2\n\* ~\/\.claude\/projects\/a\/memory: 59 files, MEMORY\.md 61 lines, about 2600 tokens per session {3}\(shown on the card\)\n {2}~\/\.claude\/projects\/b\/memory: 1 file, MEMORY\.md 3 lines, about 40 tokens per session\n/,
    'witness:claude-inspect-stores -- the report did not list every store and mark the one shown');
  assert.match(text, /Issues in the store shown: \n {2}MEMORY\.md line 4 links to gone\.md/);
  assert.match(text, /Memory gates: 13 compiled, installed and current$/);
  assert.match(text, /This report changes nothing/);
});

test('the Codex card is told the size and lines of the summary a session loads', (t) => {
  const home = temp(t, 'codex-summary');
  const codexHome = path.join(home, '.codex');
  fs.mkdirSync(path.join(codexHome, 'memories'), { recursive: true });
  const summary = `v1\n${'y'.repeat(800)}\nlast line\n`;
  fs.writeFileSync(path.join(codexHome, 'memories', 'memory_summary.md'), summary);
  const status = codexFeatureStatus({ home, codexHome });
  assert.equal(status.summaryTokens, Math.round(Buffer.byteLength(summary) / 4));
  assert.equal(status.summaryLines, 3, 'a trailing newline is not a line');
  fs.rmSync(path.join(codexHome, 'memories', 'memory_summary.md'));
  fs.writeFileSync(path.join(codexHome, 'memories', 'MEMORY.md'), '# Registry\n');
  const without = codexFeatureStatus({ home, codexHome });
  assert.deepEqual([without.summaryTokens, without.summaryLines], [null, null], 'no summary is unknown, not zero');
});

test('the Codex index count is its passage windows, null before one is built, and follows a rebuild', (t) => {
  const home = temp(t, 'codex-index');
  const codexHome = path.join(home, '.codex');
  assert.equal(codexRecallIndexCount({ home, codexHome }), null, 'nothing built yet');
  // The cache path codex-recall.js uses: a hash of the canonical Codex home.
  const canonical = process.platform === 'win32' ? path.resolve(codexHome).toLowerCase() : path.resolve(codexHome);
  const profileId = crypto.createHash('sha256').update(canonical).digest('hex');
  const file = path.join(home, '.ai-acolyte', 'codex', profileId, 'recall', 'index.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ identity: 'x', windows: [{}, {}, {}] }));
  assert.equal(codexRecallIndexCount({ home, codexHome }), 3);
  // A rebuild rewrites the file; the memo is keyed on its size and mtime, so the new count shows.
  fs.writeFileSync(file, JSON.stringify({ identity: 'y', windows: [{}, {}, {}, {}, {}] }));
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(file, later, later);
  assert.equal(codexRecallIndexCount({ home, codexHome }), 5, 'witness:codex-index-memo -- a rebuilt index kept its old count');
  fs.writeFileSync(file, '{ not json');
  fs.utimesSync(file, new Date(Date.now() + 9000), new Date(Date.now() + 9000));
  assert.equal(codexRecallIndexCount({ home, codexHome }), null, 'an unreadable index is "not built", never an error');
});
