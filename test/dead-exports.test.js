'use strict';

// An export entry with no importer.
//
// It costs nothing to keep and quite a lot to trust: it advertises a function as part of a
// module's contract when nobody has ever called it through that door, so the first caller
// to use it is also the first to exercise it. Removing the EXPORT is free; removing the
// FUNCTION is not, and this repo already records the difference — `fastLint` and
// `pickPrimaryDir` look identical from a production-import scan and are test-only rather
// than dead, and their test calls are the mutation-killing assertions for the line cap and
// the store-selection rule.
//
// So this file does not say "nothing uses it". For every name every module exports it says
// which of three states it is in, and each state has to be declared:
//
//   consumed      a file outside test/ uses it. Nothing to declare.
//   test-only     only test/ uses it. Declared in TEST_ONLY, per module.
//   no consumer   nobody uses it at all. Declared in HELD or in PENDING_REMOVAL.
//
// THE CENSUS USED TO COVER THREE MODULES. src/recall-index.js, src/tool-learn.js and
// vscode-extension/memoryLint.js — so a dead export removed from src/auto-learn-manager.js
// was invisible to it, and nothing stopped it coming back. It now covers every module in
// src/ and vscode-extension/, and since 2026-10-14 every top-level module in scripts/ that
// exports anything: the v1.6.2 audit found five dead exports there that nothing could see,
// because scripts/ was read only as a CONSUMER. A script's export counts as consumed by
// another script, a test, or a doc (a recipe in a .md may call one); the subdirectories
// hold VS Code test-runner entry points, loaded by path, which no scan can follow.
//
// AND THE METHOD MATTERS. A destructure-only scan is wrong here and was already disproven:
// bin/wildcard-perms does `const cache = require('../src/fixed-point-cache')` and then
// reaches members off it on the hook's hot path, so a scan that only reads
// `const { a, b } = require(...)` calls every one of that module's exports dead. Four
// consumer shapes are counted: destructured require (or `await import`), namespace alias
// plus member access, `require(...).name` inline, and an ESM named import. The module
// can be named by a string literal, by a path.join/resolve or pathToFileURL whose pieces
// end in it (`require(path.join(extensionDir, 'src', 'history-adapters.js'))`), or by a
// const holding such a path (`const SCRIPT = path.join(...); require(SCRIPT)`).
//
// AN IMPORT IS NOT A USE (2026-10-14, the v1.6.2 audit). vscode-extension/extension.js
// destructured SETTINGS_ABSENT from src/settings-write.js and never referenced it again
// (since 000e5b0), and that unused binding was the only thing calling the export
// "consumed". A destructured or named import now counts only when its LOCAL name occurs
// again in the importing file, outside the import itself and outside comments.
//
// AND THE TREE IS GIT'S, not the disk's (also 2026-10-14). The walk this replaced read the
// gitignored vscode-extension/src/ that scripts/package.mjs stages, so on a box that had
// packaged, a stale staged copy still importing a name counted as its consumer: a dead
// export passed here and failed on CI, where no such copy exists.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const TEST_DIR = path.join(ROOT, 'test') + path.sep;

// Held on purpose, and structurally: these have no consumer a static scan can find and
// never will. The key is the export; the value is why, and is printed on failure.
//
// 2026-10-14: pickPrimaryDir, and extension.js's activate and deactivate, left this list
// for TEST_ONLY, because the census now follows a require through a path.join and so sees
// the tests that load them that way. fastLint is still reached only through a loader that
// takes the module path as an argument.
const HELD = {
  'vscode-extension/memoryLint.js': {
    fastLint:
      'test-only, not dead, and invisible here: test/memory-line-cap.test.js reaches it '
      + 'through loadLint(), which re-requires the module by resolved path, so no require '
      + 'site names it. Those calls are what make the line-cap off-by-one falsifiable.',
  },
};

// Found with no consumer at all by this census on 2026-09-24, when it was widened past its
// original three modules. Each is a dead EXPORT over a live function — every one of them is
// called from inside its own module, which is why nothing else noticed.
//
// THE FIX IS NOT ALWAYS THE DELETION, and finding that out costs one suite run per name.
// Break the FUNCTION and see whether anything dies. If something does, the export was the
// only surplus and it goes, function intact. If nothing does, the name is not dead weight
// at all — it is a behaviour with no test, and deleting the export removes the last seam
// anyone could write one through. See the record below this list for the thirteen names
// that went through exactly that on 2026-09-25, and the two that came back.
//
// This list is DEBT, not an allowlist. It is separate from HELD so that it reads as one, and
// so that emptying it is a visible event. A name here that gains a consumer must leave it:
// the per-module assertion below compares the whole set, in both directions.
//
// EMPTIED 2026-10-13. The last entry was CODEX_BUNDLE_CACHE in src/codex-policy.js, cited
// at :71 and :12 when the constant sat at :11 and its one use, the default argument of
// readEnterpriseBundle, at :13. Mutation first, per the rule above: renaming the cache
// file in the constant failed "the active profile supplies the managed cache and manager
// default history and policy paths" in test/codex-home-routing.test.js, which reaches it
// through that default. So the export was the only surplus; it went, the constant stayed.
const PENDING_REMOVAL = {};

