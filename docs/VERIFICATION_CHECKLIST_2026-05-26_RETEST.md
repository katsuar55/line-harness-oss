# 再検証 cheat sheet (= PR #67 + #68 後、 2026-05-26)

ULTRATHINK 修復で 8 NG + UX 2 件を全て deterministic に解消 (= AI 任せ stop)。 以下に沿って再テスト。

## 🌐 URL

| 用途 | URL |
|---|---|
| admin web | https://naturism-admin.pages.dev |
| LINE 公式 | LINE app friend list → 「naturism」 chat 画面 |
| GitHub PR #67 | https://github.com/katsuar55/line-harness-oss/pull/67 |
| GitHub PR #68 | https://github.com/katsuar55/line-harness-oss/pull/68 |

---

## 📱 LINE app 再検証 8 件 (= 全部 deterministic、 AI 介さない)

### Step 1: 「私におすすめ」 (= 旧 NG → intent-router quiz_invite)
- **送信**: `私におすすめは？`
- **期待**: 招待 flex (= 緑 header「🌿 あなたにぴったり診断」 + 「診断スタート ▶」 button) ← AI 即答せず確実
- [ ] OK / [ ] NG

### Step 2: 診断 chain (= Step 1 OK の場合)
- **操作**: 「診断スタート ▶」 tap → Q1-Q5 答える → 結果 flex (= 🩵/💗/🩶)
- [ ] OK / [ ] NG

### Step 3 (UX 改善 ⭐ NEW): マイクーポン code copyable
- **送信**: `私のクーポンは？`
- **期待**: **2 message 同時受信**
  1. flex: 既存マイクーポン card (= ¥500 OFF + 公式ストア button)
  2. text: `🎁 クーポンコード：\nLINE-SCWG8ASF\n\n↑ 長押しでコピーして…`
- **テスト**: 2 番目の text を **長押し** → 「コピー」 メニュー出現 → コピー成功
- [ ] OK / [ ] NG / [ ] 期限切れで「お持ちのクーポンはございません」 (= 別途新 coupon issue 必要)

### Step 4: 会員ランク (= 旧 NG「新規友だち」 → 固定 text)
- **送信**: `私の会員ランクは？`
- **期待**: text 「🌿 会員ランク機能は近日リリース予定です。\n今しばらくお待ちください💝」
- [ ] OK / [ ] NG

### Step 5: 紹介プログラム (= 旧 NG「???」 長文 → 固定 text)
- **送信**: `紹介プログラム教えて`
- **期待**: text 「🌿 紹介プログラム機能は近日リリース予定です…」
- [ ] OK / [ ] NG

### Step 6: 公式サイト URL (= 既 OK、 regression 確認)
- **送信**: `公式サイトのURLは？`
- **期待**: plain text `https://naturism-diet.com` (= auto-link)
- [ ] OK / [ ] NG

### Step 7 ⭐ NEW: 3 種類の違い flex 化
- **送信**: `3種類の違いは？`
- **期待**: **flex カード** = welcome chain 末尾で見せた compare bubble (= 「🩵 Blue まずはここから / 💗 Pink 酵素で美容 / 🩶 Premium 本気の体型管理」 3 セクション + AI button)
- **旧**: text 形式で見栄え悪
- [ ] OK / [ ] NG

### Step 8: 価格教えて → grid flex (= 旧 NG → intent-router)
- **送信**: `価格教えて`
- **期待**: **grid table flex** (= header「💰 価格一覧 (税込)」 + 4 列 × 4 行 grid + 公式ストア button)
- [ ] OK / [ ] NG

### Step 12 ⭐ NEW: 「価格」 単独でも grid (= 旧 text auto_replies → intent-router 移譲)
- **送信**: `価格`
- **期待**: **同じ grid table flex** (= 単独 keyword でも grid)
- [ ] OK / [ ] NG

### Step 9: 画像認識・不鮮明 (= 旧 NG「返答なし」 → 復活)
- **操作**: 暗い写真 or 食器のみ等の不確実画像
- **期待**:
  - 即 reply: `🍽 食事の写真を受け取りました！解析中です…少々お待ちください 🙏` ← まずこれが出ること重要
  - その後 push: 「🤔 画像の詳細が判別できません」 flex (= 黄色 header)
- [ ] 「解析中」 reply 来た / [ ] 来ない (= まだ画像 pipeline 壊れてる可能性)
- [ ] 判別 flex 来た / [ ] 数値断定 (= prompt rule 効いてない、 別 issue)

### Step 10: 画像認識・通常 (= 鮮明な料理画像)
- **操作**: 普通のラーメン / カレー写真
- **期待**:
  - 即 reply: 「解析中…」
  - その後 push: 「食事を記録しました」 flex + 料理名 + kcal
- [ ] OK / [ ] 誤認 (= AI 品質問題、 PR 3 で対応)

---

## 🏷 auto_replies sanity (= 既存維持)

### Step 11: 飲み方
- **送信**: `飲み方`
- **期待**: text 「【飲み方ガイド】🌿\n\n🩵 Blue・💗Pink…」
- [ ] OK / [ ] NG

### Step 13 ⭐ NEW: 「違い」 短形でも flex 化
- **送信**: `違い`
- **期待**: 同じく product_compare flex (= 旧 text auto_replies 経由でなく、 intent-router 経由)
- [ ] OK / [ ] NG

---

## 報告 format

```
Step N (= ...) 失敗
- 送信: "..."
- 期待: ...
- 実際: ...
```

全 OK なら 「再検証全 pass」 とだけ。 1 件でも NG なら次の対応 PR を spin up します。

## 注意

- AI 由来の回答 (= 「効きますか?」 「ナチュリズムって何?」 等) は依然 Llama (= Qwen 復活 PR 3 待ち) なので品質低めの可能性。 ただし intent-router 経由の主要 6 件 (= Step 1/3/4/5/7/8/12/13) は **AI 経由しない deterministic** なので品質安定。
