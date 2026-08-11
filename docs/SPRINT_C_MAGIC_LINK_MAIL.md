# Sprint C: magic-link 一斉メール (「LINE 連携で ¥300 クーポン」)

**作成**: 2026-08-11 (Sprint A「連携ブースター」の締め)。
**狙い**: 定期便のご契約者に **1 タップで LINE 連携できるリンク**を配り、
LINE 到達可能な契約者を **4 人 → 二桁**へ動かす。連携は配送状況・再注文・ランク・
定期便カード・決済リマインドの**すべての前提**なので、ここが動かないと他が効かない。

**送信そのものは Katsu の操作** (Huckleberry / ストアのメール配信)。
Claude 側はリンクの発行 (差し込みデータの生成) と文面の用意までを行う。

---

## 1. 現在地 (2026-08-11 実測)

| 指標 | 値 |
|---|---|
| LINE 友だち | 6,558 |
| 稼働中の定期契約 | 144 |
| LINE⇔Shopify 連携済み | 10 |
| **LINE 到達可能な契約者** | **4** |

= 契約者の 97% には LINE で何も届けられない。メールは今のところ**唯一届く経路**。

---

## 2. 手順

### ステップ 0 — 前提 (これが済んでいないとメールを出しても特典が出ない)

1. migration 078 (`line_link_coupons`) 適用済み
2. `LINK_REWARD_ENABLED=true` 投入済み
3. `SUB_LINK_ENABLED=true` 投入済み (magic-link 自体の gate)
4. 実機で 1 件連携し、ポータルに ¥300 カードが出ることを確認済み

**順序を飛ばすと「メールで ¥300 と約束したのにクーポンが出ない」= 回復しにくい信用の毀損**になる。

### ステップ 1 — 差し込みデータの生成 (Claude 側)

```bash
curl -s -X POST "https://naturism-line-crm.katsu-7d5.workers.dev/api/admin/sub-link/generate" -H "Authorization: Bearer $ADMIN_API_KEY" -H "Content-Type: application/json" -d '{"onlyUnlinked":true,"expiresInDays":30}'
```

応答 `data.entries[]` の各行が 1 通ぶんの差し込み元:

| フィールド | 用途 |
|---|---|
| `email` | 宛先 |
| `name` | 宛名 |
| `plan` | 「ご契約中のプラン」に差し込む (null あり → 差し込まない文面へ) |
| `intervalDays` | 参考 (文面には出さない) |
| `link` | **本文の唯一のリンク** (`<LIFF_URL>?slk=<token>`) |

- `onlyUnlinked: true` = すでに連携済みの人は**自動で除外**される (二重案内をしない)
- 1 回の上限 500 件・トークンは **single-use / 既定 30 日**
- **`link` は 1 人 1 本の秘密トークン**。CSV をそのまま第三者へ渡さない・
  スクリーンショットに写さない・チャットに貼らない

### ステップ 2 — 送信 (Katsu 操作)

差し込み CSV を配信ツールに読み込ませて送る。
⚠️ 送信元は移行前のため `huckleberryapps.com` のまま (ENTERPRISE を買わない決定の帰結)。
差出人名にブランド名が出るかを送信前に 1 通テストして確認する。

### ステップ 3 — 効果測定 (送信 3 日後・7 日後)

- `GET /api/admin/sub-link/status` (トークンの発行数と消費数のみ・PII なし)
- Admin Ops `reminder-dry-run` の `linked_reachable_active` (= 到達可能な契約者数) の推移
- `/admin` ダッシュボードの「連携特典 300円」行が ON であること

---

## 3. 文面 (案)

薬機法・景品表示法の観点から、**効能効果に触れない / 断定しない / 特典条件を正確に書く**。

### 件名 (案・A/B するなら 2 つとも用意済み)

- A: `【naturism】LINEでご契約内容が確認できるようになりました（連携で300円クーポン）`
- B: `【naturism】定期便の確認・お手続きがLINEでできます（300円クーポンつき）`

### 本文

```
{{name}} 様

いつも naturism をご利用いただき、ありがとうございます。

このたび、定期便のご契約内容を LINE でご確認いただけるようになりました。
次回のお届け予定の確認や、お休み・日程変更のご相談が、
LINE のトーク画面からそのままお送りいただけます。

▼ 下のリンクを、スマートフォンでタップしてください
{{link}}

タップすると LINE が開き、そのままご契約とのお引き合わせが完了します。
（お手続きはこの 1 タップだけです。パスワードの入力はありません）

── 連携された方へ ──
お引き合わせが完了しますと、300円 OFF のクーポンを 1 枚お届けします。
LINE のミニアプリ（ホーム画面）でご確認いただけます。
公式オンラインストアの全商品にお使いいただけます。
有効期限は発行から 7 日間です。

──
※ このリンクはお客様専用です。転送はご遠慮ください。
※ リンクの有効期限は 30 日間です。期限が切れた場合はお手数ですが本メールにご返信ください。
※ ご契約の停止・解約のお手続きは、これまでどおりマイページからも行えます。
　 https://naturism-diet.com/account

naturism（株式会社ケンコーエクスプレス）
```

### 文面で守っていること (変更するときはここも一緒に見る)

