# Phase 6 KPI 分析レポート (2026-04-29)

## TL;DR (要点 4 行)

1. **観測期間が「7 日」ではなく実質 18 時間。**Phase 6 PR-5/PR-6 デプロイは 2026-04-28 11:38 JST、本レポート作成は 2026-04-29 06:00 JST。7 日観測は 2026-05-05 まで待つ必要あり。
2. **本番 D1 に migration 039 (`cron_run_logs`) が未適用だった。**Phase 5 PR-4 cron 死活監視と Phase 6 PR-6 heartbeat が silent fail していた。本セッションで適用済み (additive only / idempotent / safe)。
3. **Phase 6 PR-2 (orders/create → 自動 enroll) が一度も発火していない。**理由: ① デプロイ後 0 件の orders/create webhook、② friend ↔ Shopify customer の email 突合 0 件 (users.email が全レコードで NULL)。コード自体は正常、運用前提が未整備。
4. **product_repurchase_intervals / purchase_cross_sell_map に 1 件もデータが入っていない。**Phase 6 PR-1 推定器は全て fallback 経路、PR-3 cross-sell push は常に「該当 0 件」で空。本格運用前にシードと管理画面からの登録が必要。

---

## 1. 期間と観測条件

| 項目 | 値 |
|---|---|
| Phase 6 PR-1 デプロイ | 2026-04-28 (commit `3093c9f`) |
| Phase 6 PR-5/PR-6 デプロイ (最終) | 2026-04-28 11:38 JST (commit `3ab4645`) |
| 本レポート作成 | 2026-04-29 06:00 JST |
| 経過時間 | **約 18 時間 22 分** (= 0.76 日) |
| 元の予定 | 7 日観測 (2026-05-05 まで) |

「Phase 6 観測 7 日経った」という前提は誤り。経過時間が短いだけでなく、後述の構造問題により 7 日待っても KPI が動かない可能性が高い。

---

## 2. テーブル別 KPI (本番 D1)

### 2.1 リマインダー本体

| 指標 | 値 | コメント |
|---|---|---|
| `subscription_reminders` 総数 | 1 | Phase 6 以前 (2026-04-19) に手動投入された 1 件のみ |
| `is_active = 1` | 1 | 同上 |
| `interval_source` 内訳 | manual: 1 | Phase 6 PR-1 自動推定経路 (`auto_estimated`/`product_default`/`user_history`) は **0 件** |
| `shopify_product_id` あり | 0 | PR-2 経由 enroll が無いため |
| 直近の `last_sent_at` | NULL | まだ一度も配信していない (next_reminder_at = 2026-05-19) |

### 2.2 Phase 6 マスタテーブル

| テーブル | 行数 | 用途 | 状態 |
|---|---|---|---|
| `product_repurchase_intervals` | **0** | PR-1 商品別 interval 推定の seed | **未投入。** 24 商品中 0 件にカスタム interval が付いていない → 全商品 fallback (30 日) |
| `purchase_cross_sell_map` | **0** | PR-3 reminder push に添付するクロスセル | **未投入。** reminder 配信時に空 → クロスセル機能事実上 OFF |
| `cron_run_logs` | **存在しなかった** → 本セッションで作成 | PR-4 cron 死活監視 + PR-6 heartbeat | migration 039 が prod に未適用。**本セッションで適用済み**。次回 cron (5 分毎) から記録開始 |

### 2.3 Shopify 側のトラフィック

| 指標 | 値 |
|---|---|
| `shopify_orders` 総数 | 221 |
| `shopify_customers` 総数 | 291 |
| `shopify_products` 総数 | 24 |
| `shopify_webhook_log` 総数 | 1265 |
| 内 `orders/create` (`processed`) | **0** |
| 内 `orders/create` (`security_warning`) | 35 (= 実質処理) |
| 内 `orders/create` (`auth_failed`) | 11 |
| Phase 6 デプロイ後の `orders/create` | **0 件** |

**`security_warning` は無害**: HMAC は `SHOPIFY_CLIENT_SECRET` で検証成功している。`SHOPIFY_WEBHOOK_SECRET` を `wrangler secret put` で正しく設定すれば `processed` に変わる (cosmetic 改善、機能には影響なし)。

### 2.4 友だちとマッチング

| 指標 | 値 | 影響 |
|---|---|---|
| `friends` 総数 | 1 | naturism オーナー本人のみ。一般友だち 0 |
| `users` 総数 | 1 | 同上 |
| `users.email` が NULL でない | **0** | **致命的**: PR-2 enrollment は `users.email = shopify_customers.email` で friend を引き当てるが、users 側の email が空なので **永遠に 0 マッチ** |
| `shopify_customers.email` が NULL でない | 291 | Shopify 側はメール持っている |
| `users` × `shopify_customers` の email 一致 | **0** | 上記の通り (left = NULL) |

