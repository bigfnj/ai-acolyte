'use strict';

// A path-rooted executable is left verbatim by the wildcarding pass, as the README
// says. Until 2026-10-13 the check only recognised a path that OPENED with `/`, `\`,
// `./`, `../`, `.\` or a drive letter followed by a separator, so `~/bin/tool x`
// became `Bash(~/bin/tool *)`, `.venv/bin/python x.py` became
// `Bash(.venv/bin/python *)` and `bin/x` became `Bash(bin/x *)`: wildcards on one
// checkout's or one home directory's binary, which are no command family, and the
// second runs any script in whatever venv the session is in. The classifier already
// draws the line where this file now does (src/auto-learn.js isPathExecutable: any
// separator, a leading drive letter, a leading `~`).
//
// Every entry here is synthetic.

const test = require('node:test');
const assert = require('node:assert/strict');

const { generalizePermission, processAllowList } = require('../src/permissions');

const PATH_ROOTED = [
  'Bash(~/bin/tool --flag)',
  'Bash(~ x)',
  'Bash(~user/bin/tool x)',
  'Bash(.venv/bin/python x.py)',
  'Bash(.venv\\Scripts\\python.exe x.py)',
  'Bash(node_modules/.bin/tsc --noEmit)',
  'Bash(bin/x --y)',
  'Bash(./x.sh)',
  'Bash(../tools/x --y)',
  'Bash(.\\build.ps1)',
  'Bash(/usr/bin/env python3 x.py)',
  'Bash(C:\\Tools\\x.exe --y)',
  'Bash(C:/Tools/x.exe --y)',
  'Bash(C:x.exe --y)',                 // drive-relative
  'Bash(\\\\server\\share\\x.exe --y)',
  'Bash(//server/share/x --y)',
  // After an env prefix or a stripped wrapper the same test applies to the command.
  'Bash(FOO=1 .venv/bin/python x.py)',
  'Bash(timeout 5 ~/bin/tool x)',
];

test('a path-rooted executable is left verbatim, in every shape', () => {
  for (const entry of PATH_ROOTED) {
    // MUTATION: restore the old opener-only check
    // (`/^(?:\.{0,2}[\\/]|[A-Za-z]:[\\/])/.test(stripped)`) in generalizeCommandArg.
    // `Bash(~/bin/tool --flag)` becomes `Bash(~/bin/tool *)` and this fails on it.
    // Confirmed 2026-10-13. Dropping only the `~` arm fails the first three rows;
    // dropping only the drive-letter arm fails `C:x.exe`.
    assert.equal(generalizePermission(entry), entry, `${entry} must stay verbatim`);
  }
});

test('controls: a bare command name still generalizes, dots and digits included', () => {
  for (const [entry, expected] of [
    ['Bash(rg foo)', 'Bash(rg *)'],
    ['Bash(. env.sh)', 'Bash(. *)'],                // the `.` runner, wildcarded like bash
    ['Bash(g++ -O2 x.cc)', 'Bash(g++ *)'],
    ['Bash(7z a x.zip)', 'Bash(7z *)'],
    ['Bash(python3.11 x.py)', 'Bash(python3.11 *)'],
    ['Bash(git status)', 'Bash(git status *)'],
    // A separator in an ARGUMENT is not a path executable.
    ['Bash(rg foo src/x.js)', 'Bash(rg *)'],
    ['Bash(cat ~/notes.md)', 'Bash(cat *)'],
    ['PowerShell(Get-ChildItem C:\\x)', 'PowerShell(Get-ChildItem *)'],
  ]) assert.equal(generalizePermission(entry), expected, entry);
});

test('quoted executables are unchanged, and existing path wildcards are preserved', () => {
  assert.equal(generalizePermission('Bash("/opt/My Tool/tool" --version)'), 'Bash("/opt/My Tool/tool" --version)');
  assert.equal(generalizePermission("Bash('~/x y/tool' z)"), "Bash('~/x y/tool' z)");
  // A wildcard a user already holds is never re-generalized, so nothing on a list is
  // narrowed or removed by this change.
  const held = ['Bash(.venv/bin/python *)', 'Bash(~/bin/tool *)', 'Bash(./scripts/check.sh *)'];
  assert.deepEqual(processAllowList(held), held);
  const once = processAllowList([...held, ...PATH_ROOTED, 'Bash(rg foo)']);
  assert.deepEqual(processAllowList(once), once, 'fixed point');
});
