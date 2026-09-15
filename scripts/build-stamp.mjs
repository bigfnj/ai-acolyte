// The receipt scripts/package.mjs leaves behind for scripts/check-version-sync.mjs.
//
// Two scripts have to agree on one filename and one shape, and .github/workflows/release.yml
// runs them as SEPARATE steps, so the agreement cannot travel as a function argument or an
// environment variable. It travels as a gitignored file in the repo root.
//
// The evidence the checker uses is this file's MTIME, not the startedAt recorded inside it.
// The mtime is set by the OS at the moment package.mjs writes the stamp, one statement before
// it invokes vsce; an artefact at least that new can only have come out of that vsce run.
// startedAt exists so a failure can say WHEN in words, and is never what the check compares.

import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const BUILD_STAMP = '.vsix-build.json';

/** The one place the artefact filename is spelled. Both scripts derive it from a version. */
export const artefactName = (version) => `permission-wildcarding-${version}.vsix`;

/**
 * Record which artefact this build is about to write. Call it BEFORE vsce, never after.
 *
 * @param {string} root     repo root
 * @param {string} version  version the artefact will be named for
 */
export function writeBuildStamp(root, version) {
  const stamp = {
    artefact: artefactName(version),
    version,
    startedAt: new Date().toISOString(),
  };
  writeFileSync(join(root, BUILD_STAMP), JSON.stringify(stamp, null, 2) + '\n');
  return stamp;
}

/**
 * @param {string} root repo root
 * @returns {{stamp: {artefact: string, version: string, startedAt: string}, mtimeMs: number}
 *   | null} null when no stamp is readable, i.e. no packaging step ran in this tree
 */
export function readBuildStamp(root) {
  const file = join(root, BUILD_STAMP);
  try {
    return { stamp: JSON.parse(readFileSync(file, 'utf8')), mtimeMs: statSync(file).mtimeMs };
  } catch {
    // Missing and malformed are one case on purpose: neither one can prove anything about
    // the artefact, and the caller's message names both rather than guessing which.
    return null;
  }
}