| 書いたこと | 実装上の裏付け |
|---|---|
| 「300円 OFF のクーポンを 1 枚」 | `DEFAULT_DISCOUNT_VALUE_JPY = 300`・friend_id と shopify_customer_id の二重 UNIQUE で**生涯 1 枚** |
| 「全商品にお使いいただけます」 | `customerGets.items = { all: true }` |
| 「ミニアプリ（ホーム画面）でご確認いただけます」 | 発行は redeem 応答後の `waitUntil`。ポータルは `refreshLinkCouponAfterLink` で 1.5/4/9 秒後に拾い直し、連携完了モーダルにも「お届けしました」を出す |
| 「有効期限は発行から 7 日間」 | `DEFAULT_VALID_DAYS = 7` |
| 「リンクの有効期限は 30 日間」 | generate の `expiresInDays: 30` |
| 「パスワードの入力はありません」 | magic-link は single-use トークン方式（LINE ログインのみ） |
| 効能効果に触れない | 薬機法。商品名・成分・体感に踏み込まない |

⚠️ **金額を変えるときは 4 箇所を同時に変える**: issuer の定数 / LIFF カード（台帳の値を出すので自動追随）/
`/admin` のラベル / **この文面**。定数とラベルの一致は CI が固定するが、**この文面は CI の対象外**。

---

## 4. 送らない相手 (除外) — generate の選定条件を実装から起こしたもの

自動選定 (`customerIds` を渡さない場合) の述語 (`services/sub-link.ts`):

```sql
WHERE sc.tags LIKE '%subscription%' AND sc.tags NOT LIKE '%cancel%'
  AND sc.email IS NOT NULL AND sc.email != ''
  AND NOT EXISTS (SELECT 1 FROM friends f WHERE f.shopify_customer_id = sc.shopify_customer_id)
ORDER BY sc.updated_at DESC LIMIT ?
```

= 次は**自動で除外される**:
- すでにいずれかの LINE friend に紐づく顧客 (`onlyUnlinked: true` 既定。
  ブロック済み・退会済みの friend に占有された顧客も含む — 死にリンクを配らないため)
- タグに `cancel` を含む顧客 (解約者)
- email が空の顧客

⚠️ **自動では除外されないもの**:
- **一時停止中 (pause) の顧客**。タグ判定は `cancel` しか見ていないので pause は残る。
  連携自体は歓迎すべきなので送ってよいが、文面が「次回のお届け」を前提にしている点は許容範囲
  (「ご確認いただけます」であって「次回があります」とは書いていない)。
- **メール配信の購読停止**。D1 側では判定していないので、**配信ツール側の購読状態に必ず従う**こと。
- `LIMIT` は既定 500。対象がそれを超える場合は `updated_at` の新しい順で切られる
  (= 古い顧客が黙って落ちる)。`GET /api/admin/sub-link/status` の件数と突き合わせて確認する。

---

## 5. 想定される問い合わせと回答

| 問い合わせ | 回答 |
|---|---|
| リンクを押しても LINE が開かない | PC で開いている可能性。スマートフォンで開き直してもらう |
| 「期限切れ」と出る | 30 日経過。再発行して個別に送る (generate を対象 1 件で実行) |
| クーポンが届かない | ポータルのホームに出る (トーク画面ではない)。連携直後は数秒かかることがある |
| 2 回連携したら 2 枚もらえるか | もらえない (生涯 1 枚)。文面でも「1 枚」と明記済み |
| ほかのクーポンと一緒に使えるか | **一緒には使えない** (レジで 1 枚のみ)。理由は下の「併用について」 |

---

---

## 6. 併用について (Katsu の「重複して使用可能」への回答)

コード側は **`combinesWith: { productDiscounts: true, orderDiscounts: true, shippingDiscounts: false }`**
を設定済み = 「重ねられるようにする」意思は実装に入っている。
**ただし、今日の顧客に「併用できます」と案内してはいけない。** 理由:

1. **`combinesWith` は双方向の握手**。相手側も許可していないと重ならない。
   稼働中の **welcome ¥500 は `combinesWith` 未指定 = 併用不可** (`shopify-coupon-issuer.ts`)。
2. **クラスが同じだと重ねられない**。連携特典・紹介特典・ランク割引はいずれも
   `customerGets.items: { all: true }` = **同じ product クラス**。
   同一ラインの product 割引どうしの重ねは **Shopify Plus が必要**
   (2026-06-03 実測・memory `feedback_shopify_plus_discount_stacking`)。
   ランク割引を「order クラス」にする設計意図はコメントに残っているが、
   実際の mutation は product クラスになっている。

→ **今の構成では、どのクーポンとも実際には重ならない。**
「併用できます」と書くと、レジで弾かれた顧客の問い合わせと景表法上の「言い過ぎ」を生む。
このため LIFF カードとメール文面の両方から併用の記述を外してある。

**併用を本当に成立させたい場合の選択肢** (別タスク):
- (a) ランク割引を **order クラス**に作り替える (`customerGets` でなく `customerGets` の
  order-level 割引にする) → 連携特典 (product) × ランク (order) のクロスクラスで重なる
- (b) welcome クーポンにも `combinesWith` を付ける (ただしクラスが同じなので (a) が先)
- (c) Shopify Plus に上げる (実費・現時点では非現実的)

---

関連: `apps/worker/src/routes/sub-link.ts` (generate / redeem) /
`apps/worker/src/services/link-reward-coupon-issuer.ts` (¥300 クーポン発行) /
`docs/SUBSCRIPTION_GATE_CRITERIA.md` (gate の開放順序) /
memory `project_subscription_reach_bottleneck` (この施策が必要な理由の実測)。
