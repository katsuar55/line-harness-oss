# Session Handoff v26 — 2026-04-23

> **このドキュメントは新セッション開始時に最初に読むこと。** v25 以降の全修正・現在状態・次アクション・既知の罠を完結に記述。

---

## 0. あなた（次セッションの Claude）の役割

LINE Harness OSS (`katsuar55/line-harness-oss`) のシニアエンジニア。
オーナー **Katsu**（非エンジニア、naturism ブランド代表、株式会社ケンコーエクスプレス）のために自律的に作業する。

### 運用ルール（必ず守る）
- **Windows / PowerShell 環境**: `&&` 不可、`;` で区切る
- **マルチエージェント並列推奨**: Explore / code-reviewer / security-reviewer を積極的に並列実行
- **API > GUI**: GUI で不可能なら即座に API 実装を提案
- **naturism は必ず小文字**（"Naturism" は禁止）
- **薬機法**: 効能効果を断定する表現を AI プロンプト・UI コピーに含めない
- **タスク報告**: 引き継ぎリストの全項目を verify してから「完了」と報告
- **自律作業歓迎**: D1 マイグレーション・デプロイまで Claude が代行
- **ULTRATHINK 推奨**: 症状だけでなく根本原因まで掘る。今セッションで「Vite redirect の罠」に気づけたのは深掘りしたから

---

## 1. 今セッション (2026-04-22 〜 23) で完了した主要作業

### 🎨 リッチメニュー機能の根本修正
| コミット | 内容 |
|---|---|
| `bfc4900` | DMM 風の視覚編集 UI + チャット未読バッジエンドポイント |
| `0ea58d1` | 一覧プレビューにアップロード済み画像を表示（LINE proxy エンドポイント新設） |
| `34a220f` | 画像アップロードが multipart/form-data で silent drop されていたバグ修正 → 生バイナリ送信に変更 |
| `527c32e` | **画像変更は LINE API 仕様で再アップロード禁止** → 自動再作成フロー（clone + delete old）を透過的に実装 |
| `d6703ee` | 診断ステップ `steps[]` + 新メニューアップロードのリトライ (800ms/1.6s 間隔 × 3回) |

### 💬 個別チャット UI 大改修
| コミット | 内容 |
|---|---|
| `cd0a306` | サイドバー未読バッジ即時反映（10秒ポーリング + visibility/focus listener） |
| `3fcb7e8` | `/api/chats/unread-count` が効かない場合のフォールバック（`?status=unread` 配列長数え） |
| `537226a` | ポーリング毎の「読み込み中」フラッシュ抑止（silent flag） |
| `a4a82e0` | Flex 遅延レンダリングで scroll 位置が中途半端になる問題を多段スクロール + ResizeObserver で解決 |
| `9c2c226` | 最新メッセージ見切れ解消 + 既読自動遷移 + リサイザー（左右幅ドラッグ） |

### 🛡 AI コスト/DoS 防御（3層ガード）
| コミット | 内容 |
|---|---|
| `1df87a5` | Layer 1.5 として 3ガードを追加: ノイズフィルタ / バーストクールダウン / 日次上限 |

**詳細**:
- `apps/worker/src/routes/webhook.ts` 内、Layer 1 (auto_replies) と Layer 2 (Workers AI) の間に実装
- **Guard 1 ノイズ**: 空/1文字/記号のみ/同一文字連打 → AI 呼ばず定型返信
- **Guard 2 バースト**: 30秒以内に 5件超の incoming → クールダウン通知
- **Guard 3 日次上限**: 1 friend あたり 100 AI応答/日 超 → 上限通知
- 全ガードは `[guard:noise|burst|daily-cap]` プレフィックスで messages_log に記録

チューニング定数 (webhook.ts 先頭):
```ts
const BURST_THRESHOLD = 5;
const BURST_WINDOW_SEC = 30;
const DAILY_AI_CAP = 100;
```

---

## 2. 🚨 超重要: デプロイ時の必須手順（罠あり）

### Worker デプロイで過去にハマったポイント
`.wrangler/deploy/config.json` が存在していた時期があり、**`npx wrangler deploy` 単独では Vite ビルド成果物 (`dist/`) を見に行く**。ビルドしないと古いコードが永遠にデプロイされ続ける地獄になる。

