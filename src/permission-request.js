'use strict';

// The PermissionRequest hook for Claude Code and Codex: the decision, the rules
// it reads, the one-line log and the report over that log.
//
// WHAT THIS CAN AND CANNOT REMOVE. Both products run their own rule evaluation
// first and fire PermissionRequest only when that evaluation decided to ask. A
// hook that approves "what the same rules allow" therefore changes an outcome
// only where this matcher and the product's disagree, and with the same rules
// on both sides that is a small set by construction. Measured before this was
// built, from the real transcripts: see "PermissionRequest hook" in
// docs/engineering-record.md. The disagreements that remain are mostly the
// product's own safety checks (a redirection, a substitution, an interpreter
// rule auto mode refuses to load), which is why every gate below leans toward
// abstaining. An abstention costs one prompt; a wrong approval costs whatever
// the command does.
//
// OBSERVE IS THE DEFAULT, and the hook command is identical in both modes. The
// mode lives in its own file under ~/.ai-acolyte, so flipping it never changes
// the hook definition. That matters for Codex, which records trust against the
// definition's hash and skips a changed hook until it is reviewed again.
//
// THE LOG IS METADATA ONLY: product, host app, permission mode, tool name, the
// decision, an enumerated reason, structural reason codes and rule ids. A rule
// id is a source tier plus a hash of the rule text, never the text itself,
// because 14% of a measured allow list was whole verbatim commands. No command,
// argument, path, description or transcript content is written.
//
// Paths are resolved per call from `options.home`, never from a module-level
// constant, so a test with a temporary home cannot read or write the real one.

const fs = require('fs');
const os = require('os');
const path = require('path');

const { coversPermission } = require('./managed-policy');
const { splitCommandSegments, extractInvocations } = require('./auto-learn');
const { fnv1a32 } = require('./fixed-point-cache');

const HOOK_EVENT = 'PermissionRequest';
const PRODUCTS = new Set(['claude', 'codex']);
const MODES = new Set(['observe', 'approve']);
const STATE_DIR = '.ai-acolyte';
const MODE_FILE = 'permission-request-mode.json';
const LOG_FILE = 'permission-request.jsonl';
// One rotation, no more: the log is a measurement, not an archive, and an
// unbounded file on a path that runs before every prompt is a slow leak.
const LOG_ROTATE_BYTES = 1024 * 1024;

// The permission modes in which an approval may be emitted at all.
//
// auto is excluded on an argument, not a guess. Auto mode evaluates deny, ask
// and allow BEFORE its classifier, so any allow rule it actually loaded would
// have approved the call with no dialog. A dialog in auto mode with an allow
// rule matching here therefore means the product chose not to honour that
// rule: an interpreter grant it discards at load, an ask, or a safety check.
// None of those is friction a rules-based hook should remove. plan, dontAsk and
// bypassPermissions have their own semantics and no measured case, so they
// abstain too until one exists.
const APPROVE_PERMISSION_MODES = new Set(['default', 'acceptEdits']);

const COMMAND_TOOLS = new Map([['Bash', 'bash'], ['PowerShell', 'powershell']]);

// Classifier reason codes (src/auto-learn.js) that bar an approval even when
// every segment matches an allow rule. A trailing `*` admits shell syntax as
// readily as arguments, so `Bash(echo *)` matches `echo x > anywhere`; the
// product's own checks catch that kind of call and prompt, and this list is
// what stops the hook from undoing them.
const STRUCTURE_BARS = new Set([
  'dynamic-executable', 'environment-prefix', 'missing-command-root',
  'path-executable', 'powershell-call-operator', 'quoted-executable',
  'reserved-keyword', 'script-syntax', 'shell-structure', 'shell-wrapper',
  'shell-wrapper-option', 'stripped-wrapper', 'trailing-wildcard', 'write-redirection',
]);
// Risk classes that bar an approval for the same reason: a product check
// ("Remove-Item on system paths") is likeliest to be what raised the dialog.
const RISK_BARS = new Set(['admin', 'credential', 'destructive', 'shell']);

