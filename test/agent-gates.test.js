'use strict';

// The gates block shares its file plumbing with the shell-style block but not its
// markers, and that separation is the whole contract. Two managed blocks live in one
// instruction file, so the tests that matter are: removing one leaves the other byte for
// byte, a corpus edit is detected as stale with no version to bump, and a missing compile
// refuses to install rather than fencing off nothing and reporting success.

const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { BEGIN, applyGuidance, setGuidance } = require('../src/agent-guidance');
const {
  GATES_BEGIN, GATES_END, makeGatesBlock, compiledPath, readCompiled, setGatesAll,
  gatesStatusAll,
} = require('../src/agent-gates');

const USER_TEXT = '# My global instructions\n\nAlways use the toolbox python.\n';
const COMPILED = '## Standing gates (1 memories, managed)\n\n- **File edits.** Apply directly.';

// A fake home whose .claude/ holds a compiled gates file, so nothing touches the real one.
// Every scratch root this file creates, torn down once at the end. These three
// helpers are module-level and take no `t`, so a per-test t.after() would mean
// threading the context through every call site; one `after` hook over a registry
// is the smaller change. Measured before this: the suite left 3 directories in
// %TEMP% per run, and 798 had accumulated.
const scratchRoots = [];
after(() => {
  for (const root of scratchRoots) {
    // maxRetries because a Windows handle can still be closing when we get here.
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
    catch { /* a leaked temp dir must never fail the suite */ }
  }
});

function fakeHome(compiled = COMPILED) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-gates-'));
  scratchRoots.push(root);
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  if (compiled !== null) fs.writeFileSync(compiledPath(root), `${compiled}\n`, 'utf8');
  return root;
}

test('an absent compile reads empty, a present one reads trimmed', () => {
  assert.equal(readCompiled(fakeHome(null)), '');
  assert.equal(readCompiled(fakeHome()), COMPILED);
});

test('off is a byte-for-byte round trip of the user file', () => {
  // Block bound to the fake home, so the assertion cannot pass on the strength of this
  // machine happening to have a real compiled file.
  const block = makeGatesBlock(fakeHome());
  const on = block.apply(USER_TEXT, true);
  assert.equal(on.changed, true);
  assert.ok(on.text.startsWith(USER_TEXT), 'user text keeps its position at the top');
  assert.ok(on.text.includes(COMPILED), 'the compiled body is what got installed');
  assert.ok(block.has(on.text));

  const off = block.apply(on.text, false);
  assert.equal(off.changed, true);
  assert.equal(off.text, USER_TEXT, 'the file the user had, exactly');
});

test('a recompiled corpus reads as stale, and refreshes without duplicating', () => {
  // Same markers, different body: exactly what happens after editing a gate in a memory
  // file and recompiling. No version number is involved, which is the point.
  const block = makeGatesBlock(fakeHome());
  const stale = `${USER_TEXT}\n${GATES_BEGIN}\n## Standing gates (0 memories, managed)\n${GATES_END}\n`;
  assert.equal(block.has(stale), true);
  assert.equal(block.isCurrent(stale), false);

  const refreshed = block.apply(stale, true);
  assert.equal(refreshed.changed, true);
  assert.equal(refreshed.text.split(GATES_BEGIN).length - 1, 1, 'exactly one gates block');
  assert.ok(block.isCurrent(refreshed.text));
});

test('the two managed blocks coexist, and removing one leaves the other untouched', () => {
  // The reason the markers differ. A shared pair would make either "off" tear out both.
  const block = makeGatesBlock(fakeHome());
  const withShell = applyGuidance(USER_TEXT, true).text;
  const withBoth = block.apply(withShell, true).text;
  assert.ok(withBoth.includes(BEGIN), 'shell block survived the gates install');
  assert.ok(withBoth.includes(GATES_BEGIN));

  const gatesGone = block.apply(withBoth, false);
  assert.equal(gatesGone.changed, true);
  assert.equal(gatesGone.text, withShell, 'shell block is byte-identical after gates off');
  assert.ok(!gatesGone.text.includes(GATES_BEGIN));

  const shellGone = applyGuidance(withBoth, false);
  assert.ok(shellGone.text.includes(GATES_BEGIN), 'gates survived a guidance off');
  assert.ok(!shellGone.text.includes(BEGIN));
});