### 正しい手順
```powershell
cd C:\Users\user\Desktop\line-harness-oss\apps\worker
# ★ 必ず vite build してから deploy
npx vite build; npx wrangler deploy
# もしくは package.json の script を使う
pnpm deploy
```

`package.json` の `"deploy": "vite build && wrangler deploy"` が正しい。直接 `wrangler deploy` を叩くと事故る。

### 検証方法
デプロイ後、本番で新しいコードが走っているか確認:
```powershell
# 特定の文字列が応答に含まれているか確認
curl -s "https://naturism-line-crm.katsu-7d5.workers.dev/api/..." -H "Authorization: Bearer ..."
```

---

## 3. 現在の状態（2026-04-23 時点）

### Git
- **branch**: `main`
- **HEAD**: `1df87a5` (AI 防御ガード)

### Build / Type
- `apps/web` typecheck: ✅ クリーン
- `apps/worker` typecheck: ✅ クリーン

### 本番デプロイ
| 項目 | 値 |
|---|---|
| Worker Version | `578a2e0d-572d-4185-adf8-6e4161427dee` |
| Web (Pages) | `naturism-admin.pages.dev` |
| Cron | `*/5 * * * *` 稼働中 |
| GitHub push | ✅ `1df87a5` まで反映 |

### D1 バックアップ
| 日付 | サイズ |
|---|---|
| `backups/naturism-d1-backup-2026-04-12-v2.sql` | 938KB (古い) |
| `backups/naturism-d1-backup-2026-04-17.sql` | 1.7MB |
| **`backups/naturism-d1-backup-2026-04-23.sql`** | **1.8MB (最新)** |

---

## 4. 🐛 既知の未修正バグ・保留項目

### 🔴 優先度高: 週次レポート cron 暴走
- **症状**: `processWeeklyReports` サービスが週次ではなく **5分毎に発火** している模様
- **被害**: 2026-04-13 に単一 friend へ **196件の Flex メッセージ** が送信された（5分間隔で約17時間連続）
- **調査ポイント**: `apps/worker/src/services/weekly-report.ts` の「前回送信から7日経過」条件の存在確認・バグ修正
- **次セッション冒頭で対応推奨**

### 🟡 優先度中: リッチメニュー画像変更時のスマホ側即反映
- **現状**: 管理画面で画像を変更すると、再作成フローで LINE サーバーには正しく反映されるが、スマホ LINE アプリのキャッシュが古いまま
- **暫定対策**: 「デフォルトに設定」を押すと反映される（今セッションで Katsu 確認済）
- **恒久対策**: rich menu alias 方式への切替（ID が変わらないので即反映）
- 実装工数 中（ただし UX は大きく改善）

### 🟢 優先度低
- `console.log` プロダクション整理（LOW severity、影響軽微）
- `packages/db/schema.sql` を migrations から再生成（実運用は migration 順で問題なし）

---

## 5. P0 残タスク（Katsu 確認/対応が必要な項目）

1. **LINE Developers Console** で Webhook URL が `https://naturism-line-crm.katsu-7d5.workers.dev/webhook` か目視確認
2. **リッチメニュー画像** を本番デザイン版 (2500×1686px) に差し替え
3. **STRIPE_WEBHOOK_SECRET** が必要なら `npx wrangler secret put STRIPE_WEBHOOK_SECRET`
4. **DMM 友だちデータ CSV インポート** が必要なら依頼

---

## 6. 今セッションで Katsu に並行依頼中のテスト

セッション切替後の次セッション冒頭で結果確認:
- **AI ガードテスト**:
  1. naturism-TEST に `？` だけ送信 → ノイズフィルタの返答が来るか
  2. 30秒以内に 6〜7件連投 → バースト応答が来るか
- **正常動作確認**: 普通の質問にはこれまで通り AI が答えるか

---

## 7. 設定済みリソース（全て Claude 確認済）

