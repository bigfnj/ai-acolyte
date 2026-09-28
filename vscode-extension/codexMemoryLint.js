'use strict';

const path = require('path');

// The extension host owns notifications only. Discovery and content reads are
// supplied asynchronously by the worker. Native files and settings are untouched.
class CodexMemoryLint {
  constructor(vscode, { readMemory, codexHome, enabled = () => true, onRefresh = () => {},
    debounceMs = 250, reconcileMs = 300000 }) {
    if (typeof readMemory !== 'function' || typeof enabled !== 'function' || typeof onRefresh !== 'function') {
      throw new TypeError('CodexMemoryLint requires readMemory, enabled and onRefresh functions');
    }
    if (typeof codexHome !== 'string' || !path.isAbsolute(codexHome)) throw new TypeError('codexHome must be an absolute path');
    if (!Number.isFinite(debounceMs) || debounceMs < 0 || !Number.isFinite(reconcileMs) || reconcileMs <= 0) {
      throw new TypeError('debounceMs must be nonnegative and reconcileMs must be positive');
    }
    this.vscode = vscode;
    this.readMemory = readMemory;
    this.codexHome = path.resolve(codexHome);
    this.enabled = enabled;
    this.onRefresh = onRefresh;
    this.debounceMs = debounceMs;
    this.reconcileMs = reconcileMs;
    this.active = false;
    this.disposed = false;
    this.generation = 0;
    this.watchers = [];
    this.timer = null;
    this.reconcileTimer = null;
    this.diagnostics = null;
    this.lastReport = null;
  }

  // Returns this, not the initial worker promise. refresh() can be awaited when
  // a caller needs a completed snapshot; activation itself never blocks the host.
  activate() {
    if (this.disposed || this.active) return this;
    this.active = true;
    this.diagnostics = this.vscode.languages.createDiagnosticCollection('codex-memory');
    this.reconcileTimer = setInterval(() => this.reconfigure(), this.reconcileMs);
    this.reconcileTimer.unref?.();
    this.reconfigure();
    return this;
  }

  disposeWatchers() {
    for (const watcher of this.watchers.splice(0)) watcher.dispose();
  }