test('a compiled file with no gates in it is treated as nothing compiled', () => {
  // The shape a zero-gate compile produces. If the guard only checked for a MISSING file,
  // this would install a heading with no rules under it and report gates ON.
  for (const empty of ['', '\n', '   \n\n']) {
    const home = fakeHome(empty);
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    assert.equal(readCompiled(home), '', `"${empty}" must read as nothing compiled`);
    const results = setGatesAll(true, { home, backupDir: path.join(home, 'backups') });
    assert.equal(results[0].changed, false);
    assert.match(results[0].error, /--gates-compile/);
  }
});

// `compiled` is the only field that distinguishes "gates are off because you
// turned them off" from "gates are off because recall.py has never produced a
// corpus", and `--gates status` prints "(nothing compiled)" off it. Nothing
// asserted it anywhere: hard-wiring `compiled: true` left all 586 tests green,
// which was found by mutating this function while removing its dead export.
//
// That matters more than a status suffix usually would, because the failure it
// reports is the one this whole feature was built around — a card reading
// "gates ON" over a block fenced around nothing.
test('status distinguishes a missing compile from gates merely being off', () => {
  const uncompiled = fakeHome(null);
  const [absent] = gatesStatusAll(uncompiled);
  assert.equal(absent.compiled, false, 'no gates.generated.md at all');
  assert.equal(absent.on, false);

  // The other shape a zero-gate compile takes: the file exists and says nothing.
  const [blank] = gatesStatusAll(fakeHome('   \n\n'));
  assert.equal(blank.compiled, false, 'a whitespace-only compile is not a compile');

  const home = fakeHome();
  const [before] = gatesStatusAll(home);
  assert.equal(before.compiled, true, 'a real corpus is compiled, even with gates off');
  assert.equal(before.on, false);

  setGatesAll(true, { home, backupDir: path.join(home, 'backups') });
  const [after_] = gatesStatusAll(home);
  assert.equal(after_.on, true);
  assert.equal(after_.compiled, true);
  assert.equal(after_.current, true, 'freshly installed, so not stale');

  // MUTATION: hard-wire `compiled: true` in gatesStatus and the first two
  // assertions fail. Before this test, that mutation survived the whole suite.
});

test('installing with nothing compiled refuses instead of fencing off nothing', () => {
  const home = fakeHome(null);
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  const results = setGatesAll(true, { home, backupDir: path.join(home, 'backups') });
  assert.equal(results.length, 1);
  assert.equal(results[0].changed, false);
  assert.equal(results[0].on, false);
  assert.match(results[0].error, /--gates-compile/);
  assert.ok(!fs.existsSync(path.join(home, '.claude', 'CLAUDE.md')),
    'a refused install writes no instruction file at all');
});

test('the gates backup name cannot collide with the guidance one', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-gates-bk-'));
  scratchRoots.push(root);
  const file = path.join(root, 'CLAUDE.md');
  const backupDir = path.join(root, 'backups');
  fs.writeFileSync(file, USER_TEXT, 'utf8');

  setGuidance(true, { file, backupDir });
  setGuidance(true, {
    file, backupDir, backupName: 'CLAUDE.md.pre-gates', block: makeGatesBlock(fakeHome()),
  });

  const saved = fs.readdirSync(backupDir).sort();
  // Each block keeps its own pair: the first-ever copy and a rolling `-prev`.
  assert.deepEqual(saved, ['CLAUDE.md.pre-gates', 'CLAUDE.md.pre-gates-prev',
    'CLAUDE.md.pre-guidance', 'CLAUDE.md.pre-guidance-prev']);
  // The guidance backup holds the original; the gates backup holds it *with* guidance,
  // so neither block's pre-change copy is lost to the other.
  assert.equal(fs.readFileSync(path.join(backupDir, 'CLAUDE.md.pre-guidance'), 'utf8'), USER_TEXT);
  assert.ok(fs.readFileSync(path.join(backupDir, 'CLAUDE.md.pre-gates'), 'utf8').includes(BEGIN));
});

