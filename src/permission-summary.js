'use strict';

// Dashboard counts describe saved local declarations, not effective approvals.
// This read never enters the learner or its backup/ownership transactions.
const fs = require('node:fs');
const path = require('node:path');
const { codexRuleFileSet } = require('./codex-policy');
const { parseCodexRules } = require('./codex-rule-inventory');
// The classifier only. src/auto-learn.js has no I/O and never applies anything, so
// borrowing it keeps this module's promise above: no learner state, no transaction.
const { extractInvocations, classifyInvocation } = require('./auto-learn');

// `options` go to codexRuleFileSet unchanged; the dashboard passes
// `projectTrust: 'cached'` so this read never spawns. `pending` then says the
// trusted-project folders are not counted YET (2026-10-14), which the panel shows
// as a lower bound rather than as a complete count.
function readCodexPermissionSummary(options = {}) {
  const set = codexRuleFileSet(options);
  const result = { allow: 0, prompt: 0, forbidden: 0, total: 0, files: [], allowRules: [], complete: true,
    pending: set.projectPending === true, issues: [], directories: set.directories, blindSpots: set.blindSpots };
  const issue = (file, reason) => {
    result.complete = false;
    result.issues.push({ path: file, reason });
  };
  for (const failure of set.failures) issue(failure.path, failure.message);

  // File-set enumeration deliberately selects regular files. A linked or other
  // non-regular .rules entry must not make a dashboard's known subtotal look
  // complete, even though this reader will not follow it.
  const candidates = new Set(set.files);
  for (const directory of set.directories) {
    if (set.failures.some((failure) => failure.path === directory)) continue;
    try {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.name.toLowerCase().endsWith('.rules') && !entry.isFile()) {
          candidates.add(path.join(directory, entry.name));
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') issue(directory, error.message);
    }
  }

  for (const file of [...candidates].sort()) {
    try {
      if (!fs.lstatSync(file).isFile()) throw new Error('Linked or non-regular rule entries are not counted.');
      const bytes = fs.readFileSync(file);
      const text = bytes.toString('utf8');
      if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error('Rule file is not lossless UTF-8.');
      const parsed = parseCodexRules(text);
      if (!parsed.supported) throw new Error(parsed.reason);
      for (const rule of parsed.rules) {
        result[rule.decision] += 1;
        result.total += 1;
        if (rule.decision === 'allow') result.allowRules.push({ path: file, pattern: rule.pattern, start: rule.start });
      }
      result.files.push({ path: file, supported: true });
    } catch (error) {
      const reason = String(error.message || error);
      result.files.push({ path: file, supported: false, reason });
      issue(file, reason);
    }
  }
  return result;
}

// Saved shell approvals that are one-off scripts: exact entries that open with something
// that is not a command, or chain several. Claude Code stores an approved command
// verbatim, so an entry like `PowerShell($x = Get-Date; foreach ...)` covers that exact
// text and nothing else, and the next variation prompts again. The wildcarding pass in
// src/permissions.js leaves the PowerShell forms verbatim on purpose (no plain command
// root to key on); on the development box it left all 68 counted entries verbatim
// (measured 2026-10-13), which is why they accumulate. Measured 2026-09-25 on a
// development box (BACKLOG, "14% of this box's stored approvals can never be
// wildcarded"): 71 of 509 shell entries began with an assignment, keyword or range
// literal and 65 held an unquoted `;`. Nothing surfaced that against the INSTALLED list;
// this is the read-only count the dashboard shows, and nothing here removes anything.
//
// The reasons are the classifier's own, checked against each shape on 2026-09-27 and
// again 2026-10-13: an assignment opener is `dynamic-executable` + `missing-command-root`;
// `foreach`/`if` is `reserved-keyword` + `script-syntax`; a range literal (`1..6`) is
// `missing-command-root` + `script-syntax`; a `;`, pipe or `&&` chain is
// `compound-command` on every segment.
//
// `shell-structure` is deliberately NOT in the set, which differs from the BACKLOG
// entry's list. It is an alias raised whenever a root is present alongside any structural
// flag (src/auto-learn.js classifyInvocation), so for the shapes above it never adds an
// entry the other five do not already catch. What it adds on its own is a path, quoted
// or call-operator executable: `Bash(./scripts/build.sh --release)` or
// `PowerShell(& "C:\Tools\x.exe" --version)`. Those are ordinary commands that match
// again when re-run, and counting them would invite a user to delete working approvals,
// which is the one failure a diagnostic like this must not cause.
//
// Only exact entries are examined: anything containing `*` is a pattern, which may match
// more than its own text, and is skipped rather than judged. That can only under-count.
const DEAD_APPROVAL_REASONS = Object.freeze([
  'compound-command', 'dynamic-executable', 'missing-command-root', 'reserved-keyword',
  'script-syntax',
]);
const SHELL_APPROVAL = /^(Bash|PowerShell)\(([\s\S]+)\)$/;