// WHAT HAPPENED TO THE OTHER THIRTEEN, 2026-09-25. They were not swept. Each one was
// mutated in place and the whole suite run against it, because "no importer" and "no
// coverage" are different findings and only one of them is fixed by a deletion.
//
// ELEVEN DIED, so the export was the only thing keeping them visible and the export
// went: LEGACY_ALLOW_MARKERS (4 tests), LEGACY_APPROVE_MARKER (1), LEGACY_APPROVE_SCRIPT
// (2), detectMcpServers (3), legacyAllowActive (4), legacyApproveHookActive (2),
// legacyApproveHookLike (1), topLevelBound (1), prunePermissions (4),
// candidateAppliedTargets (1), unwrapApplication (1). Functions kept, doors closed.
//
// TWO SURVIVED, and a survivor is a coverage gap. `readBypassState` mutated to
// `return {}` left 696/694 green, because nothing in the repository ever turned the
// bypass toggle OFF; `candidateEligibleTargets` mutated to ignore the candidate
// entirely did the same, because every fixture that reaches it carries a
// `pendingTargets` array that short-circuits the branch. Both now have a test and both
// moved to TEST_ONLY below. That is the second and third time this week the answer to a
// "dead" name was a test rather than a deletion, which is why the mutation step is not
// optional before emptying a line of this list.