test('gates use an explicit Codex profile and migrate only their block into its override', () => {
  const home = fakeHome();
  const profile = path.join(home, 'alternate-codex-profile');
  fs.mkdirSync(profile);
  const regular = path.join(profile, 'AGENTS.md');
  const override = path.join(profile, 'AGENTS.override.md');
  const shellText = applyGuidance(USER_TEXT, true).text;
  const block = makeGatesBlock(home);
  fs.writeFileSync(regular, block.apply(shellText, true).text);
  fs.writeFileSync(override, shellText);
  const options = { home, codexHome: profile };
  const before = gatesStatusAll(options).find((state) => state.agent === 'codex');
  assert.equal(before.on, false);
  assert.deepEqual(before.shadowedPaths, [regular]);
  const enabled = setGatesAll(true, options).find((result) => result.agent === 'codex');
  assert.equal(enabled.path, override);
  assert.equal(enabled.on, true);
  assert.equal(enabled.error, null);
  assert.equal(fs.readFileSync(regular, 'utf8'), shellText, 'shell guidance in the base is untouched');
  assert.ok(fs.readFileSync(override, 'utf8').includes(COMPILED));
  assert.equal(gatesStatusAll(options).find((state) => state.agent === 'codex').current, true);
  assert.ok(fs.existsSync(path.join(home, '.claude', 'backups', 'AGENTS.override.md.pre-gates')));
  const disabled = setGatesAll(false, options).find((result) => result.agent === 'codex');
  assert.equal(disabled.on, false);
  assert.equal(fs.readFileSync(override, 'utf8'), shellText, 'gates off preserves the complete shell block');
  assert.equal(fs.existsSync(path.join(home, '.codex')), false, 'a custom profile must not create the default one');
});

// ── The compiled file, read once (ported from rampage 7139659) ────────────────────

// Every read of gates.generated.md that one write makes, counted.
function countCompiledReads(t, home, answer) {
  const realRead = fs.readFileSync;
  const seen = { reads: 0 };
  t.mock.method(fs, 'readFileSync', (target, ...rest) => {
    if (path.resolve(String(target)) !== path.resolve(compiledPath(home))) return realRead(target, ...rest);
    seen.reads += 1;
    return answer(seen.reads, () => realRead(target, ...rest));
  });
  return seen;
}

test('the compiled file is read once per write, so the bytes checked are the bytes installed', (t) => {
  // recall.py rewrote the file in place (open, truncate, write). The block re-read it after
  // the empty-compile check had passed, and a reader between the truncate and the write
  // installed an empty block over the user's gates and reported success. Here every read
  // after the first sees the truncated file.
  const home = fakeHome();
  const file = path.join(home, '.claude', 'CLAUDE.md');
  fs.writeFileSync(file, USER_TEXT, 'utf8');
  const seen = countCompiledReads(t, home, (n, real) => (n === 1 ? real() : ''));
  const [row] = setGatesAll(true, { home });
  assert.equal(row.error, null);
  assert.equal(seen.reads, 1, 'one read of the compiled file for the whole write');
  assert.ok(fs.readFileSync(file, 'utf8').includes(COMPILED), 'and its bytes are the installed body');

  // MUTATION: build the block with `makeGatesBlock(home)` in setGatesAll (the late-reading
  // body) and both assertions fail: several reads, and an empty block installed.
});

test('a compiled file that cannot be read is refused, not installed as an empty block', (t) => {
  // EBUSY is what Windows answers while a writer holds the file open, and readCompiled
  // gives null for it; the late-reading body's `|| ''` made that an empty body.
  const home = fakeHome();
  const file = path.join(home, '.claude', 'CLAUDE.md');
  const installed = makeGatesBlock(home).apply(USER_TEXT, true).text;
  fs.writeFileSync(file, installed, 'utf8');
  countCompiledReads(t, home, () => {
    throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
  });
  const [row] = setGatesAll(true, { home });
  assert.equal(row.changed, false);
  assert.match(row.error, /cannot read .*gates\.generated\.md: nothing was written, try again/);
  assert.equal(fs.readFileSync(file, 'utf8'), installed, 'the installed gates stay resident');
  assert.equal(setGatesAll(false, { home })[0].error, null, 'and off needs no compile at all');
  assert.equal(fs.readFileSync(file, 'utf8'), USER_TEXT);

  // MUTATION: delete the `compiled === null` refusal in refusalFor and the install throws
  // on `null.startsWith` (or, with the old guard, reports "no compiled gates": the wrong
  // cause, which sends the user to recompile a file that is fine).
});

