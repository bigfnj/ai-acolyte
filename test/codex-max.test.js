'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  readApproval, setApproval, clearApproval, isCodexMaxOn, applyCodexMax,
  sandboxMode, topLevelBound, APPROVAL_VALUES,
  allowedApprovalPolicies, allowedSandboxModes, targetApproval,
  enterprisePrefixRules, enterpriseDecisionFor, bundleFreshness,
} = require('../src/codex-max');

// A real enterprise requirements bundle, in the shape Codex caches it.
const bundleWith = (contents) => ({
  signed_payload: { bundle: { requirements_toml: { enterprise_managed: [{ contents }] } } },
});
const RESTRICTED = bundleWith([
  'allowed_sandbox_modes = ["read-only", "workspace-write"]',
  'allowed_approval_policies = ["on-request", "untrusted"]',
].join('\n'));

// The TTL fields sit one level UP from the requirements the parser reads, which
// is how they went unread: a grep for any of cached_at / expires_at /
// account_id across src/, bin/ and vscode-extension/ returned nothing on
// 2026-09-21. Every fixture above omits them, and that is deliberate — the rule
// under test has to leave those cases alone.
const withTtl = (bundle, cachedAt, expiresAt) => ({
  signed_payload: { ...bundle.signed_payload, cached_at: cachedAt, expires_at: expiresAt },
});
// The owner's real cache, measured 2026-09-21: a ONE-HOUR TTL, read weeks later.
const CACHED_AT = '2026-09-03T16:20:47Z';
const EXPIRES_AT = '2026-09-03T17:20:47Z';
const NOW_ISO = '2026-09-22T12:00:00Z';
const NOW = Date.parse(NOW_ISO);
const STALE_CAP = withTtl(RESTRICTED, CACHED_AT, EXPIRES_AT);
const LIVE_CAP = withTtl(RESTRICTED, NOW_ISO, '2026-09-22T13:00:00Z');
// The injected clock applyCodexMax already carries, reused for expiry.
const clock = () => NOW_ISO;

// A config shaped like a real one: literal-string Windows paths, an inline
// array, and several nested tables after the top-level keys.
const REAL_SHAPE = [
  'notify = [ "C:\\\\Users\\\\x\\\\codex.exe", "turn-ended" ]',
  'model = "gpt-5.6-sol"',
  'sandbox_mode = "workspace-write"',
  'personality = "pragmatic"',
  '',
  '[marketplaces.openai-bundled]',
  "source = '\\\\?\\C:\\Users\\x\\.codex\\bundled'",
  '',
  '[plugins."browser@openai-bundled"]',
  'enabled = true',
  '',
].join('\n');

test('a bare key is inserted in the top-level table, never inside a later one', () => {
  const { text, changed } = setApproval(REAL_SHAPE, 'never');
  assert.equal(changed, true);
  const lines = text.split('\n');
  const keyAt = lines.findIndex((line) => line.startsWith('approval_policy'));
  // The single most dangerous failure mode: appending at EOF would silently put
  // the key inside [plugins."browser@openai-bundled"], where Codex ignores it.
  assert.ok(keyAt >= 0, 'key must be written');
  assert.ok(keyAt < topLevelBound(lines), 'key must land before the first table header');
  assert.equal(lines[keyAt - 1], 'personality = "pragmatic"', 'groups with its siblings');
});

test('editing is surgical: one line added, nothing else touched', () => {
  const { text } = setApproval(REAL_SHAPE, 'never');
  const before = REAL_SHAPE.split('\n');
  const after = text.split('\n');
  assert.equal(after.length, before.length + 1);
  assert.deepEqual(after.filter((l) => !before.includes(l)), ['approval_policy = "never"']);
  assert.deepEqual(before.filter((l) => !after.includes(l)), []);
});

test('the toggle never touches sandbox_mode, because it is the only floor Codex has', (t) => {
  // A mkdtemp dir like every other test in this file. The name `nope.json`
  // suggested a path that would not be written, but applyCodexMax writes its
  // state there — so this left a real 69-byte nope.json in %TEMP% behind on
  // every run, at a FIXED path, which two concurrent runs would also fight over.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-max-sandbox-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const on = applyCodexMax(REAL_SHAPE, true, { statePath: path.join(dir, 'state.json'), bundle: null });
  assert.equal(sandboxMode(on.text), 'workspace-write');
  assert.equal(on.sandboxUntouched, true);
  assert.equal(/danger-full-access/.test(on.text), false);
});

