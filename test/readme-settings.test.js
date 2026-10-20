'use strict';
// vscode-extension/README.md states how many settings the manifest declares, twice, and lists
// every one in its "Every setting" table with the default the manifest declares. Nothing pinned
// any of it: in 1.9.0 the Auto Learn paragraph said "all 19 settings" while the table above
// "All 20 keys" listed 20 and the manifest declared 20 (audit of 1.9.0, 2026-10-20). These pin
// the counts, the table's rows, its defaults, its "Machine-scoped" notes and the defaults the
// Auto Learn paragraph spells out, to vscode-extension/package.json. Modelled on
// test/readme-commands.test.js, which does the same for the command table.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PREFIX = 'permissionWildcarding.';
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'vscode-extension', 'package.json'), 'utf8'));
const readme = fs.readFileSync(path.join(ROOT, 'vscode-extension', 'README.md'), 'utf8').replace(/\r\n/g, '\n');

// contributes.configuration may be one object or an array of them; both are read.
function manifestSettings() {
  const configuration = manifest.contributes.configuration;
  const sections = Array.isArray(configuration) ? configuration : [configuration];
  const settings = new Map();
  for (const section of sections) {
    for (const [key, schema] of Object.entries(section.properties || {})) {
      assert.ok(key.startsWith(PREFIX), `manifest setting ${key} is outside ${PREFIX}*`);
      settings.set(key.slice(PREFIX.length), schema);
    }
  }
  return settings;
}
const settings = manifestSettings();

function everySettingSection(text = readme) {
  const start = text.indexOf('## Every setting');
  assert.ok(start >= 0, 'vscode-extension/README.md has no "## Every setting" section');
  const next = text.indexOf('\n## ', start + 5);
  return text.slice(start, next === -1 ? text.length : next);
}

// One { key, defaultCell, meaning } per body row of the section's table.
function tableRows(section) {
  return section.split('\n')
    .filter((line) => line.startsWith('|'))
    .filter((line) => !/^\|[\s:|-]+\|?$/.test(line))
    .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()))
    .filter((cells) => cells[0] !== 'Setting')
    .map(([key, defaultCell, meaning]) => ({ key: key.replace(/^`|`$/g, ''), defaultCell, meaning }));
}

test('the manifest declares settings for this test to compare against (precondition)', () => {
  assert.ok(settings.size >= 10, `read ${settings.size} settings from the manifest`);
});

test('every "all N settings" or "All N keys" count in the README is the manifest\'s', () => {
  const counts = [...readme.matchAll(/\ball (\d+) (?:settings|keys)\b/gi)].map((m) => ({ said: Number(m[1]), text: m[0] }));
  // WITNESS: the two sentences that disagreed in 1.9.0, so a rewording that drops one shows here.
  assert.ok(counts.length >= 2, `found ${counts.length} total-count sentences; expected the Auto Learn one and the "Every setting" one`);
  const wrong = counts.filter((c) => c.said !== settings.size).map((c) => c.text);
  assert.deepEqual(wrong, [], `the manifest declares ${settings.size} settings`);
});

test('the "Every setting" table has one row per manifest setting, and no others', () => {
  const rows = tableRows(everySettingSection());
  const keys = rows.map((r) => r.key);
  const duplicates = keys.filter((k, i) => keys.indexOf(k) !== i);
  assert.deepEqual(duplicates, [], 'a setting has two rows');
  assert.deepEqual(keys.filter((k) => !settings.has(k)), [], 'table rows naming no manifest setting');
  assert.deepEqual([...settings.keys()].filter((k) => !keys.includes(k)), [], 'manifest settings with no table row');
  assert.equal(rows.length, settings.size);
});

test('each row\'s default is the one the manifest declares', () => {
  const wrong = tableRows(everySettingSection())
    .filter((r) => settings.has(r.key) && r.defaultCell !== `\`${JSON.stringify(settings.get(r.key).default)}\``)
    .map((r) => `${r.key}: README ${r.defaultCell}, manifest \`${JSON.stringify(settings.get(r.key).default)}\``);
  assert.deepEqual(wrong, []);
});

test('a row says "Machine-scoped" exactly when the manifest scopes the setting to the machine', () => {
  const wrong = tableRows(everySettingSection())
    .filter((r) => settings.has(r.key) && /machine-scoped/i.test(r.meaning) !== (settings.get(r.key).scope === 'machine'))
    .map((r) => `${r.key}: README ${/machine-scoped/i.test(r.meaning) ? 'says' : 'does not say'} Machine-scoped, manifest scope ${settings.get(r.key).scope || '(none)'}`);
  assert.deepEqual(wrong, []);
});

test('the defaults the Auto Learn paragraph spells out are the manifest\'s', () => {
  // "`permissionWildcarding.autoLearn.intervalMinutes` (default **5**" and "(default `codex`)".
  // A sentence may wrap anywhere, so the spaces match any whitespace.
  const stated = [...readme.matchAll(/`permissionWildcarding\.([\w.]+)`\s+\(default\s+(?:\*\*([^*]+)\*\*|`([^`]+)`)/g)]
    .map((m) => ({ key: m[1], said: m[2] ?? m[3] }));
  assert.ok(stated.length >= 5, `found ${stated.length} spelled-out defaults; the Auto Learn paragraph has five`);
  const wrong = stated.filter((s) => !settings.has(s.key) || String(settings.get(s.key).default) !== s.said)
    .map((s) => `${s.key}: README ${s.said}, manifest ${settings.has(s.key) ? String(settings.get(s.key).default) : '(no such setting)'}`);
  assert.deepEqual(wrong, []);
});

test('the table reader sees what it claims to (control)', () => {
  const sample = '## Every setting\n\n| Setting | Default | Meaning |\n| --- | --- | --- |\n'
    + '| `a.b` | `""` | One. Machine-scoped: x |\n| `c` | `3` | Two |\n\n## Next\n';
  assert.deepEqual(tableRows(everySettingSection(sample)), [
    { key: 'a.b', defaultCell: '`""`', meaning: 'One. Machine-scoped: x' },
    { key: 'c', defaultCell: '`3`', meaning: 'Two' },
  ]);
});
