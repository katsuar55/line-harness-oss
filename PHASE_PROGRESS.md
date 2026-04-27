# Phase Progress — naturism LINE Harness 拡張 (2026-04 〜)

> 実装中の Living Document。各 Phase の進捗・仕様変更・既知の課題を記録。
> 完成後の正式マニュアルは `docs/MANUAL/` に別途作成予定 (Final phase)。

---

## 🗺️ 全体ロードマップ

| Phase | 内容 | 期間目安 | 状態 |
|---|---|---|---|
| 1 | 能動pull化 + 服用記録 | 1〜2日 | ✅ **完了** (2026-04-26 commit `5b0df90`) |
| 2 | ゲーミフィケーション基盤 (バッジ/レベル) | 2〜3日 | ✅ **完了** (2026-04-26 commit `368515a`) |
| 3 | AI 食事診断 + カロリー記録 + グラフ | 5〜7日 | ⏸ 待機 (Anthropic API キー登録待ち) |
| 4 | ガチャ/季節イベント/アバター/投票 | 3〜4日 | ⏸ 待機 |
| Final | 管理者+ユーザー向けマニュアル + NotebookLM 投入 | 2日 | ⏸ 待機 |

合計約3週間で全機能完成予定。

---

## 📐 設計の根幹方針 (全 Phase 共通)

1. **能動pull > 受動push** — LINE 課金を最小化
2. **プレッシャーゼロ** — 義務感を出さず、開けば得する設計
3. **重さリスクゼロ設計** — `waitUntil()` 非同期化、集計テーブル事前作成、ページネーション
4. **既存資産の最大活用** — friend_points は新設せず `friends.score + friend_scores` を活用

---

## ✅ Phase 1: 能動pull化 + 服用記録 — 完了 (2026-04-26)

### 完了内容
- Cron 停止: `processIntakeReminders` を index.ts から外した (LINE 月数十万通の課金回避)
- migration 034 適用: `intake_logs.meal_type` カラム追加 + UNIQUE INDEX
- `POST /api/liff/intake` を `mealType` 対応に拡張 + 同日同 meal_type 重複防止
- `GET /api/liff/intake/today` 新設: 朝/昼/夜の状態を一括取得
- LIFF Top に「今日の服用」3ボタンカード (☀️朝/🌤昼/🌙夜)
- event_bus で `intake_log` イベント発火 (ポイント加算ルックフック)

### 検証
- worker tests 968/968 pass
- CI 54s + Deploy Worker 43s 成功
- 本番 D1 に migration 034 適用済 (10行書込)

---

## ✅ Phase 2: ゲーミフィケーション基盤 — 完了 (2026-04-26)

### 完了内容
- migration 035 適用: `badges` (定義11種 seed) + `friend_badges` (獲得記録)
- `packages/db/src/badges.ts`: クエリ関数 (awardBadge / getAllBadges / getFriendBadges / getIntakeTotalCount / calculateLevel など)
- `apps/worker/src/services/badge-evaluator.ts`: イベント駆動の判定ロジック (intake_log / cv_fire / referral_completed)
- `apps/worker/src/services/event-bus.ts`: fireEvent Phase1 に processBadgeEvaluation を追加 (Promise.allSettled で並列実行)
- `GET /api/liff/badges` 新設: 全バッジ + 自分の獲得バッジ + level + 次レベルまでのpt
- LIFF HOME に「レベル & バッジ」カード追加 (経験値プログレスバー + 5列バッジグリッド)
- レベル計算は DB 不要、`Math.floor(friends.score / 100) + 1` で表示時計算

### 検証
- worker tests 969/969 pass
- CI + Deploy Worker 成功
- 本番 D1 に migration 035 適用済

