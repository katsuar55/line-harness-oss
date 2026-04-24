# One-shot script: register CLOUDFLARE_API_TOKEN as a GitHub repository secret.
#
# Prerequisites (Katsu must do once):
#   1. Open https://dash.cloudflare.com/profile/api-tokens
#   2. Click 'Create Token', then 'Custom token' -> 'Use template'
#   3. Name: github-actions-deploy-and-backup
#      Permissions:
#        Account  - Account Settings       - Read
#        Account  - Workers Scripts        - Edit
#        Account  - D1                     - Edit
#        Account  - Workers R2 Storage     - Edit
#        User     - User Details           - Read
#      Account Resources: Include -> Specific account -> Katsu's account
#   4. 'Continue to summary' -> 'Create Token' -> COPY the token value
#   5. From PowerShell (in repo root):
#        powershell -ExecutionPolicy Bypass -File scripts\setup-github-secrets.ps1
#
# CLOUDFLARE_ACCOUNT_ID is already registered (7d5372d95437094beb5c91f4015402e1).
# This script validates the pasted token against Cloudflare API then stores it in
# GitHub repo secrets via gh CLI, using the GitHub OAuth token already cached in
# the Windows Credential Manager.

$ErrorActionPreference = 'Stop'
$REPO = 'katsuar55/line-harness-oss'

# --- Resolve gh binary ----------------------------------------------------
function Resolve-GhBinary {
    $fromPath = Get-Command gh -ErrorAction SilentlyContinue
    if ($fromPath) { return $fromPath.Source }

    $standard = @(
        'C:\Program Files\GitHub CLI\gh.exe',
        (Join-Path $env:LOCALAPPDATA 'Programs\GitHub CLI\gh.exe')
    )
    foreach ($p in $standard) {
        if (Test-Path $p) { return $p }
    }

    $localBin = Join-Path $PSScriptRoot '..\.tools\gh\bin\gh.exe'
    $localBin = [IO.Path]::GetFullPath($localBin)
    if (Test-Path $localBin) { return $localBin }

    Write-Host 'gh CLI not found. Downloading to .tools/gh/ ...' -ForegroundColor Yellow
    $parent = Split-Path $localBin -Parent
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
    $zipUrl = 'https://github.com/cli/cli/releases/download/v2.91.0/gh_2.91.0_windows_amd64.zip'
    $tmpZip = Join-Path $env:TEMP 'gh.zip'
    $tmpDir = Join-Path $env:TEMP 'gh-extract'
    Invoke-WebRequest -Uri $zipUrl -OutFile $tmpZip
    Expand-Archive -Path $tmpZip -DestinationPath $tmpDir -Force
    Copy-Item -Recurse -Force (Join-Path $tmpDir 'bin\*') $parent
    Remove-Item $tmpZip -Force
    Remove-Item -Recurse -Force $tmpDir
    if (-not (Test-Path $localBin)) { throw "gh.exe download failed: $localBin" }
    return $localBin
}

$GH_BIN = Resolve-GhBinary
Write-Host "Using gh at: $GH_BIN" -ForegroundColor DarkGray

# --- Get GitHub OAuth token from Windows Credential Manager ---------------
$credInput = "url=https://github.com`n`n"
$cred = $credInput | git credential fill 2>$null
if (-not $cred) {
    Write-Host 'ERROR: GitHub credential not found in Windows Credential Manager.' -ForegroundColor Red
    Write-Host 'Run any git push/pull to re-authenticate, then retry.'
    exit 1
}
$passwordLine = $cred | Select-String -Pattern '^password='
if (-not $passwordLine) {
    Write-Host 'ERROR: Could not extract password from git credential output.' -ForegroundColor Red
    exit 1
}
$env:GH_TOKEN = $passwordLine.Line.Substring(9)

# --- Prompt for Cloudflare API Token --------------------------------------
Write-Host ''
Write-Host '==== Cloudflare API Token ====' -ForegroundColor Cyan
Write-Host 'Paste the API token you created in the Cloudflare Dashboard.'
Write-Host '(Input is hidden; nothing will be shown as you type)'
$secure = Read-Host -Prompt 'Token' -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
$token = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
$token = $token.Trim()

if (-not $token) {
    Write-Host 'ERROR: empty token.' -ForegroundColor Red
    exit 1
}

# --- Validate token against Cloudflare API --------------------------------
Write-Host ''
Write-Host 'Verifying Cloudflare token...' -ForegroundColor Yellow
$headers = @{ 'Authorization' = "Bearer $token"; 'Content-Type' = 'application/json' }
try {
    $verify = Invoke-RestMethod -Uri 'https://api.cloudflare.com/client/v4/user/tokens/verify' -Headers $headers
} catch {
    Write-Host ('ERROR: verification call failed: ' + $_.Exception.Message) -ForegroundColor Red
    exit 1
}
if (-not $verify.success) {
    Write-Host 'ERROR: Cloudflare token verification failed:' -ForegroundColor Red
    $verify.errors | ForEach-Object { Write-Host ("  - " + $_.message) }
    exit 1
}
Write-Host ('  OK (status: ' + $verify.result.status + ')') -ForegroundColor Green

# --- Register GitHub Secret -----------------------------------------------
Write-Host ''
Write-Host "Registering CLOUDFLARE_API_TOKEN on $REPO ..." -ForegroundColor Yellow
$token | & $GH_BIN secret set CLOUDFLARE_API_TOKEN --repo $REPO
if ($LASTEXITCODE -ne 0) {
    Write-Host ('ERROR: gh secret set failed with exit code ' + $LASTEXITCODE) -ForegroundColor Red
    exit 1
}

# --- Verify ---------------------------------------------------------------
Write-Host ''
Write-Host "==== Current secrets on $REPO ====" -ForegroundColor Cyan
& $GH_BIN secret list --repo $REPO

Write-Host ''
Write-Host '[DONE] Setup complete.' -ForegroundColor Green
Write-Host ('GitHub Actions: https://github.com/' + $REPO + '/actions') -ForegroundColor Cyan