// The dashboard pushes on every settings change and on most watcher events, and the
// list rarely changes between two of them, so the last input is remembered. The key is
// the whole list serialized: JSON, not a join, because an entry may itself hold any
// separator a join could use (multi-line commands are common here).
let deadApprovalsMemo = { key: null, value: null };

function deadShellApprovals(allow) {
  const list = Array.isArray(allow) ? allow.filter((entry) => typeof entry === 'string') : [];
  const key = JSON.stringify(list);
  if (deadApprovalsMemo.key === key) return deadApprovalsMemo.value;
  const byReason = {};
  const entries = [];
  let total = 0;
  for (const entry of list) {
    const match = SHELL_APPROVAL.exec(entry);
    if (!match || entry.includes('*')) continue;
    total += 1;
    const reasons = new Set();
    for (const invocation of extractInvocations(match[1], entry)) {
      for (const reason of invocation.reasons) reasons.add(reason);
    }
    const hits = DEAD_APPROVAL_REASONS.filter((reason) => reasons.has(reason));
    if (!hits.length) continue;
    entries.push(entry);
    for (const reason of hits) byReason[reason] = (byReason[reason] || 0) + 1;
  }
  // Frozen because the memo hands the SAME object to every caller; one that mutated it
  // would change what the next push reports.
  const value = Object.freeze({
    count: entries.length, total, byReason: Object.freeze(byReason), entries: Object.freeze(entries),
  });
  deadApprovalsMemo = { key, value };
  return value;
}

// Saved WILDCARD shell grants whose head is shell grammar rather than a command: the
// shapes the wildcarding pass minted before a910daf (2026-10-13), when it keyed every
// Bash entry on its first token, so one approved loop became `Bash(for *)` and one
// `export X=1` became `Bash(export *)`. Measured that day with src/permission-match.js:
// `Bash(for *)` covers `Bash(for f in *; do rm -rf "$f"; done)`, so a rule like this
// matches far more than the approval it came from. a910daf stopped the pass minting
// them and, deliberately, removed nothing: a grant a user holds stays until they decide.
// This is the read-only count that lets them decide; nothing here removes anything.
//
// A wildcard's HEAD is its argument minus the trailing `*` (either separator), and the
// head is what the classifier judges: `reserved-keyword` (`for`, `export`, `eval`,
// PowerShell `foreach`), `dynamic-executable` (`$EDITOR`, `(`, `{`, `[[`) and
// `missing-command-root` (`FOO=bar`, a range literal, PowerShell's `&` call operator,
// which runs whatever follows it). A head with no executable at all, such as a bare
// assignment, yields no invocation from extractInvocations, so classifyInvocation is
// asked directly and reports the missing root itself.
//
// Two kinds of head are not counted although the classifier names them:
//   * `source` and `[`, reserved words to the classifier, are the `.` script runner and
//     the `test` builtin, which src/permissions.js wildcards by design (the BASH_EXEMPT
//     list in test/permissions-keywords.test.js). Counting them would ask a user to
//     remove a grant the next approval re-mints. `Bash(bash *)` and `Bash(. *)` are not
//     counted either: the classifier calls them shell wrappers, which are commands.
//   * A head that is a wrapper the classifier strips followed only by assignments
//     (`timeout 5 FOO=1`, `nohup FOO=1`, `command FOO=1`). The classifier steps over the
//     wrapper, then the assignment, finds no executable and reports `missing-command-root`
//     beside `stripped-wrapper`. But the command is under the star, and the wrapper would
//     exec the "assignment" as its program anyway, so "no root" there is an artifact of
//     cutting the head, not grammar; `missing-command-root` is dropped when
//     `stripped-wrapper` is present.
//     Corrected 2026-10-14. This used to name a head that is ONLY a wrapper (`command`,
//     `builtin`, `timeout 5`), measured 2026-10-13 on the development box's `Bash(command *)`.
//     9a5324e (the same day) made the learner strip a wrapper the way Claude Code does, only
//     when it wraps something, so a wrapper alone is now the root (`shell-wrapper`, a command)
//     and never reaches this line: deleting the line left the whole suite green (1434 tests,
//     measured 2026-10-14), where a test comment had recorded the mutation as killed. The
//     wrapper-then-assignment heads above are what reach it; that test now pins them.
//
// Only wildcard entries are examined, the mirror image of deadShellApprovals above.
// `Bash(*)` is an explicit tool-wide grant with no head, and is skipped. On the
// development box (2026-10-13) this counted 2 of 425 wildcard shell grants: one
// `Bash(export *)` and one `PowerShell(& *)`. Since 2026-10-14 it counts 1 there, the
// `Bash(export *)`: `PowerShell(& *)` is one of the grants below.
const OVER_BROAD_REASONS = Object.freeze(['dynamic-executable', 'missing-command-root', 'reserved-keyword']);
const OVER_BROAD_EXEMPT_BASH_HEADS = new Set(['source', '[']);
const WILDCARD_TAIL = /[\s:]*\*\s*$/;

