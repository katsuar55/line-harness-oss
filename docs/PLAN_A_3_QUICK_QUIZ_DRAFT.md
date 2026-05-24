# Plan A-3: LINE chat 内 5 質問 quick diagnose 設計 (叩き台、 2026-05-24)

## 背景

5/24 リハーサルで Katsu が「私におすすめは?」 と AI に質問 → AI が見当違い回答。 原因: 既存 system prompt の「商品おすすめロジック」 (= ai-response.ts L67-72) は「初めて = Blue、 美容 = Pink、 体型管理 = Premium」 のみで、 user の **状況を聞かずに** 即答する設計。

user 要求: 「5 つの質問を順番に postback chain で出して、 回答に基づいて推奨商品を返す quick diagnose」 (= 既存 LIFF quiz の chat 版簡略)。

## 既存 quiz-engine.ts (= 8 質問 LIFF 版)

- file: `apps/worker/src/services/quiz-engine.ts`
- 用途: LIFF (= 友だちが web 画面で answer する) 経由のみ (= `liff-portal.ts:966-967`)
- 質問数: 8 (= q1-q8)
- scoring: 各回答が { blue, pink, premium } の point を加算、 最大 score の product を推奨
- excluded ロジック: アレルギー回答で Pink/Premium を完全除外

→ chat 版 (= Plan A-3) は **別 service として新規実装**、 quiz-engine.ts は LIFF 専用維持。

## 提案: 新規 service `apps/worker/src/services/quick-quiz.ts`

### 質問内容 (= user 協議要、 叩き台)

| # | 質問 | 選択肢 (= postback button、 各 3-4 個) |
|---|---|---|
| Q1 | 普段の食事の傾向は? | A: 揚げ物・脂っこい料理が好き / B: ご飯・パン・麺類が多い / C: バランスを意識 / D: 外食やコンビニ中心 |
| Q2 | 体型管理の目標は? | A: 体重を落としたい / B: 体型を維持したい / C: 健康のため / D: 美容のため |
| Q3 | 美容で気になることは? | A: 肌のハリ・ツヤ / B: 消化・胃もたれ / C: 全体ケア / D: 特になし |
| Q4 | アレルギーで気になるものは? | A: オレンジ/キウイ/バナナ/大豆等あり / B: 特にない |
| Q5 | naturism を試すのは? | A: 初めて / B: 飲んだことある / C: 今飲んでいて別種類検討中 |

### scoring rule (= 叩き台、 user 協議要)

| 質問 | 回答 | Blue | Pink | Premium |
|---|---|---|---|---|
| Q1 | A 揚げ物 | +3 | 0 | 0 |
| Q1 | B 炭水化物 | 0 | 0 | +3 |
| Q1 | C バランス | 0 | +2 | 0 |
| Q1 | D 外食 | 0 | +1 | +2 |
| Q2 | A 体重落とす | 0 | 0 | +3 |
| Q2 | B 体型維持 | +2 | +1 | 0 |
| Q2 | C 健康 | +2 | +1 | 0 |
| Q2 | D 美容 | 0 | +3 | 0 |
| Q3 | A 肌ハリ・ツヤ | 0 | +3 | 0 |
| Q3 | B 消化・胃もたれ | 0 | +3 | 0 |
| Q3 | C 全体ケア | 0 | 0 | +2 |
| Q3 | D 特になし | +2 | 0 | 0 |
| Q4 | A アレルギーあり | (除外: Pink/Premium、 Blue 強制) | | |
| Q4 | B 特になし | 0 | 0 | 0 |
| Q5 | A 初めて | +3 | 0 | 0 |
| Q5 | B 飲んだことある | 0 | +1 | +1 |
| Q5 | C 検討中 | 0 | 0 | +2 |

**tie-break**: 同点なら Blue (= 「迷ったら Blue」 既存 rule)

### postback chain 仕組み (= welcome-postback.ts と同じ pattern)

```
[AI 応答 (= 「おすすめ」 intent 検出)]
  → flex「30 秒で診断スタート」 (= 「診断スタート ▶」 postback button)
    postback data: `quick_quiz:start`
  → reply flex「Q1: 食事の傾向は?」 (= 4 button)
    postback data: `quick_quiz:q1:a` / `:q1:b` / `:q1:c` / `:q1:d`
  → reply flex「Q2: 体型管理の目標は?」 (= 4 button)
    postback data: `quick_quiz:q2:a` / ...
  → ...
  → Q5 回答後 → reply flex「あなたへのおすすめは {Blue/Pink/Premium}」 (= scoring 結果、 公式ストア button)
```

**全 reply API** (= push 0 通課金、 Plan B/A-2 と同じ cost zero 設計)

state 管理: postback data に **answer 履歴を全部入れる** (= `quick_quiz:q1:a:q2:b:q3:c:q4:b:q5:a`)。 sessionless で stateless。

### AI 応答からの誘導 (= ai-response.ts 修正)

「おすすめ」 「私におすすめ」 「どれがいい」 「どれを選べば」 等の intent を keyword 検出 → AI 呼ばずに **quick_quiz 誘導 flex を直接 reply**。

実装場所: webhook.ts text message handler の Layer 1.5 (= auto_replies と AI の間)。

または、 system prompt rule に「『おすすめ』 等の質問は『下記の診断スタート ▶ をタップしてください』 と response + `[FMT:flex_intent:quick_quiz_invite]` prefix」 → buildAiMessage が intent prefix を見て quick_quiz flex を返す。

→ どちらの実装が良いか user 協議要。

## 実装 step (= 1 PR 想定)

1. `quick-quiz.ts` service (= 5 質問 config + scoring + flex builder + postback parser)
2. webhook.ts に postback dispatch 追加 (= `quick_quiz:` prefix → handleQuickQuiz)
3. AI 応答誘導 (= keyword 検出 or intent prefix、 user 協議要)
4. test (= scoring 全 pattern + postback chain + AI 誘導)
5. preflight + worker deploy

## 工数見積もり

- 質問・scoring 設計協議: 30-60 min (= user との議論)
- 実装: 4-6 hours
- test: 1-2 hours
- 合計: 1-2 日 (= 1 PR で MVP 完成)

## user 協議事項

1. 上記 5 質問内容 (= 叩き台) は naturism product 知見から妥当か?
2. scoring rule は妥当か? (= 例: Q3 美容で「肌ハリ」 = Pink +3 は強すぎ?)
3. AI 誘導方法 = keyword 検出 (= シンプル) or intent prefix (= AI 判断、 賢い)?
4. 実装着手 OK か?

## 関連

- 既存: `apps/worker/src/services/quiz-engine.ts` (= LIFF 8 質問版)
- 既存: `apps/worker/src/services/welcome-postback.ts` (= postback chain pattern reference)
- 既存: `apps/worker/src/services/ai-response.ts` (= system prompt 補強場所)
- 5/24 リハーサル発覚 11 件のうち、 #4 が本件
