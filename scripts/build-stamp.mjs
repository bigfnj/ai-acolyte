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

import { readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const BUILD_STAMP = '.vsix-build.json';

/** The one place the artefact filename is spelled. Both scripts derive it from a version. */
export const artefactName = (version) => `ai-acolyte-v${version.replaceAll('.', '')}.vsix`;

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

/**
 * Run a gate over the artefact vsce just wrote, and if it rejects, quarantine the build
 * before rethrowing: the artefact AND the stamp go.
 *
 * Without this a rejected build left both behind, and they are exactly the pair
 * scripts/check-version-sync.mjs accepts: a correctly named VSIX, newer than a stamp that
 * names it. Re-running the checker after a failed `package.mjs` therefore printed "release
 * version check OK" over an artefact the content gate had refused, sitting in the repo root
 * under the name an upload picks up (found 2026-10-13, by reading; the gate throws with no
 * handler between it and the end of the script). The stamp goes too because it is a receipt
 * for a build that produced nothing acceptable; with it gone, a same-version leftover from an
 * earlier build is reported as unvouched-for rather than judged against this build's time.
 *
 * Removal is best-effort and never replaces the gate's own error, which is the one that says
 * what was wrong. A file that could not be removed is named on stderr instead.
 *
 * @param {string} artefactPath  the VSIX the gate inspects
 * @param {string} stampPath     the stamp this build wrote before invoking vsce
 * @param {() => unknown} gate   throws to reject the artefact
 * @returns {unknown} whatever the gate returned, when it accepts
 */
export function gateOrQuarantine(artefactPath, stampPath, gate) {
  try {
    return gate();
  } catch (error) {
    for (const file of [artefactPath, stampPath]) {
      try {
        rmSync(file, { force: true });
      } catch (removal) {
        console.error(`could not remove ${file} after the gate rejected the build: ${removal.message}`);
      }
    }
    throw error;
  }
}