function homeOf(options = {}) {
  return path.resolve(options.home === undefined ? os.homedir() : options.home);
}

function statePaths(options = {}) {
  const dir = path.join(homeOf(options), STATE_DIR);
  return { dir, mode: path.join(dir, MODE_FILE), log: path.join(dir, LOG_FILE) };
}

// ── mode ──────────────────────────────────────────────────────────────────────

// observe unless the file says exactly approve. An unreadable, half-written or
// unexpected file is observe, never approve: the failure direction is "asks".
function readHookMode(options = {}) {
  const file = statePaths(options).mode;
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (error) {
    return { mode: 'observe', source: error.code === 'ENOENT' ? 'default' : 'unreadable', path: file };
  }
  try {
    const parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
    if (parsed && parsed.mode === 'approve') return { mode: 'approve', source: 'file', path: file };
    if (parsed && parsed.mode === 'observe') return { mode: 'observe', source: 'file', path: file };
  } catch { /* fall through */ }
  return { mode: 'observe', source: 'invalid', path: file };
}

function setHookMode(mode, options = {}) {
  if (!MODES.has(mode)) throw new Error('mode must be observe or approve');
  const { writeFileAtomicSync } = require('./permissions');
  const paths = statePaths(options);
  fs.mkdirSync(paths.dir, { recursive: true });
  const before = readHookMode(options);
  writeFileAtomicSync(paths.mode, `${JSON.stringify({ mode }, null, 2)}\n`);
  const after = readHookMode(options);
  if (after.mode !== mode) throw new Error('the mode file did not retain the requested mode');
  return { mode, changed: before.mode !== mode || before.source !== 'file', path: paths.mode };
}

// ── Claude rules ──────────────────────────────────────────────────────────────

// Absent is normal; anything else that stops a read is "unreadable", and an
// unreadable source makes the hook abstain rather than evaluate a partial set.
function readSettingsFile(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (error) { return error.code === 'ENOENT' ? { absent: true } : { unreadable: true }; }
  try {
    const parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { unreadable: true };
    return { settings: parsed };
  } catch { return { unreadable: true }; }
}

function managedSettingsFiles(platform = process.platform) {
  if (platform === 'win32') {
    return [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'ClaudeCode', 'managed-settings.json')];
  }
  if (platform === 'darwin') return ['/Library/Application Support/ClaudeCode/managed-settings.json'];
  return ['/etc/claude-code/managed-settings.json'];
}

