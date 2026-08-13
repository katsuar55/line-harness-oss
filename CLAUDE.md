# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

<!-- brain_notebook_id: bb76696f-4e1f-47c7-b328-801d3c55aa37 -->

## 🚨 セッション開始 protocol (絶対遵守、 ユーザー指示前に必ず自動実行)

新セッション開始時、 ユーザーが NEXT_SESSION_PROMPT.md をコピペしなかった場合でも、 以下を **必ず順に実行** してから着手宣言する:

1. **memory `project_current_state.md` を Read** (現在 Phase / 次タスク / 本番 version の最短サマリ)
   - path: `~/.claude/projects/C--dev-line-harness-oss/memory/project_current_state.md`
2. **`SESSION_HANDOFF.md` を Read** (gitignore、 main repo root、 詳細引継ぎ single source of truth)
   - path: `C:\dev\line-harness-oss\SESSION_HANDOFF.md`
3. **memory 8 件 (大方針 + 学び) を概要確認** (MEMORY.md の link を辿る)
4. **`git log --oneline 0b62292..HEAD`** で前回 commits 確認 (worktree 内、 base は最新 main)
5. **本番 smoke 最小 1 endpoint** (`GET https://naturism-line-crm.katsu-7d5.workers.dev/` → 200 + bundle ID 抽出) で運用状態確認
6. **大方針 3 行要約を出力** (① AI ネイティブ ② 汎用性 multi-brand ③ Lステップ網羅)
7. **着手宣言** (「次タスクは X です、 進めます」)

これにより、 ユーザーがコピペ忘れてもシームレスに継続可能。 NEXT_SESSION_PROMPT.md は **任意の補助** に降格 (コピペすればより詳細、 しなくても上記 7 手順で 95% カバー)。

## プロジェクト概要

LINE Harness OSS — LINE公式アカウントの完全オープンソース CRM/マーケティング自動化ツール。
Cloudflare Workers + D1 上で動作し、無料枠で5,000友だちまで運用可能。

現在のデプロイ対象: **naturism**（インナーケアサプリブランド、株式会社ケンコーエクスプレス）
- ブランド名は必ず小文字 "naturism"（"Naturism" は誤り）
- 将来的に第2アカウント「健康エクスプレス」も追加予定

## 技術スタック

| レイヤー | 技術 |
|---------|------|
| API / Webhook | Cloudflare Workers + Hono |
| データベース | Cloudflare D1 (SQLite) — 42テーブル |
| AI | Cloudflare Workers AI (Qwen3-30B-A3B) |
| 管理画面 | Next.js 15 (App Router) + Tailwind CSS 4 + React 19 |
| LINE SDK | カスタム型付きSDK (`packages/line-sdk/`) |
| SDK | TypeScript SDK (`packages/sdk/`, 41テスト) |
| 定期実行 | Workers Cron Triggers (5分毎) |
| パッケージマネージャー | **pnpm 9.15.4**（npm/yarn 使用禁止） |

## 開発コマンド

```bash
pnpm install              # 依存関係インストール
pnpm dev:worker           # Worker ローカル開発 → http://localhost:8787
pnpm dev:web              # 管理画面ローカル開発 → http://localhost:3001
pnpm build                # 全パッケージビルド
pnpm deploy:worker        # Worker デプロイ (vite build && wrangler deploy)
pnpm db:migrate           # D1 スキーマ適用（リモート）
pnpm db:migrate:local     # D1 スキーマ適用（ローカル）

# Worker 単体操作
cd apps/worker
pnpm typecheck            # TypeScript 型チェック
pnpm dev                  # vite dev
pnpm deploy               # vite build && wrangler deploy

# SDK テスト
cd packages/sdk
pnpm test                 # 41テスト実行
```

## モノレポ構成

pnpm ワークスペース (`pnpm-workspace.yaml`: `apps/*`, `packages/*`)

### apps/
- **`worker/`** — Cloudflare Workers API + Webhook (Hono)。25+ ルートファイル、100+ エンドポイント
- **`web/`** — Next.js 15 管理画面

### packages/
- **`db/`** — D1 スキーマ (`schema.sql`) + 12マイグレーション + 全クエリ関数。workspace名 `@line-crm/db`
- **`line-sdk/`** — LINE Messaging API 型付きラッパー。workspace名 `@line-crm/line-sdk`
- **`shared/`** — 共有型定義。workspace名 `@line-crm/shared`
- **`sdk/`** — 外部クライアント向け TypeScript SDK (ESM + CJS)
- **`mcp-server/`** — MCP サーバー（Claude Code 連携用）
- **`create-line-harness/`** — セットアップ CLI
- **`plugin-template/`** — プラグインテンプレート

