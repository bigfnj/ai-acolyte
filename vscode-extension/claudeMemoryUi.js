'use strict';

// The Claude memory card's Search and Inspect (2026-10-19). Built the way codexFeaturesUi.js builds
// the Codex memory card's, so the two cards offer the same actions and the user's request for
// feature parity holds at the code level too. The runners are injected:
//   search(query)  recall.py --json over the store the card shows; resolves to its JSON, or to
//                  { unavailable: reason } when Python, the script or the store is missing
//   sources()      every Claude memory store found, the one the card shows, its issues and gates
// Nothing here spawns a process or reads a file, so a test drives it with fakes.

function createClaudeMemoryUi(vscode, { search, sources }) {
  let disposed = false;
  const warn = (message) => { if (!disposed) vscode.window.showWarningMessage(`AI Acolyte: ${message}`); };

  async function searchMemory() {
    try {
      const query = await vscode.window.showInputBox({ title: 'AI Acolyte: Search Claude memory',
        prompt: 'Search your Claude Code memory files by meaning and keywords.',
        placeHolder: 'Words from the decision, fact or preference you want to recall' });
      if (disposed || !query?.trim()) return;
      const answer = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification,
        title: 'AI Acolyte: searching Claude memory on CPU', cancellable: false }, () => search(query.trim()));
      if (disposed) return;
      if (answer?.unavailable) { warn(`Claude memory search is unavailable: ${answer.unavailable}`); return; }
      // The same notice the Codex search gives when it has no model to rank by meaning.
      if (answer.mode === 'lexical') warn(`Claude memory search is using keyword matches. ${answer.reason || ''}`.trim());
      const results = (Array.isArray(answer.results) ? answer.results : [])
        .filter((result) => result && typeof result.path === 'string' && result.path);
      if (!results.length) { warn('No matching Claude memories.'); return; }
      const pick = await vscode.window.showQuickPick(results.map((result) => ({
        label: String(result.name || '').replace(/\.md$/i, ''),
        description: Number.isInteger(result.line) ? `line ${result.line}` : '',
        detail: [result.description, result.excerpt].filter(Boolean).join(' · '),
        result,
      })), { title: answer.mode === 'hybrid' ? 'AI Acolyte: Claude memory matches by meaning and keywords'
        : 'AI Acolyte: Claude memory matches', matchOnDescription: true, matchOnDetail: true,
      placeHolder: 'Open a memory at its matching line' });
      if (disposed || !pick) return;
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(pick.result.path));
      if (disposed) return;
      const line = Math.max(0, Math.min(document.lineCount - 1, (Number(pick.result.line) || 1) - 1));
      await vscode.window.showTextDocument(document, { preview: true, selection: document.lineAt(line).range });
    } catch (error) { warn(error.message); }
  }

  // A plain-text report, like the Codex card's Inspect: which stores exist, which one the card
  // shows (Claude Code reads the store of the project it runs in), and what is wrong in it.
  async function inspectMemory() {
    try {
      const report = await sources();
      if (disposed) return;
      const stores = Array.isArray(report?.stores) ? report.stores : [];
      const issues = Array.isArray(report?.issues) ? report.issues : [];
      const lines = ['Claude Code memory', report?.primary || '(no store found)',
        'Claude Code loads MEMORY.md from the memory store of the project a session runs in.'
          + ' This card shows the store above. This report changes nothing.', '',
        `Stores found: ${stores.length}`,
        ...stores.map((store) => `${store.primary ? '* ' : '  '}${store.dir}: ${store.files} file${store.files === 1 ? '' : 's'}`
          + (store.lines == null ? '' : `, MEMORY.md ${store.lines} line${store.lines === 1 ? '' : 's'}`)
          + (store.tokens == null ? '' : `, about ${store.tokens} tokens per session`)
          + (store.primary ? '   (shown on the card)' : '')), '',
        `Issues in the store shown: ${issues.length ? '' : 'none'}`, ...issues.map((issue) => `  ${issue}`), '',
        report?.gates ? `Memory gates: ${report.gates}` : 'Memory gates: none compiled'];
      const document = await vscode.workspace.openTextDocument({ language: 'plaintext', content: lines.join('\n') });
      if (disposed) return;
      await vscode.window.showTextDocument(document, { preview: true });
    } catch (error) { warn(error.message); }
  }

  return { searchMemory, inspectMemory, dispose() { disposed = true; } };
}

module.exports = { createClaudeMemoryUi };
