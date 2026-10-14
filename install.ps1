# Install/Register wildcard-perms PostToolUse hook for Claude Code on Windows.

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if ([string]::IsNullOrEmpty($scriptDir)) {
    $scriptDir = Get-Location
}
$hookCmd = Join-Path $scriptDir "bin\wildcard-perms"
# Use forward slashes for JSON path strings to make it extremely safe across environments
$hookCmdNormalized = $hookCmd.Replace("\", "/")
# Windows has no shebang support, so the extensionless Node script must be invoked
# via `node "<path>"`. Registering the bare path makes Windows show a
# "How do you want to open this file?" dialog on every hook fire.
$hookCommand = 'node "' + $hookCmdNormalized + '"'

$userProfile = [System.Environment]::GetFolderPath("UserProfile")
$settingsDir = Join-Path $userProfile ".claude"
$settingsPath = Join-Path $settingsDir "settings.json"

if (-not (Test-Path $settingsDir)) {
    # -Path, not -Value: New-Item -ItemType Directory takes the location as
    # -Path, so this silently did not create ~/.claude on a fresh machine —
    # the exact case the Test-Path guard above exists for.
    $null = New-Item -Path $settingsDir -ItemType Directory -Force
}

# ConvertFrom-Json -AsHashtable is PowerShell 6+ ONLY. Under Windows PowerShell
# 5.1 — the shell README.md names for this script — it threw, the catch below
# only warned, $cfg stayed empty, and the write further down replaced the user's
# entire settings.json with nothing but this hook. Reproduced on 5.1.26100.7019:
# model, effortLevel, env, permissions.allow, permissions.deny and a co-located
# third-party SessionStart hook all gone, exit code 0, "[OK]" printed. The
# installer deleted its own registration along with the policy.
#
# So: parse with plain ConvertFrom-Json, which exists everywhere, and convert the
# PSCustomObject tree to ordered dictionaries ourselves. Ordered, because
# ConvertTo-Json follows insertion order and a settings.json whose keys got
# shuffled is a gratuitous diff in a file the user reads.
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
        # The comma keeps a one-element result an array instead of unwrapping it,
        # so a single-hook PostToolUse does not serialise as an object.
        return ,@(foreach ($item in $InputObject) { ConvertTo-OrderedDict $item })
    }
    return $InputObject
}

$cfg = [ordered]@{}
if (Test-Path $settingsPath) {
    $raw = Get-Content $settingsPath -Raw
    # Empty is not the same as absent. A zero-byte read is the mid-write window
    # of somebody else's atomic write — routine, because Claude Code rewrites
    # this file on every /model, /effort and approval — and treating it as "no
    # config yet" is how a whole policy gets replaced by one hook.
    if ([string]::IsNullOrWhiteSpace($raw)) {
        Write-Host "[FAIL] $settingsPath is present but empty - refusing to write over it." -ForegroundColor Red
        Write-Host "       That is usually a file being written right now. Re-run in a moment." -ForegroundColor Red
        exit 1
    }
    try {
        $parsed = $raw | ConvertFrom-Json
    } catch {
        # Fail CLOSED, matching uninstall.sh's contract and the refusal in
        # src/settings-write.js. Present-but-unparseable is the one case where
        # starting from an empty config is destructive rather than merely wrong.
        Write-Host "[FAIL] $settingsPath could not be parsed - left untouched." -ForegroundColor Red
        Write-Host "       Nothing was changed. Fix or move the file, then re-run." -ForegroundColor Red
        exit 1
    }
    $cfg = ConvertTo-OrderedDict $parsed
    if ($null -eq $cfg -or $cfg -isnot [System.Collections.IDictionary]) {
        Write-Host "[FAIL] $settingsPath does not contain a JSON object - left untouched." -ForegroundColor Red
        exit 1
    }
}

# .Contains, not .ContainsKey: OrderedDictionary has only the former, and both
# it and Hashtable inherit it from IDictionary.
if (-not $cfg.Contains("hooks")) {
    $cfg["hooks"] = [ordered]@{}
}
if (-not $cfg["hooks"].Contains("PostToolUse")) {
    $cfg["hooks"]["PostToolUse"] = @()
}

