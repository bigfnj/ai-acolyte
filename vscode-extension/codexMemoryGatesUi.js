'use strict';

const path = require('path');

// The installed instruction marker is the opt-in. The worker rechecks it under
// the instruction locks, including on an automatic refresh queued before Remove.
function createCodexMemoryGatesUi(vscode, { run, codexHome, refresh = () => {},
  debounceMs = 300, reconcileMs = 300000 }) {
  let disposed = false, reviewing = false, active = false, reconcileNeeded = false, timer, interval;
  let tail = Promise.resolve(), status = null, error = null, watchError = null;
  const watchers = [];
  const queue = (task) => {
    const pending = tail.then(() => disposed ? undefined : task());
    tail = pending.catch(() => {});
    return pending;
  };
  const publish = () => { if (!disposed) refresh(); };
  const warn = (message) => { if (!disposed) vscode.window.showWarningMessage(`AI Acolyte: ${message}`); };
  const installed = (report) => report?.target?.on || report?.target?.shadowedPaths?.length > 0;

  async function inspect() {
    const report = await run('codexNativeGates');
    if (!disposed) status = report;
    return report;
  }

  async function reconcile() {
    return queue(async () => {
      if (reviewing) { reconcileNeeded = true; return; }
      try {
        await run('refreshCodexNativeGates');
        if (disposed) return;
        await inspect();
        if (!disposed) error = null;
      } catch (failure) {
        if (disposed) return;
        error = failure.message;
        try { await inspect(); } catch { /* keep the useful refresh failure */ }
      }
      publish();
    });
  }

  function schedule() {
    if (disposed) return;
    clearTimeout(timer);
    timer = setTimeout(() => { timer = null; void reconcile(); }, debounceMs);
    timer.unref?.();
  }

  function watch() {
    if (disposed) return;
    for (const watcher of watchers.splice(0)) watcher?.dispose();
    watchError = null;
    try {
      const native = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(codexHome, 'memories{,/**}'));
      const changed = (uri) => {
        if (uri?.scheme && uri.scheme !== 'file') return;
        if (typeof uri?.fsPath !== 'string') return;
        const relative = path.relative(path.join(codexHome, 'memories'), uri.fsPath).replace(/\\/g, '/');
        const name = process.platform === 'win32' ? relative.toLowerCase() : relative;
        if (name === '' || name === 'memory_summary.md' || name === (process.platform === 'win32' ? 'memory.md' : 'MEMORY.md')
          || name === 'rollout_summaries' || /^rollout_summaries\/[^/]+\.md$/.test(name)
          || name === 'skills' || (process.platform === 'win32' ? /^skills\/[^/]+(?:\/skill\.md)?$/ : /^skills\/[^/]+(?:\/SKILL\.md)?$/).test(name)) schedule();
      };
      watchers.push(native, native.onDidCreate(changed), native.onDidChange(changed), native.onDidDelete(changed));
      const instructions = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(codexHome, 'AGENTS{,.override}.md'));
      watchers.push(instructions, instructions.onDidCreate(schedule), instructions.onDidChange(schedule), instructions.onDidDelete(schedule));
      const parent = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(path.dirname(codexHome), '*'));
      const homeChanged = (uri) => {
        if (typeof uri?.fsPath === 'string' && (!uri.scheme || uri.scheme === 'file') && path.relative(codexHome, uri.fsPath) === '') {
          watch(); schedule();
        }
      };
      watchers.push(parent, parent.onDidCreate(homeChanged), parent.onDidDelete(homeChanged));
    } catch (failure) {
      for (const watcher of watchers.splice(0)) watcher?.dispose();
      watchError = `Native Codex gate watching is unavailable: ${failure.message}. Periodic refresh remains active.`;
    }
  }

  async function review() {
    if (disposed || reviewing) return;
    reviewing = true;
    try {
      const report = await queue(inspect);
      if (disposed) return;
      if (!report.readable) { warn(report.target?.error || 'The Codex instruction target cannot be read.'); return; }
      const on = installed(report);
      if (!on && !report.canEnable) {
        warn(report.complete
          ? 'No explicit global gate sections were found. Native memory must declare scope: global in leading frontmatter and use paired <!-- gate --> / <!-- /gate --> markers outside code fences.'
          : `Native Codex gates cannot be installed: the source compilation is ${report.compilationState}.`);
        return;
      }
      const installAction = on ? 'Refresh gates' : 'Install gates';
      const choices = report.canEnable ? [installAction] : [];
      if (on) choices.push('Remove gates');
      const choice = await vscode.window.showInformationMessage(on ? 'Review native Codex memory gates' : 'Install native Codex memory gates?',
        { modal: true, detail: `${report.target.path}\n\n`
          + (report.complete ? (report.body || 'No explicit global sections remain in the current readable memory files.')
            : `Current sources are ${report.compilationState}. The installed instructions have been retained; they can still be removed.`)
          + '\n\nOnly explicitly marked global sections are compiled. While this extension is running, edits to those annotations automatically update this installed block. Remove stops automatic updates. Native source files and other instruction blocks are preserved. Start a new Codex session to load instruction changes.' }, ...choices);
      if (disposed || !choices.includes(choice)) return;
      const enabled = choice !== 'Remove gates';
      const result = await queue(async () => {
        if (disposed) return;
        return run('setCodexNativeGates', { enabled, fingerprint: enabled ? report.fingerprint : report.removalFingerprint });
      });
      if (disposed) return;
      await queue(inspect);
      if (disposed) return;
      if (result.on !== enabled || status.target?.error || Boolean(installed(status)) !== enabled
        || (enabled && (!status.target.current || status.bodyHash !== report.bodyHash))) {
        warn('The native Codex gate change could not be confirmed. Inspect the instruction target before trying again.');
        return;
      }
      error = null;
      vscode.window.showInformationMessage(enabled
        ? `AI Acolyte: installed ${result.count} native Codex gate sections. Start a new Codex session to load them.`
        : 'AI Acolyte: native Codex memory gates removed and automatic updates stopped. Start a new Codex session to load the change.');
    } catch (failure) { error = failure.message; warn(error); }
    finally {
      reviewing = false;
      if (reconcileNeeded) { reconcileNeeded = false; schedule(); }
      publish();
    }
  }

  return {
    review, reconcile,
    status: () => ({ on: Boolean(installed(status)), count: status?.count ?? null,
      current: status?.target?.current === true, path: status?.target?.path || path.join(codexHome, 'AGENTS.md'),
      compilationState: status?.compilationState || 'pending', error: error || status?.target?.error || null, watchError }),
    activate() {
      if (disposed || active) return;
      active = true; watch();
      interval = setInterval(() => { watch(); void reconcile(); }, reconcileMs);
      interval.unref?.();
      void reconcile();
    },
    dispose() {
      disposed = true;
      clearTimeout(timer); clearInterval(interval);
      for (const watcher of watchers.splice(0)) watcher?.dispose();
    },
  };
}

module.exports = { createCodexMemoryGatesUi };
