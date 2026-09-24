'use strict';

// Read-only inspection of Codex's cached managed requirements. This module
// deliberately does not edit config.toml or offer an approval-policy toggle.

const fs = require('fs');
const os = require('os');
const path = require('path');

const CODEX_BUNDLE_CACHE = path.join(os.homedir(), '.codex', 'cloud-config-bundle-cache.json');

function readEnterpriseBundle(bundlePath = CODEX_BUNDLE_CACHE) {
  try { return JSON.parse(fs.readFileSync(bundlePath, 'utf8')); }
  catch { return null; }
}

function enterpriseRequirements(bundle) {
  const managed = bundle?.signed_payload?.bundle?.requirements_toml?.enterprise_managed;
  if (!Array.isArray(managed)) return '';
  return managed.map((entry) => String(entry?.contents || '')).join('\n');
}

function allowedApprovalPolicies(bundle) {
  const match = /allowed_approval_policies\s*=\s*\[([^\]]*)\]/.exec(enterpriseRequirements(bundle));
  if (!match) return null;
  return [...match[1].matchAll(/["']([^"']+)["']/g)]
    .map((entry) => entry[1].trim())
    .filter(Boolean);
}

function allowedSandboxModes(bundle) {
  const match = /allowed_sandbox_modes\s*=\s*\[([^\]]*)\]/.exec(enterpriseRequirements(bundle));
  if (!match) return null;
  const values = [...match[1].matchAll(/["']([^"']+)["']/g)]
    .map((entry) => entry[1].trim())
    .filter(Boolean);
  return values.length ? values : null;
}

// The managed rules parser remains intentionally read-only. Its matching
// fidelity is tracked by the Codex certification backlog rather than being
// changed as part of removing MAX.
function enterprisePrefixRules(bundle) {
  const text = enterpriseRequirements(bundle);
  const rules = [];
  for (const block of text.split(/\[\[rules\.prefix_rules\]\]/).slice(1)) {
    const body = block.split(/\n\s*\[/)[0];
    const decision = /decision\s*=\s*["']([^"']+)["']/.exec(body)?.[1];
    if (!decision) continue;
    const roots = [...body.matchAll(/["']([^"']+)["']/g)]
      .map((entry) => entry[1])
      .filter((value) => value !== decision);
    const justification = /justification\s*=\s*["']([^"']*)["']/.exec(body)?.[1] || '';
    const patterns = roots.filter((value) => value !== justification);
    if (patterns.length) rules.push({ decision, patterns, justification });
  }
  return rules;
}

function enterpriseDecisionFor(bundle, argv) {
  const root = String((Array.isArray(argv) ? argv[0] : argv) || '')
    .replace(/\\/g, '/').split('/').pop().toLowerCase().replace(/\.exe$/, '');
  if (!root) return null;
  for (const rule of enterprisePrefixRules(bundle)) {
    if (rule.patterns.some((pattern) => pattern.toLowerCase() === root)) return { ...rule, root };
  }
  return null;
}

module.exports = {
  CODEX_BUNDLE_CACHE,
  readEnterpriseBundle,
  enterpriseRequirements,
  allowedApprovalPolicies,
  allowedSandboxModes,
  enterprisePrefixRules,
  enterpriseDecisionFor,
};
