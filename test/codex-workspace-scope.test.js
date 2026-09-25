'use strict';

// CODEX WORKSPACE SCOPE IS WITHDRAWN, and this is the gate that keeps it
// withdrawn.
//
// The decision, not a defect: three different trust notions were in play and
// none of them was the one that decides. VS Code's `workspace.isTrusted` says
// the EDITOR may run code from this folder. The CLI's `--codex-scope workspace`
// was unguarded and asked nothing at all. Codex's own project trust is what
// actually governs whether a workspace rule file is loaded. A capability whose
// trust model cannot be stated does not get certified.
//
// Follows the MAX retirement precedent in this repo: the surface stays
// reachable and refuses. An old invocation must never fall through to user scope
// and write rules into a file it did not ask for -- which is the specific
// failure "just delete the branch" would have caused.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLI = path.resolve(__dirname, '..', 'bin', 'wildcard-perms');
const ROOT = path.resolve(__dirname, '..');
const { removeGeneratedCodexRules, CODEX_BEGIN_MARKER } = require('../src/policy-exporters');

function runCli(home, args, cwd = home) {
  const root = path.parse(home).root;
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd, encoding: 'utf8', windowsHide: true,
    env: {
      ...process.env, HOME: home, USERPROFILE: home,
      HOMEDRIVE: root.replace(/[\\/]$/, ''), HOMEPATH: home.slice(root.length - 1),
    },
  });
}

function tempHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-ws-scope-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'),
    `${JSON.stringify({ permissions: { allow: ['Bash(rg *)'] } }, null, 2)}\n`);
  t.after(() => { try { fs.rmSync(home, { recursive: true, force: true }); } catch {} });
  return home;
}

const MANAGED = [
  CODEX_BEGIN_MARKER,
  'prefix_rule(',
  '    pattern = ["rg"],',
  '    decision = "allow",',
  ')',
  '# END permission-wildcarding generated rules',
  '',
].join('\n');

