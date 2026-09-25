// Move the release version into every manifest that reports it.
//
// Two files carry the same product version, and both are user-visible:
//
//   vscode-extension/package.json   drives the sidebar badge ("Active v1.4.5")
//   package.json                    is what `bin/wildcard-perms --version` prints
//
// scripts/package.mjs used to write the release-tag override into the first one only,
// which is precisely the drift test/installers.test.js:511 exists to catch. That guard
// could never see it: .github/workflows/release.yml runs `npm test` BEFORE the packaging
// step, so the tests ran against manifests that still agreed, and the packaging step then
// pulled them apart. The 1.4.2-from-the-CLI / 1.4.4-in-the-badge split recorded in
// BACKLOG.md is what that looks like to a user.
//
// release.yml treats the extension manifest as authoritative (its workflow_dispatch input
// defaults to it), so the order below puts it first and the root follows.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const MANIFESTS = ['vscode-extension/package.json', 'package.json'];

/**
 * Write `override` into both manifests under `root`.
 *
 * @param {string} root      repo root
 * @param {string} [override] version, with or without a leading "v"
 * @returns {{version: string, changed: string[]} | null} null when no override was given
 */
export function syncVersion(root, override) {
  const version = typeof override === 'string' ? override.replace(/^v/, '').trim() : '';
  if (!version) return null;

  const changed = [];
  for (const rel of MANIFESTS) {
    const file = join(root, ...rel.split('/'));
    const pkg = JSON.parse(readFileSync(file, 'utf8'));
    if (pkg.version === version) continue;
    pkg.version = version;
    writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
    changed.push(rel);
  }
  return { version, changed };
}
