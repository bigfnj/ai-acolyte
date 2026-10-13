<#
  Behavioural tests for install.ps1 and uninstall.ps1.

  These exist because the installers are the highest-blast-radius files in the
  repo and had no test of any kind. install.ps1 replaced the user's entire
  settings.json with nothing but its own hook entry: `ConvertFrom-Json
  -AsHashtable` is PowerShell 6+ only, under Windows PowerShell 5.1 it throws,
  the catch only WARNED, and the write went ahead. Reproduced on 5.1.26100.7019
  against a config holding model, effortLevel, env, permissions.allow,
  permissions.deny and a third-party SessionStart hook: all six gone, exit code
  0, "[OK]" printed. It deleted its own hook registration along with the policy.

  RUN THIS UNDER powershell.exe, NOT ONLY pwsh. That is the whole point. Both
  installers parse clean under 5.1 -- [Parser]::ParseFile reports no errors --
  so the defect is invisible to every check that does not actually execute on
  5.1. test/installers.test.js covers install.sh and uninstall.sh for real and
  can only guard the .ps1 pair statically, which is why this file exists.

  The seam: install.ps1 and uninstall.ps1 read the home directory from
  [System.Environment]::GetFolderPath("UserProfile"), which ignores
  $env:USERPROFILE, so it cannot be redirected from outside. Each script is
  therefore copied into a sandbox with that ONE line rewritten and the copy is
  what runs -- every line that touches the config is verbatim. An earlier
  version of this harness did not understand that and ran the real installer
  against the live ~/.claude five times; nothing was lost only because the hook
  was already registered, which short-circuits before the write.

  Exit code is 0 only when every case passed, so scripts/verify-release.ps1 can
  fold the whole file into one Check on $LASTEXITCODE.
#>

# Continue, not Stop: a failing case must be reported and the run must go on, the
# same contract verify-release.ps1 uses.
$ErrorActionPreference = 'Continue'
$repo = Split-Path -Parent $PSScriptRoot

$script:results = @()
function Add-Result {
    param([string]$Case, [bool]$Pass, [string]$Detail)
    $script:results += [pscustomobject]@{ case = $Case; pass = $Pass; detail = $Detail }
}

# powershell.exe is Windows-only, and every case below spawns the child through it
# deliberately -- pwsh would hide the defect these tests exist for.
if (-not $IsWindows -and $PSVersionTable.PSEdition -eq 'Core') {
    Write-Host "installers: skipped -- powershell.exe (Windows PowerShell 5.1) is not available on this platform"
    exit 0
}

$HOME_NEEDLE = '$userProfile = [System.Environment]::GetFolderPath("UserProfile")'

# -- Where the sandboxes live, and how they go away -------------------------------
#
# Found 2026-10-13: every run of this file left all of its sandboxes behind in
# %TEMP% -- 88 pw-inst-* folders on the development box -- and said nothing. There
# %TEMP% is an 8.3 short path (C:\Users\<SHORTN~1.EXT>\AppData\Local\Temp), and
# `Remove-Item -Recurse -Force` on a folder spelled through it fails with "An
# object at the specified path C:\Users\<SHORTN~1.EXT> does not exist", under
# 5.1.26100.9444 and 7.6.6 alike, with -Path and with -LiteralPath. The folder
# stays. The error went to the console between cases, the case had already been
# recorded, and $ErrorActionPreference = 'Continue' (deliberate, see above) let
# the run reach "23 pass, 0 fail" and exit 0. [System.IO.Directory]::Delete removes
# the same folder through the same spelling, and Get-Item's FullName expands the
# short component (measured on both hosts; [IO.Path]::GetFullPath does too).
#
# So both, because neither alone is a guarantee on a machine nobody measured:
#   - the sandbox root is %TEMP% resolved to its long form, so the boxes are
#     spelled the way the installers spell their own location (see
#     Get-RealHookCommand for why that differs from %TEMP% on CI);
#   - Remove-Box deletes with [System.IO.Directory]::Delete and then LOOKS, and a
#     box still on disk afterwards is a failing case below rather than a line of
#     red text nobody reads. A leak is not cosmetic: the sandbox holds a
#     settings.json and a copy of the installer, and a folder that grows by two
#     dozen entries per run is how %TEMP% ends up with hundreds.
$script:SandboxRoot = $env:TEMP
try {
    $script:SandboxRoot = (Get-Item -LiteralPath $env:TEMP -ErrorAction Stop).FullName
} catch {
    Write-Host "WARN  could not resolve %TEMP% to its long form; sandboxes go under $env:TEMP"
}
$script:boxesMade = New-Object System.Collections.ArrayList
$script:boxesLeaked = New-Object System.Collections.ArrayList

function Remove-Box {
    param($Box)
    $dir = "$($Box.dir)"
    if ([string]::IsNullOrEmpty($dir)) { return }
    try {
        if ([System.IO.Directory]::Exists($dir)) { [System.IO.Directory]::Delete($dir, $true) }
    } catch {
        Write-Host "WARN  could not remove sandbox $dir -- $($_.Exception.Message)"
    }
    if ([System.IO.Directory]::Exists($dir)) {
        if (-not $script:boxesLeaked.Contains($dir)) { $null = $script:boxesLeaked.Add($dir) }
        Write-Host "WARN  sandbox still on disk after cleanup: $dir"
    }
}

function Get-Installer {
    param([string]$Name)
    $path = Join-Path $repo $Name
    if (-not (Test-Path $path)) { return $null }
    $source = Get-Content $path -Raw
    if (-not $source.Contains($HOME_NEEDLE)) { return $null }
    return $source
}