# -- Registrations of this tool from ANY checkout, not only this one ------------
#
# The duplicate check used to be an exact string match against the three
# spellings of THIS checkout's path. Found live 2026-10-13: the development box's
# PostToolUse hook still pointed at an old checkout of this repo (the directory
# name from before the rename, v1.4.13, 142 commits behind) while the maintained
# checkout had been cloned under the new name. Installing from a moved, renamed
# or re-cloned checkout matched none of the three strings, so it APPENDED a
# second entry beside the stale one. Both fired on every tool call and the stale
# one kept running old code: every fix since 1.4.13, the MAX retirement among
# them, never reached a real tool call, and nothing said so, because
# "registered" was true. install.sh had the same exact-match shape.
#
# So the scan recognises this TOOL wherever it lives, and an install leaves
# exactly one registration per matcher, pointing here:
#   - none found              append a new entry (unchanged behaviour);
#   - this checkout's found   leave it exactly as it is, bytes included --
#                             unless it is the bare path, which Windows cannot
#                             run, and is rewritten to $hookCommand ($respell);
#   - another checkout's      rewrite that hook's command in place, so its
#                             entry keeps its matcher, its position and any
#                             other fields, and say old -> new;
#   - more than one under     keep one (this checkout's if present, else the
#     the same matcher        first, repointed) and remove the rest, per hook,
#                             reporting each.
# Per matcher rather than globally because an entry pair split by matcher
# ("Bash" + "PowerShell") is a real shape -- the uninstallers' own tests carry
# it -- and collapsing it to one entry would silently stop the hook seeing one
# of the two tools. Under one matcher, a second copy only ever double-fires.
#
# Whether the old checkout still exists does not matter: running this installer
# IS the statement of which checkout should be the hook. A vanished path is only
# mentioned in the notice, because it is the likelier case and the user may
# want to know there is nothing left to clean up.

# The path a hook command runs, if and only if the command runs THIS tool:
# `node <path>` or a bare `<path>`, the path optionally quoted whole, ending in
# a `bin` directory holding a file named exactly `wildcard-perms`. Strict on
# purpose, because a false match REWRITES somebody else's hook: extra
# arguments, a shell wrapper, another filename (`wildcard-perms.js`,
# `wildcard-perms-audit`) or a command that only mentions the name all return
# $null. `-match` is case-insensitive, as a Windows path is.
#
# An UNQUOTED path with whitespace in it counts only when it provably names one
# file (Test-NamesOneFile): this checkout, or a file by exactly that name. It
# was refused outright until 2026-10-14, which is install.sh's case too (its
# toolTarget comment has the whole of it): `node C:/Users/Jo Doe/x/bin/wildcard-perms`
# from an older or hand-made registration was never recognised, so a reinstall
# from a moved checkout appended a second entry beside it. A wrapper such as
# `C:/tools/run.exe C:/x/bin/wildcard-perms` has the same shape, and its whole
# command line is never the name of a file.
function Get-WildcardPermsTarget {
    param([object] $Command)
    if ($Command -isnot [string]) { return $null }
    $text = $Command.Trim()
    if ($text -match '^node\s+(.+)$') { $text = $Matches[1].Trim() }
    $quoted = $false
    if ($text -match '^"([^"]+)"$') {
        $text = $Matches[1]
        $quoted = $true
    } elseif ($text -match "^'([^']+)'$") {
        $text = $Matches[1]
        $quoted = $true
    }
    if ($text -notmatch '[\\/]bin[\\/]wildcard-perms$') { return $null }
    if (-not $quoted -and $text -match '\s' -and -not (Test-NamesOneFile $text)) { return $null }
    return $text
}

# Called only from Get-WildcardPermsTarget, so only from the scan below, after
# $currentPath is set. IsPathRooted and Exists throw on .NET Framework for `"`,
# `<`, `>` or `|`; such a path proves nothing.
function Test-NamesOneFile {
    param([string] $Path)
    $native = ConvertTo-WindowsPath $Path
    try {
        if (-not [System.IO.Path]::IsPathRooted($native)) { return $false }
        if ((Resolve-LongPath $native) -ieq $currentPath) { return $true }
        return [System.IO.File]::Exists($native)
    } catch {
        return $false
    }
}