test('round trip restores the file byte for byte', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-max-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const statePath = path.join(dir, 'state.json');

  const on = applyCodexMax(REAL_SHAPE, true, { statePath, bundle: null });
  assert.equal(isCodexMaxOn(on.text, null), true);
  const off = applyCodexMax(on.text, false, { statePath, bundle: null });
  assert.equal(off.text, REAL_SHAPE, 'off must restore the original bytes');
  assert.equal(isCodexMaxOn(off.text, null), false);
});

test('an existing approval_policy is restored, not removed', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-max-prior-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const statePath = path.join(dir, 'state.json');
  const source = REAL_SHAPE.replace('model = "gpt-5.6-sol"', 'model = "gpt-5.6-sol"\napproval_policy = "untrusted"');

  const on = applyCodexMax(source, true, { statePath, bundle: null });
  assert.equal(readApproval(on.text), 'never');
  const off = applyCodexMax(on.text, false, { statePath, bundle: null });
  assert.equal(readApproval(off.text), 'untrusted', 'the prior policy must come back');
  assert.equal(off.text, source);
});

test('with no prior key, off removes it rather than inventing one', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-max-absent-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const statePath = path.join(dir, 'state.json');
  const on = applyCodexMax(REAL_SHAPE, true, { statePath, bundle: null });
  const off = applyCodexMax(on.text, false, { statePath, bundle: null });
  assert.equal(readApproval(off.text), null);
});

