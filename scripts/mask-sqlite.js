#!/usr/bin/env node

// Run the suite the way CI's node-20 legs see it.
//
//   node --require scripts/mask-sqlite.js --test
//   node --require scripts/mask-sqlite.js --test test/codex-history-store.test.js
//
// `node:sqlite` arrived in Node 22.5 and stayed flagged until 23.4, so it is present on
// this repo's dev box (node 24) and absent on both the node-20 CI legs AND on every
// shipping VS Code extension host. That asymmetry has now cost two separate defects:
//
//   1. The Codex history-store probe reported `partial` on every real extension host,
//      and the dashboard ranked that permanent warning above the review count and
//      suppressed it. Correct on the author's machine, wrong for every user.
//   2. The test written to FIX that shipped with the same assumption: it built a
//      one-healthy-one-unreadable-root fixture and asserted `partial`, which cannot be
//      constructed when no root can be inspected at all. Green locally, red on node 20.
//
// Neither was findable on this machine, because this machine is the one runtime where
// the capability exists. So: before trusting any change that touches a capability probe,
// run the suite through this preload as well as normally. The two runs should differ
// only in the SKIP count.
//
// Reference numbers on 2026-09-25, for comparison rather than as an assertion. Measured,
// not carried over from an earlier run of a smaller suite:
//   plain      731 tests, 729 pass, 0 fail, 2 skipped
//   masked     731 tests, 724 pass, 0 fail, 7 skipped
//
// A test that FAILS under the mask rather than skipping is encoding the author's
// runtime, which is the whole thing this file exists to surface.

'use strict';
const Module = require('node:module');

const original = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'node:sqlite' || request === 'sqlite') {
    // Shaped like the real absence: Node throws on require rather than returning
    // undefined, so a `try { require(...) } catch` guard is what gets exercised.
    const error = new Error(`Cannot find module '${request}'`);
    error.code = 'ERR_UNKNOWN_BUILTIN_MODULE';
    throw error;
  }
  return original.call(this, request, parent, isMain);
};