### Phase 2 実装スコープ (実装内容詳細)
- **migration 035**: `badges` (定義テーブル) + `friend_badges` (獲得記録テーブル) + 初期 seed
- **バッジ判定サービス** (`apps/worker/src/services/badge-evaluator.ts`):
  - intake_log イベントで「服用ストリーク 7/30/100日」を判定
  - cv_fire / purchase イベントで「購入 1/5/10回」を判定
  - referral_completed イベントで「紹介 1/5/10人」を判定
- **API** (`GET /api/liff/badges`): 自分の獲得バッジ + 全バッジ一覧
- **LIFF UI**: バッジ図鑑カード (Home に追加) + レベル表示
- **レベル計算**: `Math.floor(friends.score / 100) + 1` (DB不要、表示時計算)

### バッジ初期セット (seed で定義)
| code | カテゴリ | 名称 | 条件 |
|---|---|---|---|
| `intake_streak_7` | 服用 | 7日連続 | streak_count >= 7 |
| `intake_streak_30` | 服用 | 30日連続 | streak_count >= 30 |
| `intake_streak_100` | 服用 | 100日連続 | streak_count >= 100 |
| `intake_total_30` | 服用 | 累計30回 | 累計記録 >= 30 |
| `intake_total_100` | 服用 | 累計100回 | 累計記録 >= 100 |
| `purchase_first` | 購入 | 初回購入 | 1回目の cv_fire |
| `purchase_5` | 購入 | リピーター | 5回目の cv_fire |
| `purchase_10` | 購入 | 常連様 | 10回目の cv_fire |
| `referral_first` | 紹介 | 初紹介 | 1人目紹介成立 |
| `referral_5` | 紹介 | アンバサダー | 5人紹介成立 |

### 採用するゲーミフィケーション要素
| # | 要素 | プレッシャー軽減 |
|---|---|---|
| 1 | **ウィークリーガチャ** | 3日に1回 or 100pt消費。毎日縛らない |
| 2 | **服用ストリーク (緩和版)** | 累計記録優先、途切れリセットなし |
| 7 | **新商品先行投票** | 投票しなくてOK、投票者のみ先行案内 |
| 13 | **レベル制度** | 購入/紹介で勝手に上がる |
| 14 | **季節イベント** | 期間限定だが参加義務なし |
| 15 | **アバター育成 (優しい版)** | 何もしなくても自然成長 |
| 16 | **バッジ図鑑** | 集めたい人だけ集める |
| 20 | **ガチャ確率設計** | 累積pt消費型 |

### 不採用
- ❌ 17. デイリーチャレンジ (毎日プレッシャー)
- ❌ 18. 月間ヒーローランキング (1位プレッシャー)
- ❌ 19. チーム機能 (Katsu指示)

---

## ✅ 付随タスク (Phase 2 ↔ Phase 3 の間) — 完了 (2026-04-27)

Phase 3 (Anthropic API 開設待ち) の間に、Phase ロードマップ外の P0/P1 を消化。
commit `95cb97d`。

### D. 誕生月再収集シナリオ (P0 — DMM 解約対策)

**背景**: DMM チャットブースト解約 (2026-06〜07月) で誕生日データが消える。
naturism-line-crm 側で先回り収集する仕組み。

- `friends.metadata.birth_month` (TEXT "1"〜"12") に保存 — DB 変更なし
- Quick Reply 12個 (1月〜12月) → postback `action=birthday_month&month=N`
- `setFriendMetadataField()` で metadata JSON を安全に部分更新
- 管理 API:
  - `GET  /api/birthday-collection/stats`   — 登録済/未登録の件数
  - `POST /api/birthday-collection/preview` — メッセージプレビュー
  - `POST /api/birthday-collection/send`    — multicast (default `dryRun=true`)
- multicast は 500件チャンク。`dryRun` デフォルト ON で誤発射防止
- セグメントフィルタ `metadata_not_equals` で未登録者抽出可能

### F. エラー監視スケルトン (P1)

**背景**: Cloudflare Workers Logs は 24時間で消える → 重大エラーを長期保存 + 即時通知。