test('a commented-out key is not mistaken for a live one', () => {
  const source = '# approval_policy = "never"\nmodel = "x"\n';
  assert.equal(readApproval(source), null);
  assert.equal(isCodexMaxOn(source, null), false);
  const { text } = setApproval(source, 'never');
  assert.equal(text.split('\n').filter((l) => l.startsWith('approval_policy')).length, 1);
  assert.match(text, /# approval_policy = "never"/, 'the comment must survive');
});

test('CRLF files stay CRLF, and both quote styles are read', () => {
  const crlf = 'model = "x"\r\nsandbox_mode = "workspace-write"\r\n';
  const { text } = setApproval(crlf, 'never');
  assert.equal(/\r\n/.test(text), true);
  assert.equal(/[^\r]\n/.test(text), false, 'must not introduce bare LF');
  assert.equal(readApproval("approval_policy = 'on-request'\n"), 'on-request');
});

test('an unsupported policy value is refused rather than written', () => {
  assert.throws(() => setApproval(REAL_SHAPE, 'yolo'), /Unsupported Codex approval_policy/);
  assert.deepEqual([...APPROVAL_VALUES].sort(), ['never', 'on-request', 'untrusted']);
});

test('a config with no tables at all still gets a top-level key', () => {
  const { text } = setApproval('model = "x"\n', 'never');
  assert.equal(readApproval(text), 'never');
  assert.equal(clearApproval(text).text, 'model = "x"\n');
});

// An org bundle can declare which approval policies are legal at all. MAX means
// "skip every prompt", which only approval_policy="never" achieves. Where the org
// forbids "never", no value MAX could write skips prompts — and the least-friction
// one it could set is the org's own default — so MAX has no on-state to reach and
// must report that it is unavailable rather than write a no-op and call it "on".
test('enterprise policy that forbids "never" makes Codex MAX unavailable, not a no-op on', (t) => {
  assert.deepEqual(allowedApprovalPolicies(RESTRICTED), ['on-request', 'untrusted']);
  assert.deepEqual(allowedSandboxModes(RESTRICTED), ['read-only', 'workspace-write']);

  const target = targetApproval(RESTRICTED);
  assert.equal(target.restricted, true, 'never is not in the allowed set');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-max-policy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const statePath = path.join(dir, 'state.json');
  const on = applyCodexMax(REAL_SHAPE, true, { statePath, bundle: RESTRICTED });
  assert.equal(on.changed, false, 'nothing is written when MAX cannot skip prompts');
  assert.equal(on.text, REAL_SHAPE, 'the config is left byte for byte');
  assert.equal(on.blockedBy, 'enterprise-policy');
  assert.equal(on.restricted, true);
  assert.equal(/never/.test(on.text), false, 'a forbidden value is never written');
  // The sandbox is still untouched, and would have been capped anyway.
  assert.equal(sandboxMode(on.text), 'workspace-write');
});

// The exact "MAX turned itself on again" report: on a capped box, target.value
// collapses to the org's enforced default (on-request here). A config that merely
// carries that default — because Codex, the user, or a stale toggle wrote it — is
// not a MAX the user enabled, and on-request skips nothing. isCodexMaxOn must not
// read it as on, or the card claims "all prompts skipped" from the org's own floor.
test('the org default under a restriction never reads as Codex MAX on', () => {
  const target = targetApproval(RESTRICTED);
  assert.equal(target.value, 'on-request', 'the org default is the only value MAX could set');

  const withDefault = setApproval(REAL_SHAPE, 'on-request').text;
  assert.equal(readApproval(withDefault), 'on-request');
  assert.equal(isCodexMaxOn(withDefault, RESTRICTED), false, 'the org default is not MAX');

  const withUntrusted = setApproval(REAL_SHAPE, 'untrusted').text;
  assert.equal(isCodexMaxOn(withUntrusted, RESTRICTED), false, 'a permitted lesser policy is not MAX either');

  // And where the org does allow "never", the same isCodexMaxOn still reports it.
  const withNever = setApproval(REAL_SHAPE, 'never').text;
  assert.equal(isCodexMaxOn(withNever, null), true, 'unrestricted "never" is genuinely on');
});

test('no allowed policy at all is refused, not guessed at', () => {
  const none = bundleWith('allowed_approval_policies = ["something-unknown"]');
  assert.deepEqual(allowedApprovalPolicies(none), [], 'present but unreadable = nothing allowed');
  assert.equal(targetApproval(none).value, null);
  const res = applyCodexMax(REAL_SHAPE, true, { bundle: none });
  assert.equal(res.changed, false);
  assert.equal(res.blockedBy, 'enterprise-policy');
});

test('with no bundle, nothing is capped and "never" is still the target', () => {
  assert.equal(allowedApprovalPolicies(null), null, 'absent key = unrestricted');
  assert.equal(targetApproval(null).value, 'never');
  assert.equal(targetApproval(null).restricted, false);
});

// ── an expired policy cache ───────────────────────────────────────────────────
// The cap on this box was read from a cache with a one-hour TTL that lapsed on
// 2026-09-03, and Codex itself had been accepting "never" since 2026-09-14. The
// toggle stayed disabled for eighteen days while looking like it worked.

test('bundleFreshness reads the TTL beside the payload, and absence is not expiry', () => {
  const stale = bundleFreshness(STALE_CAP, NOW);
  assert.equal(stale.cachedAt, CACHED_AT, 'the date the card has to name');
  assert.equal(stale.expiresAt, EXPIRES_AT);
  assert.equal(stale.expired, true, 'a one-hour TTL read nineteen days later is expired');

  // The comparison is strict and forward. Both sides of the boundary, because a
  // flipped or widened operator is the cheapest way to get this wrong.
  assert.equal(bundleFreshness(STALE_CAP, Date.parse(EXPIRES_AT)).expired, false,
    'exactly at the deadline is not yet past it');
  assert.equal(bundleFreshness(LIVE_CAP, NOW).expired, false,
    'an hour still to run is current policy, not a lapsed cache');

  // Absence is the case EVERY other fixture in this file is in. "No expiry means
  // expired" would invert the whole suite, and a truncated cache would then read
  // as no restriction at all — the failure allowedApprovalPolicies fails closed
  // against, arriving through the other door.
  assert.deepEqual(bundleFreshness(RESTRICTED, NOW), { cachedAt: null, expiresAt: null, expired: false });
  assert.equal(bundleFreshness(null, NOW).expired, false, 'no bundle, nothing to expire');
  assert.equal(bundleFreshness(withTtl(RESTRICTED, CACHED_AT, 'whenever'), NOW).expired, false,
    'an unparseable expiry fails closed and leaves the cap exactly where it was');
  assert.equal(bundleFreshness(STALE_CAP, 'not-a-time').expired, false,
    'and so does an unreadable clock');
});

test('an expired cap still blocks, but as a question rather than a flat refusal', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-max-stale-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const statePath = path.join(dir, 'state.json');

  const res = applyCodexMax(REAL_SHAPE, true, { statePath, bundle: STALE_CAP, now: clock });
  // A DISTINCT code. A caller that saw 'enterprise-policy' here would disable
  // the switch and never ask, which is the bug this replaces.
  assert.equal(res.blockedBy, 'enterprise-policy-stale');
  assert.equal(res.changed, false, 'an expired bundle does not silently become "no restriction"');
  assert.equal(res.text, REAL_SHAPE, 'nothing is written before the user is asked');
  assert.equal(res.stale, true);
  assert.equal(res.cachedAt, CACHED_AT, 'the caller must be able to name the date without re-reading');
  assert.equal(res.expiresAt, EXPIRES_AT);
  assert.equal(fs.existsSync(statePath), false, 'and no snapshot is taken for a write that did not happen');
});

