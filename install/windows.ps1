<#
    JobBook, installed on Windows.

    Run it straight from the web:

        irm https://raw.githubusercontent.com/VibeLogicCode/JobBook/main/install/windows.ps1 | iex

    What it does, in order: checks Docker is there and running, makes a folder,
    generates two passwords nobody has to invent, writes a compose file and a
    .env beside it, pulls the image, starts it, waits until it answers, and
    opens the browser.

    ---------------------------------------------------------------------------
    IT NEVER OVERWRITES AN EXISTING .env
    ---------------------------------------------------------------------------

    That file holds the database password. Regenerating it against a data
    folder that already exists locks the app out of its own records with a
    password error nobody can act on. So a second run reuses what is there and
    says so -- which is also what makes this script safe to use as an updater.
#>

#Requires -Version 5.1
$ErrorActionPreference = 'Stop'

$Repo        = 'VibeLogicCode/JobBook'
$Branch      = 'main'
$ComposeUrl  = "https://raw.githubusercontent.com/$Repo/$Branch/install/docker-compose.yml"
$DefaultPort = 38080

function Say([string]$Text)   { Write-Host $Text }
function Step([string]$Text)  { Write-Host "`n$Text" -ForegroundColor Cyan }
function Good([string]$Text)  { Write-Host "  $Text" -ForegroundColor Green }
function Warn([string]$Text)  { Write-Host "  $Text" -ForegroundColor Yellow }
function Fail([string]$Text)  { Write-Host "`n$Text" -ForegroundColor Red; exit 1 }

Say ''
Say 'JobBook'
Say 'Quoting, invoicing and job costing, on your own machine.'
Say ''

# ---------------------------------------------------------------------------
# 1. Docker
# ---------------------------------------------------------------------------
Step 'Checking Docker...'

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Say ''
    Say '  Docker Desktop is not installed. It is free, and it is the only thing'
    Say '  JobBook needs on Windows.'
    Say ''
    Say '    https://www.docker.com/products/docker-desktop/'
    Say ''
    $open = Read-Host '  Open that page now? [Y/n]'
    if ($open -ne 'n') { Start-Process 'https://www.docker.com/products/docker-desktop/' }
    Fail 'Install Docker Desktop, start it once, then run this again.'
}

# `docker info` rather than `docker --version`: the CLI answers happily while
# the engine is still starting, and every command after this would fail with a
# pipe error that names nothing.
docker info 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    Say ''
    Say '  Docker is installed but not running. Start Docker Desktop, wait for'
    Say '  the whale in the system tray to stop animating, then run this again.'
    Fail 'Docker is not running.'
}
Good 'Docker is running.'

# The image carries a real Chromium for the PDF pipeline, and that build is
# amd64. Better to say so here than to let `docker pull` fail with a platform
# mismatch nobody reads.
if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') {
    Warn 'This is an ARM64 PC. The image is x86_64 and will run only under emulation, slowly.'
}

# ---------------------------------------------------------------------------
# 2. Where it goes
# ---------------------------------------------------------------------------
Step 'Choosing a folder...'

$Default = Join-Path $env:LOCALAPPDATA 'JobBook'
Say "  Default: $Default"
$Answer = Read-Host '  Press Enter to accept, or type another path'
$Root   = if ([string]::IsNullOrWhiteSpace($Answer)) { $Default } else { $Answer.Trim('"') }

New-Item -ItemType Directory -Force -Path $Root | Out-Null
foreach ($sub in 'data\db', 'data\files', 'data\config') {
    New-Item -ItemType Directory -Force -Path (Join-Path $Root $sub) | Out-Null
}
Good "Using $Root"

# ---------------------------------------------------------------------------
# 3. The compose file
# ---------------------------------------------------------------------------
Step 'Fetching the compose file...'

$ComposePath = Join-Path $Root 'docker-compose.yml'
try {
    Invoke-WebRequest -Uri $ComposeUrl -OutFile $ComposePath -UseBasicParsing
    Good 'Saved docker-compose.yml'
} catch {
    Fail "Could not download the compose file from $ComposeUrl`n$($_.Exception.Message)"
}

# ---------------------------------------------------------------------------
# 4. Secrets, generated once and kept
# ---------------------------------------------------------------------------
Step 'Settings...'