function New-Box {
    <#  A sandbox holding a .claude\settings.json and a copy of the script under
        test with its home directory repointed at the sandbox. $Content is a
        scriptblock taking the hook path, because the script under test derives
        that path from its OWN location -- a fixture naming the repo's path would
        never match, which cost one debugging round the first time. #>
    param([string]$Source, [scriptblock]$Content, [switch]$NoFile, [string]$ScriptName = 'under-test.ps1')
    $box = Join-Path $script:SandboxRoot ('pw-inst-' + [guid]::NewGuid().ToString('N'))
    $null = $script:boxesMade.Add($box)
    $null = New-Item -Path (Join-Path $box '.claude') -ItemType Directory -Force
    $hookPath = (Join-Path $box 'bin\wildcard-perms') -replace '\\', '/'
    if (-not $NoFile) {
        [System.IO.File]::WriteAllText((Join-Path $box '.claude\settings.json'), (& $Content $hookPath))
    }
    $script = Join-Path $box $ScriptName
    [System.IO.File]::WriteAllText($script, $Source.Replace($HOME_NEEDLE, ('$userProfile = ' + "'" + $box + "'")))
    return @{
        dir      = $box
        script   = $script
        settings = Join-Path $box '.claude\settings.json'
        hook     = $hookPath
    }
}

function Invoke-Box {
    # "n" on stdin answers install.ps1's starter-pack prompt, so nothing is seeded.
    param($Box)
    $out = ('n' | & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Box.script 2>&1) | Out-String
    return @{ output = $out; code = $LASTEXITCODE }
}

function Get-RealHookCommand {
    <#  The exact hook command install.ps1 writes into THIS sandbox, obtained by
        running it rather than by reconstructing the path.

        Why this exists: a fixture cannot derive the hook path from $env:TEMP and
        expect it to match. On a GitHub runner %TEMP% is an 8.3 short path
        (C:\Users\RUNNER~1\...) while PowerShell canonicalises
        $MyInvocation.MyCommand.Path — which is what both installers derive
        $scriptDir from — to the LONG form. The two spellings never matched, so
        every uninstall case that depends on recognising our own hook failed on CI
        and passed locally, where %TEMP% has no 8.3 component. Asking the installer
        is both spelling-proof and a truer round trip: it is the same string a real
        install would leave behind. #>
    param([string]$InstallSource, [string]$BoxDir)
    $probe = Join-Path $BoxDir 'install-probe.ps1'
    [System.IO.File]::WriteAllText($probe,
        $InstallSource.Replace($HOME_NEEDLE, ('$userProfile = ' + "'" + $BoxDir + "'")))
    $null = ('n' | & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $probe 2>&1)
    $written = Join-Path $BoxDir '.claude\settings.json'
    if (-not (Test-Path $written)) { return $null }
    $cfg = Get-Content $written -Raw | ConvertFrom-Json
    $cmd = @($cfg.hooks.PostToolUse)[0].hooks[0].command
    # Leave the sandbox as the caller found it: no settings.json, no probe.
    # [System.IO.File], not Remove-Item: under an 8.3 %TEMP% a non-recursive
    # Remove-Item fails the same way the recursive one does (see Remove-Box), and
    # -ErrorAction SilentlyContinue hid it. Harmless only because every caller
    # overwrites settings.json next; the comment above was not true.
    foreach ($leftover in @($written, ($written + '.pre-install-backup'), $probe)) {
        if ([System.IO.File]::Exists($leftover)) { [System.IO.File]::Delete($leftover) }
    }
    return $cmd
}

$HEALTHY = {
    param($hook)
    '{
  "model": "claude-opus-5",
  "effortLevel": "high",
  "env": { "FOO": "bar" },
  "permissions": {
    "allow": ["Bash(git status *)", "Bash(rg *)", "Read(*)"],
    "deny": ["Bash(rm -rf /*)"]
  },
  "hooks": {
    "SessionStart": [ { "hooks": [ { "type": "command", "command": "other-tool" } ] } ]
  }
}'
}

# ── install.ps1 ───────────────────────────────────────────────────────────────

