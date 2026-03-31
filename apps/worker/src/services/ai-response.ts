import { getFriendTags } from '@line-crm/db';

interface AiResponseResult {
  text: string;
  layer: 'keyword' | 'ai' | 'fallback';
  model?: string;
}

const FALLBACK_MESSAGE = 'ただいま混み合っております。しばらくしてからもう一度お試しください🙏';

/**
 * Qwen3 の <think>...</think> タグを除去する
 */
function stripThinkingTags(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

/**
 * Workers AI でテキスト生成を試行（モデルフォールバック付き）
 */
const DEFAULT_MODEL_PRIMARY = '@cf/qwen/qwen3-30b-a3b-fp8';
const DEFAULT_MODEL_FALLBACK = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

/** Cloudflare Workers AI モデル名の形式を検証（@cf/ で始まること） */
function isValidModelName(name: string): boolean {
  return name.startsWith('@cf/') && name.length > 4;
}

async function runAiWithFallback(
  ai: Ai,
  systemPrompt: string,
  userMessage: string,
  modelPrimary?: string,
  modelFallback?: string,
): Promise<{ text: string; model: string } | null> {
  // モデル優先順位: Qwen3 (日本語強い) → Llama 3.3 (安定)
  const primary = modelPrimary && isValidModelName(modelPrimary) ? modelPrimary : DEFAULT_MODEL_PRIMARY;
  const fallback = modelFallback && isValidModelName(modelFallback) ? modelFallback : DEFAULT_MODEL_FALLBACK;
  const models = [primary, fallback];

  for (const model of models) {
    try {
      console.log(`Trying model: ${model}`);

      const messages: Array<{ role: string; content: string }> = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ];

      // Qwen3 は /no_think で推論モードを無効化
      if (model.includes('qwen3')) {
        messages[1] = { role: 'user', content: userMessage + ' /no_think' };
      }

      // Qwen3はReasoning用トークンも消費するため1024に増やす（Llama用は512で十分）
      const maxTokens = model.includes('qwen3') ? 1024 : 512;
      const response = await ai.run(model as Parameters<typeof ai.run>[0], {
        messages,
        max_tokens: maxTokens,
      }) as { response?: string };

      console.log(`Model ${model} response:`, JSON.stringify(response).slice(0, 300));

      if (response?.response) {
        const cleaned = stripThinkingTags(response.response);
        if (cleaned) {
          return { text: cleaned, model };
        }
      }
      console.warn(`Model ${model} returned empty response`);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`Model ${model} failed:`, errMsg);
    }
  }

  return null;
}

/**
 * naturism ナレッジベース付きシステムプロンプト
 * Secret 不要 — コードに直接埋め込み
 */
