# 独自ドメイン移行 runbook — `crm.naturism-diet.com`

2026-07-23 作成。管理側ブラッシュアップ② 「独自ドメイン化」の実行手順。

**方針: 追加のみ・段階移行。** workers.dev の既存 URL
(`https://naturism-line-crm.katsu-7d5.workers.dev`) は**生かしたまま**新ホストを併存させる。
LINE Webhook・LIFF・OAuth コールバックは検証が終わるまで旧 URL のままにする
(先に切り替えると friend 追加・ログインが即死する)。

## なぜ独自ドメインにするのか

- `*.workers.dev` はスタッフ・顧客から見て素性が分かりにくく、社内メールで共有した際に
  フィッシングと誤認されうる
- 将来 worker を作り直しても URL が変わらない (アカウント名がホスト名に含まれない)
- ブラウザのブックマーク・パスワードマネージャの一貫性

## 前提

- `naturism-diet.com` の NS は既に Cloudflare (`konnor/rihana.ns.cloudflare.com`)、apex は
  Shopify ストアを指している。**サブドメイン `crm.` を足すだけなのでストアには無影響**
- CI の `CLOUDFLARE_API_TOKEN` に Zone 読取 + Workers 編集の権限が必要

---

## 手順1 — 事前確認 (read-only・無害)

GitHub Actions → **Admin Ops** → `op = custom-domain-status` を実行。

サマリに以下が出る:

```
- zone_found_in_this_account: YES / NO
- already_attached: YES / NO
```

- **YES** → 手順2へ進める
- **NO** → `naturism-diet.com` が別の Cloudflare アカウントにあるか、トークンに Zone 読取権限が
  ない。**手順2を実行してはいけない** (失敗する)。Katsu が Cloudflare ダッシュボードで
  Workers → naturism-line-crm → Settings → Domains & Routes → Custom Domain から手動追加する
  (数クリック) 方が早い

## 手順2 — ドメインをアタッチ (追加のみ・ロールバック可)

**Admin Ops** → `op = attach-custom-domain` を実行。

- Cloudflare が DNS レコードと SSL 証明書を自動発行する (数分)
- 完了後、`https://crm.naturism-diet.com/` が worker のトップを返すことを確認
- **この時点では旧 URL も完全に動いている** (併存)。ここで止めても運用に一切影響しない

ロールバック: Cloudflare ダッシュボードで Custom Domain を削除 (または DNS レコード削除)。
worker 側の設定は無変更なので旧 URL は影響を受けない。

## 手順3 — スタッフ向け URL の切替 (低リスク)

管理画面はブラウザからしか使わないので、ここは安全に切り替えられる。

1. `https://crm.naturism-diet.com/admin` が開けることを確認
2. 運用ガイド (`STAFF_GUIDE_naturism_LINE.html`) の URL を差し替えて再配布
3. スタッフにブックマークの更新を依頼

**CORS 許可オリジンには既に `https://crm.naturism-diet.com` を追加済み** (apps/worker/src/index.ts)
なので、管理画面の API 呼び出しはこのホストからでも通る。

## 手順4 — 顧客向け経路の切替 (要検証・ここから慎重に)

以下は**顧客の導線を壊しうる**。1つずつ、検証しながら進める。

| 対象 | 変更内容 | 壊れると何が起きるか |
|---|---|---|
| LINE Developers → Messaging API → Webhook URL | `https://crm.naturism-diet.com/webhook` | **全メッセージ受信停止** (自動応答・友だち追加特典が全死) |
| **LINE Developers → LIFF → エンドポイント URL** | 新 URL へ (旧 URL の LIFF セッションは残る) | **ポータル全体が旧 URL 配信のまま** — 顧客導線で最も使われる経路。`LIFF_URL` secret (= `liff.line.me/<id>`) とは別物なので secret 切替では拾えない |
| LINE Developers → LINE Login → コールバック URL | 新 URL を**追加** (旧は残す) | アカウント連携ログインが失敗 |
| Shopify Dev Dashboard → App URL / Redirect URL | 新 URL を**追加** (旧は残す) | Shopify 再連携時に失敗 |
| **Stripe ダッシュボード → Webhooks → エンドポイント** | 新 URL + 署名シークレット再生成 | 決済イベント受信停止 (`/api/integrations/stripe/webhook`) |
| wrangler secret `WORKER_URL` / `LIFF_URL` | 新 URL へ | メール内リンク・LIFF 導線が旧 URL のまま (無害だが不統一) |
| **`apps/worker/wrangler.toml` の `[vars] EMAIL_UNSUBSCRIBE_BASE_URL`** | **コード変更 + deploy が必要** (secret ではない) | メールの配信停止リンクが旧 URL のまま。特定電子メール法上の必須要素なので、旧 URL 廃止前に必ず移す |
| Shopify Webhook 登録 (注文/顧客) | 新 URL | 注文連携停止 (クーポン付与・ランク判定が止まる) |
| リッチメニューの URI | 新 URL | ボタンが旧 URL を開く (旧が生きている限り無害) |

**推奨順序**: コールバック URL の「追加」(旧併存) → 動作確認 → secret 切替 → 最後に Webhook URL。
Webhook URL の切替は**最後**にし、切替直後に自分の LINE からメッセージを送って自動応答が
返ることを必ず確認する。異常時は LINE Developers で旧 URL に戻せば即復旧する。

## 手順5 — 旧 URL の扱い

- **止めない**。`workers.dev` は無料で併存でき、旧リンク (過去のメール・既存の LIFF セッション)
  が生き続ける
- 完全移行の判断は最低 3 ヶ月後、アクセスログで旧 URL 利用がゼロになってから
- **旧 URL を止める前に、手順4 の表の全項目が新 URL に移っていることを 1 行ずつ確認する**
  (特に `EMAIL_UNSUBSCRIBE_BASE_URL` はコード側なので secret 一覧では見つからない)

## 検証チェックリスト

- [ ] `curl -s -o /dev/null -w "%{http_code}" https://crm.naturism-diet.com/` → 200
- [ ] `https://crm.naturism-diet.com/admin` がダッシュボードを表示 (401 でない)
- [ ] `https://crm.naturism-diet.com/api/admin/dashboard` が未認証で 401
- [ ] 旧 URL `https://naturism-line-crm.katsu-7d5.workers.dev/` も 200 のまま
- [ ] (手順4以降) LINE で「お問い合わせ」と送って自動応答が返る
