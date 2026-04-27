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
