'use strict';

// A separate explicit review path for Codex MCP configuration. MCP identities
// never enter the shell-rule exporter or Claude's permission namespace.
const { planCodexMcpApproval, applyCodexMcpApproval, restoreCodexMcpApproval,
  inspectPending, listCodexMcpApprovals, assertReady, finishPending } = require('./codex-mcp-config');
const nativeConfig = { planCodexMcpApproval, applyCodexMcpApproval, restoreCodexMcpApproval,
  inspectPending, listCodexMcpApprovals, assertReady, finishPending };

function createCodexMcpReview({ options, loadState, fingerprint, assertRulesReady, config = nativeConfig }) {
  function candidate(state, item) {
    if (item?.kind !== 'tool' || item.tool !== 'CodexMCP' || !Array.isArray(item.prefix) || item.prefix.length !== 2 ||
        item.key !== `codex-mcp:${JSON.stringify(item.prefix)}` ||
        item.prefix.some((part) => typeof part !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(part)) ||
        item.claudePermission || item.sources?.length !== 1 || item.sources[0] !== 'codex') return null;
    const reason = state.codexEvidenceRebuildPending || item.evidencePending ? 'Codex evidence is still being rebuilt.'
      : state.mode === 'observe' ? 'Auto Learn is in observe mode. Change mode before reviewing an approval.'
        : item.counts.success < item.threshold ? `${item.counts.success} successful runs; ${item.threshold} required before review.` : null;
    return { key: item.key, server: item.prefix[0], tool: item.prefix[1], counts: { ...item.counts },
      threshold: item.threshold, fingerprint: fingerprint(item), eligible: !reason, reason };
  }
  function selected(request) {
    const state = loadState();
    const item = candidate(state, state.candidates[request?.key]);
    if (!item?.eligible) throw new Error(item?.reason || 'This is not a reviewable Codex MCP candidate.');
    if (request.expectedCandidateFingerprint !== undefined && request.expectedCandidateFingerprint !== item.fingerprint) {
      throw new Error('Codex MCP evidence changed after review. Open the review again.');
    }
    return item;
  }
  function inventory() {
    const state = loadState();
    return { candidates: Object.values(state.candidates).map((item) => candidate(state, item)).filter(Boolean),
      receipts: config.listCodexMcpApprovals(options), pending: config.inspectPending(options) };
  }
  function plan(request) {
    assertRulesReady();
    config.assertReady(options);
    const item = selected(request);
    const proposal = config.planCodexMcpApproval({ ...options, server: item.server, tool: item.tool });
    return { candidate: item, proposal };
  }
  function apply(request) {
    assertRulesReady();
    const item = selected(request);
    if (typeof request.expectedCandidateFingerprint !== 'string' || typeof request.expectedConfigFingerprint !== 'string') {
      throw new Error('Review the current Codex MCP evidence and exact config proposal before applying.');
    }
    return config.applyCodexMcpApproval({ server: item.server, tool: item.tool,
      expectedFingerprint: request.expectedConfigFingerprint }, options);
  }
  function restore(request) {
    assertRulesReady();
    if (typeof request?.receiptId !== 'string') throw new Error('Select a saved Codex MCP approval to undo.');
    return config.restoreCodexMcpApproval(request.receiptId, options);
  }
  function recover(request) {
    // The config intent itself is pending, so only inspect the shell-rule
    // journal here. Its separate pending write must not be bypassed by recovery.
    assertRulesReady({ allowMcpPending: true });
    return config.finishPending(request, options);
  }
  return { inventory, plan, apply, restore, recover };
}

module.exports = { createCodexMcpReview };
