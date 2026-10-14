#!/usr/bin/env node
// Build the Acolyte VSIX reproducibly (used by CI and locally).
//
//   node scripts/package.mjs            # version from vscode-extension/package.json
//   node scripts/package.mjs 1.2.0      # override version (e.g. from a release tag)
//   node scripts/package.mjs v1.2.0     # leading "v" is stripped
//
// Output: ai-acolyte-v<version without dots>.vsix in the repo root (e.g. ai-acolyte-v160.vsix).

import { execSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BUILD_STAMP, artefactName, gateOrQuarantine, writeBuildStamp } from './build-stamp.mjs';
import { assertRetiredMaxAbsent } from './assert-retired-max-absent.mjs';
import { syncVersion } from './sync-version.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ext = join(root, 'vscode-extension');

// 1. Sync the shared logic (single source of truth lives at repo-root src/).
const extensionSrc = join(ext, 'src');
rmSync(extensionSrc, { recursive: true, force: true });
mkdirSync(extensionSrc, { recursive: true });
for (const entry of readdirSync(join(root, 'src'), { withFileTypes: true })
  .filter((item) => item.isFile() && item.name.endsWith('.js'))
  .sort((left, right) => left.name.localeCompare(right.name))) {
  cpSync(join(root, 'src', entry.name), join(extensionSrc, entry.name));
}

// 1b. Bundle the memory recall script + its vocab, so an installed VSIX resolves
// recall.py without a checkout on disk. The 32MB model stays a download: a versioned
// extension dir would re-fetch it on every upgrade, so the extension keeps it in
// ~/.claude/wildcarding/models instead.
const extMemory = join(ext, 'memory');
rmSync(extMemory, { recursive: true, force: true });
mkdirSync(join(extMemory, 'models'), { recursive: true });
cpSync(join(root, 'memory', 'recall.py'), join(extMemory, 'recall.py'));
cpSync(join(root, 'memory', 'codex_recall.py'), join(extMemory, 'codex_recall.py'));
cpSync(join(root, 'memory', 'models', 'bge-small.vocab.txt'),
  join(extMemory, 'models', 'bge-small.vocab.txt'));

// 2. Optional version override (release tag). Both manifests move together, or the
// sidebar badge and `wildcard-perms --version` report different numbers for one build.
// Read the manifest AFTER the sync, so the output filename below uses the new version.
const applied = syncVersion(root, process.argv[2]);
if (applied?.changed.length) {
  console.log(`version set to ${applied.version} in ${applied.changed.join(', ')}`);
}
const pkg = JSON.parse(readFileSync(join(ext, 'package.json'), 'utf8'));

// 3. Package. The stamp goes down FIRST and stays first: its mtime is the only thing that
// tells scripts/check-version-sync.mjs this build's artefact from the same-version leftover
// of an earlier one. Written after vsce instead, it would be newer than the artefact it
// vouches for, and every build -- honest ones included -- would be reported as stale.
//
// vsce is PINNED, since 2026-10-14. It was `npx --yes @vscode/vsce`, which resolves to
// whatever is latest on the day: 4.0.0 since 2026-09-14, which declares engines.node
// ">= 22", while .github/workflows/release.yml ran this on Node 20 (EOL 2026-04-30). npx
// only warns on an engine mismatch (measured in node:20-slim: `npm warn EBADENGINE`, then
// 4.0.0 ran), so the v1.6.2 release packaged on an unsupported pair and nothing said so;
// the next vsce could just as well have refused. 4.0.0 on Node 22 packages this manifest
// (node:22-alpine, 2026-10-14), and it also dropped 3.x's native keytar dependency,
// which matters with ubuntu-latest moving to Ubuntu 26 on 2026-10-19. release.yml runs
// this step on Node 22 for that reason. Bumping the pin is deliberate:
// test/release-pins.test.js requires an exact version and a release job on vsce's floor.
const VSCE = '@vscode/vsce@4.0.0';
const out = join(root, artefactName(pkg.version));
writeBuildStamp(root, pkg.version);
execSync(`npx --yes ${VSCE} package --no-dependencies -o "${out}"`, {
  cwd: ext,
  stdio: 'inherit',
});
// 4. Gate the artefact vsce actually wrote. A rejection removes the VSIX and the stamp
// before it propagates, or the pair would satisfy check-version-sync.mjs. See
// gateOrQuarantine in build-stamp.mjs.
gateOrQuarantine(out, join(root, BUILD_STAMP), () => assertRetiredMaxAbsent(out));
console.log(`\nPackaged ${out}`);