## アーキテクチャ

```
LINE Platform ──→ CF Workers (Hono) ──→ D1 (42テーブル)
                       ↑                     ↑
                 Cron (5分毎)           Workers AI
                       ↓
                LINE Messaging API

Next.js 15 (管理画面) ──→ Workers API ──→ D1
```

### Worker リクエストフロー
1. `/webhook` — LINE署名検証 → `waitUntil()` で非同期イベント処理（LINE の1秒応答制限対応）
2. `/api/*` — `authMiddleware` (API_KEY ベアラー認証) → CRUD 操作
3. Cron — ステップ配信・予約ブロードキャスト・リマインダー・BAN監視・トークンリフレッシュ

### マルチアカウント
`line_accounts` テーブルで複数LINEアカウントを管理。Webhook受信時に `destination` フィールドと署名検証で自動ルーティング。

### イベントバス
`fireEvent()` (`apps/worker/src/services/event-bus.ts`) が全自動化の起点。
イベント種別: `friend_add`, `message_received` 等 → `automations` テーブルの条件に基づきアクション実行。

### AI 自動応答（3層ハイブリッド）
```
メッセージ受信
  → [Layer 1] auto_replies テーブルでキーワードマッチ → テンプレート返信
  → [Layer 2] Workers AI (Qwen3-30B-A3B) で自然言語応答
  → [Layer 3] フォールバック定型メッセージ
```

## Env バインディング (Worker)

```typescript
DB: D1Database                    // Cloudflare D1
IMAGES: R2Bucket                  // 画像ストレージ
AI: Ai                            // Workers AI (naturism用に追加)
LINE_CHANNEL_SECRET: string       // wrangler secret
LINE_CHANNEL_ACCESS_TOKEN: string // wrangler secret
API_KEY: string                   // 管理画面認証用 wrangler secret
LINE_LOGIN_CHANNEL_ID: string     // UUID 自動取得用
LINE_LOGIN_CHANNEL_SECRET: string
LIFF_URL: string
WORKER_URL: string
```

## デプロイルール (案 A: 全権限委譲, 改訂 2026-04-28)

- Claude Code は本リポジトリの全コマンドを自律実行してよい (deploy / d1 / secret 含む)
- 実行前に必ず `pnpm preflight` で All green を確認すること
- ただし以下は**必ず実行前にチャットで報告し承認を待つ** (不可逆操作・実費・公開影響):
  - 本番 D1 データの破壊的変更 (`DROP TABLE` / `DELETE FROM ... WHERE` を伴う migration)
  - `wrangler d1 create` (新 DB 作成)
  - 実費が発生する Cloudflare プラン変更 (Workers Paid / R2 課金 / Workers AI 有料モデル切替 等)
  - 公開済み LINE Official Account への broadcast (1万件以上)
  - 公開チャンネルの Webhook URL 変更
- `pnpm --filter worker deploy` (vite build && wrangler deploy && post-deploy-check) は事前承認なしで実行可
  - post-deploy-check が本番 bundle ID とローカル build を最大 30s (5s × 6 attempts) リトライで自動照合する
  - 不一致なら exit 1 で警告を出すので、結果をチャットに報告すること
  - LIFF ID 埋め込みは preflight `[liff-bundle]` チェックで build 前に検証済み
  - preflight CRITICAL がある状態で deploy しないこと (deploy 自動ブロック)
- シークレットは `wrangler secret put` でのみ設定。コード・ログ・CLAUDE.md に含めない
  - secret 値そのもののチャットへのエコーバックも禁止 (PII / 認証情報の漏洩防止)
- 薬機法に抵触する表現（効能効果の断定）をAIプロンプトに含めない

**事故時のロールバック手順** (2026-04-28 「読み込み中...」固着事故の教訓):
- 直近 deploy で本番が壊れたら即 `wrangler rollback` または前 commit を checkout して再 deploy
- 復旧 deploy 後、必ず `curl -s https://<worker-url>/ | grep "src=\"/assets/"` で
  bundle ID が変わったことを確認 (Cloudflare CDN キャッシュは数十秒で剥がれる)
- **2026-05-07 改善**: `scripts/post-deploy-check.mjs` が deploy script に組み込まれ、
  本番 HTML とローカル build を自動照合する (curl 手順は冗長確認用に残す)

## 現在のフェーズ

**Phase 1: 基盤構築** — Worker + D1 + Webhook + AI自動応答 + 管理画面

## Workers コーディングルール (絶対遵守 — 再発防止)