- `apps/worker/src/services/logger.ts`: 軽量 logger
  - **Axiom** (Free 500MB/月) で構造化ログ長期保存
  - **Discord webhook** で error/fatal レベルを即時通知
  - **secret 未登録時は完全 no-op** (fail-safe: 観測機能不在でアプリは止まらない)
  - `waitUntil()` 経由 fire-and-forget で latency に影響しない
- `app.onError` フックで全ルート横串補足
- `docs/MONITORING.md`: Katsu 用の Axiom + Discord 開設手順 (4ステップ, 計15分)
- 必要 secret (オプショナル):
  - `AXIOM_TOKEN` / `AXIOM_DATASET` / `DISCORD_WEBHOOK_URL`

### 検証
- worker tests: 969 → **986 pass** (+17 birthday-collection)
- SDK tests: 43/43 pass
- typecheck: worker / db / line-sdk 全クリーン
- CI + Deploy Worker 自動デプロイ成功

---

## ⏸ Phase 3: AI 食事診断 + カロリー記録 + グラフ

### 計画
- LINE で食事写真受信 → R2 保存 → Anthropic Claude 3.5 Sonnet (Vision) → 栄養分析
- migration 036: `food_logs` + `daily_food_stats` (集計テーブル)
- LIFF 内グラフ画面 (Chart.js) — 週/月/年トレンド + PFC 円グラフ
- 月次AIレポート (LIFF からpullで生成、push しない)

### コスト試算
| 項目 | 月額 |
|---|---|
| Anthropic Vision (1000req/月) | ¥1,400 |
| R2 画像保存 | ¥1.5 |
| **合計追加** | **¥1,500/月** |

### 必要な事前準備
- Anthropic API アカウント開設 (Katsu 作業)
- API キーを wrangler secrets に登録: `ANTHROPIC_API_KEY`

---

## ⏸ Phase 4: ガチャ/季節/アバター/投票

### 計画
- migration 037: `gacha_draws` / `events` / `friend_avatars` / `product_votes`
- ガチャ: 3日に1回 or 累積pt消費型、確率テーブル設計
- 季節イベント: 期間限定 cron でアクティブ判定
- アバター: 自然成長 (時刻差分でクライアント側計算)
- 新商品投票: シンプル投票テーブル

---

## 🔍 重さ・リスク対策 (全 Phase 共通)

| 対策 | 適用箇所 |
|---|---|
| インデックス徹底 | friend_id + 時系列カラム |
| 集計テーブル事前作成 | daily_food_stats / daily_stats |
| `waitUntil()` 非同期化 | AI呼出/通知/集計 |
| LIFF ページネーション | 食事ログ/バッジ履歴 |
| 古いデータ archive | 1年以上前の food_logs |
| 画像サイズ上限 5MB | 食事写真受信 |
| LINE Push 制限 | cron 1日1回まで |

---

## 📝 変更ログ

| 日付 | 変更 |
|---|---|
| 2026-04-26 | PHASE_PROGRESS.md 新設、Phase 1 着手 |
| 2026-04-26 | Phase 1 完了 (commit `5b0df90`) — 能動pull型 服用記録 + cron 停止 |
| 2026-04-26 | Phase 2 完了 (commit `368515a`) — バッジ + レベル制度 (969 tests pass) |
| 2026-04-27 | 付随セクション (D + F) 完了 (commit `95cb97d`) — 誕生月再収集 (DMM 解約対策) + 監視スケルトン (986 tests pass) |
| 2026-04-27 | 管理画面に「誕生月収集」ページ追加 (commit `530c8a2`) + migrations README 整備 (`a26a6a4`) + Playwright E2E ベースライン (`307e12c`) |

---

## 🔗 関連ドキュメント

- 全体仕様: `docs/SPEC.md`
- DR 手順: `docs/DR.md`
- セッション履歴: `backups/sessions/SESSION_HANDOFF_v*.md`
- CICD 詳細: `~/.claude/projects/.../memory/project_cicd_complete.md`