function samePath(left, right) {
  const a = path.resolve(left), b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

// The merged rule set, as tagged entries. Deny and ask are read from MORE
// places than allow, on purpose: missing an ask is how the hook would approve a
// call the product asked about because of a rule, while missing an allow only
// costs a prompt.
//
//   allow      user settings.json, managed, and the two project files at cwd
//   deny, ask  all of those, plus ~/.claude/settings.local.json and the two
//              project files of every ANCESTOR of cwd
//
// Ancestors because the event's cwd is where the shell is now, and the project
// whose settings the product loaded may sit above it after a `cd`.
function loadClaudeRules(options = {}) {
  const home = homeOf(options);
  const claudeDir = path.join(home, '.claude');
  const sources = [
    { tier: 'user', file: path.join(claudeDir, 'settings.json'), kinds: ['deny', 'ask', 'allow'] },
    { tier: 'user-local', file: path.join(claudeDir, 'settings.local.json'), kinds: ['deny', 'ask'] },
    { tier: 'managed', file: options.remoteSettingsPath || path.join(claudeDir, 'remote-settings.json'), kinds: ['deny', 'ask', 'allow'] },
  ];
  for (const file of options.managedSettingsFiles || managedSettingsFiles()) {
    sources.push({ tier: 'managed-file', file, kinds: ['deny', 'ask', 'allow'] });
  }
  const cwd = typeof options.cwd === 'string' && path.isAbsolute(options.cwd) ? path.resolve(options.cwd) : null;
  // `stopAt` ends the walk at a directory, inclusive. Production passes none and
  // walks to the root; a test passes its temporary home, so the developer's own
  // settings above the temp directory cannot change a verdict.
  const stopAt = typeof options.stopAt === 'string' ? path.resolve(options.stopAt) : null;
  if (cwd) {
    for (let dir = cwd, depth = 0; depth < 64; depth += 1) {
      const kinds = dir === cwd ? ['deny', 'ask', 'allow'] : ['deny', 'ask'];
      for (const [tier, name] of [['project', 'settings.json'], ['project-local', 'settings.local.json']]) {
        const file = path.join(dir, '.claude', name);
        if (sources.some((source) => samePath(source.file, file))) continue;
        sources.push({ tier, file, kinds });
      }
      const parent = path.dirname(dir);
      if (parent === dir || (stopAt && samePath(dir, stopAt))) break;
      dir = parent;
    }
  }
  const rules = { deny: [], ask: [], allow: [] };
  const unreadable = [];
  let loaded = 0;
  for (const source of sources) {
    const read = readSettingsFile(source.file);
    if (read.absent) continue;
    if (read.unreadable) { unreadable.push(source.tier); continue; }
    loaded += 1;
    const permissions = read.settings.permissions;
    if (!permissions || typeof permissions !== 'object') continue;
    for (const kind of source.kinds) {
      const list = permissions[kind];
      // A non-array deny or ask is still a stated boundary this cannot parse.
      if (list !== undefined && !Array.isArray(list)) {
        if (kind !== 'allow') unreadable.push(source.tier);
        continue;
      }
      for (const rule of list || []) {
        if (typeof rule === 'string' && rule.trim()) rules[kind].push({ rule: rule.trim(), tier: source.tier });
      }
    }
  }
  return { rules, unreadable: [...new Set(unreadable)], loaded };
}

function ruleId(entry, kind) {
  return `${entry.tier}:${kind}:${fnv1a32(entry.rule)}`;
}

// deny and ask also try the other command tool and a case fold: PowerShell is
// case-insensitive and `rm` is a PowerShell alias, so a boundary written for
// one spelling should still stop this hook for the other. Allow does neither.
function foldSpecifier(rule) {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)\(([\s\S]*)\)$/.exec(rule);
  return match ? `${match[1]}(${match[2].toLowerCase()})` : rule;
}

function blockingMatch(list, text) {
  const probes = [];
  for (const name of COMMAND_TOOLS.keys()) probes.push(`${name}(${text})`, `${name}(${text.toLowerCase()})`);
  for (const entry of list) {
    const folded = foldSpecifier(entry.rule);
    for (const probe of probes) {
      if (coversPermission(entry.rule, probe) || coversPermission(folded, probe)) return entry;
    }
  }
  return null;
}

function allowMatch(list, tool, text) {
  const probe = `${tool}(${text})`;
  return list.find((entry) => coversPermission(entry.rule, probe)) || null;
}

// Segments as the product splits them, each with the classifier's verdict. A
// segment the classifier yields no invocation for (a bare assignment, an
// operator fragment) makes the whole command unparsed: the counts must agree.
function shellSegments(tool, command) {
  const shell = COMMAND_TOOLS.get(tool);
  const segments = splitCommandSegments(command, shell).map((value) => value.trim()).filter(Boolean);
  const invocations = extractInvocations(tool, command, { shell });
  if (!segments.length || invocations.length !== segments.length) return null;
  return segments.map((text, index) => ({ text, invocation: invocations[index] }));
}

function structureCodes(invocations) {
  const codes = new Set();
  for (const invocation of invocations) {
    for (const reason of invocation.reasons || []) if (STRUCTURE_BARS.has(reason)) codes.add(reason);
    if (RISK_BARS.has(invocation.risk)) codes.add(`risk-${invocation.risk}`);
  }
  return [...codes].sort();
}

