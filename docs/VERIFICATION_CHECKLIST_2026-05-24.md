# 実機検証 checklist (= PR #58-#62 release 後、 2026-05-24)

## 前提

- **Katsu 既に friend として登録済** (friend_id=`38215b51-9c9c-4f8d-a6ae-94c9fcd071a0`)
- LINE app の友だち list → **「naturism」 公式アカウント** を開く → chat 画面で各テキスト or 画像を送信
- 失敗時は Claude に **「検証 #N 失敗、 期待は X だが実際は Y」** と報告 (= screenshot あればなお良し)

## 主要 URL

| 用途 | URL |
|---|---|
| **admin web** (= friend / broadcast / D1 row 確認) | https://naturism-admin.pages.dev |
| **Worker API** (= 直接叩く時) | https://naturism-line-crm.katsu-7d5.workers.dev |
| **公式ストア** | https://naturism-diet.com |
| **Shopify admin** | https://xn--0ckn0a9fxa4a.myshopify.com/admin |
| **GitHub repo** | https://github.com/katsuar55/line-harness-oss |

---

## 検証 6 件 (= 各 PR 検証残)

### ✅ #1: 「私におすすめ」 → 5 質問 quick diagnose (PR #62 / Plan A-3)

#### 入力 (= 任意の 1 つ)
- 「私におすすめのサプリは?」
- 「どれが私に合う?」
- 「初めてだけどどれを買えばいい?」
- 「私はどれを買えばいいですか?」

#### 期待 flow (= 全 reply、 push 0 通)
1. **step 1**: 招待 flex (`🌿 あなたにぴったり診断` header + 「診断スタート ▶」 button)
2. button tap → **step 2 (Q1)**: 「Q1. 普段の食事の傾向は?」 flex + 4 button (= 揚げ物 / 炭水化物 / バランス / 外食)
3. button tap → **step 3 (Q2)**: 「Q2. 体型管理の目標は?」 flex + 4 button
4. button tap → **step 4 (Q3)**: 「Q3. 美容で気になることは?」 flex + 4 button
5. button tap → **step 5 (Q4)**: 「Q4. アレルギーで気になるものは?」 flex + 2 button
6. button tap → **step 6 (Q5)**: 「Q5. naturism を試すのは?」 flex + 3 button
7. button tap → **step 7 (結果)**: 「🎁 あなたへのおすすめ」 flex + 推奨商品 (🩵 Blue / 💗 Pink / 🩶 Premium) + 公式ストア button + 「AI に詳しく聞く」 button

#### NG パターン (= 失敗報告)
- ❌ 招待 flex なしで「初めてなら Blue です」 と即答 → AI が `[FMT:quiz_invite]` prefix を返してない
- ❌ Q1 出ない、 button tap 反応なし → webhook の postback dispatch 失敗
- ❌ 途中で止まる (= 例: Q3 で reply こない) → answer chain 累積 or postback parser 不整合
- ❌ 結果 flex 出ない → scoring 失敗

---

### ✅ #2: 「私のクーポンは?」 → 正確 fact 返却 (PR #60 / Plan A-2)

#### 入力
- 「私のクーポンは?」
- 「マイクーポン教えて」
- 「使えるクーポンある?」

#### 期待
- AI が text or flex で **正確に**:
  - **コード**: `LINE-SCWG8ASF`
  - **値引**: ¥500 OFF
  - **期限**: 5/27 前後 (= issued 5/24 + 3 日)
  - **利用先**: 公式ストア naturism-diet.com

#### 絶対 NG
- ❌ AI が `LINE-ABCD1234` 等の **存在しない code を fabricate** → context 注入失敗 or system prompt rule 1 違反
- ❌ 「クーポンはありません」 → expires_at 経過の可能性、 admin web の friend detail で確認

#### 補助確認 (= admin web)
- https://naturism-admin.pages.dev → friends → Katsu detail → coupon 状態 (`issued` + 期限内?)
- 期限切れなら新しいクーポン issue 必要 (= 別タスク)

---

### ✅ #3: 「私の会員ランク」 → 固定応答 (PR #59 / Plan A-1)

#### 入力 (= 全 variant 試す)
- 「私の会員ランクは?」
- 「私のステータス何?」
- 「マイル何個持ってる?」
- 「ポイント残高は?」
- 「紹介プログラム教えて」
- 「アンバサダー制度ある?」

#### 期待
- **「○○機能は近日リリース予定です。 今しばらくお待ちください🌿」** 等の固定応答 (= 各機能名で具体化されてれば OK)

#### NG パターン
- ❌ 「新規友だちです」 等の想像回答 → system prompt rule 2 違反
- ❌ 「ブロンズランク」 「Silver」 等の存在しない rank → ハルシネーション (= rule 1 違反)
- ❌ 「100 pt 保有」 等の偽数値 → 同上

---

### ✅ #4: 画像認識正直性 (PR #59 / Plan A-1)