function New-Secret {
    # 32 bytes from the OS cryptographic RNG, as hex. Not Get-Random, which is
    # seeded and predictable, and this is a database password.
    $bytes = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    -join ($bytes | ForEach-Object { $_.ToString('x2') })
}

$EnvPath = Join-Path $Root '.env'
$Port    = $DefaultPort

if (Test-Path $EnvPath) {
    Good 'Existing .env found -- keeping your password and settings.'
    $existing = Get-Content $EnvPath | Where-Object { $_ -match '^APP_PORT=' } | Select-Object -First 1
    if ($existing) { $Port = ($existing -split '=', 2)[1].Trim() }
} else {
    $answer = Read-Host "  Port to use [$DefaultPort]"
    if (-not [string]::IsNullOrWhiteSpace($answer)) { $Port = $answer.Trim() }

    @(
        '# Written by install/windows.ps1. Keep this file.',
        '#',
        '# POSTGRES_PASSWORD is the database password. If you lose it or change',
        '# it, the app can no longer open its own records -- there is nothing in',
        '# here to recover it from, because nothing else knows it.',
        "POSTGRES_PASSWORD=$(New-Secret)",
        '',
        '# Signs the internal request that renders a PDF. Never leaves the',
        '# machine.',
        "INTERNAL_RENDER_SECRET=$(New-Secret)",
        '',
        "APP_PORT=$Port",
        '',
        '# AUTH_MODE=local treats every visitor as the owner. Right for your own',
        '# machine or your own network; wrong for anything reachable from the',
        '# internet. Do not forward this port to the world.',
        'AUTH_MODE=local',
        '',
        '# A fictional demo tenant on first boot. Leave it at 0 for real work.',
        'SEED_DEMO=0',
        '',
        '# Encrypted backups. Generate a keypair on a workstation with age-keygen,',
        '# put the PUBLIC half here, keep the private half in a password manager.',
        '# Empty means no backups are taken and the log says so.',
        'BACKUP_AGE_PUBLIC_KEY='
    ) | Set-Content -Path $EnvPath -Encoding ASCII

    Good 'Wrote .env with freshly generated passwords.'
}

# ---------------------------------------------------------------------------
# 5. Pull and start
# ---------------------------------------------------------------------------
Step 'Downloading JobBook (about 2 GB the first time)...'

Push-Location $Root
try {
    docker compose pull
    if ($LASTEXITCODE -ne 0) {
        Say ''
        Say '  The download failed. The usual cause is that the image has not been'
        Say '  made public yet, in which case Docker says "unauthorized".'
        Say ''
        Say "    https://github.com/$Repo/pkgs/container/jobbook"
        Say ''
        Fail 'Could not pull the image.'
    }

    Step 'Starting...'
    docker compose up -d
    if ($LASTEXITCODE -ne 0) { Fail 'Docker could not start the containers.' }
} finally {
    Pop-Location
}

# ---------------------------------------------------------------------------
# 6. Wait for it to answer
# ---------------------------------------------------------------------------
Step 'Waiting for the first boot (it migrates the database, so give it a minute)...'

$Url   = "http://localhost:$Port"
$Ready = $false
foreach ($i in 1..60) {
    Start-Sleep -Seconds 2
    try {
        $response = Invoke-WebRequest -Uri "$Url/api/health" -UseBasicParsing -TimeoutSec 4
        if ($response.StatusCode -eq 200) { $Ready = $true; break }
    } catch {
        # Still starting. The health endpoint answers before the app is
        # reachable from a browser, so this is the honest thing to poll.
    }
}

Say ''
if ($Ready) {
    Good 'JobBook is running.'
    Say ''
    Say "  Open:     $Url"
    Say '  It will walk you through setting up your company.'
} else {
    Warn 'It has not answered yet. That is not necessarily wrong -- a first boot'
    Warn 'on a slow disk can take a few minutes.'
    Say ''
    Say "  Try:      $Url"
    Say "  Logs:     docker compose -f `"$ComposePath`" logs -f app"
}

Say ''
Say '  Stop:     docker compose -f "' + $ComposePath + '" down'
Say '  Start:    docker compose -f "' + $ComposePath + '" up -d'
Say '  Update:   irm https://raw.githubusercontent.com/' + $Repo + '/' + $Branch + '/install/update.ps1 | iex'
Say ''
Say '  Your data is in ' + (Join-Path $Root 'data') + '. Back that folder up.'
Say ''

if ($Ready) { Start-Process $Url }