// The verdict of the merged rules, deny then ask then allow, the most
// restrictive part winning. Independent of permission mode and hook mode, so
// the measurement and the hook can report the same thing.
function claudeVerdict(event, loaded) {
  const tool = String(event?.tool_name || '');
  if (!COMMAND_TOOLS.has(tool)) return { verdict: 'unsupported', tool };
  const command = event?.tool_input && typeof event.tool_input.command === 'string'
    ? event.tool_input.command : '';
  if (!command.trim()) return { verdict: 'unparsed', tool, segments: 0 };
  const { rules } = loaded;
  const whole = command.trim();
  const segments = shellSegments(tool, command);
  const probes = [whole, ...(segments || []).map((segment) => segment.text)];
  for (const text of probes) {
    const deny = blockingMatch(rules.deny, text);
    if (deny) return { verdict: 'deny', tool, segments: segments ? segments.length : 0, ruleIds: [ruleId(deny, 'deny')] };
  }
  for (const text of probes) {
    const ask = blockingMatch(rules.ask, text);
    if (ask) return { verdict: 'ask', tool, segments: segments ? segments.length : 0, ruleIds: [ruleId(ask, 'ask')] };
  }
  if (!segments) return { verdict: 'unparsed', tool, segments: 0 };
  const ids = [];
  for (const segment of segments) {
    const allow = allowMatch(rules.allow, tool, segment.text);
    if (!allow) return { verdict: 'none', tool, segments: segments.length };
    ids.push(ruleId(allow, 'allow'));
  }
  return {
    verdict: 'allow', tool, segments: segments.length, ruleIds: [...new Set(ids)],
    structure: structureCodes(segments.map((segment) => segment.invocation)),
  };
}

// ── Codex rules ───────────────────────────────────────────────────────────────

function loadCodexRules(options = {}) {
  const { resolveCodexHome } = require('./codex-paths');
  const { codexRuleFileSet, readEnterpriseBundle, enterprisePrefixRuleHealth } = require('./codex-policy');
  const { parseCodexRules } = require('./codex-rule-inventory');
  const codexHome = resolveCodexHome(options);
  const set = codexRuleFileSet({ codexHome });
  const rules = [];
  const unreadable = set.failures.map(() => 'rules-dir');
  for (const file of set.files) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); }
    catch { unreadable.push('rules-file'); continue; }
    const parsed = parseCodexRules(text);
    // Computed Starlark is read-only everywhere else in this repo; here it means
    // a rule exists that this hook cannot see, so it abstains.
    if (!parsed.supported) { unreadable.push('rules-file'); continue; }
    const name = path.basename(file).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 60);
    for (const rule of parsed.rules) {
      rules.push({ decision: rule.decision || 'allow', pattern: rule.pattern, tier: `rules:${name}`,
        text: JSON.stringify(rule.pattern) });
    }
  }
  const bundlePath = path.join(codexHome, 'cloud-config-bundle-cache.json');
  const bundle = fs.existsSync(bundlePath) ? readEnterpriseBundle(bundlePath) : null;
  if (fs.existsSync(bundlePath) && !bundle) unreadable.push('managed-bundle');
  if (bundle && enterprisePrefixRuleHealth(bundle).degraded) unreadable.push('managed-bundle');
  return { rules, bundle, unreadable: [...new Set(unreadable)] };
}

function normalizedRoot(token) {
  return path.basename(String(token).replace(/\\/g, '/')).toLowerCase().replace(/\.exe$/, '');
}

function codexPositionMatches(position, token, isRoot, loose) {
  if (token === undefined) return false;
  const values = Array.isArray(position) ? position : [position];
  if (isRoot && loose) return values.some((value) => normalizedRoot(value) === normalizedRoot(token));
  return values.includes(token);
}

function codexRuleMatches(rule, argv, loose) {
  if (!Array.isArray(rule.pattern) || argv.length < rule.pattern.length) return false;
  return rule.pattern.every((position, index) => codexPositionMatches(position, argv[index], index === 0, loose));
}

