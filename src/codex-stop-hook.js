'use strict';

// Codex 0.145 flushes the current shell result before Stop, but not before a
// synchronous PostToolUse callback. Read authoritative history at turn end;
// neither raw hook output nor the fact that a hook fired establishes success.
const fs = require('node:fs');
const path = require('node:path');

function runCodexStopHook(input, options = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || input.hook_event_name !== 'Stop') {
    throw new Error('Expected a Codex Stop hook event');
  }
  if (typeof input.cwd !== 'string' || !path.isAbsolute(input.cwd)) {
    throw new Error('Codex Stop hook cwd must be an absolute directory');
  }
  const workspaceRoot = path.resolve(input.cwd);
  if (!fs.statSync(workspaceRoot).isDirectory()) throw new Error('Codex Stop hook cwd must be an existing directory');
  const createManager = options.createManager || require('./auto-learn-manager').createAutoLearnManager;
  const settings = { workspaceRoot, claudeRoots: [], claudeSettingsPath: null,
    // The manager's legacy alias fallback treats a top-level null as absent.
    // Carry the explicit disabled value through both paths.
    paths: { claudeSettings: null } };
  for (const key of ['home', 'codexHome']) if (options[key] !== undefined) settings[key] = options[key];
  const scan = createManager(settings).scan();
  if (scan.errors > 0 || scan.partial > 0 || scan.blindScan === true) {
    return { ok: false, error: `Codex history scan incomplete (${scan.errors || 0} errors, ${scan.partial || 0} partial files)`, scan };
  }
  return { ok: true, scan };
}

// Importing this module never reads stdin, scans history or writes policy.
if (require.main === module) {
  const chunks = [];
  let bytes = 0;
  let rejected = false;
  const fail = (error) => {
    if (rejected) return;
    rejected = true;
    process.stderr.write(`AI Acolyte Codex Stop hook: ${error.message || error}\n`);
    process.exitCode = 1;
  };
  process.stdin.on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) { fail(new Error('hook input exceeds 1 MiB')); return; }
    if (!rejected) chunks.push(chunk);
  });
  process.stdin.on('error', fail);
  process.stdin.on('end', () => {
    if (rejected) return;
    try {
      const result = runCodexStopHook(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      if (!result.ok) throw new Error(result.error);
      // Neutral output: no blocking, continuation request or model context.
      process.stdout.write('{}\n');
    } catch (error) { fail(error); }
  });
}

module.exports = { runCodexStopHook };