test('a compiled file whose gates do not match its own header sha is refused', () => {
  // The other thing a read during an in-place write returns: a PREFIX. Its header is
  // intact, so it is not empty, and it used to install a truncated gate set.
  const gates = '- **Widget cache.** Reset it before a rebuild.\n- **Gadget log.** Read it first.';
  const header = (body) => `<!-- generated by recall.py --gates-compile; sha ${
    crypto.createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 16)} -->\n`
    + '## Standing gates (2 memories, managed)\n\n';
  const torn = fakeHome(header(gates) + gates.slice(0, 30));
  fs.writeFileSync(path.join(torn, '.claude', 'CLAUDE.md'), USER_TEXT, 'utf8');
  const [row] = setGatesAll(true, { home: torn });
  assert.equal(row.changed, false);
  assert.match(row.error, /does not match the sha in its own header/);
  assert.equal(fs.readFileSync(path.join(torn, '.claude', 'CLAUDE.md'), 'utf8'), USER_TEXT);

  // The whole file installs, and so does one with no header to check against.
  const whole = fakeHome(header(gates) + gates);
  fs.writeFileSync(path.join(whole, '.claude', 'CLAUDE.md'), USER_TEXT, 'utf8');
  assert.equal(setGatesAll(true, { home: whole })[0].error, null);
  assert.equal(setGatesAll(true, { home: fakeHome(gates) })[0].error, null);

  // MUTATION: make compiledIsWhole return true and the torn file installs with error null.
});

test('a compiled file torn inside its own header line is refused, not taken as headerless', () => {
  // Found by rampage's burn-down audit: a read cut at 40, 75, 100 or 111 bytes matched no
  // header, so it was taken as a headerless compile and replaced the user's gates with
  // something like `<!-- generated by recall.py --gates-comp`.
  const gates = '- **Widget cache.** Reset it before a rebuild.';
  const full = `<!-- generated by recall.py --gates-compile; sha ${
    crypto.createHash('sha256').update(gates, 'utf8').digest('hex').slice(0, 16)} -->\n`
    + '## Standing gates (1 memories, managed)\n\n' + gates;
  for (const cut of [5, 27, 40, 75, 100, 111]) {
    const home = fakeHome(full.slice(0, cut));
    fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), USER_TEXT, 'utf8');
    const [row] = setGatesAll(true, { home });
    assert.equal(row.changed, false, `cut at ${cut} must not install`);
    assert.match(row.error, /does not match the sha in its own header/, `cut at ${cut}`);
    assert.equal(fs.readFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'utf8'), USER_TEXT);
  }
  // A headerless compile that merely mentions recall.py further in is still taken as it is.
  assert.equal(setGatesAll(true, { home: fakeHome('- see <!-- generated by recall.py --gates-compile -->') })[0].error, null);

  // MUTATION: in compiledIsWhole, return true when no header matches (the old behaviour) and
  // every cut installs: this test fails on the first assertion.
});

// The real compiler's output is what the check is for, so pin that a recall.py-shaped file
// passes: the sha is over the gates as recall.py joins them, with its final newline trimmed.
test('a compile shaped exactly as recall.py writes it installs', () => {
  const blocks = ['- **One.** Pass: first.', '- **Two.** Pass: second, with an em-dash — here.'];
  const body = blocks.join('\n');
  const digest = crypto.createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 16);
  const written = `<!-- generated by recall.py --gates-compile; sha ${digest} -->\n`
    + `## Standing gates (${blocks.length} memories, managed)\n\n${body}\n`;
  const home = fakeHome(null);
  fs.writeFileSync(compiledPath(home), written, 'utf8');
  const [row] = setGatesAll(true, { home });
  assert.equal(row.error, null);
  assert.ok(fs.readFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'utf8').includes(body));
});

test('default gate writes and status follow CODEX_HOME without changing the compiled source home', (t) => {
  const home = fakeHome();
  const profile = path.join(home, 'active-codex-profile');
  fs.mkdirSync(profile);
  const override = path.join(profile, 'AGENTS.override.md');
  fs.writeFileSync(override, USER_TEXT);
  t.mock.method(os, 'homedir', () => home);
  const prior = process.env.CODEX_HOME;
  process.env.CODEX_HOME = profile;
  t.after(() => {
    if (prior === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prior;
  });
  const result = setGatesAll(true).find((row) => row.agent === 'codex');
  assert.equal(result.path, override);
  assert.equal(result.error, null);
  assert.ok(fs.readFileSync(override, 'utf8').includes(COMPILED));
  const state = gatesStatusAll().find((row) => row.agent === 'codex');
  assert.equal(state.path, override);
  assert.equal(state.compiled, true);
  assert.equal(state.on, true);
  assert.equal(fs.existsSync(path.join(home, '.codex')), false);
});
