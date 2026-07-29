# Shopify App Proxy 連携 — 有効化 runbook (2026-07-29)

`/proxy/line-link` を live にするまでの手順。**既定は dormant** (`APP_PROXY_LINK_ENABLED` 未設定 =
worker は 404 を返す) なので、merge・deploy だけでは何も起きない。

## この機能が解くこと

friend ↔ Shopify customer の連携は本番実測 10 人 / 顧客 3,434 人。属性・購買セグメント配信、
会員ランク、サブスク管理はすべてこの連携数に律速されている。magic-link (#205) が
「店舗が email を送る」プッシュ型なのに対し、本機能は**顧客が Shopify にログインした時点で拾う**
プル型で、購入前に必ずログインするため放っておいても連携が貯まる。

## フロー

```
LIFF マイアカウント「ストアにログインして連携」
  → 外部ブラウザで https://<storefront>/apps/line-link
  → Shopify App Proxy が worker GET /proxy/line-link へ転送
      (query: signature / shop / timestamp / path_prefix / logged_in_customer_id)
  → 署名検証 → 短命 token 発行 (batch_id='app-proxy', TTL 15分)
  → 「LINEを開いて連携する」タップ → LIFF_URL?slk=<token>
  → 既存 ?slk= fast path → 確認カード → redeem (CAS + UNIQUE)
```

## 手順

### 1. Shopify Dev Dashboard で App Proxy を設定

対象 app の Configuration → App proxy:

| 項目 | 値 |
|---|---|
| Subpath prefix | `apps` |
| Subpath | `line-link` |
| Proxy URL | `https://naturism-line-crm.katsu-7d5.workers.dev/proxy/line-link` |

**Subpath を変えた場合は `APP_PROXY_PATH_PREFIX` (services/app-proxy-link.ts) も合わせること。**
不一致だと署名は通るが `bad_path_prefix` で全て 404 になる。

### 2. 🚨 有効化**前**の否定テスト (必須)

本実装の identity は Shopify が付ける `logged_in_customer_id`。これは storefront の query として
訪問者も書ける位置にあるため、「訪問者が同名パラメータを先に置いたとき Shopify がどう振る舞うか」で
安全性が変わる。実装は重複キーを無条件で拒否して追記・上書きの両方を塞いでいるが、
**訪問者の値を温存する**挙動だけはコード側から検証できない。以下を実機で確認する。

gate off のまま (= 404 が返る状態で)、worker へ転送された query の
`logged_in_customer_id` の **出現回数**を確認する。

| 観測 | 意味 | 判定 |
|---|---|---|
| 2 回 | Shopify が自分の値を追記した | ✅ 重複キー拒否が効く |
| 1 回・値が空 | Shopify が上書きした | ✅ 注入が無効化される |
| 1 回・注入値のまま | 訪問者の値が温存された | 🚨 **有効化しない** |

#### 実施方法

**A. 手元に Cloudflare API トークンがある場合 (最短)**

```bash
npx wrangler tail --format=json --search line-link
```

を回しながら、別ターミナルで storefront を叩く:

```bash
curl -s -o /dev/null "https://naturism-diet.com/apps/line-link?logged_in_customer_id=999999999999"
```

出力の `"url"` に含まれる `logged_in_customer_id=` の出現回数を数える。

**B. トークンが無い場合: Admin Ops `app-proxy-probe`**

`storefront_url` を空にすると **listen-only モード**で 240 秒間 tail し、
出現回数と「注入値が残ったか」だけをサマリに出す (署名・実顧客 id は出力しない)。
その 240 秒の間に、**実端末から**上の curl を数回叩く。

運用上の注意 (2026-07-29 に実際に踏んだもの):
- **GitHub Actions の runner から storefront を叩いても worker に届かない**
  (datacenter IP が弾かれている模様)。必ず実端末から叩くこと
- 本番は常時 10 req/s 規模のトラフィックがあり、`--search` を付けないと
  tail のサンプリングでこちらのリクエストが落ちる
- job の queue 時間が読めないため、**job が `in_progress` になってから**叩き始める

**`ready` 相当の挙動が観測されたら有効化しないこと。** その場合は identity を
`logged_in_customer_id` 単独に依存しない設計へ変更する必要がある。

### 3. storefront 注入 script の棚卸し

`ready` ページは本文に連携トークン (capability) を含む。Sec-Fetch 検査で fetch/XHR/iframe は
弾いているが、**同一オリジンの `window.open` は原理的に区別できず通る**ため、storefront に
同居する第三者アプリの script は理論上トークンを読める。有効化前に storefront に注入されている
script を確認する (CRM PLUS on LINE / Social PLUS / チャットウィジェット等)。

残存リスクは TTL 15 分と、確認カードのマスク済 email (連携先が自分かを人間が確かめる材料) で縮めている。

### 4. secret 投入 + gate ON

GitHub Actions「Admin Ops」→ `enable-app-proxy-link`:

- `storefront_url` に `https://naturism-diet.com` を渡すと `SHOPIFY_STOREFRONT_URL` も投入され、
  LIFF マイアカウントに連携カードが出る
- 省略すると gate だけ ON (= proxy 経路の live 検証だけ先にやる段階投入)

op は事前に以下を検証して失敗させる:
- `sub_link_tokens` テーブルの存在 (migration 073)
- `SHOPIFY_CLIENT_SECRET` / `LIFF_URL` / `SHOPIFY_STORE_DOMAIN` が secret に存在すること
- `storefront_url` が `https://<ホスト名>` 形式であること (path/port/query は worker 側の
  検証で弾かれ、gate は ON なのにボタンだけ出ない乖離になる)

### 5. 既存連携分の逆方向リンク補完

`backfill-customer-friend-id` op を実行する。連携済み friend から
`shopify_customers.friend_id` と `shopify_orders.friend_id` を補完する
(= 購買セグメント配信・ランク集計・出荷通知の突合が効くようになる)。

既存の `friend_id` を**別値へ**上書きする行がある場合は exit 1 で停止する
(旧値は記録されず不可逆、かつ注文 webhook 経路が書いた値と食い違う可能性があるため)。

### 6. 動作確認

1. LIFF マイアカウントに「🛍️ オンラインストアと連携」カードが出ること
2. タップ → 外部ブラウザで storefront が開くこと
3. 未ログインなら「ログインする」→ ログイン後にこのページへ戻ること
4. ログイン済みなら「LINEを開いて連携する」→ LINE が開き確認カードが出ること
5. 確認カードに**マスク済み email** が出ていること (自分のものか判断できる)
6. 「このLINEに連携する」→ 完了 → ポータルに戻るとカードが「✅ 連携済み」に変わること

## 停止 (kill switch)

`APP_PROXY_LINK_ENABLED` を削除するか `true` 以外にする。
gate は **token の発行経路ごと**に効くので、これを切っても magic-link キャンペーン
(`SUB_LINK_ENABLED`) は独立して動く。逆も同じ。

## 関連

- 実装: `apps/worker/src/{utils/shopify-app-proxy.ts, services/app-proxy-link.ts, routes/app-proxy.ts}`
- 受け入れ側 (共用): `apps/worker/src/services/sub-link.ts` (#205 / #206)
- 公式ドキュメント: https://shopify.dev/docs/apps/build/online-store/app-proxies/authenticate-app-proxies
