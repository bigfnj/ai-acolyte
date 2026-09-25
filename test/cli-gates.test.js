'use strict';

// The --gates argv wiring, exercised through the real CLI against a throwaway home so
// nothing lands in the developer's ~/.claude. The block logic is covered in
// agent-gates.test.js; what is tested here is the part only argv can get wrong: that
// `refresh` behaves as a SessionStart hook must (quiet, non-zero-exit-free, idempotent),
// that a bad verb is rejected, and that `off` leaves a coexisting guidance block alone.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLI = path.resolve(__dirname, '..', 'bin', 'wildcard-perms');
const COMPILED = '## Standing gates (1 memories, managed)\n\n- **Test gate.** Pass: nothing.';

function runCli(home, args) {
  const root = path.parse(home).root;
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: home, encoding: 'utf8', windowsHide: true,
    env: {
      ...process.env, HOME: home, USERPROFILE: home,
      HOMEDRIVE: root.replace(/[\\/]$/, ''), HOMEPATH: home.slice(root.length - 1),
    },
  });
}

// A home with an instruction file and a pre-compiled gates file, so `--gates on` has
// something real to install without this test needing python.
function tempHome(t, { compiled = COMPILED } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-wildcarding-gates-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{}\n');
  fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), '# Mine\n');
  if (compiled !== null) {
    fs.writeFileSync(path.join(home, '.claude', 'gates.generated.md'), compiled + '\n');
  }
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

const claudeMd = (home) => fs.readFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'utf8');

test('CLI --gates on installs, and status reports it', (t) => {
  const home = tempHome(t);

  const status = runCli(home, ['--gates', 'status']);
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /OFF/);

  const on = runCli(home, ['--gates', 'on']);
  assert.equal(on.status, 0, on.stderr);
  assert.match(on.stdout, /ON/);
  assert.match(claudeMd(home), /BEGIN permission-wildcarding: memory gates/);
  assert.ok(claudeMd(home).startsWith('# Mine\n'), 'user text keeps its place');
  assert.match(runCli(home, ['--gates', 'status']).stdout, /ON/);
});

test('CLI --gates off is a byte-for-byte round trip', (t) => {
  const home = tempHome(t);
  const before = claudeMd(home);
  runCli(home, ['--gates', 'on']);
  const off = runCli(home, ['--gates', 'off']);
  assert.equal(off.status, 0, off.stderr);
  assert.equal(claudeMd(home), before);
});

// The SessionStart contract. A hook's stdout can be folded into session context, so an
// unchanged refresh has to say nothing at all, and it must never exit non-zero just
// because there was no work to do.
test('CLI --gates refresh is quiet and exit-0 when nothing changed', (t) => {
  const home = tempHome(t);
  runCli(home, ['--gates', 'on']);

  const first = runCli(home, ['--gates', 'refresh']);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout.trim(), '', 'an unchanged refresh must print nothing');
  // This home has no memory dir, which is a normal state and must not surface a Python
  // traceback: a hook that vomits a stack trace on every session start is worse than useless.
  assert.doesNotMatch(first.stderr, /Traceback|FileNotFoundError/,
    'a missing memory dir must be handled, not thrown');

  const second = runCli(home, ['--gates', 'refresh']);
  assert.equal(second.status, 0);
  assert.equal(second.stdout.trim(), '', 'still quiet on a repeat');
  assert.match(claudeMd(home), /BEGIN permission-wildcarding: memory gates/);
});

test('CLI --gates with nothing compiled refuses and says which command to run', (t) => {
  const home = tempHome(t, { compiled: null });
  const on = runCli(home, ['--gates', 'on']);
  assert.equal(on.status, 1);
  assert.match(on.stderr, /--gates-compile/);
  assert.equal(claudeMd(home), '# Mine\n', 'a refused install writes nothing');
});

test('CLI --gates rejects an unknown verb with usage', (t) => {
  const home = tempHome(t);
  const bad = runCli(home, ['--gates', 'enable']);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /usage: wildcard-perms --gates on\|off\|status\|refresh/);
  assert.equal(claudeMd(home), '# Mine\n');
});

// Both managed blocks share one file, so the CLI-level guarantee is that neither switch
// can disturb the other. This is the same property agent-gates.test.js asserts on the pure
// functions, checked here through the two real subcommands.
test('CLI --gates off leaves a coexisting guidance block byte-identical', (t) => {
  const home = tempHome(t);
  runCli(home, ['--guidance', 'on']);
  const withGuidance = claudeMd(home);
  assert.match(withGuidance, /BEGIN permission-wildcarding: shell style/);

  runCli(home, ['--gates', 'on']);
  assert.match(claudeMd(home), /BEGIN permission-wildcarding: shell style/);

  runCli(home, ['--gates', 'off']);
  assert.equal(claudeMd(home), withGuidance, 'guidance survived a gates off, unchanged');

  runCli(home, ['--gates', 'on']);
  runCli(home, ['--guidance', 'off']);
  assert.match(claudeMd(home), /BEGIN permission-wildcarding: memory gates/,
    'gates survived a guidance off');
});

