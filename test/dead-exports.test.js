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
// src/ and vscode-extension/.
//
// AND THE METHOD MATTERS. A destructure-only scan is wrong here and was already disproven:
// bin/wildcard-perms does `const cache = require('../src/fixed-point-cache')` and then
// reaches members off it on the hook's hot path, so a scan that only reads
// `const { a, b } = require(...)` calls every one of that module's exports dead. Four
// consumer shapes are counted: destructured require, namespace alias plus member access,
// `require(...).name` inline, and an ESM named import (scripts/ is .mjs).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const ROOT = path.resolve(__dirname, '..');
const TEST_DIR = path.join(ROOT, 'test') + path.sep;

// Held on purpose, and structurally: these have no consumer a static scan can find and
// never will. The key is the export; the value is why, and is printed on failure.
const HELD = {
  'vscode-extension/memoryLint.js': {
    fastLint:
      'test-only, not dead, and invisible here: test/memory-line-cap.test.js reaches it '
      + 'through loadLint(), which re-requires the module by resolved path, so no require '
      + 'site names it. Those calls are what make the line-cap off-by-one falsifiable.',
    pickPrimaryDir:
      'test-only, not dead, same dynamic loader: test/memory-lint-watchers.test.js and '
      + 'test/recall-index.test.js pin the store-selection rule through it, against '
      + 'recall.py as the authority.',
  },
  'vscode-extension/extension.js': {
    activate:
      'the VS Code entry point. package.json `main` names this file and the host calls '
      + 'activate() itself; no file in the repo requires it by name.',
    deactivate:
      'the other half of the VS Code contract, called by the host on teardown. The '
      + 'lifecycle tests call it off a required module object, not off a named import.',
  },
};

// Found with no consumer at all by this census on 2026-09-24, when it was widened past its
// original three modules. Each is a dead EXPORT over a live function — every one of them is
// called from inside its own module, which is why nothing else noticed. The fix is to delete
// the entry from the module.exports list and keep the function; that edit belongs to the
// owner of src/ and vscode-extension/, so they are parked here rather than silently passed.
//
// This list is DEBT, not an allowlist. It is separate from HELD so that it reads as one, and
// so that emptying it is a visible event. A name here that gains a consumer must leave it:
// the per-module assertion below compares the whole set, in both directions.
const PENDING_REMOVAL = {
  'src/codex-policy.js': {
    CODEX_BUNDLE_CACHE: 'src/codex-policy.js:71 — used only as the default argument of '
      + 'readEnterpriseBundle at :12.',
  },
  'src/legacy-max-cleanup.js': {
    LEGACY_ALLOW_MARKERS: 'src/legacy-max-cleanup.js:373 — read only at :59.',
    LEGACY_APPROVE_MARKER: 'src/legacy-max-cleanup.js:372 — internal only.',
    LEGACY_APPROVE_SCRIPT: 'src/legacy-max-cleanup.js:371 — the default argument at :92, '
      + ':109, :159 and :342. The same NAME in two tests is a local const read off a '
      + 'fixture file, not an import of this one.',
    detectMcpServers: 'src/legacy-max-cleanup.js:375 — called only at :70.',
    legacyAllowActive: 'src/legacy-max-cleanup.js:377 — internal only.',
    legacyApproveHookActive: 'src/legacy-max-cleanup.js:381 — called only at :127 and :157.',
    legacyApproveHookLike: 'src/legacy-max-cleanup.js:382 — internal only.',
    topLevelBound: 'src/legacy-max-cleanup.js:389 — called only at :265.',
  },
  'src/permissions.js': {
    prunePermissions: 'src/permissions.js:567 — called only at :488, inside processAllowList.',
    readBypassState: 'src/permissions.js:569 — called only at :554. Its own comment at :561 '
      + 'claims it is "exported and how callers reach it", which is the shape of a HELD '
      + 'reason that outlived its truth.',
  },
  'vscode-extension/autoLearnUi.js': {
    candidateAppliedTargets: 'vscode-extension/autoLearnUi.js — internal only.',
    candidateEligibleTargets: 'vscode-extension/autoLearnUi.js — internal only.',
    unwrapApplication: 'vscode-extension/autoLearnUi.js:356 — called only at :70.',
  },
};