2026-05-09 に Round 4 email channel 本番初実行で `Illegal invocation: function called with incorrect this reference` バグが発覚。テストでは検出できず、本番送信で初発覚した。同じ穴を踏まないために以下を守る。

### 禁止パターン

| パターン | 理由 |
|---|---|
| `class X { f = globalThis.fetch }` 等で global function を class field / object property に unbound 保持 | Workers ランタイムで `instance.f(...)` 呼出時に `this=instance` になり、global が要求する `this=globalThis` と不一致で Illegal invocation |
| unbound な global を **options オブジェクトに載せて別関数へ渡し**、渡された側で `opts.fetchImpl(...)` と property 経由で呼ぶ | 上記の class field 版と同じ事故。`const fetchImpl = options.fetchImpl ?? fetch` 自体は「その場で呼ぶ限り」安全なので見逃されやすいが、**下流で object property に載った瞬間に危険に変わる**。2026-08-13 に `ai-models-catalog.ts` で実発生 (下記参照) |
| secret / gate 待ちで **一度も実行されない経路**を、mock 注入テストだけで「カバー済み」とみなす | 2026-05-26 に書かれた catalog sync は `CLOUDFLARE_API_TOKEN` 未投入の間ずっと graceful skip で、既定 fetch 経路は 2.5 ヶ月間 1 度も実行されなかった。37 件の既存テストが**全て `fetchImpl` を注入**していたため既定値は完全ノーカバレッジ。token 投入の翌朝 (2026-08-12 04:00 JST) の初回実行で即 Illegal invocation。**「本番で初めて通る経路」は投入前に必ず bind 経路ごと test で通す** |
| `const { method } = globalThis.crypto.subtle` の destructure 後に `method(...)` を呼ぶ | 同上 (prototype method の context 喪失) |
| Workers ランタイムのテスト省略 + Node mock のみで完結させる | mock が default 値の bind 部分を bypass するため、unbound バグが本番初実行まで隠れる |

### 推奨パターン

| やりたいこと | 正しい方法 |
|---|---|
| class field に fetch を持って後で呼ぶ | `this.fetchImpl = options.fetchImpl ?? fetch.bind(globalThis)` (例: `packages/email-sdk/src/resend-client.ts`) |
| 関数 scope で global を参照 | `const fetchImpl = options.fetchImpl ?? fetch; await fetchImpl(...)` (これは `this` 不要、 OK) |
| crypto.subtle method を使う | `await crypto.subtle.sign(...)` のようにオブジェクト経由で直接呼ぶ。destructure しない |
| default 値の bind を test で固める | `expect(internalFetch.name).toMatch(/^bound /)` のような unit test で「bound 済み」 を検証 (例: `packages/email-sdk/__tests__/resend-client.test.ts`) |
| Node の vitest で Illegal invocation を**実際に再現**する | Node の undici fetch は `this` を見ないので素直に呼んでも再現しない。`globalThis.fetch` を **Workers と同じ brand check を持つ stub** (`this` が `undefined`/`globalThis` 以外なら throw) に差し替え、`fetchImpl` を**注入せず**に呼ぶ (例: `ai-models-catalog.test.ts` の「既定 fetch の this 束縛」)。mutation で実際に落ちることまで確認する |

### 自己点検チェックリスト (Workers 用 class を書く前)

- [ ] 外部から渡された optional dep の default に **global function** を入れていないか?
- [ ] その default は `bind(globalThis)` してあるか?
- [ ] その値は下流で **object property / class field に載る**か? 載るなら呼出は `obj.f(...)` でなく local const 経由にしてあるか?
- [ ] テストは default 値の bind 経路を実際に呼ぶか? (mock 経由でないか?)
- [ ] regression test (bind name/identity チェック) を 1 件追加したか?
- [ ] その経路は **secret / gate 待ちで本番未実行**ではないか? 未実行なら、投入前に test で必ず通しておく

### 違反時の必須アクション

新パターンで Illegal invocation バグが発生したら、本ファイルの「禁止パターン」表に該当パターンを追記してから次の作業に移る。

## シェル運用ルール (絶対遵守 — 再発防止)

過去 2 セッションで「実行中シェルが残り続け、6 時間以上ハング」事故が発生。Celeron 8GB の低スペック環境では致命的。以下を厳守する。

### 禁止パターン