#### A. 不確実画像 (= 困難 case)
**手順**: 以下のいずれかを送信
- 暗い場所で撮った写真
- ピンボケ写真
- 食器のみ写ってる (= 料理空)
- 知らない料理 (= 海外料理等)
- 写真の一部だけ料理 (= 角度悪い)

**期待**: 
- ⚠️ 「🤔 画像の詳細が判別できません」 flex (= 黄色 header) + 「料理名や食材を文字でお送りください」 案内

**NG**:
- ❌ 「約 270 kcal」 等の **数値を断定** → 正直性 rule 違反
- ❌ 「カレー」 等の **想像で料理名** → 同上

#### B. 鮮明な料理画像 (= 通常 case)
**手順**: 普通の料理 (= ラーメン / カレー / サラダ / 定食) を明るく撮って送信

**期待**:
- ✅ 「食事を記録しました」 flex (= 緑 header) + 正確な料理名 + 妥当な kcal/protein/fat/carbs

**NG**:
- ❌ ラーメン → 「オムライス」 等の **誤認** → 観察 rule 違反
- ❌ 一人前のラーメンが 1500 kcal 等の **極端数値** → 推測 quality 問題

---

### ✅ #5: 「公式サイトの URL は?」 → text return (PR #61 / Plan A-4)

#### 入力
- 「公式サイトの URL は?」
- 「naturism のサイト教えて」
- 「ストアはどこ?」
- 「naturism-diet.com 教えて」

#### 期待
- **plain text Message** で URL (= `https://naturism-diet.com`) が返る
- LINE が auto-link 化、 tap で browser 起動して公式ストア open

#### NG パターン
- ❌ 大きい flex カードで URL が中に埋め込まれる (= 旧挙動) → context-aware 切替失敗
- ❌ URL が省略表記 (= 「公式サイトをご覧ください」 のみで URL なし) → AI が URL 入れ忘れ

#### 補助確認
- AI 応答が冒頭に「[FMT:text]」 付けてれば prefix path、 ない場合は heuristics path (= URL を含む 200 字以下)

---

### ✅ #6: 「3 種類の違いは?」 → 既存 flex (= regression、 PR #61 / Plan A-4)

#### 入力
- 「3 種類の違いは?」
- 「Blue Pink Premium 比較」
- 「成分教えて」
- 「3 種類の違い」

#### 期待
- **flex カード** (= 緑 header「naturism」 + body に「## 違い」 等の section + Blue/Pink/Premium 比較表)
- 詳細回答が flex 内に構造的に表示される

#### NG パターン
- ❌ 詳細回答なのに **plain text** になる → 過剰簡略化 (= context-aware の判定 logic 問題)
- ❌ flex 内で 3 商品の区別が分からない → markdown 変換 logic 問題

---

## 追加 sanity check (= 既存機能 regression)

### welcome chain (= 友だち追加直後の挙動、 PR #54/#55)
**手順**:
1. (= Katsu 既に friend なので skip、 もし別の test account あればブロック → 解除で新規 friend として再現)
2. 期待: welcome message → 「次へ ▶」 button → 誕生月 12 button → 年代 7 button → ありがとう + 商品比較 flex + マイクーポン flex 同時 reply (= 3 message)

### auto_replies (= keyword match、 D1 6 行 🩵 化済)
**手順**:
1. 「飲み方」 と送信 → 「【飲み方ガイド】🌿\n\n🩵 Blue・💗Pink\n1回2〜3粒、1日6〜9粒\n...」 が返る
2. 「価格」 と送信 → 「【価格一覧（税込）】💰\n\n🩵 Blue: ¥100〜¥6,415\n💗 Pink: ¥121〜¥7,538\n🩶 Premium: ¥720〜¥14,904...」
3. 「違い」 「成分」 「アレルギー」 「ドンキ」 も同様、 🩵 Blue 表示確認

---

## 報告フォーマット (= Claude への伝達)

```
検証 #N (= 短い説明) 失敗
- 入力: "..."
- 期待: ...
- 実際: ... (= flex/text の type + 内容 + どこが想定外か)
- variant 試した: yes/no (= 同じ系統の他の入力でも再現するか)
- admin web で D1 row 確認した: yes/no (= 補助情報)
- screenshot: (= optional、 あれば LINE で送る or Discord 等)
```

## 補助情報

- production worker version: PR #62 deploy 済 (= 2026-05-24 夜)
- bundle: `index-DuC2JoJn.js` (= LIFF asset 不変、 backend 最新)
- D1 migrations: 1-53 全 apply 済
- broadcasts: `monthly-2026-06-naturism` (= 6 月梅雨対策 draft、 active 扱い)
- Katsu coupon: `LINE-SCWG8ASF` (= 5/24 issued、 3 日有効、 expires 5/27 前後)

---

## 戻り次第の優先順位

1. **検証 6 件 + sanity 2 件** を順番に試す (= 5-10 分)
2. 失敗あれば Claude に報告 → 追加 PR
3. 全 pass なら次 phase (= #6 価格比較表 / Phase 2.2 残月 / Phase 4 会員ランク) に進む