// Exports whose only consumers are under test/. Not a defect — a test-only export is
// usually the seam that makes a unit assertion able to fail — but enumerated, so that
// adding one is a deliberate act and so that a name QUIETLY losing its last production
// caller shows up here instead of looking unchanged.
const TEST_ONLY = {
  'src/agent-gates.js': ['GATES_BEGIN', 'GATES_END', 'makeGatesBlock'],
  'src/agent-guidance.js': ['BEGIN', 'END', 'GUIDANCE_BODY', 'applyGuidance', 'escapeMarker', 'guidanceBlock', 'guidanceTargets', 'hasGuidance', 'instructionLockPath', 'isCurrent'],
  'src/auto-learn-manager.js': ['migrateStateTo'],
  'src/auto-learn-worker.js': ['run'],
  'src/auto-learn.js': ['AUTO_SAFE_GIT', 'AUTO_SUFFIX_CLOSED_ROOTS', 'classifyInvocation', 'isLearnableTool', 'splitCommandSegments', 'tokenizeCommand', 'toolInvocation'],
  // enterpriseDecisionFor and enterprisePrefixRuleHealth lost their last production
  // consumer when the managed-requirements parser was rewritten on 2026-09-24:
  // production now asks enterprisePolicyAssessment, which answers with the degraded
  // state as well as the decision. Both are kept as a stable surface and both are
  // exercised; this census is what noticed, on the merge.
  'src/codex-policy.js': ['allowedSandboxModes', 'enterpriseDecisionFor', 'enterprisePrefixRuleHealth', 'enterprisePrefixRules', 'enterpriseRequirements'],
  'src/derived-guidance.js': ['cleanRule', 'installedDerivedIds', 'markersFor', 'reconcileDerived', 'renderMitigation'],
  'src/exec-resolve.js': ['quoteForCommandProcessor', 'resolveExecutable'],
  'src/fixed-point-cache.js': ['CACHE_VERSION', 'cachePath', 'codeFiles', 'fnv1a32', 'readFixedPoint'],
  'src/history-adapters.js': ['READ_CHUNK_BYTES', 'cursorKeyForFile', 'extractNestedShellCommands', 'parseClaudeJsonl', 'parseCodexJsonl'],
  'src/legacy-backup-cleanup.js': ['parseBackupText'],
  'src/legacy-max-cleanup.js': ['LEGACY_ALLOW_CORE', 'legacyApproveCommandFor', 'legacyGeneratedAllow'],
  'src/local-settings.js': ['localBackupPath', 'partitionLocal', 'planPromotions', 'promotionFor', 'redundantUnder'],
  'src/managed-policy.js': ['coversPrefix', 'hookEventAllowed', 'rulePrefix'],
  'src/permission-match.js': ['MATCH_CACHE_LIMIT', 'matchCacheStats'],
  'src/permissions.js': ['coverIndexKeyCacheStats', 'coverKeyCacheStats'],
  // CODEX_BEGIN_MARKER joined this list on 2026-09-24 when removeGeneratedCodexRules
  // moved into this module: the marker's only production reader is now its own file,
  // and the workspace-rules cleanup in bin/wildcard-perms asks that function rather
  // than matching the marker itself. That is the right direction -- ownership is
  // proved in one place -- but it does leave the constant test-only.
  'src/policy-exporters.js': ['AUTO_SAFE_GIT_SUBCOMMANDS', 'AUTO_SUFFIX_CLOSED_ROOTS', 'CODEX_BEGIN_MARKER', 'normalizePermissionSpelling'],
  'src/policy-guard.js': ['isBulkLoss', 'managedCapabilities', 'missingFromLive', 'shadowedByManaged'],
  'src/recall-index.js': ['MEMORY_INDEX_NAME', 'RECALL_EMBED_ID', 'RECALL_INDEX_NAME', 'indexableMemories'],
  'vscode-extension/autoLearnUi.js': ['permissionMatches'],
};

// Every file that could plausibly consume one of these modules.
function sourceFiles() {
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        walk(full);
      } else if (/\.(js|mjs|cjs)$/.test(entry.name)) {
        out.push(full);
      }
    }
  };
  for (const dir of ['src', 'test', 'vscode-extension', 'scripts']) walk(path.join(ROOT, dir));
  // Extensionless, so the walk above cannot see it, and it is the highest-frequency
  // consumer of src/ in the repo.
  out.push(path.join(ROOT, 'bin', 'wildcard-perms'));
  return out;
}

const FILES = sourceFiles();
const TEXTS = new Map();
for (const file of FILES) {
  try { TEXTS.set(file, fs.readFileSync(file, 'utf8')); } catch { /* unreadable: no consumer */ }
}

