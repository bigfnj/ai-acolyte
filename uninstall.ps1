# Uninstall/Deregister the wildcard-perms PostToolUse hook for Claude Code on Windows.
#
# The counterpart install.ps1 has always shipped without one, so a Windows install had
# no working undo: uninstall.sh filters on the bare hook path, and install.ps1 registers
# `node "<forward-slash path>"` — Windows has no shebang support, and a bare extensionless
# path pops a "How do you want to open this file?" dialog on every hook fire — so the
# filter could never match. Either spelling can be the entry in settings.json on this
# machine, so this matches on the path rather than on the command that wraps it.

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if ([string]::IsNullOrEmpty($scriptDir)) {
    $scriptDir = Get-Location
}
$hookCmd = Join-Path $scriptDir "bin\wildcard-perms"

$userProfile = [System.Environment]::GetFolderPath("UserProfile")
$settingsDir = Join-Path $userProfile ".claude"
$settingsPath = Join-Path $settingsDir "settings.json"

# One hook path, several spellings: `node "<path>"` or the bare path, backslashes or
# forward slashes, /d/repo (Git Bash) or D:/repo (PowerShell), any casing.
function ConvertTo-HookPath {
    param([object] $Value)

    $text = "$Value".Trim()
    if ($text -match '^node\s+(.+)$') {
        $text = $Matches[1].Trim().Trim('"').Trim("'")
    }
    $text = $text.Replace("\", "/")
    if ($text -match '^/([A-Za-z])/(.*)$') {
        $text = "$($Matches[1]):/$($Matches[2])"
    }
    return $text.TrimEnd("/").ToLowerInvariant()
}

if (-not (Test-Path $settingsPath)) {
    Write-Host "- no $settingsPath, so there is no hook to remove" -ForegroundColor Yellow
    exit 0
}

# ConvertFrom-Json -AsHashtable is PowerShell 6+ ONLY, so under Windows
# PowerShell 5.1 — the shell README.md names for this script — this threw on a
# perfectly healthy file and reported "could not be parsed". It failed CLOSED,
# so nothing was ever lost here (unlike install.ps1, which failed open and ate
# the config), but the Windows uninstall was simply unavailable in the
# documented shell while claiming the file was corrupt.
#
# Duplicated from install.ps1 rather than shared: these two scripts have to run
# from a bare checkout with nothing loaded, which is why they are standalone.
function ConvertTo-OrderedDict {
    param($InputObject)
    if ($null -eq $InputObject) { return $null }
    # IDictionary before IEnumerable: a hashtable is both, and enumerating one
    # yields DictionaryEntry rather than its values.
    if ($InputObject -is [System.Collections.IDictionary]) {
        $out = [ordered]@{}
        foreach ($key in @($InputObject.Keys)) { $out[$key] = ConvertTo-OrderedDict $InputObject[$key] }
        return $out
    }
    if ($InputObject -is [System.Management.Automation.PSCustomObject]) {
        $out = [ordered]@{}
        foreach ($prop in $InputObject.PSObject.Properties) { $out[$prop.Name] = ConvertTo-OrderedDict $prop.Value }
        return $out
    }
    # A string is IEnumerable too, and must stay a scalar.
    if ($InputObject -is [System.Collections.IEnumerable] -and $InputObject -isnot [string]) {
        # The comma keeps a one-element result an array instead of unwrapping it.
        return ,@(foreach ($item in $InputObject) { ConvertTo-OrderedDict $item })
    }
    return $InputObject
}

# A registration of this tool from ANOTHER checkout. Found live 2026-10-13: the
# development box's hook pointed at an old checkout of this repo while the
# maintained one had been cloned under a new name, and an uninstall run from the
# new checkout matched nothing, said "nothing removed", and left the old hook
# firing. install.ps1 now repoints such a registration; this script is more
# conservative, because removing a hook is not something the user asked for on
# behalf of a checkout they did not run it from:
#   - this checkout's                       removed (unchanged behaviour);
#   - another checkout's, target file gone  removed too: it can only fail on
#                                           every tool call. False positives: an
#                                           unreachable drive, and a Git Bash
#                                           mount such as /tmp that .NET cannot
#                                           resolve (/c/... is converted first).
#                                           Both cost only a hook of this tool,
#                                           during an uninstall of this tool;
#   - another checkout's, still on disk     LEFT, and named in the output, so
#                                           "nothing removed" is not the whole
#                                           story. Its own uninstaller removes it.
# Same strict grammar as install.ps1's Get-WildcardPermsTarget (its comment has
# the reasoning): `node <path>` or a bare `<path>`, optionally quoted whole,
# ending in bin\wildcard-perms or bin/wildcard-perms, nothing else. A relative
# path cannot be checked for existence, so it counts as still there.
function Get-WildcardPermsTarget {
    param([object] $Command)
    if ($Command -isnot [string]) { return $null }
    $text = $Command.Trim()
    if ($text -match '^node\s+(.+)$') { $text = $Matches[1].Trim() }
    if ($text -match '^"([^"]+)"$') {
        $text = $Matches[1]
    } elseif ($text -match "^'([^']+)'$") {
        $text = $Matches[1]
    } elseif ($text -match '\s') {
        return $null
    }
    if ($text -notmatch '[\\/]bin[\\/]wildcard-perms$') { return $null }
    return $text
}

function Test-GoneRegistration {
    param([string] $Path)
    $native = $Path.Replace("\", "/")
    if ($native -match '^/([A-Za-z])/(.*)$') { $native = "$($Matches[1]):/$($Matches[2])" }
    # [System.IO.File], not Test-Path: no provider, so no wildcard expansion of
    # `[` in a user's path and no dependence on the current PowerShell drive.
    # IsPathRooted THROWS on .NET Framework (so under 5.1) for a path holding
    # `"`, `<`, `>` or `|`; such a path is not provably gone, so it stays.
    try {
        return ([System.IO.Path]::IsPathRooted($native) -and -not [System.IO.File]::Exists($native))
    } catch {
        return $false
    }
}

$raw = Get-Content $settingsPath -Raw
if ([string]::IsNullOrWhiteSpace($raw)) {
    # Present but empty is somebody else's mid-write window, not "no hooks".
    Write-Host "[FAIL] $settingsPath is present but empty - left untouched." -ForegroundColor Red
    Write-Host "       That is usually a file being written right now. Re-run in a moment." -ForegroundColor Red
    exit 1
}
try {
    $cfg = ConvertTo-OrderedDict ($raw | ConvertFrom-Json)
} catch {
    Write-Host "[FAIL] $settingsPath could not be parsed - left untouched." -ForegroundColor Red
    Write-Host "       Nothing was changed. Fix or move the file, then re-run." -ForegroundColor Red
    exit 1
}

$installed = @()
if ($cfg -is [System.Collections.IDictionary] -and $cfg.Contains("hooks") `
        -and $cfg["hooks"] -is [System.Collections.IDictionary] `
        -and $cfg["hooks"].Contains("PostToolUse")) {
    $installed = @($cfg["hooks"]["PostToolUse"])
}

$target = ConvertTo-HookPath $hookCmd
$kept = @()
$removed = 0
$goneCheckouts = @()
$otherCheckouts = @()
# Removed PER HOOK, not per entry. Dropping the whole entry took any hook that
# happened to share its `hooks` array with ours — somebody else's tool, deleted
# silently by our uninstaller. The rule was copied from a per-hook filter in
# src/permissions.js; that function went with MAX and these two scripts are now
# the only place it lives, so this comment is the whole record of why the loop
# below rebuilds `hooks` instead of dropping the entry.
foreach ($entry in $installed) {
    if (-not ($entry -is [System.Collections.IDictionary]) -or -not $entry.Contains("hooks")) {
        $kept += $entry
        continue
    }
    $mine = @()
    $survivors = @()
    foreach ($h in @($entry["hooks"])) {
        if ((ConvertTo-HookPath $h.command) -eq $target) { $mine += $h; continue }
        $other = Get-WildcardPermsTarget $h.command
        if ($null -ne $other -and (Test-GoneRegistration $other)) {
            $mine += $h
            $goneCheckouts += $other
            continue
        }
        if ($null -ne $other) { $otherCheckouts += $other }
        $survivors += $h
    }
    if ($mine.Count -eq 0) { $kept += $entry; continue }
    $removed += $mine.Count
    # An entry that held only ours goes; one that held a neighbour keeps it,
    # with its matcher and any other fields intact.
    if ($survivors.Count -gt 0) {
        $entry["hooks"] = $survivors
        $kept += $entry
    }
}

# Report what happened rather than success regardless: another checkout's hook, or a
# hook someone removed by hand, must not read as "removed".
function Write-OtherCheckouts {
    foreach ($other in $otherCheckouts) {
        Write-Host "- left $other registered: it is another checkout of this tool and it still exists." -ForegroundColor Yellow
        Write-Host "  Run that checkout's uninstaller to remove it." -ForegroundColor Yellow
    }
}
if ($removed -eq 0) {
    Write-Host "- no wildcard-perms hook registered in $settingsPath; nothing removed" -ForegroundColor Yellow
    Write-OtherCheckouts
    exit 0
}

if ($kept.Count -gt 0) {
    $cfg["hooks"]["PostToolUse"] = $kept
} else {
    $null = $cfg["hooks"].Remove("PostToolUse")
}
if ($cfg["hooks"].Keys.Count -eq 0) {
    $null = $cfg.Remove("hooks")
}

$cfgJson = ConvertTo-Json $cfg -Depth 100
# A copy before an unlocked, non-atomic write to the file the whole project
# treats as fragile. An uninstall is exactly when a user wants a way back.
Copy-Item $settingsPath ($settingsPath + ".pre-uninstall-backup") -Force
[System.IO.File]::WriteAllText($settingsPath, $cfgJson + "`n")
Write-Host "[OK] removed $removed wildcard-perms PostToolUse hook(s) from ~/.claude/settings.json" -ForegroundColor Green
foreach ($gone in $goneCheckouts) {
    Write-Host "     including $gone, from a checkout that no longer exists" -ForegroundColor Green
}
Write-OtherCheckouts
Write-Host "Allow-list entries stay as they are - this removes the hook, not your permissions." -ForegroundColor Cyan