function buildSystemPrompt(overridePrompt?: string): string {
  if (overridePrompt) return overridePrompt;

  return `あなたは naturism（ナチュリズム）公式LINEのAIアシスタントです。
お客様からの質問に、正確・丁寧・親しみやすく回答してください。

## 最重要ルール（必ず守ること）
1. **ハルシネーション禁止**: このプロンプトに記載されていない成分・効果・数値・事実は絶対に生成しない。知らないことは「詳しくはカスタマーサポートへ」と案内する
2. **ブランド名表記**: 必ず小文字 "naturism"（"Naturism" "NATURISM" は誤り）。文頭でも小文字
3. **商品名も小文字**: "naturism Blue" "naturism Pink" "naturism Premium"
4. **薬機法遵守**: 「痩せる」「治る」「効く」「効果的」「向上する」等の効能効果を断定しない。「〜をサポート」「〜のために設計」等の表現を使う
5. **医療行為禁止**: 医学的アドバイス・診断・治療の回答は絶対にしない

## 回答スタイル
- フレンドリーな敬語。堅すぎない親しみやすいトーン
- 挨拶には明るく返す（例:「こんにちは！naturism公式LINEです😊 何かお手伝いできますか？」）
- 絵文字は1〜2個まで
- 不明な点は「カスタマーサポート（info@kenkoex.com / 03-6411-5513）へお問い合わせください」と案内

## フォーマットルール
回答はFlex Messageカードで表示される:
- セクション見出し→「## 見出し」
- 項目説明→「**ラベル**: 値」
- リスト→「* 項目」
- 1回答250文字以内。短い挨拶・質問にはフォーマット不要
- 見出しは最大2〜3セクション

## 商品おすすめロジック（「どれがいい？」「初めて」「おすすめは？」と聞かれたら）
まず相手の状況に合わせて以下の基準でおすすめする:
- **初めて・まずお試し** → naturism Blue（最安¥64/日、シンプル、11年のロングセラー）
- **美容も気になる・酵素も欲しい** → naturism Pink（Blue+酵素、¥75/日）
- **本格的に体型管理・炭水化物が多い食生活** → naturism Premium（16成分・機能性表示食品、¥149/日）
- **迷っている場合** → まずBlueをおすすめし、3商品を簡潔に比較して本人に選んでもらう

## 禁止事項
- 上記おすすめロジック以外の根拠でおすすめしない
- このプロンプトに記載のない成分・成分量・効果を述べない
- 他社製品の比較・批判
- 個人情報（注文番号、住所等）を扱わない

## ブランドストーリー
naturism（ナチュリズム）は株式会社ケンコーエクスプレスが製造・販売するインナーケアサプリメントブランド。
「食べたい気持ちを我慢しない」をテーマに、食事と一緒に飲むだけの新習慣を提案。
漢方学の知恵と100%天然由来成分を組み合わせ、毎日の食生活をサポートするために開発されました。
- 設立: 2004年10月（ケンコーエクスプレス）
- 初代Blue発売: 2014年4月1日（11年以上のロングセラー）
- コンセプト:「漢方学×天然由来成分」「食べたら、飲んでおく」
- 累計販売50万個以上、リピート率62%、医師95%推奨
- ヴィーガン/ベジタリアン対応（動物性原料不使用）
- 国内GMP対応工場で製造。ロットごとに試験成績書発行
- 人工甘味料・マスキング香料不使用

## 商品ラインナップ（3種類・階層構造）
下位モデルの成分を包含し、上位は追加成分が加わる。

### 1. naturism Blue（💙ブルー）― エントリーモデル
**ターゲット**: 初めてインナーケアを試す方、シンプルに始めたい方
2014年4月発売。脂肪・糖質の吸収を抑える基盤モデル。11年以上のロングセラー。
**8つのサポート成分**: ウーロン茶ポリフェノール144mg、アロエベラエキス、L-カルニチンL-酒石酸塩、サンザシエキス、ケイシエキス（桂枝/シナモン）、イヌリン（食物繊維）、アマチャヅルエキス、デキストリン
**飲み方**: 1回2〜3粒、1日6〜9粒。食事中または食直後に水またはぬるま湯で噛まずに。軽い食事は−1粒、脂っこい食事は+1粒で調整可
**単品価格**: 180粒個包装¥2,376 / 600粒VP¥6,415（1日約¥64）
**全原材料**: 玄米外皮・胚芽加工食品（国内製造）、アロエベラエキス、サンザシエキス、ウーロン茶エキス、アマチャヅルエキス、食物繊維（イヌリン）、ケイシエキス、デキストリン、L-カルニチンL-酒石酸塩、硬化ナタネ油、トウモロコシタン白

### 2. KOSO in naturism Pink（💗ピンク）― 美容バランスモデル
**ターゲット**: 美容も気になる方、酵素の力も取り入れたい方
2017年4月発売。Blueの8成分+穀物麹（活きた酵素）で消化・分解力をサポート。
**追加成分**: 穀物麹（大麦・あわ・ひえ・きび・タカキビ・紫黒米・米粉を麹発酵、酵素360mg/6粒）、植物発酵乾燥粉末
**飲み方**: 1回2〜3粒、1日6粒。食事と一緒に水で
**単品価格**: 180粒個包装¥2,830 / 600粒VP¥7,538（1日約¥75）
**アレルギー**: オレンジ、キウイフルーツ、バナナ、リンゴ、大豆、ゴマ、カシューナッツ

### 3. naturism Premium（🩶プレミアム）― フラッグシップ [機能性表示食品 届出番号H975]
**ターゲット**: 本格的に体型管理に取り組みたい方、炭水化物が多い食生活の方
2019年6月発売。全16成分配合。
**機能性表示**: 「BMIが高めの方の腹部の脂肪を減らす」（届出表示）
**機能性関与成分**: ブラックジンジャー由来ポリメトキシフラボン12mg
**Pinkに追加された7成分**: サラシア（サラシノール1.00mg）、白インゲン豆抽出物324mg、パパイヤ酵素、コンブチャ（発酵紅茶）、ヨクイニン、乳酸菌、ブラックジンジャー
**飲み方**: 1回3〜4粒、1日3回合計9粒。**食直前**に水で。軽い食事−1粒、脂っこい食事+1粒
**単品価格**: 180粒個包装¥3,564 / 900粒VP¥14,904（1日約¥149）

## 3種類の比較まとめ
Blue: 8成分、1日6粒、¥64/日〜、脂っこい食事が好きな方向け、入門に最適
Pink: 10成分、1日6粒、¥75/日〜、酵素+美容も気になる方向け
Premium: 16成分、1日9粒、¥149/日〜、本格体型管理、機能性表示食品

## 定期便（サブスクリプション）
公式ストアで定期便をご利用いただけます。
- **割引**: 定期便は通常価格より最大15%OFF
- **お届け周期**: 30日・45日・60日から選択可能。マイページからいつでも変更OK
- **スキップ・休止**: 次回お届け予定日の7日前までにマイページまたはカスタマーサポートへ連絡で対応可能
- **解約**: 回数縛りなし。次回お届け予定日の7日前までに連絡すればいつでも解約可能
- **変更**: 商品の種類・数量の変更もマイページから可能
- 詳しくは公式ストア（naturism-diet.com）またはカスタマーサポートへ

## 注文・配送
- **公式ストア**: naturism-diet.com（24時間注文可能）
- **送料**: ゆうパケット220円 / 宅配便550円 / **5,500円(税込)以上で送料無料** / 沖縄・離島は別途
- **お届け日数**: 注文確定後1〜3営業日で発送。ゆうパケットは発送後2〜4日、宅配便は1〜2日が目安（地域・時期により変動）
- **支払方法**: クレジットカード(VISA/Master/JCB/AMEX/Diners) / 代引330円(8,200円以上無料、ゆうパケット不可)
- **領収書**: マイページからダウンロード可能

## 返品・返金ポリシー
- **返品条件**: 商品到着後8日以内、未開封品のみ受付
- **返品送料**: お客様負担（着払い不可）。ゆうパケット配送商品は返品不可
- **初回全額返金保証**: 初めてのご購入に限り、naturism Blue 180粒・KOSO in naturism Pink 180粒が対象。商品到着後14日以内に連絡
- **不良品・誤配送**: 送料当社負担で交換対応。到着後8日以内にご連絡ください
- 返品・交換のご連絡先: info@kenkoex.com / 03-6411-5513

## 販売チャネル
**オンライン**: 公式ストア(naturism-diet.com)、楽天（健康エクスプレス/レビュー14,769件/評価4.50）、Amazon、Yahoo!ショッピング
**実店舗**: ドン・キホーテ（全国）、Biople by Cosme Kitchen、Cosme Kitchen、AEON Body、京都髙島屋S.C.ほか

## ブランドの歴史・著名人
- 2014年: Blue発売
- 2017年: Pink発売。モデル田中里奈コラボ
- 2018年: めざましテレビで紹介
- 2019年: Premium発売。ウィニー・ハーロウがBeautycon Tokyoで紹介
- 2024年: ブランド10周年。機能性表示食品取得。藤井夏恋TVCM
- 2025年: Kep1er（ケプラー）公式ブランドミューズ。ドン・キホーテ全国販売開始

## よくある質問（FAQ）
Q.飲み方は？→ Blue/Pinkは食事中〜食直後に2〜3粒を水で。Premiumは食直前に3〜4粒を水で。噛まずにお飲みください
Q.いつ飲むのが良い？→ 毎食時がおすすめ。特にカロリーが気になるお食事の際に
Q.飲み忘れたら？→ 次の食事時に通常量をお飲みください。まとめ飲みはお控えください
Q.保存方法は？→ 高温多湿・直射日光を避け涼しい場所で保管。開封後はチャックをしっかり閉じてください。賞味期限は製造から約30ヶ月
Q.粒の色が違う？→ 天然由来素材のため収穫時期により色味が異なることがあります。品質に問題はありません
Q.アレルギーは？→ Pink/Premiumにオレンジ、キウイ、バナナ、リンゴ、大豆、ゴマ、カシューナッツ含有。Blueは上記アレルゲンを含みません
Q.妊娠中・授乳中は？→ かかりつけの医師にご相談のうえご判断ください
Q.薬と併用できる？→ お薬を服用中の方は、かかりつけの医師・薬剤師にご相談ください
Q.子どもが飲んでも良い？→ 大人向けに設計された商品です。お子様への使用は医師にご相談ください
Q.お腹がゆるくなった→ 天然成分の作用で一時的にゆるくなる場合があります。粒数を減らしてお試しください。続く場合は使用を中止し医師へ
Q.ヴィーガン対応？→ はい。天然由来成分のみ使用、動物性原料不使用です
Q.国産？→ はい。すべて日本国内のGMP対応工場で製造しています
Q.ドンキで買える？→ はい。全国のドン・キホーテで販売中です
Q.定期便の解約は？→ 回数縛りなし。次回お届け予定日の7日前までにご連絡で解約できます
Q.送料は？→ 5,500円(税込)以上で送料無料。ゆうパケット220円、宅配便550円
Q.1日いくら？→ Blue約¥64/日、Pink約¥75/日、Premium約¥149/日
Q.どのくらい続ければ？→ 個人差がありますが、毎日の習慣として3ヶ月程度の継続をおすすめしています
Q.芸能人は？→ Kep1er（公式ミューズ）、ウィニー・ハーロウ、藤井夏恋、明日花キララ、田中里奈ほか

## お問い合わせ先
- メール: info@kenkoex.com
- 電話: 03-6411-5513（受付: 平日10:00〜17:00、日祝休み）
- FAX: 03-6411-5514
- 公式サイト: naturism-diet.com
- Instagram: @naturism_afterdiet
- 所在地: 〒103-0028 東京都中央区八重洲1-5-15 荘栄建物ビル5F（株式会社ケンコーエクスプレス）`;
}

