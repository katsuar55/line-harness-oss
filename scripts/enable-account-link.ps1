# =============================================================
# ③アカウント連携 有効化スクリプト (1コマンド・Katsu 用)
# =============================================================
# 使い方 (リポジトリ root で):
#   powershell -ExecutionPolicy Bypass -File scripts\enable-account-link.ps1
#
# 前提: このシェルで wrangler が Cloudflare 認証済みであること
#   確認: cd apps\worker; npx wrangler whoami
#
# やること:
#   1. OTP hash 用のランダム pepper (ACCOUNT_LINK_HMAC_KEY) をローカル生成 (画面には表示しない)
#   2. ACCOUNT_LINK_ENABLED / ACCOUNT_LINK_HMAC_KEY / MEMBER_BACKFILL_ENABLED を
#      `wrangler secret bulk` で一括投入
#      (JSON ファイル方式 = PowerShell パイプの末尾 CRLF 混入トラップ回避)
#   3. 一時ファイル ($env:TEMP 配下・repo 外) を finally で削除し、secret 名の一覧を表示して確認
#      ※ 強制終了された場合に備え、異常時は最後に一時ファイルの残存を確認してください
#
# secret は投入後すぐ有効 (worker の再デプロイ不要)。
# 参照: docs/ACCOUNT_LINK_DESIGN.md §6 有効化手順
# =============================================================

$ErrorActionPreference = 'Stop'

$workerDir = Join-Path $PSScriptRoot '..\apps\worker'
Set-Location $workerDir

Write-Host '=== 1/3 HMAC pepper を生成中 (表示されません) ==='
$hmac = (node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" | Out-String).Trim()
if (-not $hmac -or $hmac.Length -lt 64) {
  throw 'HMAC key の生成に失敗しました (node が PATH にあるか確認してください)'
}

$secrets = [ordered]@{
  ACCOUNT_LINK_ENABLED    = 'true'
  ACCOUNT_LINK_HMAC_KEY   = $hmac
  MEMBER_BACKFILL_ENABLED = 'true'
} | ConvertTo-Json

# repo 外 ($env:TEMP) に書く — commit 事故と repo 内残存を防止 (review LOW)
$tmp = Join-Path $env:TEMP ("secrets.account-link.{0}.json" -f [guid]::NewGuid().ToString('N'))
Write-Host '=== 2/3 wrangler secret bulk で投入中 ==='
try {
  # UTF8 (BOM なし) で書く — wrangler の JSON parse を確実に通す
  [System.IO.File]::WriteAllText($tmp, $secrets)
  npx wrangler secret bulk $tmp
  if ($LASTEXITCODE -ne 0) { throw "wrangler secret bulk failed (exit $LASTEXITCODE)" }
} finally {
  if (Test-Path $tmp) { Remove-Item $tmp -Force }
}

Write-Host ''
Write-Host '=== 3/3 現在の secret 一覧 (値は表示されません) ==='
npx wrangler secret list

Write-Host ''
Write-Host '完了。上の一覧に ACCOUNT_LINK_ENABLED / ACCOUNT_LINK_HMAC_KEY / MEMBER_BACKFILL_ENABLED があれば成功です。'
Write-Host '次: Claude に「secret 投入完了」と伝えてください (本番検証と一括バックフィルを実行します)。'