  isRelevant(uri) {
    if (!uri || (uri.scheme && uri.scheme !== 'file') || typeof uri.fsPath !== 'string') return false;
    const root = path.join(this.codexHome, 'memories');
    const relative = path.relative(root, uri.fsPath).replace(/\\/g, '/');
    if (relative === '') return true;
    if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) return false;
    const insensitive = process.platform === 'win32';
    const name = insensitive ? relative.toLowerCase() : relative;
    return name === (insensitive ? 'memory.md' : 'MEMORY.md') || name === 'memory_summary.md' ||
      name === 'rollout_summaries' || /^rollout_summaries\/[^/]+\.md$/.test(name) ||
      name === 'skills' || (insensitive ? /^skills\/[^/]+(?:\/skill\.md)?$/ : /^skills\/[^/]+(?:\/SKILL\.md)?$/).test(name);
  }

  watch() {
    // The base is CODEX_HOME, not the possibly absent memories directory. Its
    // creation therefore refreshes discovery without requiring an existing store.
    const watcher = this.vscode.workspace.createFileSystemWatcher(
      new this.vscode.RelativePattern(this.codexHome, 'memories{,/**}'));
    const changed = (uri) => { if (this.isRelevant(uri)) this.schedule(); };
    this.watchers.push(watcher);
    this.watchers.push(watcher.onDidCreate(changed), watcher.onDidChange(changed), watcher.onDidDelete(changed));
    // A removed/recreated selected home needs a new recursive subscription. The
    // parent watcher observes that transition without scanning a different home.
    const parent = this.vscode.workspace.createFileSystemWatcher(
      new this.vscode.RelativePattern(path.dirname(this.codexHome), '*'));
    const homeChanged = (uri) => {
      if (uri?.scheme && uri.scheme !== 'file') return;
      if (typeof uri?.fsPath !== 'string') return;
      if (path.relative(this.codexHome, uri.fsPath) === '') this.reconfigure();
    };
    this.watchers.push(parent);
    this.watchers.push(parent.onDidCreate(homeChanged), parent.onDidDelete(homeChanged));
  }

  reconfigure({ codexHome = this.codexHome } = {}) {
    if (this.disposed) return this;
    if (typeof codexHome !== 'string' || !path.isAbsolute(codexHome)) throw new TypeError('codexHome must be an absolute path');
    this.codexHome = path.resolve(codexHome);
    this.generation += 1;
    clearTimeout(this.timer); this.timer = null;
    this.disposeWatchers();
    this.diagnostics?.clear();
    if (!this.active) return this;
    if (this.enabled() === false) {
      this.lastReport = null;
      this.notify(null);
      return this;
    }
    this.watchError = null;
    try { this.watch(); } catch (error) {
      this.disposeWatchers();
      this.watchError = `Native Codex memory watching is unavailable: ${error.message || error}`;
    }
    void this.refresh();
    return this;
  }

  schedule() {
    if (this.disposed || !this.active || this.enabled() === false) return;
    // Invalidate an older in-flight read immediately, rather than allowing it to
    // repaint stale diagnostics during the debounce interval after a file edit.
    this.generation += 1;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; void this.refresh(); }, this.debounceMs);
    this.timer.unref?.();
  }

  notify(report) {
    if (this.disposed) return;
    try {
      Promise.resolve(this.onRefresh(report)).catch((error) => console.error('AI Acolyte: Codex memory refresh callback failed:', error));
    } catch (error) { console.error('AI Acolyte: Codex memory refresh callback failed:', error); }
  }

  async refresh() {
    if (this.disposed || !this.active) return null;
    clearTimeout(this.timer); this.timer = null;
    const generation = ++this.generation;
    const codexHome = this.codexHome;
    if (this.enabled() === false) {
      this.diagnostics.clear(); this.lastReport = null; this.notify(null);
      return null;
    }
    let report;
    try {
      report = await this.readMemory({ codexHome });
      if (!report || typeof report !== 'object' || !Array.isArray(report.files) || !Array.isArray(report.diagnostics)) {
        throw new Error('Worker returned an invalid native-memory descriptor');
      }
      if (!report.files.every((file) => file && typeof file.path === 'string') ||
        !report.diagnostics.every((item) => item && typeof item.path === 'string' && typeof item.message === 'string')) {
        throw new Error('Worker returned invalid native-memory source metadata');
      }
      if (path.resolve(report.root || '') !== path.join(codexHome, 'memories')) {
        throw new Error('Worker returned native memory from a different Codex profile');
      }
    } catch (error) {
      report = { agent: 'codex', codexHome, root: path.join(codexHome, 'memories'),
        state: 'unreadable', storageState: 'unreadable', featureState: 'unknown',
        files: [], chunks: [], diagnostics: [], error: `Native Codex memory could not be read: ${error.message || error}` };
    }
    if (this.disposed || !this.active || generation !== this.generation || this.enabled() === false) return null;
    if (this.watchError) report = { ...report, watchError: this.watchError };
    this.publishDiagnostics(report);
    this.lastReport = report;
    this.notify(report);
    return report;
  }

  publishDiagnostics(report) {
    this.diagnostics.clear();
    const files = new Set(report.files.map((file) => path.resolve(file.path)));
    const grouped = new Map();
    for (const item of report.diagnostics) {
      // Directory/root failures remain in the report for the dashboard. They are
      // not fabricated file Problems entries pointing at an unopenable directory.
      if (typeof item.path !== 'string' || !files.has(path.resolve(item.path))) continue;
      const relative = path.relative(report.root, item.path);
      if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) continue;
      const line = Number.isSafeInteger(item.line) && item.line >= 0 ? item.line : 0;
      const severity = { error: this.vscode.DiagnosticSeverity.Error, warning: this.vscode.DiagnosticSeverity.Warning,
        information: this.vscode.DiagnosticSeverity.Information, info: this.vscode.DiagnosticSeverity.Information,
        hint: this.vscode.DiagnosticSeverity.Hint }[item.severity] ?? this.vscode.DiagnosticSeverity.Warning;
      const diagnostic = new this.vscode.Diagnostic(new this.vscode.Range(line, 0, line, 1), String(item.message), severity);
      diagnostic.source = 'Codex native memory'; diagnostic.code = item.code;
      if (!grouped.has(item.path)) grouped.set(item.path, []);
      grouped.get(item.path).push(diagnostic);
    }
    for (const [file, diagnostics] of grouped) this.diagnostics.set(this.vscode.Uri.file(file), diagnostics);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true; this.active = false; this.generation += 1;
    clearTimeout(this.timer); clearInterval(this.reconcileTimer);
    this.timer = null; this.reconcileTimer = null;
    this.disposeWatchers();
    this.diagnostics?.clear(); this.diagnostics?.dispose();
    this.lastReport = null;
  }
}

module.exports = { CodexMemoryLint };