// The starter pack's 13 blanket interpreter and shell grants, kept on the maintainer's call
// (docs/engineering-record.md, "The 13 blanket wrapper grants": left in place 2026-09-03 and
// still standing). Each is an arbitrary-execution grant, and the diagnostic is not the place to
// relitigate a standing decision: `PowerShell(& *)`, the one of the 13 this diagnostic flags
// (`missing-command-root`, the call operator runs whatever follows it), was half of its count
// on the development box, so the dashboard asked the user, on every push, to remove a grant the
// project seeds on purpose. They are still examined (`total`) and reported apart as `kept`, so
// the count is the grants nobody decided on. Matched by tool and head, so the colon spelling
// `PowerShell(&:*)`, the same rule, is kept too.
//
// The one list: patterns/starter-pack.json must hold every entry (test/starter-pack.test.js
// asserts it, and that the record's heading expands to exactly these 13), and that test reads
// the pack's control set from `kept` rather than from a copy of its own. The pack no longer
// seeds `Bash(export *)` (2026-10-14), so this diagnostic flags nothing the pack seeds.
const MAINTAINER_KEPT_GRANTS = Object.freeze([
  'Bash(bash *)', 'Bash(sh *)', 'Bash(python *)', 'Bash(python3 *)', 'Bash(node *)', 'Bash(npx *)',
  'Bash(pwsh *)', 'Bash(powershell *)', 'PowerShell(& *)', 'PowerShell(python *)', 'PowerShell(python3 *)',
  'PowerShell(powershell *)', 'PowerShell(node *)',
]);
const wildcardHead = (entry) => {
  const match = SHELL_APPROVAL.exec(entry);
  if (!match || !WILDCARD_TAIL.test(match[2])) return null;
  return { tool: match[1], head: match[2].replace(WILDCARD_TAIL, '').trim() };
};
const KEPT_HEADS = new Set(MAINTAINER_KEPT_GRANTS.map((entry) => {
  const { tool, head } = wildcardHead(entry);
  return `${tool}\u0000${head}`;
}));

// Its own memo cell, for the reason the one above has one: the dashboard asks for both
// diagnostics on every push, and one shared cell would evict the other each time.
let overBroadMemo = { key: null, value: null };

function overBroadShellGrants(allow) {
  const list = Array.isArray(allow) ? allow.filter((entry) => typeof entry === 'string') : [];
  const key = JSON.stringify(list);
  if (overBroadMemo.key === key) return overBroadMemo.value;
  const byReason = {};
  const entries = [];
  const kept = [];
  let total = 0;
  for (const entry of list) {
    const parsed = wildcardHead(entry);
    if (!parsed) continue;
    const { tool, head } = parsed;
    if (!head) continue;
    total += 1;
    if (KEPT_HEADS.has(`${tool}\u0000${head}`)) { kept.push(entry); continue; }
    if (tool === 'Bash' && OVER_BROAD_EXEMPT_BASH_HEADS.has(head.split(/\s+/)[0])) continue;
    const invocations = extractInvocations(tool, head);
    const reasons = new Set(invocations.length
      ? invocations.flatMap((invocation) => invocation.reasons)
      : classifyInvocation({ tool, command: head }).reasons);
    if (reasons.has('stripped-wrapper')) reasons.delete('missing-command-root');
    const hits = OVER_BROAD_REASONS.filter((reason) => reasons.has(reason));
    if (!hits.length) continue;
    entries.push(entry);
    for (const reason of hits) byReason[reason] = (byReason[reason] || 0) + 1;
  }
  // Frozen for the same reason as deadShellApprovals: the memo hands one object to all.
  const value = Object.freeze({
    count: entries.length, total, byReason: Object.freeze(byReason), entries: Object.freeze(entries),
    kept: Object.freeze(kept),
  });
  overBroadMemo = { key, value };
  return value;
}

module.exports = { readCodexPermissionSummary, deadShellApprovals, overBroadShellGrants };
