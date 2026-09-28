'use strict';

// A development extension, not an extension-test entry point. Native Review's
// Grant dialog is deliberately disabled by VS Code's extension-test mode.
const vscode = require('vscode');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

const samePath = (left, right) => path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();

function ownedFixture() {
  assert.equal(process.env.ACOLYTE_ACCEPTANCE_OWNED_HOST, '1', 'normal acceptance host must be explicitly owned');
  assert.equal(process.env.ACOLYTE_ACCEPTANCE_REVIEW_RUNTIME, '1', 'driver is reserved for native Review acceptance');
  const home = process.env.ACOLYTE_ACCEPTANCE_HOME;
  const report = process.env.ACOLYTE_ACCEPTANCE_REPORT;
  const codexHome = process.env.ACOLYTE_ACCEPTANCE_CODEX_HOME;
  const extensionDir = process.env.ACOLYTE_ACCEPTANCE_EXTENSION;
  const progress = process.env.ACOLYTE_ACCEPTANCE_REVIEW_PROGRESS;
  for (const [label, value] of Object.entries({ home, report, codexHome, extensionDir, progress })) {
    assert.ok(typeof value === 'string' && path.isAbsolute(value), `missing absolute ${label} fixture path`);
  }
  const root = path.dirname(report);
  assert.ok(path.basename(root).startsWith('acolyte-vscode-drive-'), 'acceptance report is not inside the owned fixture');
  assert.equal(path.basename(report), 'acceptance.json');
  assert.ok(samePath(home, path.join(root, 'home')));
  assert.ok(samePath(os.homedir(), home));
  assert.ok(samePath(process.env.HOME, home) && samePath(process.env.USERPROFILE, home));
  assert.ok(samePath(process.env.CODEX_HOME, codexHome));
  assert.ok(samePath(codexHome, path.join(home, '.codex')) || samePath(codexHome, path.join(root, 'custom-codex')));
  assert.ok(samePath(path.dirname(progress), root));
  assert.equal(vscode.workspace.workspaceFolders?.length, 1, 'acceptance driver requires exactly its owned workspace');
  assert.ok(samePath(vscode.workspace.workspaceFolders[0].uri.fsPath, path.join(root, 'workspace')));
  return { root, home, report, codexHome, extensionDir, progress };
}

async function runOwnedAcceptance() {
  // Refuse to run or quit an editor unless the launcher supplies every isolation
  // invariant. The launcher uses a separate --user-data-dir and process instance.
  let fixture;
  try { fixture = ownedFixture(); }
  catch (error) { console.error('Acolyte acceptance driver refused the host:', error.stack || error.message); return; }
  let failure;
  try { await require(process.env.ACOLYTE_ACCEPTANCE_NATIVE_GATES_ONLY === '1' ? './native-gates'
    : process.env.ACOLYTE_ACCEPTANCE_RECALL_ONLY === '1' ? './recall'
    : process.env.ACOLYTE_ACCEPTANCE_MCP_ONLY === '1' ? './mcp'
    : process.env.ACOLYTE_ACCEPTANCE_APPROVALS_ONLY === '1' ? './approvals'
    : process.env.ACOLYTE_ACCEPTANCE_FEATURES_ONLY === '1' ? './features' : './index').run(); }
  catch (error) { failure = error.stack || error.message || String(error); }
  finally {
    let report;
    try { report = JSON.parse(fs.readFileSync(fixture.report, 'utf8')); }
    catch { /* A setup failure must still produce a reviewable failure report. */ }
    if (!report || !Array.isArray(report.results)) {
      report = { vscodeVersion: vscode.version, nodeVersion: process.version,
        extensionDir: fixture.extensionDir, home: fixture.home, codexHome: fixture.codexHome,
        codexLayout: process.env.ACOLYTE_ACCEPTANCE_CODEX_LAYOUT,
        results: [{ verdict: 'FAIL', name: 'normal-host acceptance driver produced its report',
          detail: failure || 'Acceptance returned without writing acceptance.json.' }] };
    } else if (failure && !report.results.some((item) => item.verdict === 'FAIL')) {
      report.results.push({ verdict: 'FAIL', name: 'normal-host acceptance driver completed', detail: failure });
    }
    const failed = report.results.some((item) => item.verdict === 'FAIL');
    report.driver = { mode: 'normal-development-host', completedAt: new Date().toISOString(), failed };
    fs.writeFileSync(fixture.report, JSON.stringify(report, null, 2) + '\n');
    fs.writeFileSync(path.join(fixture.root, 'acceptance-driver.json'), JSON.stringify({
      ...report.driver, report: fixture.report, failure: failure || null,
    }, null, 2) + '\n');
    if (failed) {
      const next = `${fixture.progress}.tmp`;
      fs.writeFileSync(next, JSON.stringify({ phase: 'review-runtime-failed',
        detail: failure || report.results.find((item) => item.verdict === 'FAIL').detail,
        updatedAt: new Date().toISOString() }, null, 2) + '\n');
      fs.renameSync(next, fixture.progress);
    }
    // Let the renderer observe the terminal phase and dismiss a failed modal.
    // closeQuickOpen handles an unfinished picker through the public command API.
    try { await vscode.commands.executeCommand('workbench.action.closeQuickOpen'); }
    catch (error) { console.error('Acceptance QuickPick close failed:', error.message); }
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await vscode.commands.executeCommand('workbench.action.quit');
  }
}

exports.activate = function activate() {
  void runOwnedAcceptance().catch((error) => {
    // A report has already been written if quitting fails. The owning launcher
    // has a finite timeout and terminates only this isolated process tree.
    console.error('Acolyte acceptance driver cleanup failed:', error.stack || error.message);
  });
};
