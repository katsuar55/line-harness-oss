# Rich Menu Setup Guide (= LINE 公式アカウント、 naturism、 2026-05-24)

## 概要

Rich Menu (リッチメニュー) = LINE 公式アカウントの chat 画面下部に表示される grid button menu。
naturism では既に **v3 (= 8 button)** spec が backend に実装済 (`apps/worker/src/routes/rich-menus.ts:220`)、 1 click で API 経由 setup 可能。

## 現状の設計 v3 (= 8 button、 2500x1686 px)

```
┌────────────┬────────────┬─────────────┐
│            │            │  友達紹介   │ (LIFF)
│ ホームページ │ カテゴリー  ├─────────────┤
│   (uri)    │   (uri)    │ マイランク*  │ (LIFF)
├────────────┼────────────┼─────────────┤
│            │            │    SNS     │ (uri)
│ 配送状況*  │ 購入履歴*   ├─────────────┤
│  (LIFF)    │  (LIFF)    │ Q&A お問合せ │ (message)
└────────────┴────────────┴─────────────┘
* = Phase 4 (= 会員ランク / 注文関連) 未実装
```

| Cell | label | action type | target |
|---|---|---|---|
| 上段左 (833x843) | ホームページ | uri | `https://naturism-diet.com` |
| 上段中 (833x843) | カテゴリー | uri | `https://naturism-diet.com/collections` |
| 上段右上 (834x421) | 友達紹介 | uri | `${LIFF_URL}#referral` |
| 上段右下 (834x422) | マイランク | uri | `${LIFF_URL}#rank` ⚠ Phase 4 |
| 下段左 (833x843) | 配送状況 | uri | `${LIFF_URL}#delivery` ⚠ Phase 4 |
| 下段中 (833x843) | 購入履歴・再購入 | uri | `${LIFF_URL}#reorder` ⚠ Phase 4 |
| 下段右上 (834x421) | SNS | uri | `https://www.instagram.com/naturism_supplement/` |
| 下段右下 (834x422) | Q&A お問合せ | message | text: `お問い合わせ` |

`LIFF_URL` = wrangler secret で設定済 (= 既定 `https://liff.line.me/2009713578-NbdHyFZf`)。

---

## ⚠ 注意: Phase 4 未実装 button について

3 button (= マイランク / 配送状況 / 購入履歴) は **Phase 4 (= 会員ランク + 注文関連)** で実装予定。 現状 LIFF page 開いても「準備中」 等の暫定表示 or 空 page になる可能性。

### 暫定対応案 (= 3 つから user 判断)

| 案 | 内容 | trade-off |
|---|---|---|
| **A. 現状維持で setup** | v3 8 button そのまま、 未実装 button tap で LIFF が「準備中」 表示 | UX は不完全だが LINE 上で全 button 見せられる、 Phase 4 完成時は LIFF 側差替えで透過 |
| **B. message に置換** | 未実装 3 button を `message` action で「○○機能は近日リリース予定です」 を user が送信する形に → AI 応答が「近日リリース」 固定応答 (= Plan A-1) | LINE 上で「機能ある風」 を見せず正直、 Phase 4 完成時は再 setup 必要 |
| **C. 5 button に縮小** | 未実装 3 button を削除して空セルにする (= 画像を 5 cell 用に作り直す) | 整然、 ただし 画像作り直し + setup endpoint 改修 必要 |

### 推奨 = B (= cost low + Plan A-1 と整合 + LINE 上で正直)
私の autonomous 範囲では実装着手しないが、 user 判断 + 指示で別 PR (= setup-naturism endpoint 改修 + B 案の message 内容明示) で対応可能。

---

## Setup 方法 A: admin web 経由 (= GUI、 推奨)

### Step 1. admin web にログイン
https://naturism-admin.pages.dev → API_KEY 入力 (= wrangler secret と同じ)

### Step 2. Rich Menu 管理 page を開く
左 nav → 「rich-menus」 (= /rich-menus path)

### Step 3. naturism 用 1-click setup
「naturism リッチメニューを設定」 button を tap (= 内部で `POST /api/rich-menus/setup-naturism` が叩かれる)

### Step 4. 設定状況確認
同じ page で 「設定状況」 → `default rich menu` が `naturism メインメニュー v3` になってるか確認

### Step 5. LINE app で確認
LINE app の naturism 公式アカウント chat 画面下部に 8 button grid が表示されるか確認

---

## Setup 方法 B: API 直接 (= advanced、 ターミナル経由)

### 前提
- `WORKER_URL` = `https://naturism-line-crm.katsu-7d5.workers.dev`
- `API_KEY` = wrangler secret 値 (= admin web 認証と同じ)

### 既存 rich_menu の確認
```bash
curl -H "Authorization: Bearer ${API_KEY}" "${WORKER_URL}/api/rich-menus"
curl -H "Authorization: Bearer ${API_KEY}" "${WORKER_URL}/api/rich-menus/status"
```

### naturism 用 setup (= 1 click 相当、 既存 default 削除 + 新規作成 + 画像 upload + default 設定 を atomic)
```bash
curl -X POST -H "Authorization: Bearer ${API_KEY}" "${WORKER_URL}/api/rich-menus/setup-naturism"
```