// Codex hands the hook the command string it is about to run. A plain
// `bash -lc '<script>'` or `powershell -Command '<script>'` wrapper is unwrapped
// once, the same shape Codex's own policy check unwraps; anything else stays a
// wrapper, and a wrapper is structure.
const WRAPPER_SHELLS = new Map([['bash', ['-lc', '-c']], ['sh', ['-c', '-lc']], ['zsh', ['-lc', '-c']],
  ['powershell', ['-command', '-c']], ['pwsh', ['-command', '-c']]]);
const POWERSHELL_PREAMBLE = new Set(['-noprofile', '-nologo', '-noninteractive']);

function unwrapCodexCommand(command, platformShell) {
  const { tokenizeCommand } = require('./auto-learn');
  // Operators come back as tokens too, so a wrapper followed by `&& more` has
  // the wrong count below and is never unwrapped.
  const values = tokenizeCommand(command, platformShell).map(String);
  if (values.length < 3) return { script: command, shell: platformShell, unwrapped: false };
  const root = normalizedRoot(values[0]);
  const flags = WRAPPER_SHELLS.get(root);
  if (!flags) return { script: command, shell: platformShell, unwrapped: false };
  let index = 1;
  const shell = root === 'powershell' || root === 'pwsh' ? 'powershell' : 'bash';
  while (shell === 'powershell' && index < values.length && POWERSHELL_PREAMBLE.has(values[index].toLowerCase())) index += 1;
  if (index + 2 !== values.length || !flags.includes(values[index].toLowerCase())) {
    return { script: command, shell: platformShell, unwrapped: false };
  }
  return { script: values[index + 1], shell, unwrapped: true };
}

function codexVerdict(event, loaded, options = {}) {
  const tool = String(event?.tool_name || '');
  if (tool !== 'Bash') return { verdict: 'unsupported', tool };
  const raw = event?.tool_input?.command;
  const command = Array.isArray(raw) ? raw.map(String).join(' ') : typeof raw === 'string' ? raw : '';
  if (!command.trim()) return { verdict: 'unparsed', tool, segments: 0 };
  const platformShell = options.platform === 'win32' || (options.platform === undefined && process.platform === 'win32')
    ? 'powershell' : 'bash';
  const unwrap = unwrapCodexCommand(command, platformShell);
  const permissionTool = unwrap.shell === 'powershell' ? 'PowerShell' : 'Bash';
  const segments = shellSegments(permissionTool, unwrap.script);
  if (!segments) return { verdict: 'unparsed', tool, segments: 0, unwrapped: unwrap.unwrapped };
  const argvs = segments.map((segment) => segment.invocation.argv.map(String));
  const { enterprisePolicyAssessment } = require('./codex-policy');
  for (const argv of argvs) {
    const harsh = loaded.rules.find((rule) => rule.decision !== 'allow' && codexRuleMatches(rule, argv, true));
    if (harsh) {
      return { verdict: harsh.decision === 'forbidden' ? 'deny' : 'ask', tool, segments: segments.length,
        unwrapped: unwrap.unwrapped, ruleIds: [`${harsh.tier}:${harsh.decision}:${fnv1a32(harsh.text)}`] };
    }
    if (loaded.bundle) {
      const managed = enterprisePolicyAssessment(loaded.bundle, argv).match;
      if (managed && managed.decision !== 'allow') {
        return { verdict: managed.decision === 'forbidden' ? 'deny' : 'ask', tool, segments: segments.length,
          unwrapped: unwrap.unwrapped, ruleIds: [`managed:${managed.decision}:line${managed.line}`] };
      }
    }
  }
  const ids = [];
  for (const argv of argvs) {
    const allow = loaded.rules.find((rule) => rule.decision === 'allow' && codexRuleMatches(rule, argv, false));
    if (!allow) return { verdict: 'none', tool, segments: segments.length, unwrapped: unwrap.unwrapped };
    ids.push(`${allow.tier}:allow:${fnv1a32(allow.text)}`);
  }
  const structure = structureCodes(segments.map((segment) => segment.invocation));
  // Codex's own check splits only simple bash scripts; a compound here is a
  // shape this hook has no measured Codex evidence for.
  if (segments.length > 1) structure.push('compound-command');
  return { verdict: 'allow', tool, segments: segments.length, unwrapped: unwrap.unwrapped,
    ruleIds: [...new Set(ids)], structure };
}