// Exports whose only consumers are under test/. Not a defect — a test-only export is
// usually the seam that makes a unit assertion able to fail — but enumerated, so that
// adding one is a deliberate act and so that a name QUIETLY losing its last production
// caller shows up here instead of looking unchanged.
const TEST_ONLY = {
  // 2026-10-16, both new. rule-usage.js: production enters through countOffThread (the thread
  // runs countRuleUsage inside the module) and summarizeRuleUsage; these are the seams
  // test/rule-usage.test.js uses to hold the index to a full scan, pin the crediting rules and
  // drive a pass with an injected scanner. agent-sessions.js: the tests age fixtures by the window.
  'src/rule-usage.js': ['analyzeRuleUsage', 'countRuleUsage', 'createRuleIndex', 'creditsFor', 'probesFor', 'ruleKey', 'trackedRule'],
  'src/agent-sessions.js': ['WINDOW_MS'],
  // 2026-10-14: agent-gates.js left this list, and agent-guidance.js, derived-guidance.js
  // and history-adapters.js shrank, when the census learned to follow a require through a
  // path.join. scripts/check-codex-runtime.js and scripts/vscode-acceptance/ load the STAGED
  // copies of these modules that way (`require(path.join(extensionDir, 'src', ...))`),
  // and nothing used to see them.
  'src/agent-guidance.js': ['guidanceBlock', 'guidanceStatus', 'instructionLockPath', 'setGuidance'],
  // readCompiled joined 2026-10-14: the dashboard's gate count now rides on gatesStatusAll's
  // per-agent rows, so extension.js no longer reads the compiled file a second time.
  'src/agent-gates.js': ['readCompiled'],
  'src/auto-learn-manager.js': ['migrateStateTo'],
  'src/auto-learn-worker.js': ['run'],
  // These are exercised inside their own production modules; exporting them
  // lets tests pin command quoting and the standalone stdin adapter separately.
  'src/codex-hook-config.js': ['codexStopHookDefinition'],
  'src/codex-stop-hook.js': ['runCodexStopHook'],
  // Production wraps this read-only primitive in the reviewed proposal API.
  'src/codex-mcp-config.js': ['inspectCodexMcpTool'],
  // classifyInvocation came off 2026-10-13: src/permission-summary.js
  // overBroadShellGrants calls it for a wildcard head that has no invocation at all.
  // splitCommandSegments came off 2026-10-16: src/rule-usage.js splits each counted call with it.
  'src/auto-learn.js': ['AUTO_SAFE_GIT', 'AUTO_SUFFIX_CLOSED_ROOTS', 'BASH_RESERVED', 'POWERSHELL_RESERVED', 'isLearnableTool', 'tokenizeCommand', 'toolInvocation'],
  // enterpriseDecisionFor and enterprisePrefixRuleHealth lost their last production
  // consumer when the managed-requirements parser was rewritten on 2026-09-24:
  // production now asks enterprisePolicyAssessment, which answers with the degraded
  // state as well as the decision. Both are kept as a stable surface and both are
  // exercised; this census is what noticed, on the merge.
  'src/codex-policy.js': ['allowedSandboxModes', 'enterpriseDecisionFor', 'enterprisePrefixRules', 'enterpriseRequirements'],
  'src/derived-guidance.js': ['cleanRule', 'installedDerivedIds', 'reconcileDerived'],
  // resolveExecutable left this list 2026-10-13 (src/codex-version.js keys its cache on it); taskkillPath joined 2026-10-14 (the config worker's grace kill is endProcessTree's now).
  'src/exec-resolve.js': ['quoteForCommandProcessor', 'taskkillPath'],
  'src/fixed-point-cache.js': ['CACHE_VERSION', 'cachePath', 'codeFiles', 'fnv1a32', 'readFixedPoint'],
  'src/history-adapters.js': ['READ_CHUNK_BYTES', 'cursorKeyForFile', 'extractNestedShellCommands', 'parseClaudeJsonl'],
  'src/legacy-backup-cleanup.js': ['parseBackupText'],
  'src/legacy-max-cleanup.js': ['LEGACY_ALLOW_CORE', 'legacyApproveCommandFor', 'legacyGeneratedAllow'],
  'src/local-settings.js': ['localBackupPath', 'partitionLocal', 'planPromotions', 'promotionFor', 'redundantUnder'],
  'src/managed-policy.js': ['coversPrefix', 'hookEventAllowed', 'rulePrefix'],
  'src/permission-match.js': ['MATCH_CACHE_LIMIT', 'matchCacheStats'],
  // readBypassState joined on 2026-09-25 off PENDING_REMOVAL: see the note above that
  // list. test/bypass-round-trip.test.js is the only caller and is the whole reason the
  // `--bypass off` restore can fail a build.
  // RENAME_RETRY_ATTEMPTS and renameRetryDelayMs joined 2026-10-14: the shared rename-retry
  // budget, read inside permissions.js and held against the other writers' own numbers by
  // test/rename-retry-policy.test.js. RETRYABLE_RENAME_CODES has production importers.
  'src/permissions.js': ['RENAME_RETRY_ATTEMPTS', 'coverIndexKeyCacheStats', 'coverKeyCacheStats', 'readBypassState', 'renameRetryDelayMs'],
  // The shared Codex claims reader now consumes CODEX_BEGIN_MARKER in production.
  'src/policy-exporters.js': ['AUTO_SAFE_GIT_SUBCOMMANDS', 'AUTO_SUFFIX_CLOSED_ROOTS', 'normalizePermissionSpelling'],
  'src/policy-guard.js': ['isBulkLoss', 'managedCapabilities', 'missingFromLive', 'shadowedByManaged'],
  'src/recall-index.js': ['MEMORY_INDEX_NAME', 'RECALL_EMBED_ID', 'RECALL_INDEX_NAME', 'indexableMemories'],
  // Test-only since 2026-10-14: the extension's import of it was unused (since 000e5b0) and
  // was what made the census count it as a production consumer.
  'src/settings-write.js': ['SETTINGS_ABSENT'],
  'vscode-extension/autoLearnUi.js': ['candidateEligibleTargets', 'permissionMatches'],
  // extension.js's activate and deactivate left this list 2026-10-14: the VS Code host is their real consumer (package.json
  // `main`), and scripts/measure-push-host-thread.js now loads a tree's extension.js by path and calls both, which the
  // census counts. Before that only the lifecycle tests did, which is why they were here.
  // Off HELD 2026-10-14, same reason: test/memory-lint-watchers.test.js loads it by path.
  // gateOf joined 2026-10-14: test/gate-agents.test.js holds it to recall.py's _gate file by
  // file; in production it is called inside the module, by fullReport and the census.
  // gateEntryOf joined the same day for the same reason, held to recall.py's _gate_entry (the
  // card's retired count against the list the gates panel shows).
  'vscode-extension/memoryLint.js': ['gateEntryOf', 'gateOf', 'pickPrimaryDir'],
  // scripts/, audited as subjects since 2026-10-14. Each of these is the seam a test
  // drives a command-line tool through; the tools themselves are run by hand or by CI.
  'scripts/assert-retired-max-absent.mjs': ['assertNoRetiredMaxEntries', 'inspectVsix'],
  'scripts/auto-mode-audit.js': ['audit', 'main', 'parseArgs', 'readAllow', 'render', 'stripCredentials'],
  // check and defaultBinary moved to src/claude-strip-model.js on 2026-10-15, where the script
  // and the extension consume them; the script exports only its main.
  'scripts/check-claude-strip-model.js': ['main'],
  'scripts/check-codex-runtime.js': ['PROVENANCE_ROOTS', 'localRequireClosure'],
  'scripts/check-line-refs.js': ['anchorLines', 'anchorsFrom', 'checkBounds', 'checkVacuous', 'collectRefs', 'fixAnchored', 'isVacuousSpan', 'stripRefs', 'tracked'],
  'scripts/mirror-pack.js': ['NEVER_MIRROR', 'mirrorTargets'],
};

