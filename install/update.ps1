<#
    Updates a JobBook install on Windows.

        irm https://raw.githubusercontent.com/VibeLogicCode/JobBook/main/install/update.ps1 | iex

    Pulls the newest image, refreshes the compose file, and restarts. Your
    .env is never touched, so the database password stays what it was -- which
    is the whole reason this is a separate script rather than "run the
    installer again".

    The data folder is untouched too. An update replaces the program, not the
    records: migrations run at boot, and the container that runs them will not
    start serving until they have finished.
#>

#Requires -Version 5.1
$ErrorActionPreference = 'Stop'

$Repo       = 'VibeLogicCode/JobBook'
$Branch     = 'main'
$ComposeUrl = "https://raw.githubusercontent.com/$Repo/$Branch/install/docker-compose.yml"

function Say([string]$t)  { Write-Host $t }
function Step([string]$t) { Write-Host "`n$t" -ForegroundColor Cyan }
function Good([string]$t) { Write-Host "  $t" -ForegroundColor Green }
function Fail([string]$t) { Write-Host "`n$t" -ForegroundColor Red; exit 1 }

Say ''
Say 'Updating JobBook'

$Default = Join-Path $env:LOCALAPPDATA 'JobBook'
Say ''
Say "  Default: $Default"
$Answer = Read-Host '  Press Enter to accept, or type where you installed it'
$Root   = if ([string]::IsNullOrWhiteSpace($Answer)) { $Default } else { $Answer.Trim('"') }

if (-not (Test-Path (Join-Path $Root '.env'))) {
    Fail "No .env in $Root -- that does not look like a JobBook install.`nRun the installer instead:`n  irm https://raw.githubusercontent.com/$Repo/$Branch/install/windows.ps1 | iex"
}

Step 'Backing up your settings file...'
# Cheap insurance. The .env holds the only copy of the database password, and
# every step below writes near it.
Copy-Item (Join-Path $Root '.env') (Join-Path $Root '.env.backup') -Force
Good 'Copied .env to .env.backup'

Step 'Refreshing the compose file...'
try {
    Invoke-WebRequest -Uri $ComposeUrl -OutFile (Join-Path $Root 'docker-compose.yml') -UseBasicParsing
    Good 'Updated docker-compose.yml'
} catch {
    Fail "Could not download the compose file.`n$($_.Exception.Message)"
}

Push-Location $Root
try {
    Step 'Downloading the new image...'
    docker compose pull
    if ($LASTEXITCODE -ne 0) { Fail 'Could not pull the image.' }

    Step 'Restarting...'
    # `up -d` recreates only what changed, so the database container is left
    # alone when only the app image moved.
    docker compose up -d
    if ($LASTEXITCODE -ne 0) { Fail 'Docker could not restart the containers.' }

    Step 'Tidying up old images...'
    docker image prune -f | Out-Null
    Good 'Done.'
} finally {
    Pop-Location
}

$Port = 38080
$line = Get-Content (Join-Path $Root '.env') | Where-Object { $_ -match '^APP_PORT=' } | Select-Object -First 1
if ($line) { $Port = ($line -split '=', 2)[1].Trim() }

Say ''
Say "  JobBook is restarting at http://localhost:$Port"
Say '  The first request after an update waits for the migrations to finish.'
Say ''