// A managed-network approval is a second gate with its own allowlist. A prefix
// rule says nothing about it, so a request that names the network is left to
// the person. The description is free text and is tested, never logged.
function mentionsNetwork(event) {
  const description = event?.tool_input?.description;
  return typeof description === 'string' && /\bnetwork\b/i.test(description);
}

// ── the decision ──────────────────────────────────────────────────────────────

// Turn a verdict into the hook's decision. `allow` here means "the rules and
// every gate agree"; whether that is emitted is the hook mode's business.
function decide(product, event, loaded, options = {}) {
  const permissionMode = enumValue(event?.permission_mode, 'unknown');
  const base = { product, permissionMode, tool: enumValue(event?.tool_name, 'unknown', 80) };
  if (event?.hook_event_name !== HOOK_EVENT) return { ...base, decision: 'abstain', reason: 'wrong-event', verdict: 'n/a' };
  if (loaded.unreadable.length) {
    return { ...base, decision: 'abstain', reason: 'rules-unreadable', verdict: 'n/a', unreadable: loaded.unreadable };
  }
  const result = product === 'codex' ? codexVerdict(event, loaded, options) : claudeVerdict(event, loaded);
  const out = { ...base, verdict: result.verdict, segments: result.segments || 0, ruleIds: result.ruleIds || [],
    structure: result.structure || [] };
  if (result.unwrapped) out.unwrapped = true;
  const abstain = (reason) => ({ ...out, decision: 'abstain', reason });
  if (result.verdict === 'unsupported') return abstain('unsupported-tool');
  if (result.verdict === 'unparsed') return abstain('unparsed');
  if (result.verdict === 'deny') return abstain('deny-rule');
  if (result.verdict === 'ask') return abstain('ask-rule');
  if (result.verdict === 'none') return abstain('no-allow-rule');
  if (out.structure.length) return abstain('structure');
  if (product === 'codex' && mentionsNetwork(event)) return abstain('network-approval');
  if (!APPROVE_PERMISSION_MODES.has(permissionMode)) return abstain('permission-mode');
  return { ...out, decision: 'allow', reason: 'rules-allow' };
}

// ── host ──────────────────────────────────────────────────────────────────────

function enumValue(value, fallback, max = 40) {
  const text = typeof value === 'string' ? value.trim() : '';
  return new RegExp(`^[A-Za-z0-9 _.:-]{1,${max}}$`).test(text) ? text : fallback;
}

function readSlice(file, fromEnd, bytes) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const length = Math.min(bytes, size);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, fromEnd ? size - length : 0);
    return buffer.toString('utf8');
  } catch { return ''; }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* closed */ } }
}

// Which app is waiting. Claude Code exports CLAUDE_CODE_ENTRYPOINT to its own
// process; when a hook does not inherit it, the transcript's newest records
// carry the same `entrypoint` value. Codex writes its originator on the first
// line of the rollout. Only an enum-shaped value is ever kept.
function hostOf(product, event, env = process.env) {
  if (product === 'claude') {
    const fromEnv = enumValue(env.CLAUDE_CODE_ENTRYPOINT, null);
    if (fromEnv) return fromEnv;
    const file = typeof event?.transcript_path === 'string' ? event.transcript_path : '';
    const matches = file ? [...readSlice(file, true, 64 * 1024).matchAll(/"entrypoint":"([^"]{1,40})"/g)] : [];
    return matches.length ? enumValue(matches[matches.length - 1][1], 'unknown') : 'unknown';
  }
  const fromEnv = enumValue(env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE, null);
  if (fromEnv) return fromEnv;
  const file = typeof event?.transcript_path === 'string' ? event.transcript_path : '';
  const match = file ? /"originator":"([^"]{1,40})"/.exec(readSlice(file, false, 256 * 1024)) : null;
  return match ? enumValue(match[1], 'unknown') : 'unknown';
}

