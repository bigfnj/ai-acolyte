'use strict';

// The release path had a hole that no test could reach.
//
// .github/workflows/release.yml runs `npm test`, then `node scripts/package.mjs "<tag>"`.
// That override used to write the tag into vscode-extension/package.json and nothing
// else, leaving the root manifest behind. The root manifest is what
// `bin/wildcard-perms --version` prints and the extension manifest is what the sidebar
// badge shows, so one build reported two different versions. installers.test.js:455
// already asserts the two agree, and was structurally blind to this: it ran before the
// step that broke them.
//
// So this file covers both halves. syncVersion is driven directly, against throwaway
// manifests, and check-version-sync.mjs is run as CI runs it, as a process whose exit
// code is the result.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const checker = path.join(repoRoot, 'scripts', 'check-version-sync.mjs');

// Spelled out rather than imported from scripts/build-stamp.mjs: this file is CommonJS, and
// a rename of the receipt has to break a test rather than quietly stop proving anything.
const BUILD_STAMP = '.vsix-build.json';

// Fixed instants. The freshness half of the check is about ORDER IN TIME, and a fixture that
// leaned on how fast this machine writes two files would prove whatever the machine felt like
// that morning. BUILT_AT is when package.mjs stamped; PACKAGED is when vsce finished, a few
// seconds later as it really is; STALE is the same-version artefact of yesterday's build.
const BUILT_AT = new Date('2026-09-14T12:00:00.000Z');
const PACKAGED = new Date(BUILT_AT.getTime() + 4000);
const STALE = new Date(BUILT_AT.getTime() - 24 * 60 * 60 * 1000);

