# Agent Policy Console rename migration

Status: planned, intentionally deferred until the MAX modes removal is complete and verified.

This document records the agreed migration from the visible product name
`Permission Wildcarding` to `Agent Policy Console`. The rename is a compatibility
migration, not a new extension identity. Existing installations must upgrade in place,
existing settings and learned policy must continue to work, and no second extension may
activate beside the first one.

## Preconditions

The MAX modes removal is separate work and comes first. The rename must not begin until:

- neither Claude MAX nor Codex MAX can be enabled through the extension, CLI, or a
  documented entry point;
- the retained one-way legacy cleanup path has upgrade coverage;
- a fresh installation contains no MAX offering; and
- the installed VSIX has been exercised in the real VS Code application.

Keeping these efforts separate makes failures attributable and keeps the MAX cleanup
from being hidden inside a broad naming diff.

## Compatibility contract

| Surface | Migration decision |
|---|---|
| Visible product name | Change to `Agent Policy Console` |
| VS Code extension ID | Keep `local.permission-wildcarding` |
| Manifest `name` and `publisher` | Keep their current values |
| Command IDs | Keep every `permission-wildcarding.*` ID |
| Setting keys | Keep every `permissionWildcarding.*` key |
| View and container IDs | Keep existing IDs |
| Managed-block markers | Keep existing marker strings |
| State, backup, lock, and claim paths | Keep existing paths and filenames |
| Codex rules filename | Keep `permission-wildcarding.rules` |
| Preferred CLI | Add `agent-policy` |
| Existing CLI | Keep `wildcard-perms` as a forwarding compatibility shim |
| Repository and checkout directory | Rename only after the product migration is proven |
| Historical releases and Git history | Leave unchanged |

The stable identifiers above are compatibility identifiers, not visible branding. New
code should label them as such so a later cleanup does not accidentally break upgrades.
Changing the extension `name` or `publisher` would create a second VS Code extension
instead of upgrading the installed one, so that is outside this migration.

## Phase 1: establish the upgrade baseline

Before changing visible text, preserve fixtures and evidence for:

- a fresh installation;
- an in-place upgrade from the last `Permission Wildcarding` release;
- existing settings, Auto Learn state, gates, guidance, backups, and generated Codex
  rules;
- each legacy MAX state covered by the MAX removal migration; and
- the current live Claude hook command and extension installation identity.

Record the old and new manifest versions used by the test. The root and extension
package versions must move together, and the new VSIX must have a higher version than
the installed build so VS Code performs a real upgrade.

## Phase 2: rename visible product surfaces

Change only text and assets that a user sees:

- extension display name and description;
- activity-bar, view, command, setting-page, status, and notification labels;
- output-channel and diagnostic headings;
- README and other current documentation headings and prose;
- current screenshots or image filenames where the old visible name appears; and
- new release titles and generated package descriptions.

Do not rename commands, settings, views, managed markers, state files, backups, locks,
or rule files during this phase. Tests should assert both the new visible name and the
continued presence of the stable compatibility identifiers.

## Phase 3: introduce the CLI name

Add `agent-policy` as the documented executable and keep `wildcard-perms` as a thin
forwarding shim to the same implementation. The two entry points must return identical
exit codes, stdout, stderr, and file effects for every retained command.

Existing hooks may continue to call `wildcard-perms`; they do not need to be rewritten
merely for branding. New installation and documentation paths should prefer
`agent-policy`. A later release may emit a deprecation notice for direct interactive use
of the old name, but the shim must remain silent when called as an automation hook unless
a separate migration explicitly proves that a notice is safe.

Legacy MAX enable commands must not return through either executable. Any retained MAX
verbs are cleanup-only and follow the behavior fixed by the MAX removal effort.

## Phase 4: package and upgrade verification

Build and install the renamed VSIX over the prior released extension. Verify in the real
application that:

- VS Code reports one extension with ID `local.permission-wildcarding`;
- the visible product name is `Agent Policy Console` everywhere in the active UI;
- existing settings and commands still resolve under their old IDs;
- Auto Learn state, gates, guidance, backups, and generated rules survive unchanged;
- activation does not duplicate managed blocks, rules, views, commands, or watchers;
- both CLI names execute the same implementation;
- MAX cannot be enabled and any legacy cleanup remains reachable;
- no old visible product name remains outside an intentional compatibility, migration,
  or historical context; and
- packaged production sources match the reviewed checkout.

The source test suite, package checks, and release verifier must pass, but they do not
replace the installed upgrade test.

## Phase 5: rename external artifacts last

Only after the in-place extension upgrade is proven should external names move. Handle
these as an explicit follow-up change:

- repository and remote display name;
- local checkout directory;
- future VSIX and release artifact names;
- badges, repository URLs, issue links, and installation examples; and
- live automation that contains an absolute checkout path.

Before moving the checkout, identify every path-hashed or path-keyed Auto Learn record.
Either migrate those keys or deliberately retain the old storage key. Update the live
Claude hook path in the same operation, then prove it from a real hook invocation. Keep
repository redirects in place where the hosting service supports them.

The external rename must not alter the extension ID, compatibility IDs, on-disk state
contract, or managed marker strings.

## Rollback

Rollback is a package rollback, not an identity change:

1. Keep the previous signed or otherwise verified VSIX available during the migration.
2. Do not delete or rewrite legacy state merely because its filename contains the old
   name.
3. Make new state fields additive and readable by the migration release wherever
   practical.
4. If the renamed build fails acceptance, reinstall the previous VSIX with the same
   extension ID and restore only files that the failed build demonstrably changed.
5. If an external repository or checkout rename fails, restore the old path and hook
   target without rolling back user policy or extension state.

Backups made for upgrade verification must exclude secrets and must not be committed.
Rollback testing must demonstrate that the previous extension activates and reads the
preserved state after a failed-upgrade simulation.

## Acceptance criteria

The rename is complete only when all of the following are true:

- one installed extension upgrades in place and presents `Agent Policy Console`;
- all stable command, setting, view, marker, state, and rule identifiers retain their
  prior values;
- current user policy and learned state survive the upgrade byte-for-byte unless a
  documented migration requires a specific change;
- `agent-policy` and `wildcard-perms` have parity for every supported operation;
- fresh-install and prior-release upgrade tests pass in the real VS Code application;
- rollback to the previous VSIX has been exercised successfully;
- the repository contains no accidental old-brand user-facing text;
- historical references and compatibility identifiers remain clearly identified rather
  than mechanically renamed; and
- the external repository and artifact rename, if performed, preserves links, hooks, and
  path-keyed state.

## Deferred decisions

The following choices are intentionally deferred until implementation:

- the release version carrying the visible rename;
- how long the `wildcard-perms` executable remains documented;
- whether release artifact filenames change in the same release as the repository; and
- whether a future major version migrates any internal compatibility identifier.

None of these decisions blocks the MAX removal or the visible-name migration described
above.