| パターン | 理由 |
|---|---|
| `until …; do sleep N; done` で別 bash の完了を待つ | run_in_background 通知が届くため不要。output ファイルが空のままだと永久ループする |
| `tail -f file` (`-F` 含む) | 自然終了しない |
| `watch …` / `while true; do …; done` | 同上 |
| `sleep N && command` を 60 秒以上 | 進捗が見えず、キャンセル困難 |
| `pnpm dev` / `npm start` 等の常駐サーバーを Bash で起動したまま | プロセスが残り続ける。dev サーバーが必要なら preview_start か Playwright `webServer` 設定を使う |
| `& disown` 等の手動デーモン化 | 制御不能になる |

### 推奨パターン

| やりたいこと | 正しい方法 |
|---|---|
| background bash の完了を待つ | **何もしない**。`run_in_background: true` の通知を受信するまで他作業を進めるか、ScheduleWakeup で再開 |
| 完了後にログを見る | 通知到着後、`Read` ツールまたは `tail -n 100 file` を **1 回だけ** |
| 進捗を能動的に見たい | `Monitor` ツール (selective grep + 自然終了する command) を使う |
| dev サーバーで動作確認 | preview_start (1 つだけ) または Playwright `webServer` (テスト終了時に自動停止) |
| 「ビルド成功か?」だけ知りたい | exit code を返す one-shot コマンド (`npm run build && echo OK`) を `run_in_background: true` で投げ、通知を待つ |

### 自己点検チェックリスト (Bash 実行前)

- [ ] このコマンドは **何秒以内に確実に終わる** か?
- [ ] 終了条件は **プロセス自体の exit** か (output 文字列マッチではなく)?
- [ ] 既に同じ目的の background bash が走っていないか?
- [ ] 別 background の完了を待つ目的なら、それは **不要** ではないか (通知が来る)?

1 つでも怪しければコマンドを変更するか、ユーザーに方針確認する。

### Bash 実行時の自己宣言 (必須)

すべての Bash ツール呼び出し時、コマンド前にコメントで予想実行時間を宣言する:

```bash
# expected: <30s | 30s-2min | 2min-10min | >10min(needs-confirmation)
```

`>10min` を選ぶ場合は実行前にユーザー承認を取る。

### ユーザー側監視

- 2 分以上「実行中」が残るタスクがあれば、ユーザーは即「タスクパネルの状態を分析して」と質問する
- Claude Code は自分の実行中タスクを `Get-CimInstance Win32_Process` 等で確認して報告
- 該当 bash の生存状況に応じて `TaskStop` または継続判断

### 違反時の必須アクション

新パターンでハングした場合、本ファイルの「禁止パターン」表に該当パターンを追記してから次の作業に移る。
追記なき再発は同じ穴を踏み続けるため、必ずルール側にフィードバックする。

## LIFF inline JS コーディングルール (絶対遵守 — 再発防止)

2026-07-10 に #192 デプロイ後、ポータルが「読み込み中」スピナーのまま**全ユーザーで全損**する本番障害が発生 (#193 で hotfix)。原因は inline onclick 属性内の JS に `\'` エスケープを書いたこと。同じ穴を踏まないために以下を守る。

### 禁止パターン

| パターン | 理由 |
|---|---|
| server 側 TS の template literal 内で、client JS 文字列に「バックスラッシュ+シングルクォート」エスケープを書く (例: onclick 属性内の JS) | TS の template literal がエスケープを素のクォートに潰して emit → client JS の文字列リテラルが途中終端 → **inline script 全体が SyntaxError → ページ全損** (watchdog も同 script 内なので死ぬ)。regex ベースの静的ガードでも typecheck でも原理的に検出不能 |
| inline onclick / onerror 属性値に引用符ネストが必要な JS を直接書く | 上記エスケープ地獄の温床。両引用符 (HTML=二重・JS=単一) を跨ぐ時点で危険信号 |
| **inline script の中に script 終了タグを literal で書く (コメント内・文字列内を含む)** | HTML parser は script data state でコメント/文字列を**一切区別せず**最初の終了タグで打ち切る。以降の JS は 1 行も実行されない。**打ち切られた断片は文法的に valid なので parse 検証をすり抜ける** (= 既存の恒久ガードでも検出不能)。2026-05-17〜07-29 に /liff/opt-in が 2.5 ヶ月「読み込み中」で固着し、4,000 件のテスト・preflight・敵対的採点 4 ラウンドを全て素通りした。皮肉にも原因は「終了タグ注入 XSS を防ぐ」説明コメントだった |
| inline script に埋める値を `&` `"` だけエスケープして済ませる | script data state では**実体参照が復号されない**ため `&amp;` が literal に残り値が壊れる (URL の `&t=30` → `&amp;t=30` でパラメータ名が `amp;t` に化ける)。`<` `>` を素通しすると終了タグ注入まで成立する。/t/:linkId が実際にこの状態で LIVE だった (2026-07-29 の監査で発見) |

