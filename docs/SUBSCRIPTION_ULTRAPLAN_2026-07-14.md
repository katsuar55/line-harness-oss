# SUBSCRIPTION ULTRAPLAN — サブスクLINE完結 & Huckleberry 卒業計画 (2026-07-14)

Katsu 指示: Phase 1 → 1.5 → 3 で進め、Huckleberry「定期購買」をやめていく方向。
各 Work Item (WI) に採点基準を設け、採点→修正ループで**全次元 90 点以上**になったら次へ進む。
ビルド目標 10 日。Huckleberry アンインストールのみ課金サイクル物理に律速され 8 月中判定。

## 0. 背景 (確定事実、2026-07-14 調査)

- サブスクは Huckleberry「定期購買」STANDARD $49/月 (決済手数料 1%)。API 連携は ENTERPRISE $299/月 限定で、更新系は「お届け日変更」のみ → **Phase 2 (ENTERPRISE) は破棄**
- Shopify 仕様: サブスク契約は作成アプリのみ read/write (`*_own_subscription_contracts`)。他アプリの契約は読めない
- 実績 (7/14): 契約 76 件 / MRR ¥131,386 / ARPU ¥1,729 / 全員継続 1 回目 / 解約 0 → **最初の更新波が目前 (30日周期→8月頭)**
- 顧客タグ・注文タグが有効: 注文=`subscription-id:{ID}` / `subscription-count:{N}` / `delivery-{ID}:{date}` + note attributes `deliveryDate`。顧客=`subscription-{ID}-plan:{名}` / `-cancel:{date}` / `-skip-count:{n}` (7/14 ON) / `-pause:{date}` (7/14 ON)
- マイページ顧客許可: スキップ(最大12回)/一時停止/解約/商品・数量変更/お届け日変更(注文+3日〜次回注文+30日)/住所/支払い方法。**周期変更・他商品追加は不可**。**全操作の締切=次回決済日の 3 日前**
- 決済失敗: 自動再決済なし → 契約は自動「一時停止」化 (顧客タグで検知可能)
- 事前案内メールは「お届け 3 日前」= 決済とほぼ同時 → **変更が間に合う事前通知は現状ゼロ** (LINE 決済4日前通知が唯一になる)
- LINE 公式 = スタンダードプラン (30,000通/月) → push コストは実質ゼロ。リーチ 6,568
- マイページ実体: app proxy `naturism-diet.com/apps/subscription` (要ログイン=新型カスタマーアカウント メール+6桁)
- 運用起点=決済日起点。お届け不可曜日=日祝
- 既存リッチメニュー v3 = 8 ボタン (rich-menus.ts、R2 `richmenu-v3.jpg`)。postback エリアなし。**間引き候補=SNS (Katsu 確認待ち、デフォルトで SNS 差し替えとして実装)**
- claude-in-chrome は Shopify アプリ iframe を操作不可 → アプリ内設定変更は Katsu にコピペ依頼方式

## 1. North Star

LINE トーク内で定期便のすべて (確認・スキップ・日付変更・一時停止・解約・支払いリカバリ) が完結し、課金基盤も自社所有。Huckleberry 解約で $49+1% が消え、「LINE 完結サブスク」が line-harness OSS の multi-brand 差別化機能になる。

## 2. 工程表

| WI | 内容 | 日程 | 完了条件 |
|---|---|---|---|
| WI-1 | Phase 1: コンシェルジュ (契約読取モデル+トークUI+postback/intent+リッチメニューv4定義+76件バックフィル) | Day 0–2 | 採点全次元≥90 → merge (gate OFF) → 実機 → ON |
| WI-2 | Phase 1.5: 決済4日前リマインド+決済失敗リカバリ通知+Flow受信口 | Day 3 | 同上 |
| WI-3 | Phase 3 設計書+payment_methods スコープ申請+移行方式確定 | Day 3–4 | 設計書採点≥90・申請発射 |
| WI-4 | Phase 3 課金基盤 (billing cron/冪等/dunning/webhook/LINE UI裏差し替え/非LINEマイページ) | Day 5–8 | money-path 採点2ラウンド全≥90+E2E完動 |
| WI-5 | 移行リハーサル→Katsu契約1件実課金→段階拡大 | Day 9–10〜 | 1件実課金成功がDay10目標 |
| WI-6 | CRM PLUS on LINE 撤去準備 (lineharness.line_user_id metafield 移行) | Day 0–2 並行 | 連携経路無停止の実証 |
| 卒業 | Huckleberry アンインストール | 8月中 | 全契約2サイクル連続無事故+全通知動作+ロールバック検証 |

