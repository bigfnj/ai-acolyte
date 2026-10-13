'use strict';

// Dashboard counts describe saved local declarations, not effective approvals.
// This read never enters the learner or its backup/ownership transactions.
const fs = require('node:fs');
const path = require('node:path');
const { codexRuleFileSet } = require('./codex-policy');
const { parseCodexRules } = require('./codex-rule-inventory');
// The classifier only. src/auto-learn.js has no I/O and never applies anything, so
// borrowing it keeps this module's promise above: no learner state, no transaction.
const { extractInvocations } = require('./auto-learn');

function readCodexPermissionSummary(options = {}) {
  const set = codexRuleFileSet(options);
  const result = { allow: 0, prompt: 0, forbidden: 0, total: 0, files: [], allowRules: [], complete: true,
    issues: [], directories: set.directories, blindSpots: set.blindSpots };
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

module.exports = { readCodexPermissionSummary, deadShellApprovals };