**結論**: Phase 6 PR-2 (orders/create → enroll) は、**仮に 7 日待って 100 件の orders/create が来ても 1 件も enroll できない**。`users.email` を埋める仕組みが先に必要。

### 2.5 LINE メッセージ活動

| 指標 | 値 |
|---|---|
| `messages_log` 総数 | 279 |
| 直近 7 日 (2026-04-22 以降) | 2 件 |
| 直近メッセージ | 2026-04-22 11:31 (オーナー本人とのやり取り) |
| `delivery_type = 'subscription-reminder'` | 0 |

LINE 側の友だち活動は事実上停止 (テスト以外)。Phase 6 効果測定の母数なし。

---

## 3. 構造的な KPI 不発の原因

### 3.1 致命的な前提崩れ (順位順)

1. **`users.email` を埋めるパスが本番で動いていない。**
   - LIFF 経由で友だち追加した時点では LINE 側の displayName と userId しか取れず、email は LIFF Login (Email Scope) を別途取得しないと埋まらない。
   - 現状 1 件の user record すら email NULL。
2. **`product_repurchase_intervals` が空。**
   - Phase 6 PR-1 の優先順 (user_history → product_default → auto_estimated → fallback) のうち、最初の 3 つが全滅し常に fallback (30 日固定) になる。
3. **`purchase_cross_sell_map` が空。**
   - reminder push に添付するべきクロスセル候補が無い → 空配列で送信 → クロスセル機能の効果計測不可能。
4. **migration 039 未適用 (本セッションで解決)。**
   - `cron_run_logs` テーブル不在 → cron-monitor の judge も heartbeat 書き込みも noop で成功扱いになっていた。
   - これにより「cron が止まっていることを Discord 通知する」セーフティネットが Phase 6 デプロイから 18 時間沈黙していた。

### 3.2 構造ではなく純粋に時間/トラフィック問題

- 18 時間で `orders/create` 0 件 → これは naturism Shopify ストアの売上トラフィックそのものが少ない可能性。Shopify Admin で 1 日あたりの注文数を確認した方が良い。

---

## 4. 推奨アクション (優先順)

### P0 (運用ブロック解除)

| # | アクション | 工数 | 担当 |
|---|---|---|---|
| 1 | `users.email` を埋める仕組み追加: LIFF Login 時の email scope 取得、または `customers/create` webhook で `friend.email`/`user.email` に back-fill | 半日〜1 日 | Claude (要設計) |
| 2 | `product_repurchase_intervals` を最低 5 商品分シード (admin 画面 `/reorder` から登録) | 0.5h | オーナー手動 or Claude (seed migration) |
| 3 | `purchase_cross_sell_map` 投入 (Phase 6 PR-3 を機能化) | 0.5h | 同上 |

### P1 (cosmetic / 安定化)

| # | アクション | 工数 |
|---|---|---|
| 4 | `SHOPIFY_WEBHOOK_SECRET` を Shopify Admin の現行値に揃える → `security_warning` を消す | 5 分 (オーナーが Shopify Admin から secret コピー → `wrangler secret put`) |
| 5 | `cron_run_logs` 適用後 5 分待ち、PR-6 の subscription-reminder heartbeat が SUCCESS 行を残すか確認 | 10 分 |
| 6 | KPI 観測再起動: 上記 P0 完了後、新たに 7 日カウント (= 観測完了 P0 完了 + 7 日後) | — |

### P2 (本格 KPI 計測の準備)

| # | アクション | 工数 |
|---|---|---|
| 7 | Phase 6 PR-8 (reminder copy A/B) のために `ab_tests` テーブル運用を整える | 1 日 |
| 8 | LINE 友だち増加チャネル確認 (リッチメニュー / shopfront での QR 設置 / カート完了画面の友だち追加導線) | 議論 |

---

## 5. 本セッションで実施済み

- [x] migration 039 (`cron_run_logs` + index) を本番 D1 に適用 (additive / idempotent)
- [x] /liff/cart 500 hotfix (notFound 再帰バグ + cart redirect) — commit `322bb46`
- [x] 本レポート作成

---

## 6. 7 日観測再開条件 (チェックリスト)

以下が **すべて埋まった日** から 7 日カウントを再開する。

- [ ] `users.email` を埋めるパスが運用上動き、最低 5 件の user.email が non-NULL
- [ ] `product_repurchase_intervals` に最低 5 商品分の seed
- [ ] `purchase_cross_sell_map` に最低 3 ペアの cross-sell 定義
- [ ] cron_run_logs に subscription-reminder の heartbeat が 6 時間連続で成功記録
- [ ] Shopify ストアで 1 日 1 件以上の orders/create があることを確認

達成できれば、7 日後に意味のある KPI (enroll 率 / push 開封率 / cross-sell click 率 / 再購入率) を出せる。