// The tree as git sees it, repo-relative with forward slashes: tracked files, plus new ones
// that are not ignored, so an export added and imported in a file not yet staged still
// counts. Ignored files are out, which is the point: vscode-extension/src/ and
// vscode-extension/memory/ are generated by scripts/package.mjs and can be stale. A path
// listed but gone from disk (deleted, not yet staged) is dropped. Without git, as in a
// source tarball, a walk stands in, minus the generated directories .gitignore names.
function treeFiles() {
  try {
    const out = execFileSync('git', ['-C', ROOT, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 26 });
    // An unmerged path is listed once per index stage.
    const listed = [...new Set(out.split('\0').filter(Boolean))];
    if (listed.length) return listed.filter((rel) => fs.existsSync(path.join(ROOT, rel)));
  } catch { /* not a git checkout: walk instead */ }
  const GENERATED = new Set(['vscode-extension/src', 'vscode-extension/memory']);
  const out = [];
  const walk = (rel) => {
    let entries;
    try { entries = fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git' || GENERATED.has(child)) continue;
        walk(child);
      } else out.push(child);
    }
  };
  walk('');
  return out;
}
const TREE = treeFiles();

// Every file that could plausibly consume one of these modules. bin/wildcard-perms is
// extensionless and is the highest-frequency consumer of src/ in the repo.
const FILES = TREE
  .filter((rel) => /^(src|test|vscode-extension|scripts)\/.+\.(js|mjs|cjs)$/.test(rel) || rel === 'bin/wildcard-perms')
  .map((rel) => path.join(ROOT, rel));
// Docs, consulted only for scripts/ subjects (see the header).
const DOCS = TREE.filter((rel) => rel.endsWith('.md')).map((rel) => path.join(ROOT, rel));
const TEXTS = new Map();
for (const file of [...FILES, ...DOCS]) {
  try { TEXTS.set(file, fs.readFileSync(file, 'utf8')); } catch { /* unreadable: no consumer */ }
}

// The text with every comment blanked to spaces, so each index still lines up with the
// original. Used only to ask whether an imported name is ever used: a comment that
// mentions it is not a use. A scanner rather than two regexes, because a regex for
// `/* ... */` starts a "comment" inside the string '**/*.md', which extension.js holds,
// and blanked a third of the file the first time this ran. Strings, template literals
// and regex literals are skipped whole; a `/` is a regex when the last significant
// character could not end an operand. That heuristic can misread a division, and the
// only cost is a few characters of code read as a regex, never a comment kept as code.
function stripComments(text) {
  const out = text.split('');
  const wipe = (from, to) => { for (let k = from; k < to; k += 1) if (out[k] !== '\n') out[k] = ' '; };
  let last = '';   // the last significant (non-space, non-comment) character
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (c === '/' && next === '/') {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? text.length : end;
      wipe(i, stop);
      i = stop;
    } else if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      wipe(i, stop);
      i = stop;
    } else if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === '\\' ? 2 : 1;
      i = j + 1;
      last = c;
    } else if (c === '/' && (last === '' || /[(,=:[!&|?{};+\-*%<>~^]/.test(last))) {
      let j = i + 1;
      let inClass = false;
      while (j < text.length && text[j] !== '\n') {
        if (text[j] === '\\') { j += 2; continue; }
        if (text[j] === '[') inClass = true;
        else if (text[j] === ']') inClass = false;
        else if (text[j] === '/' && !inClass) break;
        j += 1;
      }
      i = j + 1;
      last = '/';
    } else {
      if (!/\s/.test(c)) last = c;
      i += 1;
    }
  }
  return out.join('');
}
const CODE = new Map();
const codeOnly = (file) => {
  if (!CODE.has(file)) CODE.set(file, stripComments(TEXTS.get(file) || ''));
  return CODE.get(file);
};