## 3. 採点方式 (全 WI 共通)

- 各次元 0–100、**全次元 90 以上で通過** (最低値ゲート)。独立グレーダーの Workflow (反証プロンプト付き) で採点、自己申告不可
- money-path (WI-4/5) は通過後もう 1 ラウンド義務 (最低 2 ラウンド)
- 共通前提: full worker suite green + clean typecheck (tsbuildinfo 削除) + PR→CI→merge + env gate default OFF

### WI-1 採点次元
1. データ正確性 — タグ解析/推定日/複数契約/解約・スキップ・一時停止の境界/周期変更後のズレ耐性
2. セキュリティ — IDOR (LINE userId→friend→customer 毎回再検証)、PII 非漏洩、gate 正当性
3. UX・文言 — ティール基調/タップ数最少/薬機法 (効能断定なし)/迷子ゼロ (許可されていない操作を案内しない)
4. 誠実な失敗 — API/D1 死亡時に false-success を返さない、timeout、フォールバック文言
5. テスト網羅 — 新規 critical path 全カバー + 既存 suite 無退行 + vi.mock/dynamic import ルール遵守
6. 既存系整合 — 再購入 subscription_reminders と非干渉 (naming 含む)、AI 3層・intent 優先順位、audit 慣例

### WI-2 採点次元
1. タイミング正確性 (JST/冪等クレーム/1契約1サイクル1通) 2. 推定ズレ安全性 (締切超過検出時は送らない・断定しない文言) 3. コンプラ (blacklist/頻度/薬機法) 4. セキュリティ 5. テスト 6. 文言UX

### WI-3 採点次元 (設計書)
1. 課金状態機械の完全性 2. 失敗系網羅 (dunning matrix) 3. 移行安全性 (二重課金防止の原子性) 4. 運用手順・kill switch 5. 検証可能性 (各主張のテスト方法が書かれているか)

### WI-4 採点次元
1. 課金正確性 (二重課金ゼロ証明=冪等キー+claim+テスト) 2. dunning 3. money-path セキュリティ 4. resilience 5. テスト (mutation 経路100%) 6. 移行リハ結果 7. 運用監視・kill switch

### WI-5 完了チェックリスト
二重課金ゼロ証跡 / 全通知動作 / 解約・スキップ経路実績 / ロールバック手順の実地検証 / 段階拡大の各ゲート記録

## 4. WI-1 実装スコープ (Phase 1)

- D1 新テーブル (名前は既存 `subscription_reminders` (再購入系) と衝突しない namespace): 契約キャッシュ — contract_id PK / shopify_customer_id / plan_name / interval_days / last_order_at / last_order_id / order_count / last_delivery_date / next_billing_estimate / status (active|skip_detected|paused|cancelled) / source (webhook|backfill) / updated_at
- 取込: 注文 webhook (タグ+note_attributes+selling_plan) と顧客 webhook (cancel/pause/skip タグ) から derive。バックフィル: read_all_orders で過去90日の subscription タグ付き注文 → 76 契約 seed
- トーク UI: postback `action=subscription_menu` (displayText「サブスクリプション」) → 契約カード (複数=カルーセル)。ボタン=[次回をスキップ][お届け日を変更][解約・一時停止] (各→マイページ最短導線カード+手順) + 商品・数量変更はテキストリンク。未連携→連携導線カード。未契約→定期便訴求カード (Shop導線)。締切注記「変更・スキップは次回決済日の3日前まで」常設
- intent: サブスク/定期便/定期/スキップ/解約 等 → 同カード (Layer 1.5)
- リッチメニュー v4: SNS 枠→「サブスク」postback。setup-naturism の areas 更新 + 画像はティール生成版を R2 `richmenu-v4.jpg` に配置。**本番反映 (setup 実行) は Katsu の間引き確認後**
- gate: `SUBSCRIPTION_MENU_ENABLED` (default OFF)。audit_logs 全操作記録
- 非スコープ: 契約の mutation (Phase 3)、リマインド (WI-2)

## 5. WI-2 実装スコープ (Phase 1.5)

- cron (JST 夕方帯): next_billing_estimate−4日 該当 & LINE連携済 & blacklist 除外 → push「明日が変更締切」カード (WI-1 流用)。冪等: 契約×サイクル単位 claim
- 決済失敗リカバリ: 顧客 webhook で `-pause:` タグ出現検知 → 「お支払いのご確認」push (支払い方法変更導線)。※自動再決済 OFF 運用が前提。Katsu が検討B (再決済ON) を採用したら文言調整
- Flow Trigger 受信 endpoint (`POST /api/integrations/teiki-flow` 等、共有秘密検証) を先行実装 + Katsu 向け Flow 設定手順書 (正確な次回決済日を Flow→HTTP で受け、推定を実測に昇格)
- gate: `SUBSCRIPTION_REMINDER_ENABLED`