// The third block that can be in this file, and the one nothing swept.
//
// An accepted derived mitigation installs its own marker-fenced block.
// `--guidance off` removed only the shell-style one; `--guidance decline <id>`
// removes a single id and only while the learner still derives it; and
// install.sh, install.ps1 and both uninstallers never touch instruction files at
// all. So an accepted block outlived the uninstall of the tool that wrote it,
// with no command anywhere that could remove it.
test('CLI --guidance off also sweeps an accepted derived block', (t) => {
  const home = tempHome(t);
  const file = path.join(home, '.claude', 'CLAUDE.md');

  // Installed through the module's own reconcile, so the markers are the real
  // ones rather than a string this test invented.
  const { reconcileDerived } = require('../src/derived-guidance');
  runCli(home, ['--guidance', 'on']);
  runCli(home, ['--gates', 'on']);
  const seeded = reconcileDerived(
    fs.readFileSync(file, 'utf8'),
    [{ id: 'batch-file-edits', title: 'Editing a gated path', body: 'One edit per file.' }],
    { accepted: ['batch-file-edits'] },
  );
  assert.equal(seeded.changed, true, 'precondition: a derived block really was installed');
  fs.writeFileSync(file, seeded.text);
  assert.match(claudeMd(home), /BEGIN permission-wildcarding: batch-file-edits \(derived\)/);

  const off = runCli(home, ['--guidance', 'off']);

  assert.equal(off.status, 0, off.stderr);
  assert.doesNotMatch(claudeMd(home), /batch-file-edits \(derived\)/,
    'an accepted derived block survived the only command that claims to turn guidance off');
  assert.doesNotMatch(claudeMd(home), /BEGIN permission-wildcarding: shell style/,
    'and the shell-style block still goes, which is what it always did');
  assert.match(off.stdout, /removed 1 derived block \(batch-file-edits\)/,
    'silently removing text from the user’s own instruction file is not acceptable '
    + 'either — say which blocks went');

  // Targeted, not a blanket wipe: the gates block has its own switch, and the
  // user's own text is not ours to touch.
  assert.match(claudeMd(home), /BEGIN permission-wildcarding: memory gates/,
    'gates have a separate switch and must survive');
  assert.match(claudeMd(home), /^# Mine$/m, 'the user’s own first line is still there');

  // MUTATION: delete the `if (cmd === 'off')` derived sweep from guidance() in
  // bin/wildcard-perms and this fails on the first assertion, with the derived
  // block still fenced in CLAUDE.md after guidance is off.

  // WHERE THE SAFETY COPY LANDS, and it has to be one place. `setDerivedGuidance`
  // writes `<name>.pre-derived` before it rewrites the user's instruction file,
  // and the two callers used to disagree about the directory: `decideDerived`
  // passes the learner's `~/.claude/wildcarding/backups`, while this verb passed
  // nothing and fell through to `~/.claude/backups`. So which verb removed the
  // block decided where the only pre-change copy of the user's CLAUDE.md went,
  // and the one `off` wrote landed where nothing looks for it.
  //
  // MUTATION: restore `backupDir = path.join(os.homedir(), '.claude', 'backups')`
  // as the default in src/derived-guidance.js. The first assertion then fails
  // with no file in the learner's directory at all.
  const learnerBackups = path.join(home, '.claude', 'wildcarding', 'backups');
  assert.ok(fs.existsSync(path.join(learnerBackups, 'CLAUDE.md.pre-derived')),
    'witness:pre-derived -- the pre-change copy is not where decideDerived puts it. '
    + `${learnerBackups} holds ${JSON.stringify(fs.existsSync(learnerBackups) ? fs.readdirSync(learnerBackups) : null)}`);
  // The control: it went to ONE place, so the old directory did not also gain a
  // copy. Without this, writing to both would satisfy the assertion above.
  const strayDir = path.join(home, '.claude', 'backups');
  const stray = fs.existsSync(strayDir) ? fs.readdirSync(strayDir) : [];
  assert.deepEqual(stray.filter((name) => name.endsWith('.pre-derived')), [],
    `witness:pre-derived -- a second copy was left in ${strayDir}: ${JSON.stringify(stray)}`);
});
