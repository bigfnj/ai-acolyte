'use strict';

// A script nobody can find the usage of is a script nobody runs correctly.
//
// The v1.6.2 audit found scripts/check-codex-recall-runtime.js and
// scripts/drive-codex-background.js with no usage line anywhere (the second launches a
// separate VS Code, which is worth knowing before running it), and
// scripts/mask-sqlite.js documented only in its own header, so the masked suite run that
// catches Node-20-only failures was in no checklist. Fixed 2026-10-14: both have a usage
// header, and README.md's "Build, test, release" lists the masked run. This holds every
// runtime harness and driver to naming its own invocation, so the next one cannot ship
// without.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SCRIPTS = path.join(ROOT, 'scripts');

test('every runtime harness and driver names its own invocation', () => {
  const subjects = fs.readdirSync(SCRIPTS)
    .filter((name) => /^check-codex-.*-runtime\.js$|^drive-.*\.js$/.test(name)).sort();
  // WITNESS: the two the audit found without one.
  for (const name of ['check-codex-recall-runtime.js', 'drive-codex-background.js']) {
    assert.ok(subjects.includes(name), `${name} is not among the subjects`);
  }
  const missing = subjects.filter((name) => {
    const text = fs.readFileSync(path.join(SCRIPTS, name), 'utf8');
    const header = text.split(/\r?\n/).slice(0, 40).join('\n');
    // Either the header shows `node scripts/<name>`, or the script prints a usage line.
    return !header.includes(`node scripts/${name}`) && !/['"`]usage: /.test(text);
  });
  assert.deepEqual(missing, [], `no usage line in: ${missing.join(', ')}`);
});

test("the README's release checklist runs the suite with node:sqlite masked", () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const section = readme.slice(readme.indexOf('### Build, test, release'));
  const block = /```bash\r?\n([\s\S]*?)```/.exec(section);
  assert.ok(block, 'the checklist block moved');
  // The `./` matters: --require resolves like require(), so a bare path is a package name.
  assert.match(block[1], /^node --require \.\/scripts\/mask-sqlite\.js --test\b/m);
});