// A module defined in scripts/ is a census subject only if it exports something; most
// are command-line tools with nothing to export.
const SCRIPT_EXPORTS = /^\s*(?:module\.exports\s*=|export\s)/m;

function censusModules() {
  return TREE.filter((rel) => /^(src|vscode-extension)\/[^/]+\.js$/.test(rel)
    || (/^scripts\/[^/]+\.(js|mjs)$/.test(rel) && SCRIPT_EXPORTS.test(TEXTS.get(path.join(ROOT, rel)) || '')))
    .sort();
}

// memoryLint.js and extension.js require 'vscode' at module scope, and extension.js also
// requires './src/*' — a path that only exists in the PACKAGED layout, which is why the
// harness tests redirect it. `os` is stubbed to a throwaway directory as well: nothing here
// calls into a module's body, but module scope in extension.js computes a dozen paths off
// os.homedir() and this test has no business resolving them against the real home.
function loadModule(moduleFile) {
  const modulePath = path.join(ROOT, moduleFile);
  const extensionPath = path.join(ROOT, 'vscode-extension', 'extension.js');
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-wildcarding-exports-'));
  const originalLoad = Module._load;
  const originalHomeEnv = Object.fromEntries(['HOME', 'USERPROFILE', 'CODEX_HOME'].map((key) => [key, process.env[key]]));
  Object.assign(process.env, { HOME: sandbox, USERPROFILE: sandbox, CODEX_HOME: path.join(sandbox, '.codex') });
  Module._load = function load(request, parent, isMain) {
    if (request === 'vscode') return vscodeStub();
    if (request === 'os' || request === 'node:os') return { ...os, homedir: () => sandbox };
    if (request.startsWith('./src/') && parent?.filename === extensionPath) {
      return originalLoad.call(this, path.join(ROOT, 'src', request.slice('./src/'.length)), parent, isMain);
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  const purge = () => {
    for (const key of Object.keys(require.cache)) {
      if (key.startsWith(path.join(ROOT, 'src') + path.sep)
        || key.startsWith(path.join(ROOT, 'vscode-extension') + path.sep)) {
        delete require.cache[key];
      }
    }
  };
  try {
    purge();
    return Object.keys(require(modulePath)).sort();
  } finally {
    Module._load = originalLoad;
    for (const [key, value] of Object.entries(originalHomeEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    purge();
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

function vscodeStub() {
  const disposable = { dispose() {} };
  return {
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    StatusBarAlignment: { Right: 2 },
    ThemeColor: class ThemeColor {},
    RelativePattern: class RelativePattern {},
    Uri: { file: (fsPath) => ({ fsPath }) },
    commands: { registerCommand: () => disposable, executeCommand() {} },
    window: {
      createStatusBarItem: () => ({ hide() {}, show() {}, dispose() {} }),
      createOutputChannel: () => ({ appendLine() {}, clear() {}, show() {}, dispose() {} }),
      registerWebviewViewProvider: () => disposable,
      setStatusBarMessage() {}, showErrorMessage() {}, showInformationMessage() {},
      showWarningMessage() {},
    },
    workspace: {
      isTrusted: true,
      workspaceFolders: [],
      getConfiguration: () => ({ get: () => undefined, inspect: () => ({}), update: async () => {} }),
      onDidChangeConfiguration: () => disposable,
      onDidChangeWorkspaceFolders: () => disposable,
      createFileSystemWatcher: () => ({
        onDidChange() {}, onDidCreate() {}, onDidDelete() {}, dispose() {},
      }),
    },
  };
}

// The exported names, sorted. An .mjs cannot be require()d on every supported Node, so it
// is imported; only a scripts/ module that statically exports reaches here (censusModules),
// and the three that do are imported by tests already, side-effect free.
async function exportsOf(moduleFile) {
  if (moduleFile.endsWith('.mjs')) {
    return Object.keys(await import(pathToFileURL(path.join(ROOT, moduleFile)).href)).sort();
  }
  return loadModule(moduleFile);
}

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const IDENT = String.raw`[A-Za-z_$][\w$]*`;

// Each `require(` or `import(` call in `text`: where the keyword starts, where the closing
// paren ends, and the argument between them. Parens are balanced, so a path.join(...)
// argument comes back whole. `require.resolve(` is not a load and does not match.
function loadCalls(text) {
  const out = [];
  const opener = /\b(?:require|import)\s*\(/g;
  let match;
  while ((match = opener.exec(text)) !== null) {
    let depth = 1;
    let i = opener.lastIndex;
    for (; i < text.length && depth; i += 1) {
      if (text[i] === '(') depth += 1;
      else if (text[i] === ')') depth -= 1;
    }
    if (depth) continue;
    out.push({ start: match.index, end: i, arg: text.slice(opener.lastIndex, i - 1) });
  }
  return out;
}

// `name` standing alone in `code`: not inside a longer identifier, and not `x.name` or
// `x?.name`, which is some other object's property of the same name. A spread, `...name`,
// IS a use (the first version missed `...codexFeatureStatus(...)` and called a live
// import unused).
function standsAlone(code, name) {
  const re = new RegExp(String.raw`(?<![\w$])` + escapeRe(name) + String.raw`(?![\w$])`, 'g');
  let match;
  while ((match = re.exec(code)) !== null) {
    const before = code.slice(Math.max(0, match.index - 3), match.index);
    if (!before.endsWith('.') || before === '...') return true;
  }
  return false;
}

// Is `local` used anywhere in `file` outside [start, end), the import statement itself?
// Comments do not count (codeOnly).
function usedOutside(file, start, end, local) {
  const code = codeOnly(file);
  return standsAlone(code.slice(0, start) + ' ' + code.slice(end), local);
}

// `a`, `a: b` or `a = 1` from a destructure, `a` or `a as b` from an ESM import:
// [the exported name, the local binding].
function bindings(list, esm) {
  return list.split(',').map((part) => part.trim()).filter(Boolean).map((part) => {
    if (esm) {
      const [name, local = name] = part.split(/\s+as\s+/).map((s) => s.trim());
      return [name, local];
    }
    const [name, rest] = part.split(':').map((s) => s.trim());
    return [name.split('=')[0].trim(), (rest || name).split('=')[0].trim()];
  }).filter(([name, local]) => name && local && !name.startsWith('...'));
}

// { used, imported }: name -> Set of files. `used` decides the verdicts; `imported` also
// holds bindings that are never used, so an import of a name the module stopped exporting
// still fails the over-pruning check below. `only` narrows the files read, for the
// synthetic test of this machinery at the end of the file.
function consumers(moduleFile, exported, only = null) {
  const stem = path.basename(moduleFile, path.extname(moduleFile));
  const absolute = path.join(ROOT, moduleFile);
  // A string literal naming the module: a spec with a directory in it ('../src/permissions',
  // './codexFeaturesUi.js'), or a path piece WITH its extension ('history-adapters.js'). A
  // bare 'codex-memory' is neither: it is how scripts/check-codex-memory-runtime.js lists
  // three modules in one array and loads them by index, which no scan can attribute. No
  // backreference for the quote: folded into a longer pattern the group number moves, and
  // `\1` once matched the destructure body instead, which read every module in the tree as
  // having no consumers at all.
  const named = new RegExp(String.raw`['"](?:[^'"\n]*[\\/]` + escapeRe(stem) + String.raw`(?:\.m?js)?|`
    + escapeRe(stem) + String.raw`\.m?js)['"]`);
  // An argument with its string literals blanked, so a holder's name inside a string
  // ('derived-guidance.js' holds `guidance`) is not read as the holder.
  const outsideStrings = (arg) => arg.replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, '""');

  const used = new Map();
  const imported = new Map();
  const add = (map, name, file) => {
    if (!map.has(name)) map.set(name, new Set());
    map.get(name).add(file);
  };
  const sources = only || (moduleFile.startsWith('scripts/') ? [...FILES, ...DOCS] : FILES);
  for (const file of sources) {
    if (path.resolve(file) === absolute) continue;
    const text = TEXTS.get(file);
    if (!text || !text.includes(stem)) continue;

    // Consts holding a PATH to the module, for `require(SCRIPT)` and `import(gateUrl)`. A
    // const holding the loaded module itself (`const guidance = require(...)`) is an
    // alias, handled below, and must not become a holder.
    const holders = [];
    for (const m of text.matchAll(new RegExp(String.raw`(?:const|let|var)\s+(${IDENT})\s*=\s*([^;]*);`, 'g'))) {
      if (named.test(m[2]) && !/^\s*(?:await\s+)?(?:require|import)\s*\(/.test(m[2])) {
        holders.push(new RegExp(String.raw`(?<![\w$.])` + escapeRe(m[1]) + String.raw`(?![\w$])`));
      }
    }
    const refersHere = (arg) => named.test(arg) || holders.some((holder) => holder.test(outsideStrings(arg)));

    // ESM: import { a, b as c } from '...'.
    for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*(['"][^'"\n]+['"])/g)) {
      if (!named.test(m[2])) continue;
      for (const [name, local] of bindings(m[1], true)) {
        add(imported, name, file);
        if (usedOutside(file, m.index, m.index + m[0].length, local)) add(used, name, file);
      }
    }

    for (const call of loadCalls(text)) {
      if (!refersHere(call.arg)) continue;
      // require(...).name, whatever it is assigned to: checked first, because
      // `const other = require(...).name` also looks like an alias.
      const inline = new RegExp(String.raw`^\s*\.\s*(${IDENT})`).exec(text.slice(call.end));
      if (inline) {
        add(imported, inline[1], file);
        add(used, inline[1], file);
        continue;
      }
      const before = text.slice(Math.max(0, call.start - 4000), call.start);
      const offset = call.start - before.length;
      // const { a, b: c } = require(...)   /   = await import(...)
      const destructure = new RegExp(String.raw`(?:const|let|var)\s*\{([^}]*)\}\s*=\s*(?:await\s+)?$`).exec(before);
      if (destructure) {
        for (const [name, local] of bindings(destructure[1], false)) {
          add(imported, name, file);
          if (usedOutside(file, offset + destructure.index, call.end, local)) add(used, name, file);
        }
        continue;
      }
      // const helper = require(...), then helper.name
      const alias = new RegExp(String.raw`(?:const|let|var)\s+(${IDENT})\s*=\s*(?:await\s+)?$`).exec(before);
      if (alias) {
        // `(?<![\w$])`, not `\b`-plus-no-dot: `...cleanup.LEGACY_ALLOW_CORE` is a use.
        for (const name of exported) {
          if (new RegExp(String.raw`(?<![\w$])` + escapeRe(alias[1]) + String.raw`\s*\??\.\s*` + escapeRe(name) + String.raw`(?![\w$])`).test(text)) {
            add(imported, name, file);
            add(used, name, file);
          }
        }
      }
    }
  }
  return { used, imported };
}

const declaredFor = (moduleFile) => ({
  ...(HELD[moduleFile] || {}),
  ...(PENDING_REMOVAL[moduleFile] || {}),
});

// Global preconditions, ahead of every per-module verdict. A scan that silently stopped
// matching reports every export in the tree as dead — or, if the declarations were written
// against that broken scan, reports everything as fine. Either way the number below moves a
// long way, never by one.
const CONSUMED_FLOOR = 100;

test('the export census actually scanned the tree', async () => {
  assert.ok(FILES.length > 60, `precondition: only ${FILES.length} source files were found`);
  assert.ok([...FILES, ...DOCS].every((file) => TEXTS.has(file)),
    'precondition: a source or doc file could not be read');
  assert.ok(!TREE.some((rel) => rel.startsWith('vscode-extension/src/')),
    'precondition: the generated vscode-extension/src/ is not part of the tree the census reads');
  const modules = censusModules();
  assert.ok(modules.length >= 30,
    `precondition: only ${modules.length} modules in the census; src/, vscode-extension/ or scripts/ moved`);
  // WITNESS for the scripts/ half: the ones the v1.6.2 audit read, CommonJS and ESM both.
  for (const name of ['scripts/check-codex-runtime.js', 'scripts/mirror-pack.js', 'scripts/sync-version.mjs']) {
    assert.ok(modules.includes(name), `precondition: ${name} is not in the census`);
  }

  let consumed = 0;
  for (const moduleFile of modules) {
    const exported = await exportsOf(moduleFile);
    const { used } = consumers(moduleFile, exported);
    for (const name of exported) {
      const files = used.get(name);
      if (!files) continue;
      if ([...files].some((file) => !path.resolve(file).startsWith(TEST_DIR))) consumed += 1;
    }
  }
  assert.ok(consumed >= CONSUMED_FLOOR,
    `only ${consumed} exports have a production consumer, against a floor of ${CONSUMED_FLOOR}. `
    + 'The consumer scan has stopped matching; every verdict below is worthless until it does.');
});

for (const moduleFile of censusModules()) {
  test(`${moduleFile} exports nothing it cannot account for`, async () => {
    const exported = await exportsOf(moduleFile);
    const { used: found, imported } = consumers(moduleFile, exported);
    const declared = declaredFor(moduleFile);

    assert.ok(exported.length > 0, 'precondition: the module was loaded and does export');

    const dead = [];
    const testOnly = [];
    for (const name of exported) {
      const files = found.get(name);
      if (!files || files.size === 0) { dead.push(name); continue; }
      if (![...files].some((file) => !path.resolve(file).startsWith(TEST_DIR))) testOnly.push(name);
    }

    // No consumer at all. Both directions: an undeclared one is dead weight, and a declared
    // one that gained a consumer has to leave the list, or the reasons rot into excuses.
    assert.deepEqual(dead.sort(), Object.keys(declared).sort(),
      `${moduleFile}: the set of exports with NO consumer has moved.\n`
      + `  found     : ${dead.join(', ') || '(none)'}\n`
      + `  declared  : ${Object.keys(declared).sort().join(', ') || '(none)'}\n`
      + '  An extra found name is a dead export: delete the entry from module.exports (keep the\n'
      + '  function), or declare it in HELD/PENDING_REMOVAL with the reason. An extra declared\n'
      + '  name has gained a consumer: drop it, its reason no longer holds.\n'
      + Object.entries(declared).map(([name, why]) => `  ${name}: ${why}`).join('\n'));

    // Consumed only by test/. Same both-directions rule, so a production caller quietly
    // disappearing shows up here rather than looking unchanged.
    assert.deepEqual(testOnly.sort(), [...(TEST_ONLY[moduleFile] || [])].sort(),
      `${moduleFile}: the set of TEST-ONLY exports has moved. An extra found name lost its last\n`
      + '  production consumer, or is a new test-only seam that has to be listed. An extra\n'
      + '  listed name gained a production consumer and should come off the list.');

    // The other direction of the contract, so over-pruning fails here rather than at runtime.
    // Every import counts here, used or not: binding a name the module no longer exports is
    // still a mistake, even where nothing reads it.
    for (const name of imported.keys()) {
      assert.ok(exported.includes(name),
        `something imports ${name} from ${moduleFile}, which no longer exports it`);
    }
    for (const [name] of Object.entries(declared)) {
      assert.ok(exported.includes(name),
        `${moduleFile} no longer exports ${name}, which is still declared here`);
    }
    for (const name of TEST_ONLY[moduleFile] || []) {
      assert.ok(exported.includes(name),
        `${moduleFile} no longer exports ${name}, which is still listed as test-only`);
    }
  });
}

// The consumer scan itself, on a synthetic importer, so each rule above has an assertion
// that fails when the rule does. Every shape in it is one the real tree uses. The file is
// registered in TEXTS only, never written to disk.
test('the consumer scan counts a use, not an import, through every shape it claims to read', () => {
  const fixture = path.join(ROOT, 'test', 'census-synthetic-importer.js');
  TEXTS.set(fixture, [
    "const { used, inComment, unused, spread: local, usedAsProperty } = require('../src/census-fixture');",
    // A glob in a string holds `/*`, which a regex for block comments reads as one, and
    // it would blank the call to used() below.
    "const glob = '**/*.md'; // inComment is named here, which is not a use",
    'used();',
    '/* unused, in a block comment */',
    'const all = [...local];',
    'const other = config.usedAsProperty + config?.usedAsProperty;',
    "const value = require('../src/census-fixture').inline;",
    "const ns = require('../src/census-fixture'); ns.member();",
    "const SUBJECT = path.join(__dirname, '..', 'src', 'census-fixture.js');",
    'const { viaHolder } = require(SUBJECT); viaHolder();',
    "const { viaJoin } = require(path.join(root, 'src', 'census-fixture.js')); viaJoin();",
    // Not this module: a path piece without its extension, and a holder named inside a string.
    "const { notOurs } = require(path.join(root, 'src', 'census-fixture-gates.js')); notOurs();",
  ].join('\n'));
  try {
    const exported = ['used', 'inComment', 'unused', 'spread', 'usedAsProperty', 'inline', 'member',
      'viaHolder', 'viaJoin', 'notOurs'];
    const { used, imported } = consumers('src/census-fixture.js', exported, [fixture]);
    assert.deepEqual([...used.keys()].sort(), ['inline', 'member', 'spread', 'used', 'viaHolder', 'viaJoin'],
      'a use is a use in code, a spread included; a comment, a property of the same name and a bare import are not');
    assert.deepEqual([...imported.keys()].sort(),
      ['inComment', 'inline', 'member', 'spread', 'unused', 'used', 'usedAsProperty', 'viaHolder', 'viaJoin'],
      'every binding still counts as an IMPORT, for the over-pruning check');
  } finally {
    TEXTS.delete(fixture);
    CODE.delete(fixture);
  }
});