### 推奨パターン

| やりたいこと | 正しい方法 |
|---|---|
| onclick で複数文の JS を実行 | **名前付き関数を script 内に定義**して `onclick="fnName()"` で呼ぶ (例: `scrollToReferralCard()`) |
| client JS 内に改行文字を書く | `\\n` (バックスラッシュ2つ) — emit 後に `\n` になる (例: shareRefLine の msg) |
| script 終了タグに言及したい (コメント・文字列) | **バックスラッシュを挟む** (`<\/script>`) か、日本語で「終了タグ」と書く。`utils/inline-script.ts` の `inlineScriptBody()` を通せば機械的に無害化される |
| inline script に値を埋める | `jsonForScript(value)` (`utils/inline-script.ts`)。`<` `>` `&` を `\u00XX` にする。**引用符込みで返る**ので `"${...}"` と書かない |
| HTML 属性値に値を埋める | `escapeHtmlAttr(value)`。script 内とは**必要なエスケープが逆**なので使い分ける (属性値では実体参照が復号される) |
| 変更後の検証 | `liff-script-syntax.test.ts` が **LIFF 全 7 ページ + 管理画面 5 ページ**の吐き出された HTML を検証する。①開始/終了タグの数が釣り合うか ②本体に開始タグが紛れていないか ③本体が丸ごと出ているか ④parse できるか。inline script を持つ新ルートを追加したら、このテストの表にも追加すること |

### 自己点検チェックリスト (liff-pages.ts 等の inline JS を編集する前)

- [ ] 追加した client JS 文字列に「バックスラッシュ+シングルクォート」が無いか?
- [ ] onclick 属性に引用符ネストを書いていないか? (必要なら名前付き関数へ)
- [ ] **script 終了タグを literal で書いていないか? (コメント内・文字列内も含む)**
- [ ] **値の埋め込みに `jsonForScript` / `escapeHtmlAttr` を文脈どおり使い分けたか?**
- [ ] `liff-script-syntax.test.ts` を実行したか? (打ち切り検出 + parse 検証)
- [ ] **ガードを足したら、バグを再注入して実際に落ちることを確認したか?** (parse 検証だけでは
      打ち切りを検出できない。「守った」と報告する前に mutation で測定器の健全性を確かめる)

### 違反時の必須アクション

新パターンで inline script が壊れた場合、本ファイルの「禁止パターン」表に該当パターンを追記してから次の作業に移る。

## テストコーディングルール (絶対遵守 — 再発防止)

2026-05-17 に Phase 5β-prep adoption batch 2 で `vi.mock` と `await import()` の干渉により
4 件の test が silently fail するバグを発見。 同じ穴を踏まないために以下を守る。

### 禁止パターン

| パターン | 理由 |
|---|---|
| `vi.mock('A')` した module の caller (= A を import するファイル) 内で **別 module B** を `await import('B')` する | vi の hoisting と dynamic import の解決順序が干渉し、 caller 内の promise が silently swallow される。 catch ブロックにも到達せず、 assertion が「called 0 times」 で fail (=> 原因特定に時間がかかる) |
| test 環境で重要な branch (try/catch / early-return) を持つ caller 内に dynamic import を追加 | dynamic import の resolve タイミングで promise chain が早期 settle し、 後続コードが走らない可能性 |

### 推奨パターン

| やりたいこと | 正しい方法 |
|---|---|
| Cloudflare Workers の bundle size を抑えたい lazy import | **vi.mock 対象 module の caller では避ける**。 bundle に影響しない軽量 module は static import に切替 |
| 既存 dynamic import (例: `webhook.ts:786` の text message AI 応答経路) | **既存 test が pass しているなら維持 OK**。 ただし新たに別 event handler 内で同じ pattern を使う場合は事前に dedicated test で検証 |
| AIRouter のような軽量 factory | top-level `import { createAIRouterFromEnv } from '...'` で問題なし (例: `webhook.ts` の image handler) |

### 自己点検チェックリスト (新規 dynamic import を追加する前)

- [ ] その caller を import している test ファイルで `vi.mock` が hoist されていないか?
- [ ] 同じ caller 内で既存の dynamic import は **test で exercise されているか**? されていなければ新規追加で初めて顕在化する可能性
- [ ] static import で bundle size 影響は本当に懸念か? (軽量 factory なら影響軽微)
- [ ] 不安なら **まず static import で実装 → 後から dynamic 化** の段階リリース

### 違反時の必須アクション

新パターンで test が silently fail したら、 本ファイルの「禁止パターン」表に該当パターンを追記してから次の作業に移る。