// ── log ───────────────────────────────────────────────────────────────────────

function appendLog(entry, options = {}) {
  const paths = statePaths(options);
  fs.mkdirSync(paths.dir, { recursive: true });
  try {
    if (fs.statSync(paths.log).size > LOG_ROTATE_BYTES) fs.renameSync(paths.log, `${paths.log}.1`);
  } catch { /* absent, or another hook rotated it first */ }
  fs.appendFileSync(paths.log, `${JSON.stringify(entry)}\n`, 'utf8');
  return paths.log;
}

// Every field is chosen, none is copied wholesale from the event, so a new
// event field can never reach the log by accident.
function logEntry(result, context) {
  const entry = {
    v: 1, ts: context.ts, product: result.product, host: context.host, mode: context.mode,
    permissionMode: result.permissionMode, tool: result.tool, decision: context.decision,
    reason: result.reason, verdict: result.verdict, segments: result.segments || 0,
    rules: (result.ruleIds || []).slice(0, 16), structure: result.structure || [],
  };
  if (result.unwrapped) entry.unwrapped = true;
  if (result.unreadable) entry.unreadable = result.unreadable;
  if (context.agent) entry.subagent = true;
  if (context.error) entry.error = context.error;
  if (typeof context.ms === 'number') entry.ms = Math.round(context.ms * 10) / 10;
  return entry;
}

const ALLOW_OUTPUT = JSON.stringify({
  hookSpecificOutput: { hookEventName: HOOK_EVENT, decision: { behavior: 'allow' } },
});

// The whole hook, minus stdin. Returns what to print (null means print
// nothing, which leaves the product's own dialog in place) and the log entry.
// It never throws: any failure is an abstention, logged with its error class.
function runPermissionRequest(product, input, options = {}) {
  const started = process.hrtime.bigint();
  const ts = (options.now ? options.now() : new Date()).toISOString();
  let event = null;
  let result;
  let error = null;
  try {
    if (!PRODUCTS.has(product)) throw new Error('unknown product');
    if (options.oversized) {
      const oversized = new Error('the event exceeded the stdin cap');
      oversized.code = 'oversized-event';
      throw oversized;
    }
    event = typeof input === 'string' ? JSON.parse(input) : input;
    if (!event || typeof event !== 'object' || Array.isArray(event)) throw new TypeError('event is not an object');
    const loaded = product === 'codex'
      ? loadCodexRules({ home: options.home, codexHome: options.codexHome })
      : loadClaudeRules({ home: options.home, cwd: event.cwd, stopAt: options.stopAt,
        remoteSettingsPath: options.remoteSettingsPath, managedSettingsFiles: options.managedSettingsFiles });
    result = decide(product, event, loaded, options);
  } catch (caught) {
    error = enumValue(caught && (caught.code || caught.name), 'Error');
    result = { product: PRODUCTS.has(product) ? product : 'unknown', permissionMode: enumValue(event?.permission_mode, 'unknown'),
      tool: enumValue(event?.tool_name, 'unknown', 80), decision: 'abstain', reason: 'error', verdict: 'n/a' };
  }
  const mode = readHookMode(options).mode;
  const approve = result.decision === 'allow' && mode === 'approve';
  const decision = result.decision !== 'allow' ? 'abstain' : approve ? 'approved' : 'would-approve';
  let host = 'unknown';
  try { host = hostOf(result.product, event, options.env || process.env); } catch { /* unknown */ }
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  const entry = logEntry(result, { ts, host, mode, decision, error, ms,
    agent: Boolean(event && (event.agent_id || event.agent_type)) });
  return { output: approve ? ALLOW_OUTPUT : null, entry };
}