test('a cache still inside its TTL is refused exactly as before', () => {
  const res = applyCodexMax(REAL_SHAPE, true, { bundle: LIVE_CAP, now: clock });
  assert.equal(res.blockedBy, 'enterprise-policy');
  assert.equal(res.stale, false);
  // And the override is scoped to STALENESS, not a general escape hatch: a live
  // cap does not take it. Getting this wrong turns an informed override into a
  // way to ignore org policy outright.
  const forced = applyCodexMax(REAL_SHAPE, true, { bundle: LIVE_CAP, overrideStale: true, now: clock });
  assert.equal(forced.blockedBy, 'enterprise-policy', 'a current cap is current policy');
  assert.equal(forced.changed, false);
  assert.equal(/never/.test(forced.text), false, 'a forbidden value is still never written');
});

test('the override writes "never", and the card then reads ON', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-max-override-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const statePath = path.join(dir, 'state.json');

  const on = applyCodexMax(REAL_SHAPE, true, {
    statePath, bundle: STALE_CAP, overrideStale: true, now: clock,
  });
  assert.equal(on.blockedBy, undefined);
  assert.equal(on.changed, true);
  assert.equal(readApproval(on.text), 'never',
    'the value the user asked for, not the least-friction one a lapsed cache happened to permit');
  assert.equal(on.target, 'never');
  assert.equal(on.stale, true, 'the result still says where the cap came from');
  assert.equal(sandboxMode(on.text), 'workspace-write', 'the sandbox floor is untouched, as always');

  // The half that recreates the v1.24.0 bug INVERTED if it is wrong: the
  // override lands, the config says "never", and the card still reads OFF, so
  // the user clicks a toggle that already fired.
  assert.equal(isCodexMaxOn(on.text, STALE_CAP, { now: NOW_ISO }), true,
    'an expired cap does not cap, so "never" in the file is MAX on');

  // Not a blanket allowance, though. The org default under a stale cap is still
  // not MAX: the cache ceasing to be evidence does not make on-request skip
  // prompts, and reading it as on is the original "MAX turned itself on" report.
  const withDefault = setApproval(REAL_SHAPE, 'on-request').text;
  assert.equal(isCodexMaxOn(withDefault, STALE_CAP, { now: NOW_ISO }), false);
  // And under a LIVE cap the original answer is unchanged, file contents aside.
  assert.equal(isCodexMaxOn(on.text, LIVE_CAP, { now: NOW_ISO }), false);

  // Off has to agree it was on, or the restore never runs.
  const off = applyCodexMax(on.text, false, { statePath, bundle: STALE_CAP, now: clock });
  assert.equal(off.text, REAL_SHAPE, 'off restores the original bytes over a stale cap too');
});

// The enterprise bundle carries prefix rules that force a prompt regardless of
// any user rule. A diagnostic that reads only user rules names the wrong cause
// and suggests a fix (write a rule) that cannot work.
test('enterprise prefix rules are parsed and matched by command root', () => {
  const bundle = bundleWith([
    '[[rules.prefix_rules]]',
    'pattern = [{ any_of = ["sh", "bash", "zsh"] }]',
    'decision = "prompt"',
    'justification = "Shell launchers require human review."',
    '',
    '[[rules.prefix_rules]]',
    'pattern = [{ any_of = ["curl", "wget"] }]',
    'decision = "prompt"',
    'justification = "Network access requires approval."',
  ].join('\n'));

  const rules = enterprisePrefixRules(bundle);
  assert.equal(rules.length, 2, 'each block is its own rule');
  assert.deepEqual(rules[0].patterns, ['sh', 'bash', 'zsh']);
  assert.equal(rules[1].justification, 'Network access requires approval.');

  // Matching is on the command root, so a path or .exe suffix still matches.
  assert.equal(enterpriseDecisionFor(bundle, ['curl', '--version']).decision, 'prompt');
  assert.equal(enterpriseDecisionFor(bundle, ['C:\\tools\\curl.exe', '-s']).decision, 'prompt');
  assert.equal(enterpriseDecisionFor(bundle, ['/usr/bin/bash', '-lc', 'ls']).root, 'bash');
  assert.equal(enterpriseDecisionFor(bundle, ['rg', '--files']), null, 'ungoverned root');
  assert.equal(enterpriseDecisionFor(bundle, []), null);
  assert.equal(enterpriseDecisionFor(null, ['curl']), null, 'no bundle, no rules');
});
