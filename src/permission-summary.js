'use strict';

// Dashboard counts describe saved local declarations, not effective approvals.
// This read never enters the learner or its backup/ownership transactions.
const fs = require('node:fs');
const path = require('node:path');
const { codexRuleFileSet } = require('./codex-policy');
const { parseCodexRules } = require('./codex-rule-inventory');

function readCodexPermissionSummary(options = {}) {
  const set = codexRuleFileSet(options);
  const result = { allow: 0, prompt: 0, forbidden: 0, total: 0, files: [], complete: true,
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

module.exports = { readCodexPermissionSummary };