成功 response 例:
```json
{
  "success": true,
  "data": {
    "richMenuId": "richmenu-xxxxxxxxxxxxxxxx",
    "areas": [
      { "label": "ホームページ", "type": "uri" },
      { "label": "カテゴリー", "type": "uri" },
      { "label": "友達紹介", "type": "uri" },
      ...
    ],
    "message": "リッチメニュー v3（8ボタン）を作成・画像アップロード・デフォルト設定まで完了。"
  }
}
```

### 削除 (= 全 rich_menu 1 つずつ delete)
```bash
curl -X DELETE -H "Authorization: Bearer ${API_KEY}" "${WORKER_URL}/api/rich-menus/{richMenuId}"
```

---

## 画像 spec

### 自動生成 (= setup-naturism endpoint 内蔵)
endpoint 内 hardcoded ソリッド緑色 (#06C755) PNG (= 14,923 bytes、 zlib lv9) を自動 upload。 button 区切り線等の design は **未含み** (= シンプル背景のみ)。

### custom 画像で差替え (= デザイナーが作った PNG を upload)

#### 仕様
- size: **2500 x 1686 px** (= LINE フルサイズ)
- format: PNG or JPG
- file size: 1 MB 以下推奨 (LINE 上限 1 MB)

#### button layout reference (= image-guide endpoint)
```bash
# browser で開く (= HTML template が return される)
open "${WORKER_URL}/api/rich-menus/image-guide"
```
このページのスクリーンショット (= 2500x1686) を画像 file として保存 → 編集して使う。

#### upload (= 既存 rich_menu に画像を差替え)
```bash
curl -X POST -H "Authorization: Bearer ${API_KEY}" -H "Content-Type: image/png" \
  --data-binary @./your-image.png \
  "${WORKER_URL}/api/rich-menus/{richMenuId}/image"
```

---

## 検証 step

### 1. setup 直後 (= 自分の LINE app で)
1. LINE app の friend list → naturism 公式アカウント → chat 画面開く
2. 下部に grid button menu (= 「メニュー」 と書かれた tab) が出てるか確認
3. menu tab tap → 8 button grid が展開
4. 各 button tap → 期待 action 発火
   - uri button → LINE 内 browser で URL 開く
   - LIFF button → LIFF page 開く
   - message button → user message として送信 → webhook 経由 AI 応答 (= 「Q&A お問合せ」 → 「お問い合わせ」 が AI に届き auto_replies or AI 応答が返る)

### 2. user 全体への展開確認
- admin web → friends → 任意の friend detail → rich_menu link 状況確認
- 「default」 として設定された rich_menu は全 user に自動配信 (= `setDefaultRichMenu` API)
- friend ごとに別 rich_menu を割当てる場合は `POST /api/friends/{friendId}/rich-menu` (= segment marketing 用)

---

## troubleshoot

### 「rich_menu 出ない」 場合
- LINE app の chat 画面 で **menu tab が表示されないか**? (= ▲ 印が下部にあるはず)
- LINE app 再起動 (= cache reset)
- LINE app 最新 version か (= rich_menu API は LINE 7.5+ 推奨)
- worker log 確認: `https://dash.cloudflare.com → Workers → naturism-line-crm → Logs`
- setup-naturism endpoint 成功 response 確認 (= 上記 curl で 201 確認)

### 「button tap しても反応なし」 場合
- LIFF button → LIFF_URL env var 正しいか (`wrangler secret list`)
- uri button → URL に typo ないか (= setup-naturism endpoint hardcoded、 改修必要)
- message button → webhook 経由 AI 応答 logic 動いてるか (= auto_replies + AI 応答 trace)

### 「v3 を変更したい」 場合
1. `apps/worker/src/routes/rich-menus.ts:240-287` の `richMenuBody.areas` を編集
2. `pnpm --filter worker test` で test pass 確認 (= rich-menus.test.ts に既存 test あり)
3. `pnpm --filter worker run deploy` で worker 反映
4. admin web or curl で setup-naturism endpoint を **再叩く** (= 既存 default が削除 + 新 menu が作成 + default 設定 が atomic 実行)

---

## 関連 file

- `apps/worker/src/routes/rich-menus.ts` (= 全 endpoint)
- `apps/worker/src/services/rich-menu-conductor.ts` (= LINE API ラッパー)
- `apps/worker/src/__tests__/rich-menus.test.ts` (= 既存 test、 setup-naturism 含む)
- `apps/web/src/app/rich-menus/page.tsx` (= admin web UI)
- LINE Messaging API: https://developers.line.biz/en/reference/messaging-api/#rich-menu

---

## 次セッション推奨 (= rich_menu 関連)

1. **B 案 (= 未実装 button を message に置換) を実装** → setup-naturism endpoint 改修 + Plan A-1 「近日リリース」 と統合
2. **画像差替え** = デザイナーに 8 cell layout + naturism brand color (= 緑 #06C755 + ティファニーブルー #0ABAB5) の image 依頼 → upload
3. **segment 別 rich_menu** = 例えば「定期便継続 user 用」 「離脱予兆 user 用」 等を作って `POST /api/friends/{friendId}/rich-menu` で割当て