function workspaceRules(root, text) {
  const file = path.join(root, '.codex', 'rules', 'permission-wildcarding.rules');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

test('--codex-scope workspace refuses, names the reason, and writes nothing', (t) => {
  const home = tempHome(t);
  const userRules = path.join(home, '.codex', 'rules', 'permission-wildcarding.rules');

  const refused = runCli(home, ['--learn', 'status', '--codex-scope', 'workspace']);
  assert.equal(refused.status, 1, refused.stdout);
  assert.equal(refused.stdout, '', 'a refusal prints nothing on stdout');
  assert.match(refused.stderr, /withdrawn/);
  assert.match(refused.stderr, /trust model could not be stated/);
  assert.match(refused.stderr, /Nothing was changed/);
  assert.match(refused.stderr, /--codex-workspace-rules remove/, 'it names the cleanup');

  // The failure the refusal exists to prevent: falling through to user scope.
  assert.equal(fs.existsSync(userRules), false, 'no user-scope rules file was created');
  assert.equal(fs.existsSync(path.join(home, '.codex', 'rules')), false);

  // The neighbouring values still work, or the refusal would just be a break.
  for (const scope of ['user', 'off']) {
    const ok = runCli(home, ['--learn', 'status', '--codex-scope', scope]);
    assert.equal(ok.status, 0, `${scope} must still be accepted: ${ok.stderr}`);
    assert.match(ok.stdout, /"version"/);
  }
  // And an unknown value is still a usage error, not the withdrawal message.
  const bogus = runCli(home, ['--learn', 'status', '--codex-scope', 'global']);
  assert.equal(bogus.status, 1);
  assert.match(bogus.stderr, /^usage: wildcard-perms --learn/);
  assert.doesNotMatch(bogus.stderr, /withdrawn/);
});

test('the usage text stops advertising a scope that refuses', (t) => {
  const home = tempHome(t);
  const help = runCli(home, ['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--codex-scope user\|off/);
  assert.doesNotMatch(help.stdout, /--codex-scope user\|workspace\|off/);
  assert.match(help.stdout, /--codex-workspace-rules status\|remove/,
    'the cleanup is discoverable from --help, not folklore');
});

test('the one-way cleanup removes only the block it can prove it wrote', (t) => {
  const home = tempHome(t);
  const repo = path.join(home, 'repo');
  fs.mkdirSync(repo, { recursive: true });

  // Nothing there: reports, exits 0, creates nothing.
  const absent = runCli(home, ['--codex-workspace-rules', 'status', '--workspace', repo]);
  assert.equal(absent.status, 0, absent.stderr);
  assert.match(absent.stdout, /no workspace Codex rules at/);
  assert.equal(fs.existsSync(path.join(repo, '.codex')), false);

  // A hand-written file that merely shares the name. Ownership is unprovable, so
  // it is left BYTE-IDENTICAL -- the same rule the retired Codex MAX cleanup
  // uses, and the one that stops this from being a file deleter.
  const foreign = 'prefix_rule(\n    pattern = ["mine"],\n    decision = "allow",\n)\n';
  const file = workspaceRules(repo, foreign);
  const beforeBytes = fs.readFileSync(file);
  const status = runCli(home, ['--codex-workspace-rules', 'status', '--workspace', repo]);
  assert.equal(status.status, 0);
  assert.match(status.stdout, /will NOT touch it \(no generated block\)/);
  const refusedRemove = runCli(home, ['--codex-workspace-rules', 'remove', '--workspace', repo]);
  assert.equal(refusedRemove.status, 1);
  assert.match(refusedRemove.stderr, /refused — no generated block/);
  assert.ok(fs.readFileSync(file).equals(beforeBytes), 'a file it cannot claim is untouched');

  // Our block beside their rule: the block goes, their rule stays.
  fs.writeFileSync(file, `${foreign}\n${MANAGED}`);
  const mixed = runCli(home, ['--codex-workspace-rules', 'remove', '--workspace', repo]);
  assert.equal(mixed.status, 0, mixed.stderr);
  assert.match(mixed.stdout, /removed the generated block/);
  assert.match(mixed.stdout, /kept the rest of the file/);
  const kept = fs.readFileSync(file, 'utf8');
  assert.ok(kept.includes('pattern = ["mine"]'), 'the hand-written rule survives');
  assert.equal(kept.includes(CODEX_BEGIN_MARKER), false);

  // Our block and nothing else: the file itself goes.
  fs.writeFileSync(file, MANAGED);
  const only = runCli(home, ['--codex-workspace-rules', 'remove', '--workspace', repo]);
  assert.equal(only.status, 0, only.stderr);
  assert.match(only.stdout, /it held nothing but this tool's generated block/);
  assert.equal(fs.existsSync(file), false);

  // There is deliberately no path that WRITES one.
  const bad = runCli(home, ['--codex-workspace-rules', 'on', '--workspace', repo]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /^usage: wildcard-perms --codex-workspace-rules status\|remove/);
});

// The shapes the remover refuses, at the level it decides them. A cleanup that
// silently did nothing and one that silently did the wrong thing look identical
// to the caller unless the reason comes back.
test('the remover refuses every marker shape it cannot resolve', () => {
  const begin = CODEX_BEGIN_MARKER;
  const end = '# END permission-wildcarding generated rules';
  assert.equal(removeGeneratedCodexRules('').reason, 'no generated block');
  assert.equal(removeGeneratedCodexRules(`${begin}\nx\n`).reason,
    'unbalanced or duplicate generated markers');
  assert.equal(removeGeneratedCodexRules(`${begin}\na\n${end}\n${begin}\nb\n${end}\n`).reason,
    'unbalanced or duplicate generated markers');
  assert.equal(removeGeneratedCodexRules(`${end}\nx\n${begin}\n`).reason,
    'generated markers are out of order');

  const good = removeGeneratedCodexRules(`keep\n${begin}\ndrop\n${end}\nkeep2\n`);
  assert.equal(good.changed, true);
  assert.equal(good.text, 'keep\nkeep2\n');
  assert.equal(good.empty, false);
  assert.equal(removeGeneratedCodexRules(`${begin}\ndrop\n${end}\n`).empty, true);
});

// ── the packaging-style gate ──────────────────────────────────────────────────
//
// A source-text check has to assert the CONDITION, not that some statement
// exists: disable a guard and the statement is still sitting there, unreachable,
// and a presence regex still matches. So this asserts ABSENCE of the symbols
// that could only exist to compute or write a workspace-scoped rules path, over
// the SHIPPED artefact where one is available.
//
// Same entry shape as scripts/assert-retired-max-absent.mjs, and it reuses that
// module's VSIX reader so there is one ZIP parser in the repo rather than two.
const FORBIDDEN_SYMBOLS = ['codexWorkspaceRoot', 'trustedWorkspaceRoot'];

function assertWorkspaceScopeWithdrawn(entries, label) {
  const failures = [];
  let sawManifest = false;
  let sawExtension = false;
  for (const entry of entries) {
    const name = String(entry?.name || '').replace(/\\/g, '/');
    if (typeof entry?.text !== 'string') continue;
    if (/(^|\/)extension\.js$/i.test(name)) {
      sawExtension = true;
      for (const symbol of FORBIDDEN_SYMBOLS) {
        if (new RegExp(`\\b${symbol}\\b`).test(entry.text)) {
          failures.push(`${name}: withdrawn workspace-scope symbol ${symbol}`);
        }
      }
    }
    if (/(^|\/)package\.json$/i.test(name)) {
      let manifest;
      try { manifest = JSON.parse(entry.text); } catch { continue; }
      const setting = manifest?.contributes?.configuration?.properties?.[
        'permissionWildcarding.autoLearn.codexScope'];
      if (!setting) continue;
      sawManifest = true;
      if (Array.isArray(setting.enum) && setting.enum.includes('workspace')) {
        failures.push(`${name}: codexScope still offers the withdrawn "workspace" value`);
      }
      // The ID stays reachable. A manifest that dropped the setting entirely
      // would fail every existing settings.json instead of explaining itself.
      if (!Array.isArray(setting.enum) || !setting.enum.includes('user')) {
        failures.push(`${name}: codexScope no longer offers "user"`);
      }
    }
  }
  // A gate that inspected nothing must say so rather than pass.
  if (!sawManifest) failures.push(`${label}: no extension manifest declaring codexScope was inspected`);
  if (!sawExtension) failures.push(`${label}: no extension.js was inspected`);
  if (failures.length) {
    throw new Error(`${label} still carries withdrawn Codex workspace scope:\n- ${failures.join('\n- ')}`);
  }
  return { manifest: sawManifest, extension: sawExtension };
}

test('the workspace-scope gate fires on every shape of the withdrawn capability', () => {
  const manifest = (values) => JSON.stringify({
    contributes: {
      configuration: {
        properties: {
          'permissionWildcarding.autoLearn.codexScope': { enum: values },
        },
      },
    },
  });
  const clean = [
    { name: 'extension/extension.js', text: 'const codexScope = cfg.get("autoLearn.codexScope");' },
    { name: 'extension/package.json', text: manifest(['user', 'off']) },
  ];
  assert.doesNotThrow(() => assertWorkspaceScopeWithdrawn(clean, 'clean-fixture'));

  for (const symbol of FORBIDDEN_SYMBOLS) {
    assert.throws(
      () => assertWorkspaceScopeWithdrawn([
        { name: 'extension/extension.js', text: `const ${symbol} = null;` },
        { name: 'extension/package.json', text: manifest(['user', 'off']) },
      ], `${symbol}-mutant`),
      new RegExp(`withdrawn workspace-scope symbol ${symbol}`),
      `${symbol} must fire the gate`,
    );
  }
  assert.throws(
    () => assertWorkspaceScopeWithdrawn([
      { name: 'extension/extension.js', text: 'ok' },
      { name: 'extension/package.json', text: manifest(['user', 'workspace', 'off']) },
    ], 'enum-mutant'),
    /codexScope still offers the withdrawn "workspace" value/,
  );
  assert.throws(
    () => assertWorkspaceScopeWithdrawn([
      { name: 'extension/extension.js', text: 'ok' },
      { name: 'extension/package.json', text: manifest(['off']) },
    ], 'dropped-mutant'),
    /codexScope no longer offers "user"/,
    'removing the setting outright is also wrong: an existing settings.json must still load',
  );
  // The gate must not pass on an empty inspection.
  assert.throws(() => assertWorkspaceScopeWithdrawn([], 'empty'),
    /no extension manifest declaring codexScope was inspected/);
  assert.throws(
    () => assertWorkspaceScopeWithdrawn([{ name: 'extension/package.json', text: manifest(['user']) }], 'no-js'),
    /no extension\.js was inspected/,
  );
});

test('the shipped artefact carries no workspace-scope surface', async () => {
  const vsix = fs.readdirSync(ROOT)
    .filter((name) => name.toLowerCase().endsWith('.vsix'))
    .map((name) => path.join(ROOT, name))
    .sort();
  let entries;
  let label;
  if (vsix.length) {
    const { inspectVsix } = await import(
      require('node:url').pathToFileURL(path.join(ROOT, 'scripts', 'assert-retired-max-absent.mjs')).href);
    label = path.basename(vsix[vsix.length - 1]);
    entries = inspectVsix(vsix[vsix.length - 1]);
  } else {
    // DEGRADED, and it says so on every run. The checkout is what vsce packages,
    // but it is not the artefact, and a stale generated tree or a direct vsce
    // invocation can differ from it. Build one and this assertion upgrades.
    process.stderr.write(
      '\n[codex-workspace-scope] DEGRADED: no .vsix in the repo root, so the gate inspected the ' +
      'CHECKOUT rather than the packaged artefact. Run `npm run package` to exercise the real one.\n\n');
    label = 'checkout (no VSIX present)';
    entries = [
      { name: 'extension/extension.js', text: fs.readFileSync(path.join(ROOT, 'vscode-extension', 'extension.js'), 'utf8') },
      { name: 'extension/package.json', text: fs.readFileSync(path.join(ROOT, 'vscode-extension', 'package.json'), 'utf8') },
    ];
  }
  const inspected = assertWorkspaceScopeWithdrawn(entries, label);
  assert.equal(inspected.manifest, true);
  assert.equal(inspected.extension, true);
});
