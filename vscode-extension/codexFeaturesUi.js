'use strict';

function shared(name) {
  try { return require(`./src/${name}`); }
  catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    return require(`../src/${name}`);
  }
}

function codexFeatureStatus(options = {}) {
  let memory;
  try { memory = require('./src/codex-memory').discoverCodexMemory(options); }
  catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    memory = require('../src/codex-memory').discoverCodexMemory(options);
  }
  return { root: memory.root, state: memory.storageState, files: memory.files.length,
    diagnostics: memory.diagnostics.length, featureState: memory.featureState };
}

function createCodexFeaturesUi(vscode, { readMemory, rebuildMemory, runRules, profileOptions = {}, refresh = () => {} }) {
  let disposed = false;
  const warn = (message) => { if (!disposed) vscode.window.showWarningMessage(`AI Acolyte: ${message}`); };

  async function configureHook() {
    try {
      const { inspectCodexHook, setCodexHook } = shared('codex-hook-install');
      const status = inspectCodexHook(profileOptions);
      if (disposed) return;
      if (!status.writable) { warn(status.reason); return; }
      const enabled = !status.configured;
      const action = enabled ? 'Configure hook' : 'Remove hook';
      const command = process.platform === 'win32'
        ? status.definition.hooks[0].commandWindows : status.definition.hooks[0].command;
      const choice = await vscode.window.showInformationMessage(
        enabled ? 'Learn from Codex turns while the editor is closed?' : 'Remove Codex after-turn learning?',
        { modal: true, detail: `${status.path}\n\n${command}\n\n`
          + (enabled
            ? 'After each completed turn, this hook reads Codex history using your current Auto Learn mode. Configure it here, then review this exact hook in Codex /hooks before it can run.'
            : 'Remove this exact AI Acolyte hook. Other hooks and the current Auto Learn mode are preserved.') }, action);
      if (disposed || choice !== action) return;
      const result = setCodexHook(enabled, profileOptions);
      refresh();
      vscode.window.showInformationMessage(result.configured
        ? 'AI Acolyte: hook configured. Review it in Codex /hooks; configuration alone does not activate it.'
        : 'AI Acolyte: Codex after-turn hook removed.');
    } catch (error) { warn(error.message); }
  }

  async function searchMemory() {
    try {
      const query = await vscode.window.showInputBox({ title: 'AI Acolyte: Search Codex memory',
        prompt: 'Search the native summary, task registry, rollout summaries and memory skills.',
        placeHolder: 'Words from the task or decision you want to recall' });
      if (disposed || !query?.trim()) return;
      const memory = await readMemory(query.trim());
      if (disposed) return;
      if (memory.storageState === 'absent') { warn(`No native memory files at ${memory.root}.`); return; }
      const chunks = memory.chunks || [];
      if (memory.storageState === 'unreadable') warn('Some Codex memory files could not be read. Search results include readable sources only; inspect Codex memory for details.');
      if (memory.retrieval?.mode === 'lexical') warn(`Codex memory search is using keyword matches. ${memory.retrieval.reason}`);
      if (memory.retrieval?.cacheWarning) warn(`Codex memory search completed, but its cache could not be saved: ${memory.retrieval.cacheWarning}`);
      if (!chunks.length) { warn('No matching Codex memory passages.'); return; }
      const pick = await vscode.window.showQuickPick(chunks.map((chunk) => ({
        label: chunk.title || chunk.relativePath,
        description: `${chunk.relativePath}:${chunk.startLine}`,
        detail: chunk.text,
        chunk,
      })), { title: memory.retrieval?.mode === 'hybrid' ? 'AI Acolyte: Codex memory matches by meaning and keywords'
        : 'AI Acolyte: Codex memory matches', matchOnDescription: true, matchOnDetail: true,
        placeHolder: 'Open a passage in its source file' });
      if (disposed || !pick) return;
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(pick.chunk.path));
      if (disposed) return;
      // VS Code removes a file's leading UTF-8 BOM from TextDocument text. The
      // adapter preserves original source offsets and declares the BOM explicitly.
      const bomLength = pick.chunk.hasUtf8Bom === true ? 1 : 0;
      const startOffset = Math.max(0, pick.chunk.startOffset - bomLength);
      const endOffset = Math.max(0, pick.chunk.endOffset - bomLength);
      const passage = bomLength && pick.chunk.startOffset === 0 ? pick.chunk.text.slice(1) : pick.chunk.text;
      if (document.getText().slice(startOffset, endOffset) !== passage) {
        warn('This Codex memory changed after the search. Search again to get current passage locations.');
        return;
      }
      const selection = new vscode.Range(document.positionAt(startOffset), document.positionAt(endOffset));
      await vscode.window.showTextDocument(document, { preview: true, selection });
    } catch (error) { warn(error.message); }
  }

  async function rebuildMemoryIndex() {
    try {
      const report = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification,
        title: 'AI Acolyte: rebuilding Codex memory recall on CPU', cancellable: false }, () => rebuildMemory());
      if (disposed) return;
      if (!report.retrieval?.rebuilt || report.retrieval.mode !== 'hybrid') {
        warn(report.retrieval?.reason || 'No Codex memory passages were available to index.');
        return;
      }
      if (report.retrieval.cacheWarning) { warn(`The Codex memory cache could not be saved: ${report.retrieval.cacheWarning}`); return; }
      refresh();
      vscode.window.showInformationMessage(`AI Acolyte: indexed ${report.retrieval.indexedChunks} Codex memory passages for search by meaning and keywords.`);
    } catch (error) { warn(error.message); }
  }

  async function inspectMemory() {
    try {
      const memory = await readMemory();
      if (disposed) return;
      const lines = ['Codex native memory', memory.root,
        `Storage: ${memory.storageState}; feature enablement: ${memory.featureState}`,
        'Feature enablement is not inferred from files. This report does not enable or generate memories.', '',
        ...memory.files.map((file) => `${file.relativePath}: ${file.readable === false ? 'unreadable' : `${file.size} bytes, ${file.lineCount ?? '?'} lines`}`), '',
        ...memory.diagnostics.map((item) => `${item.relativePath || '(memory root)'}: ${item.message}`)];
      const document = await vscode.workspace.openTextDocument({ language: 'plaintext', content: lines.join('\n') });
      if (disposed) return;
      await vscode.window.showTextDocument(document, { preview: true });
    } catch (error) { warn(error.message); }
  }

  async function reviewRules(kind = 'stored-widening') {
    try {
      const inventory = await runRules('codexApprovalInventory', kind);
      if (disposed) return;
      if (inventory.pendingRemoval || inventory.pendingRestore) {
        warn(inventory.pendingRestore ? 'Finish the interrupted restore in Restore Codex rules first.'
          : 'Finish the interrupted removal in Show Codex rules first.');
        return;
      }
      let request;
      if (inventory.pendingApproval) {
        const choice = await vscode.window.showWarningMessage('Finish interrupted Codex reviewed change?',
          { modal: true, detail: 'Finish the exact rule change you already confirmed. Concurrent edits are preserved. Restart Codex after completion.' }, 'Finish change');
        if (disposed || choice !== 'Finish change') return;
        request = { resume: true };
      } else {
        const rows = [
          ...inventory.plans.map((plan) => ({ label: JSON.stringify(plan.target.pattern),
            description: `${plan.target.decision} · ${plan.kind === 'project-import' ? 'project import' : 'wider approval'}`,
            detail: plan.source.path, plan })),
          ...inventory.files.filter((file) => file.supported === false).map((file) => ({
            label: file.path || file.source?.path, description: 'Read-only', detail: file.reason })),
          ...inventory.skipped.map((item) => ({ label: JSON.stringify(item.source?.pattern || item.target?.pattern || []),
            description: 'Not proposed', detail: item.reason })),
        ];
        if (!rows.length) { warn(inventory.reason || 'No Codex rule changes to propose.'); return; }
        const pick = await vscode.window.showQuickPick(rows, { title: kind === 'project-import'
          ? 'Import project Codex rules' : 'Review Codex approvals', matchOnDescription: true, matchOnDetail: true,
          placeHolder: 'Review one proposal; skipped and unsupported rules are read-only' });
        if (disposed || !pick) return;
        if (!pick.plan) { warn(pick.detail); return; }
        const plan = pick.plan;
        const detail = `Source: ${plan.source.path}\n${plan.source.text}\n\n`
          + `Add in user scope: ${inventory.destination.path || inventory.destination}\n${plan.target.text}\n\n`
          + (plan.dependencies?.length ? 'Preserve accompanying restrictions:\n'
            + plan.dependencies.map((item) => `${item.source?.path || item.path}\n${item.target?.text || item.text}`).join('\n\n') + '\n\n' : '')
          + `${plan.reviewReason}\nThe source remains unchanged. This applies across workspaces. Restart Codex to load the change.`;
        const choice = await vscode.window.showWarningMessage('Apply this reviewed Codex rule change?',
          { modal: true, detail }, 'Apply change');
        if (disposed || choice !== 'Apply change') return;
        request = { kind, id: plan.id };
      }
      const result = await runRules('approveCodexRules', request);
      if (disposed) return;
      if (!result.changed || !Number.isInteger(result.addedCount) || result.addedCount < 1) {
        warn('No Codex rule was added. Open the review again to refresh the proposal.');
        return;
      }
      refresh();
      vscode.window.showInformationMessage(`AI Acolyte: added ${result.addedCount} reviewed Codex rule${result.addedCount === 1 ? '' : 's'}. Restart Codex to load the change.`);
    } catch (error) { warn(error.message); }
  }

  async function reviewMcp() {
    try {
      const inventory = await runRules('codexMcpInventory');
      if (disposed) return;
      let operation, request;
      if (inventory.pending) {
        const pending = inventory.pending;
        const choice = await vscode.window.showWarningMessage('Resolve interrupted Codex MCP change?',
          { modal: true, detail: `${pending.server} / ${pending.tool}\n${pending.path}\n\n`
            + 'Inspect the saved change against the current configuration. An unwritten change is cancelled; a completed exact change is recorded. Other edits require manual review. This does not retry the config write.' }, 'Resolve change');
        if (disposed || choice !== 'Resolve change') return;
        operation = 'recoverCodexMcp'; request = { id: pending.id, acceptedHash: pending.currentHash };
      } else {
        const rows = [
          ...inventory.candidates.map((item) => ({ label: `${item.server} / ${item.tool}`,
            description: item.eligible ? 'Review exact tool approval' : 'Not ready for review',
            detail: item.reason || `${item.counts.success} successful, ${item.counts.failed} failed, ${item.counts.unknown} unknown runs`, candidate: item })),
          ...inventory.receipts.filter((item) => !item.restored).map((receipt) => ({ label: `${receipt.server} / ${receipt.tool}`,
            description: receipt.undoable ? 'Undo saved tool approval' : 'Saved approval needs review',
            detail: receipt.reason || receipt.path, receipt })),
        ];
        if (!rows.length) { warn('No Codex MCP tool evidence or saved approvals to review. Scan completed Codex history first.'); return; }
        const pick = await vscode.window.showQuickPick(rows, { title: 'Review Codex MCP approvals', matchOnDescription: true,
          placeHolder: 'Approve one exact server/tool pair or undo a saved approval' });
        if (disposed || !pick) return;
        if (pick.receipt) {
          const receipt = pick.receipt;
          if (!receipt.undoable) { warn(receipt.reason || 'This saved approval cannot be undone until the changed configuration is reviewed.'); return; }
          const prior = receipt.beforeApproval.exists ? receipt.beforeApproval.value : 'no explicit override';
          const choice = await vscode.window.showWarningMessage('Undo this Codex MCP approval?',
            { modal: true, detail: `${receipt.server} / ${receipt.tool}\n${receipt.path}\n\n`
              + `Restore the previous per-tool setting: ${prior}. Other server settings and project trust are preserved. A changed configuration is left for review. Restart Codex afterward.` }, 'Undo approval');
          if (disposed || choice !== 'Undo approval') return;
          operation = 'undoCodexMcp'; request = { receiptId: receipt.id };
        } else {
          if (!pick.candidate.eligible) { warn(pick.candidate.reason); return; }
          const reviewed = await runRules('planCodexMcp', { key: pick.candidate.key,
            expectedCandidateFingerprint: pick.candidate.fingerprint });
          if (disposed) return;
          const { candidate, proposal } = reviewed;
          if (!proposal.supported) { warn(proposal.reason); return; }
          if (proposal.explicitApprovalMode === 'approve') { warn('This exact Codex MCP tool already has an explicit approval.'); return; }
          const choice = await vscode.window.showWarningMessage('Approve this exact Codex MCP tool?',
            { modal: true, detail: `${candidate.server} / ${candidate.tool}\n${proposal.source.path}\n\n`
              + `${candidate.counts.success} successful, ${candidate.counts.failed} failed, ${candidate.counts.unknown} unknown runs.\n`
              + `Current effective mode: ${proposal.effectiveApprovalMode ?? 'Codex default'}. New per-tool mode: approve.\n\n`
              + 'Future calls to this exact tool can run without per-call approval, including different arguments. Tool behavior is not classified as safe. This user setting applies across workspaces. Other tools, server settings and project trust are preserved. Codex may normalize line endings. Restart Codex to load it.' }, 'Approve tool');
          if (disposed || choice !== 'Approve tool') return;
          operation = 'approveCodexMcp'; request = { key: candidate.key,
            expectedCandidateFingerprint: candidate.fingerprint, expectedConfigFingerprint: proposal.fingerprint };
        }
      }
      const result = await runRules(operation, request);
      if (disposed) return;
      if (!result.changed && !result.cancelled) { warn(result.reason || 'No Codex MCP configuration change was confirmed.'); return; }
      refresh();
      vscode.window.showInformationMessage(result.cancelled ? 'AI Acolyte: unwritten Codex MCP change cancelled.'
        : 'AI Acolyte: Codex MCP change recorded. Restart Codex to load the configuration.');
    } catch (error) { warn(error.message); }
  }

  return { configureHook, searchMemory, inspectMemory, rebuildMemoryIndex, reviewRules, reviewMcp, dispose() { disposed = true; } };
}

module.exports = { codexFeatureStatus, createCodexFeaturesUi };
