# D1 Migrations

このディレクトリは Cloudflare D1 のスキーマ進化を表すマイグレーション SQL を保持します。
適用は wrangler が `d1_migrations` テーブルでファイル名単位に追跡します。

## 命名規則

`NNN_description.sql` (例: `034_intake_meal_type.sql`)

- `NNN` は 3 桁の連番。新しいマイグレーションは既存最大値 + 1 を使う。
- 命名のすぐ後に空行を含めず、ALTER TABLE / CREATE TABLE などを書く。
- 既に適用されたファイルはリネーム禁止 (wrangler が「未適用」と判断して再実行を試み、`duplicate column name` 等で失敗するため)。

## 適用方法

```bash
# 本番
cd apps/worker
npx wrangler d1 execute naturism-line-crm --file=../../packages/db/migrations/NNN_xxx.sql --remote

# ローカル
npx wrangler d1 execute naturism-line-crm --file=../../packages/db/migrations/NNN_xxx.sql --local
```

`pnpm db:migrate` ラッパーも同等の動作。

## 既知の歴史的事項

### `009_*` の番号重複

`009_delivery_type.sql` と `009_token_expiry.sql` の 2 ファイルが同一プレフィックスで存在する。
別ブランチで並行開発された結果、いずれも `009` を取得したまま本番に適用された
(`d1_migrations` に両ファイルが正常登録済)。

**リネームしないこと**: ファイル名を変更すると wrangler が新規マイグレーションと誤認し、
ALTER TABLE 再実行で `duplicate column name` エラーとなりデプロイがブロックされる。
アルファベット順で `009_delivery_type.sql` → `009_token_expiry.sql` の順に並ぶため
論理的な順序は保たれており、機能上の問題はない。

### Wrangler が並び順を守る前提

ファイル名のアルファベット順 (= 番号順) で適用されるため、
依存関係があるマイグレーションは必ず番号で順序を制御すること。
番号が同じ場合は、依存される側を先に置く (今回の `009_*` はいずれも独立した ALTER で順序非依存)。

### migration 052 + scenario v2 (2026-05-24、 Phase 1 ULTRATHINK MVP)

LP launch 前 リハーサル (2026-05-23) で「Welcome は来たがクーポンコードは 24h 後」 問題発覚 →
user 指示で「公式 LINE = 最安窓口 + 習慣化 channel」 grand design に拡張。 Phase 1 MVP:

- **migration 052_friend_demographics.sql**: `friends` に `birth_month INTEGER NULL` (1-12) +
  `age_group TEXT NULL` (10s/20s/.../70+) column 追加 + index (= 月 1 通信 + 誕生月特典 + 年代別
  セグメント用、 既存 `birthday TEXT NULL` は legacy 残置)
- **scripts/welcome-scenario-v2-2026-05-24.sql**: `naturism-welcome-v1` の 3 step を content
  + timing rebrush (step 0 に coupon 即時開示 + 「次へ ▶」 postback button、 step 1 30→15 min、
  step 2 text→flex、 旧 content は SQL ファイル末尾 comment に backup)
- **webhook postback handler** (= `apps/worker/src/services/welcome-postback.ts` 新規):
  `welcome_intro_step` / `welcome_birthday:N` / `welcome_age_group:X` 3 action を処理、
  birth_month / age_group を column UPDATE、 audit_logs に `friend.demographic_collected` 記録

詳細は `~/.claude/plans/optimized-snuggling-lovelace.md` 参照。 Phase 2 (= 月 1 通信 framework)
+ Phase 3 (= AI サポート最適化) + Phase 4 (= 会員ランク / 紹介) は別 PR で順次実装。

### `d1_migrations` state drift (2026-05-22 解消)

過去のいずれかの時点で production の `d1_migrations` table が空になり、
`wrangler d1 migrations apply` が全 migration を「未適用」 と判定して再試行 →
`duplicate column name` 等で fail する状態が続いていた。

2026-05-22 に `scripts/d1-migrations-state-recovery.sql` を一度きり apply して、
当時 production で適用済だった 50 migration (= 001〜051、 009 重複 +1、 038/046 欠番 -2)
を `d1_migrations` table に bookkeeping のみ insert して state を sync 済。

それ以後は `wrangler d1 migrations apply naturism-line-crm --remote` が
正常動作する (= 「No migrations to apply」を返す)。

将来また drift した場合は同 script を再利用可能 (= `INSERT OR IGNORE` で idempotent)。
ただし、 drift が起きる根本原因 (= 過去に wipe された経緯) は不明、 再発時は調査すること。