// ── report ────────────────────────────────────────────────────────────────────

function readLogEntries(options = {}) {
  const paths = statePaths(options);
  const entries = [];
  let malformed = 0;
  for (const file of [`${paths.log}.1`, paths.log]) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { entries.push(JSON.parse(line)); } catch { malformed += 1; }
    }
  }
  return { entries, malformed, path: paths.log };
}

function tally(map, key) { map[key] = (map[key] || 0) + 1; }

// Grouped by product and host app, because "does it fire at all in this app"
// is the first question the log answers and a pooled total hides it.
function summarizeLog(options = {}) {
  const { entries, malformed, path: logPath } = readLogEntries(options);
  const groups = new Map();
  for (const entry of entries) {
    const key = `${entry.product || 'unknown'} / ${entry.host || 'unknown'}`;
    if (!groups.has(key)) {
      groups.set(key, { product: entry.product, host: entry.host, total: 0, decisions: {}, reasons: {},
        verdicts: {}, permissionModes: {}, tools: {}, structure: {}, rules: {}, first: entry.ts, last: entry.ts, ms: [] });
    }
    const group = groups.get(key);
    group.total += 1;
    tally(group.decisions, entry.decision);
    tally(group.reasons, entry.reason);
    tally(group.verdicts, entry.verdict);
    tally(group.permissionModes, entry.permissionMode);
    tally(group.tools, entry.tool);
    for (const code of entry.structure || []) tally(group.structure, code);
    for (const id of entry.rules || []) tally(group.rules, id);
    if (entry.ts < group.first) group.first = entry.ts;
    if (entry.ts > group.last) group.last = entry.ts;
    if (typeof entry.ms === 'number') group.ms.push(entry.ms);
  }
  const summary = [...groups.values()].map((group) => {
    const ms = group.ms.sort((a, b) => a - b);
    const { ms: _ms, ...rest } = group;
    return { ...rest, msP50: ms.length ? ms[Math.floor(ms.length / 2)] : null, msMax: ms.length ? ms[ms.length - 1] : null };
  });
  return { path: logPath, entries: entries.length, malformed, mode: readHookMode(options), groups: summary };
}

function formatSummary(summary) {
  const lines = [`permission-request log: ${summary.entries} entries (${summary.path})`
    + `${summary.malformed ? `, ${summary.malformed} malformed lines skipped` : ''}`,
  `mode: ${summary.mode.mode} (${summary.mode.source})`];
  if (!summary.groups.length) {
    lines.push('no PermissionRequest has been logged yet. Either no prompt has appeared since the hook was',
      'installed, or the host app does not run it (a managed policy can drop user hooks per event).');
  }
  const top = (counts, limit = 8) => Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, limit)
    .map(([key, value]) => `${key} ${value}`).join(', ') || '-';
  for (const group of summary.groups) {
    lines.push('', `${group.product} / ${group.host}: ${group.total} prompt(s), ${group.first} .. ${group.last}`,
      `  decisions: ${top(group.decisions)}`,
      `  reasons:   ${top(group.reasons)}`,
      `  verdicts:  ${top(group.verdicts)}`,
      `  modes:     ${top(group.permissionModes)}`,
      `  tools:     ${top(group.tools)}`);
    if (Object.keys(group.structure).length) lines.push(`  structure: ${top(group.structure)}`);
    if (Object.keys(group.rules).length) lines.push(`  rule ids:  ${top(group.rules, 5)}`);
    if (group.msP50 !== null) lines.push(`  hook time: p50 ${group.msP50} ms, max ${group.msMax} ms (in-process, excludes node start)`);
  }
  return `${lines.join('\n')}\n`;
}

module.exports = {
  readHookMode, setHookMode,
  loadClaudeRules, loadCodexRules, decide,
  runPermissionRequest, appendLog,
  summarizeLog, formatSummary,
};