## 6. WI-3/4/5 骨子 (Phase 3)

- 方式 (推奨=ハイブリッド): 新規契約→自社 selling plan に即切替 / 既存 76 件→スコープ承認後に一括移行 (subscriptionContractAtomicCreate + 既存 customerPaymentMethod 紐付け → 直後に Huckleberry 側契約停止、契約毎に原子的に)
- 課金エンジン: 5分 cron で due 契約を claim → subscriptionBillingAttemptCreate (冪等キー=contract_id+cycle) → webhook (success/failure/challenged) で遷移。dunning: 失敗→3日後リトライ×2→一時停止+LINE通知。kill switch: `BILLING_ENGINE_ENABLED` + 契約 allowlist (段階拡大用)
- 非LINE顧客: 簡易 web マイページ (worker 上、メールでマジックリンク)。LINE 友だちには全機能をトーク内で
- 申請: `read_customer_payment_methods` (前例: read_all_orders を Dev Dashboard 経由で取得済)
- 検証: テスト商品 ¥100 実課金→返金 E2E (Katsu 承認待ち) → Katsu 契約 1 件移行 → 5 件 → 全件
- ロールバック: 移行前スナップショット (契約条件 JSON) を D1 保存。自社課金が失敗しても Huckleberry 契約は停止済みのため、復旧= Huckleberry で再作成 or 自社で手動請求。移行は 1 契約ずつ原子的に行い、途中停止可能

## 7. Katsu 確認事項 (デフォルトで進行、帰宅後に上書き可)

1. 間引き=SNS 確定? (リッチメニュー本番反映のみ保留中)
2. リッチメニュー画像=生成版先行で OK?
3. 移行方式=ハイブリッド案で OK?
4. 特記事項・アンケートの保存完了?
5. ¥100 テスト商品の実課金→返金テスト可否?

## 8. 進捗ログ

- 2026-07-14: Ultraplan 策定。WI-1 着手。
- 2026-07-14: WI-1 完了 — PR #195 merge (gated off、本番挙動変化ゼロ)。採点4ラウンドで
  全8→6次元 90+ (最終 98/96/90/92/98/95)。read-model (migration 069)・コンシェルジュカード・
  intent Layer-1.5・rich menu v4 定義・teiki-flow 受信口・rebuild endpoint。
- 2026-07-14: WI-2 実装 — 決済リマインド (4日前+catch-up 3日前) + 決済失敗リカバリ cron
  (migration 070)。採点 R1 (66-75 全fail) → R2 (68-87 全fail) → R3 (96/90/89/86/86/88、
  timing・estimation-safety pass) → R4 修正: rebuild の初見 pause ガード迂回 (歴史的一時停止への
  一斉 stale 通知) を suppressRecoveryMarkers で遮断、recovery claim に pending 述語追加、
  409=配信済み扱い、cron-monitor DEFAULT_RULES 登録 (gate OFF でも heartbeat)、
  teiki-flow 未設定 503→401、INSERT/UPDATE 列同期。
- 2026-07-19: WI-2 完了 — R4 全次元 pass (compliance 98 / security 97 / tests 95 / ux 97)。
  PR #196 merge (main=b7e9e49)、3,484 テスト green、Deploy Worker success (gated off)。
- 2026-07-19: WI-6 実装 — lineharness.line_user_id 移行 (service+endpoint+admin-ops
  switch/rollback op+runbook)。secret-list 実査で判明: CRM PLUS 依存は reverse 経路
  (FRIEND_LINK_METAFIELD_*=socialplus/line) のみ、forward は secret 未設定で
  naturism.line_user_id が実効値。検証は直読 (即時)+検索経路 (インデックス非同期) の2段。
- 2026-07-19: WI-6 採点完了 — R1 (85/88/95✅/86/81) → R2 修正 (Free プラン subrequest 上限
  →チャンク化、verify useSecret、legacy-audit 棚卸し新設、jq 除去、put-worker-api-key op)
  → R2 (95✅/87/91✅/94✅) → R3 修正 (matchFailed+算術閉包、予算前判定+再開cursor、
  audit 記録) → R3 data-correctness **98 ✅ = 全5次元 90+**。
