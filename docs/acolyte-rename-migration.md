# Acolyte rename migration

**Phase 2 is DONE as of 2026-09-25.** The visible product name is now `Acolyte`.

This file replaces `agent-policy-console-rename-migration.md`. That plan named
`Agent Policy Console` as the target; the name chosen instead is **Acolyte**, for a tool
whose whole design is an apprentice that asks constantly at first and earns the right to
stop. `agent-policy` was also discovered to be **taken on npm** (v0.6.0, published
2026-03-08), so the CLI name that plan preferred was unavailable anyway.

The precondition that plan set has been met: MAX modes are retired and released in v1.5.2,
no enable path remains, and the one-way cleanup has been exercised against real leftover
state on this machine.

## What changed, and what deliberately did not

Only text a user reads. Every compatibility identifier is byte-identical.

| Surface | State |
|---|---|
| Visible product name | **`Acolyte`** (was `Permission Wildcarding`) |
| Command palette titles | **`Acolyte: …`** (17 of them) |
| Activity-bar container title, settings section title | **`Acolyte`** |
| Output channel, notification and diagnostic prefixes | **`acolyte: …`** (104 strings) |
| VS Code extension ID | unchanged, `local.permission-wildcarding` |
| Manifest `name` and `publisher` | unchanged |
| Command IDs | unchanged, every `permission-wildcarding.*` |
| Setting keys | unchanged, every `permissionWildcarding.*` |
| View and container IDs | unchanged |
| **Managed-block markers** | **unchanged** — see the near-miss below |
| State, backup, lock and claim paths | unchanged |
| Codex rules filename | unchanged, `permission-wildcarding.rules` |
| Git history and released tags | unchanged |

## ⚠ The near-miss, recorded because it would have been silent

The message prefix is spelled `permission-wildcarding: ` with a colon and a space. So are
the **managed-block markers**:

    <!-- BEGIN permission-wildcarding: shell style (managed) -->
    <!-- BEGIN permission-wildcarding: memory gates (managed) -->
    <!-- BEGIN permission-wildcarding: <slug> (derived) -->

A rewrite targeting the prefix therefore rewrote the markers too, in five source files
plus `scripts/verify-release.ps1` and the tests that assert them. **31 marker strings.**

Had that shipped, every block already installed in a user's `CLAUDE.md` and `AGENTS.md`
would have become unfindable: the removal path looks for the old marker and would never
match it again, and the install path would append a second block beside the orphan. On
this machine that is two live files with two blocks each.

Two tests caught it, both on the precondition rather than the assertion: *"activation
installed the block"* in `test/extension-lifecycle-async.test.js`. Nothing else in 731
tests noticed, because every other test writes and reads markers through the same
constant, so renaming both halves together keeps them agreeing with each other. **A
round-trip test cannot see a renamed marker. Only a test that pins the literal string
can, and the ones that did were checking something else.**

The revert was anchored on `BEGIN ` and `END ` so the message prefixes kept the new name.

## Still to do before this could be published

Phase 2 is complete for a locally installed build. The remaining phases are gated on a
decision that was not made when the original plan was written: whether this is ever
published to the Marketplace at all.

**Publishing forces a new extension identity.** The Marketplace requires a registered
publisher, so `local.permission-wildcarding` would become
`<publisher>.permission-wildcarding`. That is a different extension. An existing local
install does not upgrade to it; both activate and both write
`~/.claude/settings.json`. The original plan's rule that "no second extension may activate
beside the first one" cannot survive publishing, and would be traded away knowingly rather
than broken quietly. Uninstall the local build first.

**The CLI drain decision changes when strangers install it.** `docs/engineering-record.md`
records the drain trust gap as accepted on the explicit grounds that the owner does not
clone untrusted code on a single-user box, with the condition "revisit if this repository
is ever used on a machine that clones untrusted code". Publishing is that condition.
**Decision taken 2026-09-25: a published build disables the CLI drain entirely** and
relies on the extension path, which VS Code already gates behind workspace trust. The
local build keeps current behaviour.

Also outstanding: no `icon` is declared and the Marketplace listing needs one; the eight
screenshots under `img/` have never been eyeballed for legible paths or window titles, and
the repo's own privacy gate is text-only so nothing automated will ever check them.

## Phase 3, the CLI name, not started

`wildcard-perms` still prints `wildcard-perms:` and is unchanged. If a second name is
added it should be `acolyte`, with `wildcard-perms` kept as a silent forwarding shim so
existing hook registrations keep working. The hook command string is recorded in
`~/.claude/settings.json` on every install, so renaming the executable without a shim
breaks every existing installation on its next tool call.