function censusModules() {
  const out = [];
  for (const name of fs.readdirSync(path.join(ROOT, 'src'))) {
    if (name.endsWith('.js')) out.push(`src/${name}`);
  }
  for (const name of fs.readdirSync(path.join(ROOT, 'vscode-extension'))) {
    if (name.endsWith('.js')) out.push(`vscode-extension/${name}`);
  }
  return out;
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

// name -> Set of files that consume it. Four shapes, because one is demonstrably not enough.
function consumers(moduleFile, exported) {
  const stem = path.basename(moduleFile, '.js');
  const absolute = path.join(ROOT, moduleFile);
  const esc = stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // No backreference for the quote: folded into a longer pattern the group number moves,
  // and `\1` then matched the destructure body instead. That single character read every
  // module in the tree as having no consumers at all — a clean sweep, which is a harness
  // bug and never a result.
  const req = String.raw`\(\s*['"](?:[^'"]*\/)?` + esc + String.raw`(?:\.js)?['"]\s*\)`;
  const destructure = new RegExp(String.raw`(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require` + req, 'g');
  const alias = new RegExp(String.raw`(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require` + req, 'g');
  const inline = new RegExp(String.raw`require` + req + String.raw`\s*\.\s*([A-Za-z_$][\w$]*)`, 'g');
  const esmNamed = new RegExp(
    String.raw`import\s*\{([^}]*)\}\s*from\s*['"](?:[^'"]*\/)?` + esc + String.raw`(?:\.js)?['"]`, 'g');

  const found = new Map();
  const add = (name, file) => {
    if (!found.has(name)) found.set(name, new Set());
    found.get(name).add(file);
  };
  for (const file of FILES) {
    if (path.resolve(file) === absolute) continue;
    const text = TEXTS.get(file);
    if (!text) continue;
    let match;
    destructure.lastIndex = 0;
    while ((match = destructure.exec(text)) !== null) {
      // `cfg: memoryConf` binds under a local alias; the EXPORT is the left half.
      for (const part of match[1].split(',')) {
        const name = part.split(':')[0].trim();
        if (name) add(name, file);
      }
    }
    esmNamed.lastIndex = 0;
    while ((match = esmNamed.exec(text)) !== null) {
      for (const part of match[1].split(',')) {
        const name = part.split(/\s+as\s+/)[0].trim();
        if (name) add(name, file);
      }
    }
    inline.lastIndex = 0;
    while ((match = inline.exec(text)) !== null) add(match[1], file);
    // Namespace alias: `const cache = require('../src/fixed-point-cache')` followed by
    // `cache.readFixedPoint(...)`. This is the shape a destructure-only scan misses, and
    // bin/wildcard-perms uses it on the hook's hot path.
    alias.lastIndex = 0;
    const aliases = [];
    while ((match = alias.exec(text)) !== null) aliases.push(match[1]);
    for (const local of aliases) {
      for (const name of exported) {
        if (new RegExp(String.raw`\b${local}\s*\.\s*${name}\b`).test(text)) add(name, file);
      }
    }
  }
  return found;
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

test('the export census actually scanned the tree', () => {
  assert.ok(FILES.length > 60, `precondition: only ${FILES.length} source files were found`);
  assert.ok(TEXTS.size === FILES.length,
    `precondition: ${FILES.length - TEXTS.size} source file(s) could not be read`);
  const modules = censusModules();
  assert.ok(modules.length >= 24,
    `precondition: only ${modules.length} modules in the census; src/ or vscode-extension/ moved`);

  let consumed = 0;
  for (const moduleFile of modules) {
    const exported = loadModule(moduleFile);
    const found = consumers(moduleFile, exported);
    for (const name of exported) {
      const files = found.get(name);
      if (!files) continue;
      if ([...files].some((file) => !path.resolve(file).startsWith(TEST_DIR))) consumed += 1;
    }
  }
  assert.ok(consumed >= CONSUMED_FLOOR,
    `only ${consumed} exports have a production consumer, against a floor of ${CONSUMED_FLOOR}. `
    + 'The consumer scan has stopped matching; every verdict below is worthless until it does.');
});

for (const moduleFile of censusModules()) {
  test(`${moduleFile} exports nothing it cannot account for`, () => {
    const exported = loadModule(moduleFile);
    const found = consumers(moduleFile, exported);
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
    for (const name of found.keys()) {
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