// A minimal tree with the two manifests the release path cares about. Real ones carry
// far more, which is the point of writing the whole object back out: a version bump
// must not be the only key that survives.
//
// `stamp` defaults to whatever VSIX was written, which is the shape of a healthy build;
// null leaves the tree with no evidence that packaging ever ran.
function fixture({
  root = '1.0.0', ext = '1.0.0', vsix = null,
  vsixAt = PACKAGED, stamp = vsix, stampAt = BUILT_AT,
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-release-'));
  fs.mkdirSync(path.join(dir, 'vscode-extension'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'permission-wildcarding', version: root, license: 'MIT',
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'vscode-extension', 'package.json'), JSON.stringify({
    name: 'permission-wildcarding', version: ext, publisher: 'local',
  }, null, 2) + '\n');
  if (vsix) {
    const built = path.join(dir, `permission-wildcarding-${vsix}.vsix`);
    fs.writeFileSync(built, 'x');
    fs.utimesSync(built, vsixAt, vsixAt);
  }
  if (stamp) {
    const receipt = path.join(dir, BUILD_STAMP);
    fs.writeFileSync(receipt, JSON.stringify({
      artefact: `permission-wildcarding-${stamp}.vsix`,
      version: stamp,
      startedAt: stampAt.toISOString(),
    }, null, 2) + '\n');
    fs.utimesSync(receipt, stampAt, stampAt);
  }
  return dir;
}

const versionIn = (dir, ...parts) =>
  JSON.parse(fs.readFileSync(path.join(dir, ...parts), 'utf8')).version;

function runChecker(dir) {
  try {
    return { code: 0, out: execFileSync(process.execPath, [checker, dir], { encoding: 'utf8' }) };
  } catch (err) {
    return { code: err.status, out: `${err.stdout || ''}${err.stderr || ''}` };
  }
}

function withFixture(options, body) {
  const dir = fixture(options);
  try {
    body(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('a version override reaches BOTH manifests, not only the extension one', async () => {
  const { syncVersion } = await import('../scripts/sync-version.mjs');
  withFixture({}, (dir) => {
    const applied = syncVersion(dir, '9.9.9');

    assert.equal(versionIn(dir, 'vscode-extension', 'package.json'), '9.9.9');
    assert.equal(versionIn(dir, 'package.json'), '9.9.9',
      'the root manifest kept its old version, so `wildcard-perms --version` would '
      + 'disagree with the sidebar badge for the same build');
    assert.deepEqual(applied.changed, ['vscode-extension/package.json', 'package.json']);
    assert.equal(applied.version, '9.9.9');
  });
});

test('a release tag keeps its leading v out of the manifests', async () => {
  const { syncVersion } = await import('../scripts/sync-version.mjs');
  withFixture({}, (dir) => {
    // release.yml passes github.event.release.tag_name straight through, and the tags
    // on this repo are v1.4.1, v1.4.0, v1.3.0 ...
    assert.equal(syncVersion(dir, 'v2.0.0').version, '2.0.0');
    assert.equal(versionIn(dir, 'package.json'), '2.0.0');
    assert.equal(versionIn(dir, 'vscode-extension', 'package.json'), '2.0.0');
  });
});

test('no override leaves both manifests untouched', async () => {
  const { syncVersion } = await import('../scripts/sync-version.mjs');
  withFixture({ root: '1.2.3', ext: '1.2.3' }, (dir) => {
    // workflow_dispatch's version input is optional, so this is the normal local build.
    for (const absent of [undefined, '', '  ']) {
      assert.equal(syncVersion(dir, absent), null);
      assert.equal(versionIn(dir, 'package.json'), '1.2.3');
      assert.equal(versionIn(dir, 'vscode-extension', 'package.json'), '1.2.3');
    }
  });
});

test('other manifest keys survive a version rewrite', async () => {
  const { syncVersion } = await import('../scripts/sync-version.mjs');
  withFixture({}, (dir) => {
    syncVersion(dir, '3.0.0');
    const ext = JSON.parse(fs.readFileSync(
      path.join(dir, 'vscode-extension', 'package.json'), 'utf8'));
    assert.equal(ext.publisher, 'local');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).license,
      'MIT');
  });
});

test('the release check passes when the manifests agree and the VSIX was built', () => {
  withFixture({ root: '1.4.5', ext: '1.4.5', vsix: '1.4.5' }, (dir) => {
    const { code, out } = runChecker(dir);
    assert.equal(code, 0, out);
    assert.match(out, /release version check OK: 1\.4\.5/);
  });
});

test('the release check fails, naming both numbers, when the manifests drift', () => {
  // This is the exact state the old package.mjs left behind on a tag build.
  withFixture({ root: '1.4.4', ext: '1.4.5', vsix: '1.4.5' }, (dir) => {
    const { code, out } = runChecker(dir);
    assert.equal(code, 1, 'drifted manifests must fail the release build');
    assert.match(out, /package\.json is 1\.4\.4/);
    assert.match(out, /vscode-extension\/package\.json is 1\.4\.5/);
  });
});

test('the release check fails when packaging produced no matching VSIX', () => {
  withFixture({ root: '1.4.5', ext: '1.4.5', vsix: '1.4.4' }, (dir) => {
    const { code, out } = runChecker(dir);
    assert.equal(code, 1, 'a VSIX named for a different version is not this build');
    assert.match(out, /did not produce permission-wildcarding-1\.4\.5\.vsix/);
  });
});

test('a same-version VSIX left over from an earlier build does not count as this build', () => {
  // The hole the name check left open. A working checkout accumulates artefacts -- seven of
  // them, 1.4.2 through 1.4.8, in the checkout where this was written -- so the version about
  // to be released usually already has a file sitting there from the build before. existsSync
  // could not tell that file from the one this run was supposed to write, and release.yml
  // uploads `*.vsix`, so a packaging step that did nothing shipped last week's bytes.
  withFixture({ root: '1.4.5', ext: '1.4.5', vsix: '1.4.5', vsixAt: STALE }, (dir) => {
    const { code, out } = runChecker(dir);
    assert.equal(code, 1, 'an artefact older than the packaging step is not its output');
    assert.match(out, /is OLDER than the packaging step/);
    assert.match(out, /leftover from an earlier build/);
  });
});

test('an artefact written in the same millisecond as the stamp still counts as this build', () => {
  // The comparison is `<`, not `<=`, and this is the case that pins it there. Two writes CAN
  // land in the same millisecond, and a check that called that stale would fail honest builds
  // at random on a fast machine, which is the failure mode nobody debugs twice.
  withFixture({ root: '1.4.5', ext: '1.4.5', vsix: '1.4.5', vsixAt: BUILT_AT }, (dir) => {
    const { code, out } = runChecker(dir);
    assert.equal(code, 0, out);
    assert.match(out, /release version check OK: 1\.4\.5/);
  });
});

test('the release check fails when nothing in the tree shows packaging ran', () => {
  // No receipt: either package.mjs was never run here, or it stopped writing one and the
  // freshness comparison has silently had nothing to compare against ever since.
  withFixture({ root: '1.4.5', ext: '1.4.5', vsix: '1.4.5', stamp: null }, (dir) => {
    const { code, out } = runChecker(dir);
    assert.equal(code, 1, 'without a stamp nothing here can date the artefact');
    assert.match(out, /\.vsix-build\.json is missing or unreadable/);
  });
});

test('the release check fails when the stamp names an artefact the manifests do not', () => {
  // package.mjs reading the manifest BEFORE syncVersion is the exact bug this repo already
  // shipped once (the 1.4.2-from-the-CLI / 1.4.4-in-the-badge split). It would build and stamp
  // the old number while the manifests carried the new one. The expected name is derived here
  // from the manifest, never from the stamp, so this check can still see that disagreement.
  withFixture({ root: '1.4.5', ext: '1.4.5', vsix: '1.4.5', stamp: '1.4.4' }, (dir) => {
    const { code, out } = runChecker(dir);
    assert.equal(code, 1, 'the packaged name and the manifest name must be the same name');
    assert.match(out, /stamp says packaging wrote permission-wildcarding-1\.4\.4\.vsix/);
    assert.match(out, /manifests call for permission-wildcarding-1\.4\.5\.vsix/);
  });
});

test('package.mjs stamps BEFORE it packages, or the stamp dates the wrong side of the build',
  () => {
    // Order, not presence. A stamp written after vsce returns is newer than the artefact it
    // vouches for, so every build -- including every honest one -- reports as stale. Both
    // statements would still be sitting in the file, which is why this asserts which comes
    // first rather than that they are there.
    const src = fs.readFileSync(path.join(repoRoot, 'scripts', 'package.mjs'), 'utf8');
    const stampAt = src.indexOf('writeBuildStamp(root');
    const vsceAt = src.indexOf('execSync(');
    assert.ok(stampAt > 0, 'package.mjs no longer writes a build stamp at all');
    assert.ok(vsceAt > 0, 'package.mjs no longer invokes vsce');
    assert.ok(stampAt < vsceAt,
      'package.mjs stamps after packaging, so check-version-sync.mjs would call every '
      + 'artefact stale, including the one this build just produced');
  });

// PowerShell source with comments stripped and backtick line-continuations folded, so a
// wrapped statement reads as one line and the prose above it cannot satisfy a guard. Sibling
// of installers.test.js:66 -- both comment forms, blocks first, because the interior lines of
// a <# #> block do not start with # and a line-only filter sails straight past them.
const psStatements = (body) => body
  .replace(/<#[\s\S]*?#>/g, ' ')
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('#'))
  .join('\n')
  .replace(/`\r?\n[^\S\n]*/g, ' ');

test('verify-release.ps1 captures STDERR from --gates refresh, or it cannot see it fail', () => {
  // `--gates refresh` reports its one interesting failure -- recall.py's compile step failing,
  // so a stale block is installed on every invocation -- on STDERR (bin/wildcard-perms:641).
  // The assertion beside it says "refresh is silent when nothing changed". Capture stdout
  // only and that sentence is TRUE in precisely the state it exists to report: the warning
  // goes to the console, the captured text is empty, and the board prints PASS.
  //
  // HONEST LIMIT, because this repo does not accept a source check that merely confirms a
  // guarded statement exists: this asserts the CONDITION and the ORDER -- the redirection is
  // on the invocation the assertion consumes, the assertion reads the variable that
  // invocation fills, and the exit code is part of what is asserted -- not the runtime
  // behaviour. No test runs verify-release.ps1, and none should: it writes to the real
  // ~/.claude (`--gates refresh` recompiles gates.generated.md and rewrites the managed block
  // in CLAUDE.md and AGENTS.md; the corpus-watcher probe re-stamps a real memory file).
  const ps = psStatements(
    fs.readFileSync(path.join(repoRoot, 'scripts', 'verify-release.ps1'), 'utf8'));
  const lines = ps.split('\n');

  const isCall = (line) => /^\s*\$r\s*=.*--gates\s+refresh/.test(line);
  const isCheck = (line) => /^\s*Check\s+'--gates refresh/.test(line);
  assert.equal(lines.filter(isCall).length, 1,
    'expected exactly one `$r = ... --gates refresh` invocation to judge');
  assert.equal(lines.filter(isCheck).length, 1,
    'expected exactly one assertion about --gates refresh');

  const callAt = lines.findIndex(isCall);
  const checkAt = lines.findIndex(isCheck);
  assert.ok(checkAt > callAt,
    'the --gates refresh assertion no longer follows the invocation it judges');
  assert.match(lines[callAt], /2>&1/,
    'verify-release.ps1 runs `--gates refresh` without merging STDERR, so a compile failure '
    + 'is invisible to it and the check passes hardest when refresh is broken');
  assert.ok(lines.slice(callAt + 1, checkAt).some((line) => /\$rText\s*=\s*\$r\b/.test(line)),
    'the asserted text is no longer derived from the captured output, so the redirection '
    + 'above it lands somewhere the assertion never reads');
  assert.match(lines[checkAt], /\$rCode\s+-eq\s+0/,
    'the exit code is not part of the assertion: a refresh that fails silently on stdout '
    + 'still passes');
});