$install = Get-Installer 'install.ps1'
if (-not $install) {
    Add-Result 'install.ps1 is testable' $false "missing, or the home-directory line moved -- update `$HOME_NEEDLE"
} else {

    # 1. A healthy file. Every key survives and the hook is added beside the neighbour.
    $box = New-Box -Source $install -Content $HEALTHY
    $r = Invoke-Box $box
    $after = Get-Content $box.settings -Raw | ConvertFrom-Json
    $names = $after.PSObject.Properties.Name
    $kept = @('model', 'effortLevel', 'env', 'permissions') | Where-Object { $names -contains $_ }
    $allow = if ($after.permissions.allow) { @($after.permissions.allow).Count } else { 0 }
    $deny = if ($after.permissions.deny) { @($after.permissions.deny).Count } else { 0 }
    $hookNames = @($after.hooks.PSObject.Properties.Name)
    Add-Result 'install: keeps every key it found' `
    ($r.code -eq 0 -and $kept.Count -eq 4 -and $allow -eq 3 -and $deny -eq 1 `
            -and ($hookNames -contains 'SessionStart') -and ($hookNames -contains 'PostToolUse')) `
        "kept=$($kept.Count)/4 allow=$allow deny=$deny hooks=$($hookNames -join '+')"
    Remove-Box $box

    # 2. Unparseable: refuse, change nothing, exit non-zero.
    $broken = { param($hook) '{ "model": "x", "permissions": { "allow": [ ' }
    $box = New-Box -Source $install -Content $broken
    $r = Invoke-Box $box
    Add-Result 'install: refuses an unparseable settings.json' `
    ($r.code -ne 0 -and (Get-Content $box.settings -Raw) -eq (& $broken $box.hook) `
            -and $r.output -match 'could not be parsed') `
        "exit=$($r.code)"
    Remove-Box $box

    # 3. Zero bytes is somebody else's mid-write window, not "no config yet".
    $box = New-Box -Source $install -Content { param($hook) '' }
    $r = Invoke-Box $box
    Add-Result 'install: refuses a zero-byte settings.json' `
    ($r.code -ne 0 -and (Get-Item $box.settings).Length -eq 0 -and $r.output -match 'present but empty') `
        "exit=$($r.code)"
    Remove-Box $box

    # 4. Absent is the legitimate first run and must still work.
    $box = New-Box -Source $install -NoFile
    $r = Invoke-Box $box
    $fresh = if (Test-Path $box.settings) { Get-Content $box.settings -Raw | ConvertFrom-Json } else { $null }
    Add-Result 'install: creates an absent settings.json' `
    ($r.code -eq 0 -and $null -ne $fresh -and @($fresh.hooks.PostToolUse).Count -eq 1) `
        "exit=$($r.code) created=$(Test-Path $box.settings)"
    Remove-Box $box

    # 5. Idempotent.
    $box = New-Box -Source $install -Content $HEALTHY
    $null = Invoke-Box $box
    $r = Invoke-Box $box
    $after = Get-Content $box.settings -Raw | ConvertFrom-Json
    Add-Result 'install: run twice does not double-register' `
    (@($after.hooks.PostToolUse).Count -eq 1 -and $r.output -match 'already registered') `
        "PostToolUse=$(@($after.hooks.PostToolUse).Count)"
    Remove-Box $box

    # 6. Key order preserved, so the write is not a gratuitous diff in a file the
    #    user reads. This is what the ordered-dictionary conversion buys.
    $box = New-Box -Source $install -Content $HEALTHY
    $null = Invoke-Box $box
    $order = ((Get-Content $box.settings -Raw | ConvertFrom-Json).PSObject.Properties.Name) -join ','
    Add-Result 'install: preserves key order' `
    ($order -eq 'model,effortLevel,env,permissions,hooks') "order=$order"
    Remove-Box $box

    # 7. The backup holds the bytes as FOUND, not the object being written -- the
    #    easy mistake is to serialise $cfg, which by then already has the new hook.
    $box = New-Box -Source $install -Content $HEALTHY
    $null = Invoke-Box $box
    $bk = $box.settings + '.pre-install-backup'
    Add-Result 'install: pre-write backup is the original bytes' `
    ((Test-Path $bk) -and (Get-Content $bk -Raw) -notmatch 'PostToolUse' `
            -and (Get-Content $bk -Raw) -match 'SessionStart') `
        "exists=$(Test-Path $bk)"
    Remove-Box $box

    # 8-12. A registration from ANOTHER checkout of this tool. Found live
    #    2026-10-13: the development box's hook still pointed at an old checkout
    #    (the pre-rename directory, v1.4.13, 142 commits behind) because the
    #    duplicate check was an exact match on THIS checkout's path, so installing
    #    from the re-cloned checkout appended a second entry and the stale one kept
    #    running old code. Each fixture is built from the command install.ps1
    #    really writes in its sandbox (Get-RealHookCommand), so "current" is never
    #    a reconstructed spelling, and from a stale path under the sandbox that
    #    does not exist on disk -- the likelier case, and the notice says so.
    function New-SeededInstallBox {
        param([scriptblock]$Content)
        $box = New-Box -Source $install -NoFile
        $real = Get-RealHookCommand -InstallSource $install -BoxDir $box.dir
        if (-not $real) { return $null }
        $box.real = $real
        $box.stale = ($box.dir -replace '\\', '/') + '/old-checkout/bin/wildcard-perms'
        [System.IO.File]::WriteAllText($box.settings, (& $Content $real $box.stale $box.dir))
        return $box
    }
    # Every hook command in PostToolUse that names this tool, by the same tail the
    # installer keys on, so "exactly one" counts what would actually fire.
    function Get-ToolHooks {
        param($Cfg)
        $out = @()
        foreach ($entry in @($Cfg.hooks.PostToolUse)) {
            foreach ($h in @($entry.hooks)) {
                if ("$($h.command)" -match '[\\/]bin[\\/]wildcard-perms"?$') { $out += "$($h.command)" }
            }
        }
        return ,$out
    }

    # 8. Stale `node "<old>"` in the MIDDLE of three entries, under a matcher the
    #    installer never writes, with a field beside `command`: repointed in place,
    #    so position, matcher and timeout all survive and nothing is appended.
    $staleMiddle = {
        param($real, $stale)
        '{
  "model": "claude-opus-5",
  "hooks": {
    "SessionStart": [ { "hooks": [ { "type": "command", "command": "other-tool" } ] } ],
    "PostToolUse": [
      { "matcher": "Bash", "hooks": [ { "type": "command", "command": "first-neighbour" } ] },
      { "matcher": "Bash|PowerShell|Edit", "hooks": [ { "type": "command", "command": ' + (ConvertTo-Json ('node "' + $stale + '"')) + ', "timeout": 30 } ] },
      { "matcher": "Write", "hooks": [ { "type": "command", "command": "last-neighbour" } ] }
    ]
  }
}'
    }
    $box = New-SeededInstallBox -Content $staleMiddle
    if (-not $box) {
        Add-Result 'install: repoints another checkout in place' $false 'could not learn the installed hook command'
    } else {
        $r = Invoke-Box $box
        $after = Get-Content $box.settings -Raw | ConvertFrom-Json
        $ptu = @($after.hooks.PostToolUse)
        $tool = Get-ToolHooks $after
        Add-Result 'install: repoints another checkout in place' `
        ($r.code -eq 0 -and $ptu.Count -eq 3 -and $tool.Count -eq 1 `
                -and $ptu[1].hooks[0].command -eq $box.real -and $ptu[1].matcher -eq 'Bash|PowerShell|Edit' `
                -and $ptu[1].hooks[0].timeout -eq 30 `
                -and $ptu[0].hooks[0].command -eq 'first-neighbour' -and $ptu[2].hooks[0].command -eq 'last-neighbour' `
                -and $null -ne $after.hooks.SessionStart -and $after.model -eq 'claude-opus-5' `
                -and $r.output.Contains($box.stale) -and $r.output -match 'repointed' -and $r.output -match 'no longer exists') `
            "PostToolUse=$($ptu.Count) toolHooks=$($tool.Count) middle=$($ptu[1].hooks[0].command) matcher=$($ptu[1].matcher)"
        Remove-Box $box
    }

    # 9. Control: commands that only MENTION the tool are somebody else's. None is
    #    a registration of it, so they stay byte-for-byte and ours is appended.
    $lookalikes = @(
        'wildcard-perms-audit --since today',
        'node "C:/tools/x/bin/wildcard-perms.js"',
        'C:/tools/bin/wildcard-perms-old',
        'echo C:/tools/bin/wildcard-perms',
        'node "C:/tools/x/bin/wildcard-perms" --seed'
    )
    $mentions = {
        param($real, $stale)
        $hooks = ($lookalikes | ForEach-Object { '{ "type": "command", "command": ' + (ConvertTo-Json $_) + ' }' }) -join ', '
        '{ "model": "x", "hooks": { "PostToolUse": [ { "matcher": "Bash", "hooks": [ ' + $hooks + ' ] } ] } }'
    }
    $box = New-SeededInstallBox -Content $mentions
    if (-not $box) {
        Add-Result 'install: leaves commands that only mention it' $false 'could not learn the installed hook command'
    } else {
        $r = Invoke-Box $box
        $after = Get-Content $box.settings -Raw | ConvertFrom-Json
        $ptu = @($after.hooks.PostToolUse)
        $kept = @($ptu[0].hooks | ForEach-Object { $_.command })
        $same = ($kept.Count -eq $lookalikes.Count)
        for ($k = 0; $same -and $k -lt $kept.Count; $k++) { $same = ($kept[$k] -ceq $lookalikes[$k]) }
        Add-Result 'install: leaves commands that only mention it' `
        ($r.code -eq 0 -and $same -and $ptu.Count -eq 2 -and $ptu[1].hooks[0].command -eq $box.real `
                -and $r.output -notmatch 'repointed' -and $r.output -notmatch 'duplicate') `
            "PostToolUse=$($ptu.Count) untouched=$same"
        Remove-Box $box
    }

    # 10. Already this checkout: no write at all, so no backup and the same bytes.
    $currentOnly = {
        param($real, $stale)
        '{ "model": "x", "hooks": { "PostToolUse": [ { "matcher": "Bash|PowerShell", "hooks": [ { "type": "command", "command": ' `
            + (ConvertTo-Json $real) + ' }, { "type": "command", "command": "neighbour-tool" } ] } ] } }'
    }
    $box = New-SeededInstallBox -Content $currentOnly
    if (-not $box) {
        Add-Result 'install: this checkout already registered is a no-op' $false 'could not learn the installed hook command'
    } else {
        $before = [System.IO.File]::ReadAllBytes($box.settings)
        $r = Invoke-Box $box
        $afterBytes = [System.IO.File]::ReadAllBytes($box.settings)
        $identical = ([Convert]::ToBase64String($before) -eq [Convert]::ToBase64String($afterBytes))
        Add-Result 'install: this checkout already registered is a no-op' `
        ($r.code -eq 0 -and $identical -and -not (Test-Path ($box.settings + '.pre-install-backup')) `
                -and $r.output -match 'already registered') `
            "identical=$identical backup=$(Test-Path ($box.settings + '.pre-install-backup'))"
        Remove-Box $box
    }

    # 11. Two stale registrations under ONE matcher, the second sharing its entry
    #    with a neighbour and spelled as a bare backslash path: the first is
    #    repointed, the second removed per hook, so the neighbour and its entry stay.
    $twoStale = {
        param($real, $stale, $dir)
        $second = ($dir -replace '/', '\') + '\older-checkout\bin\wildcard-perms'
        '{ "hooks": { "PostToolUse": [
  { "matcher": "Bash|PowerShell", "hooks": [ { "type": "command", "command": ' + (ConvertTo-Json ('node "' + $stale + '"')) + ' } ] },
  { "matcher": "Bash|PowerShell", "hooks": [ { "type": "command", "command": "neighbour-tool" }, { "type": "command", "command": ' + (ConvertTo-Json $second) + ' } ] }
] } }'
    }
    $box = New-SeededInstallBox -Content $twoStale
    if (-not $box) {
        Add-Result 'install: two stale registrations leave one' $false 'could not learn the installed hook command'
    } else {
        $r = Invoke-Box $box
        $after = Get-Content $box.settings -Raw | ConvertFrom-Json
        $ptu = @($after.hooks.PostToolUse)
        $tool = Get-ToolHooks $after
        Add-Result 'install: two stale registrations leave one' `
        ($r.code -eq 0 -and $tool.Count -eq 1 -and $ptu.Count -eq 2 -and $ptu[0].hooks[0].command -eq $box.real `
                -and @($ptu[1].hooks).Count -eq 1 -and $ptu[1].hooks[0].command -eq 'neighbour-tool' `
                -and $r.output -match 'repointed' -and $r.output -match 'removed a duplicate' `
                -and $r.output -match 'older-checkout') `
            "toolHooks=$($tool.Count) PostToolUse=$($ptu.Count) second=$(@($ptu[1].hooks).Count)"
        Remove-Box $box
    }

    # 12. Stale AND current under one matcher -- the exact state the old installer
    #    left on the development box. This checkout's is kept as it is and the
    #    stale one goes; nothing is repointed, because nothing needs to be.
    $staleAndCurrent = {
        param($real, $stale)
        '{ "hooks": { "PostToolUse": [
  { "matcher": "Bash|PowerShell", "hooks": [ { "type": "command", "command": ' + (ConvertTo-Json ('node "' + $stale + '"')) + ' } ] },
  { "matcher": "Bash|PowerShell", "hooks": [ { "type": "command", "command": ' + (ConvertTo-Json $real) + ' } ] }
] } }'
    }
    $box = New-SeededInstallBox -Content $staleAndCurrent
    if (-not $box) {
        Add-Result 'install: stale beside current keeps only current' $false 'could not learn the installed hook command'
    } else {
        $r = Invoke-Box $box
        $after = Get-Content $box.settings -Raw | ConvertFrom-Json
        $ptu = @($after.hooks.PostToolUse)
        Add-Result 'install: stale beside current keeps only current' `
        ($r.code -eq 0 -and $ptu.Count -eq 1 -and @($ptu[0].hooks).Count -eq 1 -and $ptu[0].hooks[0].command -eq $box.real `
                -and $r.output -match 'removed a duplicate' -and $r.output.Contains($box.stale) -and $r.output -notmatch 'repointed') `
            "PostToolUse=$($ptu.Count) kept=$($ptu[0].hooks[0].command)"
        Remove-Box $box
    }

    # 13. This checkout registered as the BARE path: exactly what install.sh used
    #    to write from Git Bash (found 2026-10-13), and what makes Windows ask how
    #    to open the file on every hook fire. Rewritten in place to the node form,
    #    its timeout and its neighbour kept, and reported as this checkout -- the
    #    old exact-match check called it "already registered" and left it.
    $bareCurrent = {
        param($real, $stale)
        $bare = ($real -replace '^node\s+"?', '') -replace '"$', ''
        '{ "model": "x", "hooks": { "PostToolUse": [ { "matcher": "Bash|PowerShell", "hooks": [ { "type": "command", "command": ' `
            + (ConvertTo-Json $bare) + ', "timeout": 30 }, { "type": "command", "command": "neighbour-tool" } ] } ] } }'
    }
    $box = New-SeededInstallBox -Content $bareCurrent
    if (-not $box) {
        Add-Result 'install: rewrites this checkout''s bare path to node' $false 'could not learn the installed hook command'
    } else {
        $r = Invoke-Box $box
        $after = Get-Content $box.settings -Raw | ConvertFrom-Json
        $ptu = @($after.hooks.PostToolUse)
        Add-Result 'install: rewrites this checkout''s bare path to node' `
        ($r.code -eq 0 -and $ptu.Count -eq 1 -and @($ptu[0].hooks).Count -eq 2 -and $ptu[0].hooks[0].command -eq $box.real `
                -and $ptu[0].hooks[0].timeout -eq 30 -and $ptu[0].hooks[1].command -eq 'neighbour-tool' `
                -and $r.output -match 'runs through node' -and $r.output -notmatch 'another checkout') `
            "PostToolUse=$($ptu.Count) command=$($ptu[0].hooks[0].command)"
        Remove-Box $box
    }

    # 14. install.sh run from Git Bash registers the SAME command install.ps1 does,
    #    byte for byte, so neither installer reads the other's registration as
    #    stale or rewrites it. Same sandbox, same checkout: install.ps1's command
    #    comes from Get-RealHookCommand, then a copy of the real install.sh runs
    #    with HOME pointed at the box. Needs Git for Windows' bash, found from
    #    `git --exec-path` -- never the first bash on PATH, which can be WSL's --
    #    and is skipped, not failed, without it.
    $gitBash = $null
    try {
        $gitExec = "$(& git --exec-path 2>$null)".Trim()
        if ($gitExec) {
            $gitRoot = [System.IO.Path]::GetDirectoryName([System.IO.Path]::GetDirectoryName([System.IO.Path]::GetDirectoryName($gitExec)))
            $candidate = Join-Path $gitRoot 'bin\bash.exe'
            if ([System.IO.File]::Exists($candidate)) { $gitBash = $candidate }
        }
    } catch { $gitBash = $null }
    if (-not $gitBash) {
        Write-Host 'SKIP  install.sh (Git Bash) registers install.ps1''s command: no bash.exe found via git --exec-path'
    } else {
        $box = New-Box -Source $install -NoFile
        $real = Get-RealHookCommand -InstallSource $install -BoxDir $box.dir
        $null = New-Item -Path (Join-Path $box.dir 'bin') -ItemType Directory -Force
        $null = New-Item -Path (Join-Path $box.dir 'patterns') -ItemType Directory -Force
        [System.IO.File]::WriteAllText((Join-Path $box.dir 'bin\wildcard-perms'), "#!/usr/bin/env node`n")
        [System.IO.File]::Copy((Join-Path $repo 'install.sh'), (Join-Path $box.dir 'install.sh'))
        [System.IO.File]::Copy((Join-Path $repo 'patterns\starter-pack.json'), (Join-Path $box.dir 'patterns\starter-pack.json'))
        # Forward slashes: Git Bash converts C:/x to /c/x but drops the
        # backslashes of C:\x. Restored afterwards, unset if it was unset.
        $savedHome = [System.Environment]::GetEnvironmentVariable('HOME', 'Process')
        [System.Environment]::SetEnvironmentVariable('HOME', ($box.dir -replace '\\', '/'), 'Process')
        try {
            $null = ('n' | & $gitBash (($box.dir -replace '\\', '/') + '/install.sh') 2>&1)
            $shCode = $LASTEXITCODE
        } finally {
            [System.Environment]::SetEnvironmentVariable('HOME', $savedHome, 'Process')
        }
        $sh = $null
        if ([System.IO.File]::Exists($box.settings)) {
            $sh = @((Get-Content $box.settings -Raw | ConvertFrom-Json).hooks.PostToolUse)[0].hooks[0].command
        }
        Add-Result 'install.sh (Git Bash) registers install.ps1''s command' `
        ($null -ne $real -and $shCode -eq 0 -and $sh -ceq $real) `
            "exit=$shCode install.ps1=$real install.sh=$sh"
        Remove-Box $box
    }
}