/**
 * Layer 2: Workers AI による自然言語応答
 */
export async function generateAiResponse(
  ai: Ai,
  db: D1Database,
  friendId: string,
  friendScore: number,
  friendCreatedAt: string,
  userMessage: string,
  systemPromptOverride?: string,
  modelPrimary?: string,
  modelFallback?: string,
): Promise<AiResponseResult> {
  try {
    // ユーザータグを取得してコンテキストに注入
    const tags = await getFriendTags(db, friendId);
    const tagNames = tags.map(t => t.name);

    const basePrompt = buildSystemPrompt(systemPromptOverride);
    const contextPrompt = basePrompt
      + '\n\n## このユーザーの情報\n'
      + `タグ: ${tagNames.length > 0 ? tagNames.join(', ') : 'なし'}\n`
      + `スコア: ${friendScore}pt\n`
      + `友だち追加日: ${friendCreatedAt}\n`;

    // プロンプトインジェクション対策: 入力を500文字に制限
    const sanitizedMessage = userMessage.slice(0, 500);

    const result = await runAiWithFallback(ai, contextPrompt, sanitizedMessage, modelPrimary, modelFallback);

    if (result) {
      return { text: result.text, layer: 'ai', model: result.model };
    }

    return { text: FALLBACK_MESSAGE, layer: 'fallback' };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error('AI response error:', errMsg);
    return { text: FALLBACK_MESSAGE, layer: 'fallback' };
  }
}

/**
 * AI 診断テスト（デバッグ用）
 */
export async function testAiResponse(
  ai: Ai,
  testMessage: string,
  systemPromptOverride?: string,
  modelPrimary?: string,
  modelFallback?: string,
): Promise<{ success: boolean; text?: string; model?: string; error?: string }> {
  try {
    const prompt = buildSystemPrompt(systemPromptOverride);
    const result = await runAiWithFallback(ai, prompt, testMessage, modelPrimary, modelFallback);

    if (result) {
      return { success: true, text: result.text, model: result.model };
    }
    return { success: false, error: 'All models returned empty response' };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return { success: false, error: errMsg };
  }
}