### wrangler.toml
- D1 binding: `DB` → `naturism-line-crm`
- R2 binding: `IMAGES` → `naturism-line-crm-images`
- AI binding: `AI`（Workers AI）
- Cron: `*/5 * * * *`
- Rate Limiter: `WEBHOOK_RATE_LIMITER` (60req/60s), `API_RATE_LIMITER` (300req/60s)

### Worker シークレット（13個設定済）
```
AI_SYSTEM_PROMPT, API_KEY, LIFF_URL,
LINE_CHANNEL_ACCESS_TOKEN, LINE_CHANNEL_SECRET,
LINE_LOGIN_CHANNEL_ID, LINE_LOGIN_CHANNEL_SECRET,
SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET,
SHOPIFY_LINE_NOTIFY_ENABLED, SHOPIFY_STORE_DOMAIN,
SHOPIFY_WEBHOOK_SECRET, WORKER_URL
```
未設定: `STRIPE_WEBHOOK_SECRET` (未設定時は自動 reject 実装済)、`LINE_CHANNEL_ID` (コード上未使用)

---

## 8. リポジトリ構成（pnpm 9.15.4 monorepo）

```
apps/
  worker/              Cloudflare Workers + Hono
    src/routes/        30+ ルート
    src/services/      Cron で回るビジネスロジック (12本)
  web/                 Next.js 15 + React 19 + Tailwind 4 (33ページ)
packages/
  db/                  @line-crm/db — D1 スキーマ + クエリ関数
  line-sdk/            @line-crm/line-sdk — LINE Messaging API ラッパー
  shared/              @line-crm/shared
backups/               D1バックアップ + 旧セッションハンドオフ (v1〜v25)
```

---

## 9. AI 応答アーキテクチャ（重要）

`apps/worker/src/services/ai-response.ts` + `webhook.ts`

```
メッセージ受信
  ↓
[Layer 1] auto_replies テーブルでキーワード一致 → 定型返信
  ↓ マッチしない場合
[Layer 1.5] ガード3段 (新規追加)
  - Guard 1: ノイズフィルタ
  - Guard 2: バーストクールダウン (30s/5件)
  - Guard 3: 日次上限 (100/friend/day)
  ↓ 全ガード通過
[Layer 2] Workers AI
  - Primary: Qwen3-30B-A3B (日本語得意)
  - Fallback: Llama 3.3 70B (安定)
  - 約230行のシステムプロンプト（商品3種の全情報・FAQ・薬機法ルール）を毎回注入
  ↓ 両モデル失敗
[Layer 3] 固定文「ただいま混み合っております...」
```

### コスト（参考）
- Llama 3.3 70B (Workers AI): ~$0.60 input / $1.40 output per 1M tok
- Qwen3 30B (Workers AI): ~$0.30 input / $0.60 output
- Claude Haiku 4.5 API: $1.00 / $5.00 (Llama より 3〜4倍高い)
- → Llama 3.3 維持、ガードで DoS 対策済み

---

## 10. 参考リンク

| 項目 | URL |
|---|---|
| GitHub | https://github.com/katsuar55/line-harness-oss |
| Worker | https://naturism-line-crm.katsu-7d5.workers.dev |
| 管理画面 | https://naturism-admin.pages.dev |
| OpenAPI | https://naturism-line-crm.katsu-7d5.workers.dev/openapi.json |
| Memory | `C:\Users\user\.claude\projects\C--Users-user-Desktop-line-harness-oss\memory\MEMORY.md` |
| 旧セッション | `backups/sessions/SESSION_HANDOFF_v1〜v25.md` |

---

## 11. 新セッション開始時の推奨手順

1. このファイル `SESSION_HANDOFF_v26.md` を読む
2. `git log --oneline -10` で直近コミット確認
3. Katsu から以下の情報が来るはず:
   - AI ガードテスト結果（ノイズ・バースト動作確認）
4. 問題があれば Guard チューニング、なければ以下のどれかへ:
   - **A**: 週次レポート cron 暴走バグ修正（推奨）
   - **B**: リッチメニュー alias 方式リファクタ
   - **C**: Katsu の次の要望

---

**以上、v26 ハンドオフ完了。次セッションで `git log --oneline -5` 確認 + Katsu のテスト結果フィードバック受領から開始してください。**