# One path, several spellings: backslashes or forward slashes, /d/repo (Git
# Bash's own), /cygdrive/d/repo (Cygwin's) or D:/repo (this script, and
# install.sh run from Git Bash). Compare the results with -ieq; casing is folded
# there, not here, so the notice prints the path as the user wrote it. The
# /cygdrive/ form was not folded until 2026-10-14: .NET reads /cygdrive/c/x as
# C:\cygdrive\c\x, which never exists, so this checkout spelled that way was
# "repointed from another checkout ... (the old path no longer exists)".
function ConvertTo-WindowsPath {
    param([string] $Path)
    $text = $Path.Replace("\", "/")
    if ($text -match '^(?:/cygdrive)?/([A-Za-z])/(.*)$') { $text = "$($Matches[1]):/$($Matches[2])" }
    return $text.TrimEnd("/")
}

# One file can have more than one spelling even after that folding, found
# 2026-10-13: an 8.3 short path (C:/Users/SHORTN~1.EXT/...) and its long form
# name the same checkout. Compared as text they differ, so this checkout
# registered under its short spelling was "repointed from another checkout",
# which it is not. Git Bash writes the short form by itself whenever a checkout
# sits under /tmp. [System.IO.Path]::GetFullPath expands every 8.3 component of
# the part of a path that exists, even when the file at the end does not,
# measured under 5.1.26100.9444 and 7.6.6 alike; Get-Item's FullName expands
# too, but only for an item that exists. It does NOT resolve a junction or a
# symlink, which install.sh's realpath does: there such a spelling is still
# repointed, which is harmless. Not rooted, or unparseable (.NET Framework
# throws on `"`, `<`, `>`, `|`): compared as written.
function Resolve-LongPath {
    param([string] $Path)
    try {
        if ([System.IO.Path]::IsPathRooted($Path)) {
            return [System.IO.Path]::GetFullPath($Path).Replace("\", "/").TrimEnd("/")
        }
    } catch { }
    return $Path
}

$currentPath = Resolve-LongPath (ConvertTo-WindowsPath $hookCmd)
$entries = @($cfg["hooks"]["PostToolUse"])
$found = @()
for ($i = 0; $i -lt $entries.Count; $i++) {
    $entry = $entries[$i]
    if (-not ($entry -is [System.Collections.IDictionary]) -or -not $entry.Contains("hooks")) { continue }
    $entryHooks = @($entry["hooks"])
    for ($j = 0; $j -lt $entryHooks.Count; $j++) {
        $h = $entryHooks[$j]
        if (-not ($h -is [System.Collections.IDictionary])) { continue }
        $command = $h["command"]
        # The three spellings the old exact-match check knew stay THIS checkout
        # whatever the grammar above makes of them, so nothing it called
        # "already registered" is ever repointed as another checkout. (A bare
        # one is still respelled; see $respell below.)
        if ($command -is [string] -and ($command -eq $hookCommand -or $command -eq $hookCmdNormalized -or $command -eq $hookCmd)) {
            $target = $hookCmd
            $isCurrent = $true
        } else {
            $target = Get-WildcardPermsTarget $command
            if ($null -eq $target) { continue }
            $isCurrent = (Resolve-LongPath (ConvertTo-WindowsPath $target)) -ieq $currentPath
        }
        # This checkout registered BARE, which is what install.sh used to write
        # from Git Bash (found 2026-10-13): the C:/.../bin/wildcard-perms that
        # makes Windows ask how to open the file on every hook fire, the dialog
        # $hookCommand exists to avoid. It is still this checkout -- never
        # "another checkout" -- but it is rewritten to $hookCommand below rather
        # than left as "already registered". A `node ...` spelling of it, any
        # casing or slash direction, is left exactly as it is -- unless it is
        # UNQUOTED with whitespace in its path ($split), which Git Bash, the shell
        # Claude Code runs a hook command through on Windows, splits at the space.
        $bare = $command -notmatch '^\s*node\s'
        $split = ($target -match '\s') -and ("$command".Trim() -notmatch '["'']$')
        $respell = $isCurrent -and ($bare -or $split)
        # "$i/$j" identifies the hook for the rebuild below; indices rather than
        # object identity, which PowerShell's PSObject wrapping makes unreliable.
        $found += [pscustomobject]@{
            id      = "$i/$j"
            hook    = $h
            command = $command
            target  = $target
            current = $isCurrent
            respell = $respell
            bare    = $bare
            matcher = "$($entry['matcher'])"
        }
    }
}

# Which registration survives under each matcher: this checkout's first, else
# the first found. New-Object, not @{}: a PowerShell hashtable literal folds
# key case, and "Bash" and "bash" are different matchers.
$keepers = New-Object System.Collections.Hashtable
foreach ($f in $found) { if ($f.current -and -not $keepers.ContainsKey($f.matcher)) { $keepers[$f.matcher] = $f.id } }
foreach ($f in $found) { if (-not $keepers.ContainsKey($f.matcher)) { $keepers[$f.matcher] = $f.id } }

$notices = @()
$drop = New-Object System.Collections.Hashtable
foreach ($f in $found) {
    if ($keepers[$f.matcher] -ne $f.id) {
        $drop[$f.id] = $true
        $notices += "[OK] removed a duplicate wildcard-perms hook (matcher '$($f.matcher)'): $($f.target)"
    } elseif (-not $f.current) {
        # In place: the hook keeps its own key order and any field beside
        # `command` (a timeout, say), and its entry keeps matcher and position.
        $f.hook["command"] = $hookCommand
        # Only for the notice. IsPathRooted THROWS on .NET Framework (so under
        # 5.1) for a path holding `"`, `<`, `>` or `|`, and a cosmetic suffix
        # must not abort an install that has already decided what to write.
        $gone = ''
        $oldPath = ConvertTo-WindowsPath $f.target
        try {
            if ([System.IO.Path]::IsPathRooted($oldPath) -and -not [System.IO.File]::Exists($oldPath)) {
                $gone = ' (the old path no longer exists)'
            }
        } catch { $gone = '' }
        $notices += "[OK] wildcard-perms hook repointed from another checkout: $($f.target) -> $hookCmdNormalized$gone"
    } elseif ($f.respell) {
        # In place, like a repoint: same entry, matcher, position and fields.
        $f.hook["command"] = $hookCommand
        if ($f.bare) {
            $notices += "[OK] wildcard-perms hook now runs through node, because Windows cannot run the bare path: $($f.command) -> $hookCommand"
        } else {
            $notices += "[OK] wildcard-perms hook path quoted, because a shell splits an unquoted path at its space: $($f.command) -> $hookCommand"
        }
    }
}

if ($drop.Count -gt 0) {
    # Removed PER HOOK, the uninstallers' rule: an entry left empty goes, an
    # entry that also holds a neighbour's hook keeps it, with its matcher.
    $rebuilt = @()
    for ($i = 0; $i -lt $entries.Count; $i++) {
        $entry = $entries[$i]
        if (-not ($entry -is [System.Collections.IDictionary]) -or -not $entry.Contains("hooks")) { $rebuilt += ,$entry; continue }
        $entryHooks = @($entry["hooks"])
        $survivors = @()
        for ($j = 0; $j -lt $entryHooks.Count; $j++) {
            $h = $entryHooks[$j]
            if (-not $drop.ContainsKey("$i/$j")) { $survivors += ,$h }
        }
        if ($survivors.Count -eq $entryHooks.Count) { $rebuilt += ,$entry; continue }
        if ($survivors.Count -gt 0) {
            $entry["hooks"] = $survivors
            $rebuilt += ,$entry
        }
    }
    $cfg["hooks"]["PostToolUse"] = $rebuilt
}

if ($found.Count -eq 0) {
    # Add new PostToolUse entry
    $newHook = [ordered]@{
        matcher = "Bash|PowerShell"
        hooks = @(
            [ordered]@{
                type = "command"
                command = $hookCommand
            }
        )
    }
    $cfg["hooks"]["PostToolUse"] = @(@($cfg["hooks"]["PostToolUse"]) + $newHook)
}

if ($found.Count -eq 0 -or $notices.Count -gt 0) {
    $cfgJson = ConvertTo-Json $cfg -Depth 100
    # A copy before the only unlocked, non-atomic write to this file in the
    # project. Everything in-process goes through writeFileAtomicSync; this
    # script cannot, so the next-best thing is somewhere to go back to.
    if (Test-Path $settingsPath) {
        Copy-Item $settingsPath ($settingsPath + ".pre-install-backup") -Force
    }
    [System.IO.File]::WriteAllText($settingsPath, $cfgJson + "`n")
    if ($found.Count -eq 0) {
        Write-Host "[OK] wildcard-perms registered as PostToolUse hook in ~/.claude/settings.json" -ForegroundColor Green
    }
    foreach ($notice in $notices) { Write-Host $notice -ForegroundColor Green }
} else {
    Write-Host "[OK] wildcard-perms already registered as PostToolUse hook" -ForegroundColor Green
}

# Seed starter pack
$packPath = Join-Path $scriptDir "patterns\starter-pack.json"
if (Test-Path $packPath) {
    try {
        $pack = Get-Content $packPath -Raw | ConvertFrom-Json
        Write-Host "Starter pack: $scriptDir\patterns\starter-pack.md"
        Write-Host "Contains $($pack.Count) curated safely generalized permissions."
        
        $answer = Read-Host "Seed your allow list from the starter pack? (y/N)"
        if ($answer -match "^[Yy]([Ee][Ss])?$") {
            node "$hookCmd" --seed
        } else {
            Write-Host "Skipped seed - run manually at any time." -ForegroundColor Yellow
        }
    } catch {
        Write-Host "Starter pack check skipped"
    }
}

Write-Host "Done. Restart your Claude Code session to apply the hook." -ForegroundColor Cyan
