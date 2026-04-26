# Phase Progress — naturism LINE Harness 拡張 (2026-04 〜)

> 実装中の Living Document。各 Phase の進捗・仕様変更・既知の課題を記録。
> 完成後の正式マニュアルは `docs/MANUAL/` に別途作成予定 (Final phase)。

---

## 🗺️ 全体ロードマップ

| Phase | 内容 | 期間目安 | 状態 |
|---|---|---|---|
| 1 | 能動pull化 + 服用記録 | 1〜2日 | 🚧 着手 (2026-04-26) |
| 2 | ゲーミフィケーション基盤 (バッジ/レベル) | 2〜3日 | ⏸ 待機 |
| 3 | AI 食事診断 + カロリー記録 + グラフ | 5〜7日 | ⏸ 待機 |
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

## 🚧 Phase 1: 能動pull化 + 服用記録

### 目的
- 受動 push の服用リマインダーを停止 → LINE 課金を激減
- LIFF Top に「朝/昼/夜」3ボタンの能動pull UI
- 押すたびにスコア +10 加算 → 既存 ranking と連動

### 仕様
| 項目 | 内容 |
|---|---|
| UI 場所 | LIFF Portal Top (`apps/worker/src/routes/liff-pages.ts` の portalPage) |
| ボタン | 朝 ○ / 昼 ○ / 夜 ○ (押したら ●、再押し不可) |
| API | `POST /api/liff/intake` を `meal_type` 受け取りに拡張 |
| 重複防止 | 同日 + 同 meal_type で UNIQUE (DB制約) |
| ポイント | event_bus で `intake_log` イベント発火 → 既存 applyScoring が拾う |
| 累計表示 | LIFF 内に「累計記録: N日」「今月ポイント: Mpt」 |

### スキーマ変更 (migration 034)
- `intake_logs.meal_type` TEXT (`breakfast`/`lunch`/`dinner`/`snack`) を追加
- `(friend_id, logged_at_date, meal_type)` で UNIQUE INDEX

### Cron 停止
- `apps/worker/src/index.ts` の `processIntakeReminders` 呼出を削除
- `intake-reminder.ts` のコードは残置 (将来オプトイン用)

### 実装チェックリスト
- [ ] migration 034 作成
- [ ] schema.sql 再生成
- [ ] `createIntakeLog` を meal_type 対応に
- [ ] `POST /api/liff/intake` を meal_type 対応に
- [ ] 同日同 meal_type 重複防止 (DB UNIQUE + アプリ層 try/catch)
- [ ] event_bus で `intake_log` イベント発火
- [ ] LIFF Top の UI 3ボタン化
- [ ] cron 停止 (index.ts)
- [ ] 既存テスト更新 (liff-portal.test.ts の mock)
- [ ] 新規テスト追加 (meal_type / 重複防止)
- [ ] typecheck パス
- [ ] commit + push (CI 自動デプロイ)

---

## ⏸ Phase 2: ゲーミフィケーション基盤

### 計画 (Phase 1 完了後に詳細化)
- migration 035: `badges` (定義) + `friend_badges` (獲得記録)
- バッジ判定ロジック (服用ストリーク / 購入回数 / 紹介数)
- LIFF にバッジ図鑑画面
- ストリークは「累計優先」設計 (途切れてもリセットされない)
- レベル制度: `friends.score / 100` で level 計算 (テーブル不要)

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

---

## 🔗 関連ドキュメント

- 全体仕様: `docs/SPEC.md`
- DR 手順: `docs/DR.md`
- セッション履歴: `backups/sessions/SESSION_HANDOFF_v*.md`
- CICD 詳細: `~/.claude/projects/.../memory/project_cicd_complete.md`
