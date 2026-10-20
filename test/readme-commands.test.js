'use strict';
// vscode-extension/README.md's "Every command" section states how many commands the manifest
// registers and lists each in a table. Nothing pinned either: during the 1.9.0 integration two
// branches each added a command and each moved "35" to "36", the merge kept one of them, and the
// README said 36 then 37 while the manifest registered 37 then 38. These pin both to the manifest.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'vscode-extension', 'package.json'), 'utf8'));
const readme = fs.readFileSync(path.join(ROOT, 'vscode-extension', 'README.md'), 'utf8').replace(/\r\n/g, '\n');

const titles = manifest.contributes.commands.map((c) => c.title.replace(/^AI Acolyte: /, ''));
const norm = (s) => s.replace(/…/g, '...').replace(/\s+/g, ' ').trim();

function everyCommandSection() {
  const start = readme.indexOf('## Every command');
  assert.ok(start >= 0, 'vscode-extension/README.md has no "## Every command" section');
  const next = readme.indexOf('\n## ', start + 5);
  return readme.slice(start, next === -1 ? readme.length : next);
}

function tableRows(section) {
  return section.split('\n')
    .filter((line) => line.startsWith('|'))
    .filter((line) => !/^\|[\s:|-]+\|?$/.test(line))           // the separator row
    .map((line) => line.split('|')[1].trim())
    .filter((first) => first !== 'Command');                      // the header row
}

test('the README states the number of commands the manifest registers', () => {
  const m = /The manifest registers (\d+) commands under AI Acolyte/.exec(everyCommandSection());
  assert.ok(m, 'the "The manifest registers N commands" sentence is missing');
  assert.equal(Number(m[1]), titles.length, `the README says ${m[1]} commands; the manifest registers ${titles.length}`);
});

test('the README command table has one row per manifest command, and no others', () => {
  const rows = tableRows(everyCommandSection()).map(norm);
  // A row names a title exactly, or shortens it by dropping a trailing parenthetical
  // ("Lint memory index" for "Lint memory index (MEMORY.md bloat + broken links)"); an exact row wins,
  // so "Auto Learn - Scan now" is not also counted for "... (compatibility command)".
  const all = titles.map(norm);
  const rowFor = (t) => {
    const exact = rows.filter((r) => r === t);
    return exact.length ? exact : rows.filter((r) => t.startsWith(r + ' (') && !all.includes(r));
  };
  const unmatchedTitles = all.filter((t) => rowFor(t).length !== 1);
  const unmatchedRows = rows.filter((r) => !all.some((t) => rowFor(t).includes(r)));
  assert.deepEqual(unmatchedRows, [], `table rows naming no manifest command: ${unmatchedRows.join('; ')}`);
  assert.deepEqual(unmatchedTitles, [], `manifest commands without exactly one table row: ${unmatchedTitles.join('; ')}`);
  assert.equal(rows.length, titles.length, `the table has ${rows.length} rows; the manifest registers ${titles.length}`);
});

test('the table reader sees what it claims to (control)', () => {
  const sample = '## Every command\n\n| Command | What |\n|---|---|\n| One | a |\n| Two (long) | b |\n\n## Next\n';
  const start = sample.indexOf('## Every command');
  assert.deepEqual(tableRows(sample.slice(start, sample.indexOf('\n## ', start + 5))), ['One', 'Two (long)']);
});
