'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  readEnterpriseBundle,
  enterpriseRequirements,
  allowedApprovalPolicies,
  allowedSandboxModes,
  enterprisePrefixRules,
  enterpriseDecisionFor,
} = require('../src/codex-policy');

// A real enterprise requirements bundle, in the shape Codex caches it. These
// helpers are read-only inputs to the "Why did this prompt?" diagnostic. They
// do not edit config.toml or provide an approval-policy toggle.
const bundleWith = (...contents) => ({
  signed_payload: {
    bundle: {
      requirements_toml: {
        enterprise_managed: contents.map((value) => ({ contents: value })),
      },
    },
  },
});

test('managed requirement fragments are joined without inventing policy', () => {
  const bundle = bundleWith(
    'allowed_sandbox_modes = ["read-only", "workspace-write"]',
    'allowed_approval_policies = ["on-request", "never"]',
  );

  assert.equal(enterpriseRequirements(bundle), [
    'allowed_sandbox_modes = ["read-only", "workspace-write"]',
    'allowed_approval_policies = ["on-request", "never"]',
  ].join('\n'));
  assert.deepEqual(allowedSandboxModes(bundle), ['read-only', 'workspace-write']);
  assert.deepEqual(allowedApprovalPolicies(bundle), ['on-request', 'never']);
  assert.equal(allowedApprovalPolicies(null), null, 'no managed key means no known cap');
  assert.equal(allowedSandboxModes({}), null, 'a malformed bundle does not invent a cap');
});

test('the enterprise bundle reader is read-only and fails closed', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-policy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bundlePath = path.join(dir, 'cloud-config-bundle-cache.json');
  const bundle = bundleWith('allowed_approval_policies = ["on-request"]');
  fs.writeFileSync(bundlePath, JSON.stringify(bundle));

  assert.deepEqual(readEnterpriseBundle(bundlePath), bundle);
  assert.equal(readEnterpriseBundle(path.join(dir, 'missing.json')), null);
  fs.writeFileSync(bundlePath, '{ not json');
  assert.equal(readEnterpriseBundle(bundlePath), null, 'partial or corrupt cache is unknown');
});

// This pins the existing read-only, root-alternative behavior. Full positional
// matching for multi-token managed patterns belongs to the Codex certification
// backlog and is deliberately not misrepresented by this migration test.
test('enterprise root rules identify the managed decision used by diagnostics', () => {
  const bundle = bundleWith([
    '[[rules.prefix_rules]]',
    'pattern = [{ any_of = ["sh", "bash", "zsh"] }]',
    'decision = "prompt"',
    'justification = "Shell launchers require human review."',
    '',
    '[[rules.prefix_rules]]',
    'pattern = [{ any_of = ["curl", "wget"] }]',
    'decision = "prompt"',
    'justification = "Network access requires approval."',
  ].join('\n'));

  const rules = enterprisePrefixRules(bundle);
  assert.equal(rules.length, 2, 'each managed block remains a separate rule');
  assert.deepEqual(rules[0].patterns, ['sh', 'bash', 'zsh']);
  assert.equal(rules[1].justification, 'Network access requires approval.');

  assert.equal(enterpriseDecisionFor(bundle, ['curl', '--version']).decision, 'prompt');
  assert.equal(enterpriseDecisionFor(bundle, ['C:\\tools\\curl.exe', '-s']).root, 'curl');
  assert.equal(enterpriseDecisionFor(bundle, ['/usr/bin/bash', '-lc', 'ls']).root, 'bash');
  assert.equal(enterpriseDecisionFor(bundle, ['rg', '--files']), null);
  assert.equal(enterpriseDecisionFor(bundle, []), null);
  assert.equal(enterpriseDecisionFor(null, ['curl']), null);
});
