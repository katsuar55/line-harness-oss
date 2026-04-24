# ワンショット: CLOUDFLARE_API_TOKEN を GitHub Secrets に登録する。
#
# 事前作業 (Katsu):
#   1. https://dash.cloudflare.com/profile/api-tokens を開く
#   2. 「トークンを作成」→「カスタムトークン」を「使う」
#   3. トークン名: github-actions-deploy-and-backup
#      権限:
#        アカウント > Account Settings       : Read
#        アカウント > Workers Scripts        : Edit
#        アカウント > D1                     : Edit
#        アカウント > Workers R2 Storage     : Edit
#        ユーザー   > User Details           : Read
#      アカウントリソース: 含める > 特定のアカウント > Katsu@kenkoex.com's Account
#   4. 「概要を続ける」→「トークンを作成」→ 表示される値をコピー
#   5. このスクリプトを実行 (PowerShell から):
#        cd C:\Users\user\Desktop\line-harness-oss
#        powershell -ExecutionPolicy Bypass -File scripts/setup-github-secrets.ps1
#
# CLOUDFLARE_ACCOUNT_ID は既に登録済 (7d5372d95437094beb5c91f4015402e1)
# 登録後の検証方法はスクリプト末尾に表示します。

$ErrorActionPreference = 'Stop'

$REPO = 'katsuar55/line-harness-oss'

# gh.exe の解決順: (1) PATH (2) winget 標準インストール先 (3) ローカル .tools にダウンロード
function Resolve-GhBinary {
    $fromPath = Get-Command gh -ErrorAction SilentlyContinue
    if ($fromPath) { return $fromPath.Source }

    $standardPaths = @(
        'C:\Program Files\GitHub CLI\gh.exe',
        "$env:LOCALAPPDATA\Programs\GitHub CLI\gh.exe"
    )
    foreach ($p in $standardPaths) {
        if (Test-Path $p) { return $p }
    }

    $localBin = 'C:\Users\user\Desktop\line-harness-oss\.tools\gh\bin\gh.exe'
    if (Test-Path $localBin) { return $localBin }

    Write-Host "gh not found anywhere. Downloading to .tools/gh ..." -ForegroundColor Yellow
    New-Item -ItemType Directory -Force -Path (Split-Path $localBin -Parent) | Out-Null
    $zipUrl = 'https://github.com/cli/cli/releases/download/v2.91.0/gh_2.91.0_windows_amd64.zip'
    $tmpZip = "$env:TEMP\gh.zip"
    Invoke-WebRequest -Uri $zipUrl -OutFile $tmpZip
    Expand-Archive -Path $tmpZip -DestinationPath "$env:TEMP\gh-extract" -Force
    Copy-Item -Recurse -Force "$env:TEMP\gh-extract\bin" (Split-Path $localBin -Parent | Split-Path -Parent | Join-Path -ChildPath 'bin')
    Remove-Item $tmpZip -Force
    if (-not (Test-Path $localBin)) { throw "gh.exe download failed: $localBin" }
    return $localBin
}

$GH_BIN = Resolve-GhBinary
Write-Host "Using gh at: $GH_BIN" -ForegroundColor DarkGray

# GitHub 認証情報を Windows 資格情報マネージャから取得
$cred = @"
url=https://github.com
"@ | git credential fill

$ghToken = ($cred | Select-String '^password=').Line.Split('=', 2)[1]
if (-not $ghToken) {
    Write-Host "ERROR: GitHub credential not found in Windows Credential Manager."
    Write-Host "Run 'git credential-manager configure' or push any commit to re-authenticate." -ForegroundColor Red
    exit 1
}
$env:GH_TOKEN = $ghToken

# Cloudflare API Token を入力
Write-Host ""
Write-Host "==== Cloudflare API Token ====" -ForegroundColor Cyan
Write-Host "Dashboard > My Profile > API Tokens > Create Token で作成したトークンを貼り付けてください。"
Write-Host "(入力時は画面に表示されません)"
$secureToken = Read-Host "Paste CLOUDFLARE_API_TOKEN" -AsSecureString
$plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
)
$plain = $plain.Trim()

if (-not $plain) {
    Write-Host "ERROR: empty token" -ForegroundColor Red
    exit 1
}

# Cloudflare API で token 妥当性検証
Write-Host ""
Write-Host "Verifying Cloudflare token..." -ForegroundColor Yellow
$headers = @{ 'Authorization' = "Bearer $plain"; 'Content-Type' = 'application/json' }
$verify = Invoke-RestMethod -Uri 'https://api.cloudflare.com/client/v4/user/tokens/verify' -Headers $headers -ErrorAction Stop
if (-not $verify.success) {
    Write-Host "ERROR: Cloudflare token verification failed:" -ForegroundColor Red
    $verify.errors | ForEach-Object { Write-Host "  $($_.message)" }
    exit 1
}
Write-Host "  Cloudflare token verified (status: $($verify.result.status))" -ForegroundColor Green

# GitHub Secret に登録
Write-Host ""
Write-Host "Setting CLOUDFLARE_API_TOKEN on $REPO ..." -ForegroundColor Yellow
$plain | & $GH_BIN secret set CLOUDFLARE_API_TOKEN --repo $REPO
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: gh secret set failed with exit code $LASTEXITCODE" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "==== Current secrets on $REPO ====" -ForegroundColor Cyan
& $GH_BIN secret list --repo $REPO

Write-Host ""
Write-Host "[OK] Completed. Next workflow run will use the new token." -ForegroundColor Green
Write-Host ""
Write-Host "Verify CI status: https://github.com/$REPO/actions" -ForegroundColor Cyan