# ── uninstall.ps1 ─────────────────────────────────────────────────────────────

$uninstall = Get-Installer 'uninstall.ps1'
if (-not $uninstall) {
    Add-Result 'uninstall.ps1 is testable' $false "missing, or the home-directory line moved -- update `$HOME_NEEDLE"
} elseif (-not $install) {
    Add-Result 'uninstall.ps1 is testable' $false 'install.ps1 is needed to learn the real hook spelling'
} else {

    # A sandbox whose fixture is built from the hook command install.ps1 actually
    # writes, so nothing here assumes a path spelling. See Get-RealHookCommand.
    function New-UninstallBox {
        param([scriptblock]$Content)
        $box = New-Box -Source $uninstall -NoFile
        $real = Get-RealHookCommand -InstallSource $install -BoxDir $box.dir
        if (-not $real) { return $null }
        [System.IO.File]::WriteAllText($box.settings, (& $Content $real))
        $box.real = $real
        return $box
    }

    # $real is the full command install.ps1 writes, e.g. `node "C:/.../wildcard-perms"`.
    # ConvertTo-Json quotes and escapes it for embedding, so the fixtures never
    # hand-build that string. $bareOf recovers just the path, which is the spelling
    # install.sh registers on Linux and macOS, and left on Windows before 2026-10-13.
    $bareOf = { param($cmd) ($cmd -replace '^node\s+"?', '') -replace '"$', '' }

    # 1. Removes only ours, from among a sibling entry and a separate hook group.
    #    This is the case that could not run at all under 5.1 before the fix.
    $withHook = {
        param($real)
        '{
  "model": "claude-opus-5",
  "permissions": { "allow": ["Bash(rg *)"], "deny": [] },
  "hooks": {
    "SessionStart": [ { "hooks": [ { "type": "command", "command": "other-tool" } ] } ],
    "PostToolUse": [
      { "matcher": "Bash|PowerShell", "hooks": [ { "type": "command", "command": ' + (ConvertTo-Json $real) + ' } ] },
      { "matcher": "Bash", "hooks": [ { "type": "command", "command": "someone-elses-hook" } ] }
    ]
  }
}'
    }
    $box = New-UninstallBox -Content $withHook
    if (-not $box) {
        Add-Result 'install: registers a bare node command' $false 'could not learn the installed hook command'
        Add-Result 'uninstall: removes only our hook' $false 'could not learn the installed hook command'
    } else {

        # The registered command must be a BARE `node` invocation -- never
        # `cmd /c node ...`, never `powershell.exe -Command node ...`.
        #
        # The durable reason is reversibility, not speed. Both uninstallers recover
        # the hook path with `^node\s+(.+)$` -- ConvertTo-HookPath in uninstall.ps1
        # and hookPath in uninstall.sh. A wrapped command does not match that
        # anchor, so the whole wrapper string gets compared against the bare path,
        # the registration is never recognised as ours, and the hook becomes
        # UN-UNINSTALLABLE: installed by a script that ships its own undo, and the
        # undo cheerfully reports "nothing removed". Then the performance cost on
        # top: measured +17.6 ms per tool call for `cmd /c`, +1059 ms for
        # `powershell.exe -Command` -- 18x the whole hook.
        #
        # Honest limit: this asserts the SPELLING, not the resolved executable. A
        # bare `node` that resolves to a node.cmd/node.bat shim (nvm-windows,
        # Volta) still routes through cmd.exe and reintroduces the ~17.6 ms behind
        # a string this case happily accepts. Catching that needs a runtime probe.
        #
        # $box.real is what install.ps1 actually wrote in this sandbox (see
        # Get-RealHookCommand), already fetched by New-UninstallBox -- so this case
        # costs no extra process spawn. SHAPE plus the path TAIL, never a
        # reconstructed path: on CI %TEMP% is an 8.3 short path while the installer
        # canonicalises to the long form (see Get-RealHookCommand). `[^"]+` not
        # `\S+`, because `node "C:/Users/My Name/repo/bin/wildcard-perms"` is
        # legitimate. Case-insensitive on purpose: `-match` matches what both
        # uninstallers do, and they accept `Node` too.
        Add-Result 'install: registers a bare node command' `
        ($box.real -match '^node "[^"]+/bin/wildcard-perms"$') `
            "registered=$($box.real)"

        $r = Invoke-Box $box
        $after = Get-Content $box.settings -Raw | ConvertFrom-Json
        $ptu = @($after.hooks.PostToolUse)
        Add-Result 'uninstall: removes only our hook' `
        ($r.code -eq 0 -and $ptu.Count -eq 1 -and $ptu[0].hooks[0].command -eq 'someone-elses-hook' `
                -and $null -ne $after.hooks.SessionStart -and $after.model -eq 'claude-opus-5' `
                -and @($after.permissions.allow).Count -eq 1) `
            "PostToolUse=$($ptu.Count) survivor=$($ptu[0].hooks[0].command)"
        Remove-Box $box
    }

    # 2. The bare-path spelling install.sh writes, not install.ps1's `node "..."`.
    $bare = {
        param($real)
        '{ "model": "x", "hooks": { "PostToolUse": [ { "matcher": "Bash", "hooks": [ { "type": "command", "command": ' `
            + (ConvertTo-Json (& $bareOf $real)) + ' } ] } ] } }'
    }
    $box = New-UninstallBox -Content $bare
    if (-not $box) {
        Add-Result 'uninstall: matches the bare-path spelling too' $false 'could not learn the installed hook command'
    } else {
        $r = Invoke-Box $box
        $after = Get-Content $box.settings -Raw | ConvertFrom-Json
        Add-Result 'uninstall: matches the bare-path spelling too' `
        ($r.code -eq 0 -and -not ($after.PSObject.Properties.Name -contains 'hooks')) `
            "keys=$($after.PSObject.Properties.Name -join ',')"
        Remove-Box $box
    }

    # 3. A third-party hook sharing OUR entry's hooks array. Removing the whole
    #    entry deleted somebody else's tool, silently.
    $shared = {
        param($real)
        '{ "model": "x", "hooks": { "PostToolUse": [ { "matcher": "Bash", "hooks": [ { "type": "command", "command": ' `
            + (ConvertTo-Json $real) + ' }, { "type": "command", "command": "neighbour-tool" } ] } ] } }'
    }
    $box = New-UninstallBox -Content $shared
    if (-not $box) {
        Add-Result 'uninstall: keeps a co-located third-party hook' $false 'could not learn the installed hook command'
    } else {
        $r = Invoke-Box $box
        $after = Get-Content $box.settings -Raw | ConvertFrom-Json
        $ptu = @($after.hooks.PostToolUse)
        Add-Result 'uninstall: keeps a co-located third-party hook' `
        ($r.code -eq 0 -and $ptu.Count -eq 1 -and @($ptu[0].hooks).Count -eq 1 `
                -and $ptu[0].hooks[0].command -eq 'neighbour-tool' -and $ptu[0].matcher -eq 'Bash') `
            "hooks=$(@($ptu[0].hooks).Count) survivor=$($ptu[0].hooks[0].command) matcher=$($ptu[0].matcher)"
        Remove-Box $box
    }

    # 4. Nothing of ours registered: say so, change nothing, exit 0.
    $none = { param($hook) '{ "model": "x", "hooks": { "SessionStart": [ { "hooks": [ { "type": "command", "command": "other" } ] } ] } }' }
    $box = New-Box -Source $uninstall -Content $none
    $r = Invoke-Box $box
    Add-Result 'uninstall: reports when there was nothing to remove' `
    ($r.code -eq 0 -and (Get-Content $box.settings -Raw) -eq (& $none $box.hook) `
            -and $r.output -match 'nothing removed') `
        "exit=$($r.code)"
    Remove-Box $box

    # 5. Unparseable: refuse. Fails closed, so nothing was ever lost here -- but it
    #    used to report "could not be parsed" for a HEALTHY file under 5.1.
    $brokenU = { param($hook) '{ "hooks": { "PostToolUse": [ ' }
    $box = New-Box -Source $uninstall -Content $brokenU
    $r = Invoke-Box $box
    Add-Result 'uninstall: refuses an unparseable settings.json' `
    ($r.code -ne 0 -and (Get-Content $box.settings -Raw) -eq (& $brokenU $box.hook) `
            -and $r.output -match 'left untouched') `
        "exit=$($r.code)"
    Remove-Box $box

    # 6. Zero bytes: refuse, and say which it was.
    $box = New-Box -Source $uninstall -Content { param($hook) '' }
    $r = Invoke-Box $box
    Add-Result 'uninstall: refuses a zero-byte settings.json' `
    ($r.code -ne 0 -and $r.output -match 'present but empty') "exit=$($r.code)"
    Remove-Box $box

    # 7. No file at all is not a failure.
    $box = New-Box -Source $uninstall -NoFile
    $r = Invoke-Box $box
    Add-Result 'uninstall: an absent settings.json is not a failure' `
    ($r.code -eq 0 -and $r.output -match 'no hook to remove') "exit=$($r.code)"
    Remove-Box $box

    # 8. A copy exists after a real removal. An uninstall is exactly when a user
    #    wants a way back.
    $box = New-UninstallBox -Content $withHook
    if (-not $box) {
        Add-Result 'uninstall: takes a pre-write backup' $false 'could not learn the installed hook command'
    } else {
        $r = Invoke-Box $box
        $bk = $box.settings + '.pre-uninstall-backup'
        Add-Result 'uninstall: takes a pre-write backup' `
        ((Test-Path $bk) -and (Get-Content $bk -Raw) -match 'someone-elses-hook') `
            "exists=$(Test-Path $bk) removalExit=$($r.code)"
        Remove-Box $box
    }

    # 9-10. Another checkout's registration (found live 2026-10-13, see install
    #    case 8). Removed when its target file is gone, because then it can only
    #    fail on every tool call; LEFT, and named, when that checkout still exists,
    #    because it is not this checkout's to remove.
    $otherCheckout = {
        param($path)
        '{ "model": "x", "hooks": { "PostToolUse": [
  { "matcher": "Bash|PowerShell", "hooks": [ { "type": "command", "command": ' + (ConvertTo-Json ('node "' + $path + '"')) + ' } ] },
  { "matcher": "Bash", "hooks": [ { "type": "command", "command": "someone-elses-hook" } ] }
] } }'
    }

    $box = New-Box -Source $uninstall -NoFile
    $gone = ($box.dir -replace '\\', '/') + '/gone-checkout/bin/wildcard-perms'
    [System.IO.File]::WriteAllText($box.settings, (& $otherCheckout $gone))
    $r = Invoke-Box $box
    $after = Get-Content $box.settings -Raw | ConvertFrom-Json
    $ptu = @($after.hooks.PostToolUse)
    Add-Result 'uninstall: removes a vanished checkout too' `
    ($r.code -eq 0 -and $ptu.Count -eq 1 -and $ptu[0].hooks[0].command -eq 'someone-elses-hook' `
            -and $r.output.Contains($gone) -and $r.output -match 'no longer exists') `
        "PostToolUse=$($ptu.Count) survivor=$($ptu[0].hooks[0].command)"
    Remove-Box $box

    $box = New-Box -Source $uninstall -NoFile
    $live = Join-Path $box.dir 'other-checkout\bin\wildcard-perms'
    $null = New-Item -Path (Split-Path -Parent $live) -ItemType Directory -Force
    [System.IO.File]::WriteAllText($live, '')
    $liveSpelled = $live -replace '\\', '/'
    [System.IO.File]::WriteAllText($box.settings, (& $otherCheckout $liveSpelled))
    $before = Get-Content $box.settings -Raw
    $r = Invoke-Box $box
    Add-Result 'uninstall: leaves a live other checkout, and says so' `
    ($r.code -eq 0 -and (Get-Content $box.settings -Raw) -eq $before -and $r.output -match 'nothing removed' `
            -and $r.output.Contains($liveSpelled) -and $r.output -match 'another checkout') `
        "exit=$($r.code) unchanged=$((Get-Content $box.settings -Raw) -eq $before)"
    Remove-Box $box
}

# -- cleanup ----------------------------------------------------------------------
#
# A case of its own, so a leaked sandbox FAILS the run instead of scrolling past
# as red text between cases (see Remove-Box for the 88 folders that did). Two
# conditions: no case's Remove-Box left its box behind, and nothing this run
# created is still on disk after a final sweep. The sweep deletes directly rather
# than through Remove-Box, so it also catches a box a case never handed back, and
# so a run where Remove-Box is broken still leaves %TEMP% as it found it.
$swept = 0
$remaining = @()
foreach ($dir in @($script:boxesMade)) {
    if (-not [System.IO.Directory]::Exists($dir)) { continue }
    $swept++
    try { [System.IO.Directory]::Delete($dir, $true) } catch { }
    if ([System.IO.Directory]::Exists($dir)) {
        $remaining += $dir
        Write-Host "WARN  sandbox left on disk: $dir"
    }
}
Add-Result 'harness: removes every sandbox it creates' `
($script:boxesLeaked.Count -eq 0 -and $remaining.Count -eq 0) `
    "created=$($script:boxesMade.Count) cleanupFailed=$($script:boxesLeaked.Count) swept=$swept remaining=$($remaining.Count)"

# ── report ────────────────────────────────────────────────────────────────────

Write-Host ("installers, child running under powershell.exe (parent: PowerShell $($PSVersionTable.PSVersion))")
foreach ($r in $script:results) {
    Write-Host ('  {0}  {1,-52} {2}' -f $(if ($r.pass) { 'PASS' } else { 'FAIL' }), $r.case, $r.detail)
}
$failed = @($script:results | Where-Object { -not $_.pass }).Count
$total = @($script:results).Count
Write-Host ''
Write-Host ("{0} pass, {1} fail" -f ($total - $failed), $failed)
# A floor, because without one this harness passes by doing nothing. An empty
# results array prints "0 pass, 0 fail" and exits 0, and the CI job that runs
# this would go green having verified nothing at all -- which is the failure
# this whole script exists to prevent, turned on itself. It records 26 cases
# today, 25 where Git for Windows is absent (16 until the other-checkout cases
# landed 2026-10-13, then 23, 24 with the sandbox-cleanup case); the floor sits
# below that so adding or reordering a case does not break it, but no
# plausible breakage leaves more than a handful behind.
$MinimumCases = 18
if ($total -lt $MinimumCases) {
    Write-Host ("FAIL  harness floor: recorded $total cases, expected at least $MinimumCases")
    Write-Host '      A run this short means cases stopped registering, not that they passed.'
    exit 1
}
if ($failed -gt 0) { exit 1 }
exit 0
