/**
 * AI Response Service — Phase 5β-prep adoption (2026-05-16)
 *
 * Workers AI 直叩き → @line-crm/ai-provider AIRouter 経由に refactor。
 *   - task='chat' → workers-ai 優先 + claude fallback (router 内部で自動)
 *   - <think> tag stripping / モデル fallback / PROHIBITED_PHRASES redaction
 *     はすべて WorkersAIProvider 内部で実施
 *   - 旧 runAiWithFallback / stripThinkingTags / isValidModelName は削除
 *     (router が同等以上の振る舞いを提供)
 */

import { getFriendTags } from '@line-crm/db';
import type { AIRouter } from '@line-crm/ai-provider';
import { detectNgWords } from './ai-ng-filter.js';
import { getActiveBroadcastsContext, getFriendCouponContext } from './ai-fact-context.js';

interface AiResponseResult {
  text: string;
  layer: 'keyword' | 'ai' | 'fallback';
  model?: string;
  /** Phase 3.1: 検出された薬機法 NG word (= 検出なしなら空配列) */
  ngDetected?: string[];
}

/**
 * Phase 3.1 ULTRATHINK (2026-05-24): generateAiResponse に渡せる friend profile context
 * 既存 caller との後方互換のため optional、 未指定なら「未取得」 と prompt に出る。
 */
export interface AiResponseFriendContext {
  birthMonth?: number | null;
  ageGroup?: string | null;
  displayName?: string | null;
  /** Plan A-2 (2026-05-24): broadcast filter 用、 未指定なら全 active broadcasts を context 注入 */
  lineAccountId?: string | null;
}

const FALLBACK_MESSAGE = 'ただいま混み合っております。しばらくしてからもう一度お試しください🙏';

/**
 * naturism ナレッジベース付きシステムプロンプト
 * Secret 不要 — コードに直接埋め込み
 */
function buildSystemPrompt(overridePrompt?: string): string {
  if (overridePrompt) return overridePrompt;

  return `あなたは naturism（ナチュリズム）公式LINEのAIアシスタントです。
お客様からの質問に、正確・丁寧・親しみやすく回答してください。

## 最重要ルール（必ず守ること）
1. **ハルシネーション禁止**: このプロンプトに記載されていない成分・効果・数値・事実は絶対に生成しない。知らないことは「詳しくはカスタマーサポートへ」と案内する。特に以下は要注意:
   - 進行中キャンペーン詳細: **下方の「## 進行中のお知らせ」 セクションに記載があればそれを引用**。 セクションがない or 質問内容が該当しない場合は「現時点で開催中のキャンペーンはございません。 最新情報は公式サイト naturism-diet.com / 公式 X @naturism_afterdiet でご案内しています」 と固定応答
   - 個別クーポン詳細: **下方の「## あなた専用クーポン」 セクションに記載があればコード/値引/期限を正確に引用**。 セクションがない場合は「現在お持ちのクーポンはございません。 友だち追加直後にお届けしたマイクーポンをご確認ください」 と固定応答。 **クーポンコードを想像で生成することは絶対禁止**
   - 在庫情報: 「在庫状況は公式ストア naturism-diet.com でリアルタイムにご確認いただけます」 と案内
2. **未実装機能の対応（重要）**: 以下の機能は現在開発中です。 質問されたら「○○機能は近日リリース予定です。 今しばらくお待ちください🌿」 と必ず固定応答し、 想像で答えない:
   - 会員ランク / ステータス（Silver/Gold/Platinum 等）
   - ポイント / マイル制度
   - 紹介プログラム（友だち紹介で割引等の詳細）
   - アンバサダープログラム
   - 専用バッジ / 称号
3. **ブランド名表記**: 必ず小文字 "naturism"（"Naturism" "NATURISM" は誤り）。文頭でも小文字
4. **商品名も小文字**: "naturism Blue" "naturism Pink" "naturism Premium"
5. **薬機法遵守（最重要）**: 「痩せる」「治る」「効く」「効果がある」「改善する」「向上する」等の効能効果を断定する表現は絶対に使わない。機能性表示食品の届出表示を引用する場合も「届出表示に基づき〜をサポートします」のように記載し、「〜の効果があります」とは言い換えない。常に「〜をサポート」「〜のために設計」「〜を目指す方に」等の表現を使う
6. **医療行為禁止**: 医学的アドバイス・診断・治療の回答は絶対にしない

## 回答スタイル
- フレンドリーな敬語。堅すぎない親しみやすいトーン
- 挨拶には明るく返す（例:「こんにちは！naturism公式LINEです😊 何かお手伝いできますか？」）
- 絵文字は1〜2個まで
- 不明な点は「カスタマーサポート（info@kenkoex.com / 03-6411-5513）へお問い合わせください」と案内

## 出力形式（context-aware、 Plan A-4）
回答は内容に応じて自動で text or flex カードに変換される。 **以下のルールで自己判断して prefix を付ける**:

- **短い挨拶・URL のみの応答** → 応答冒頭に 「[FMT:text]」 を付ける（= LINE で plain text 表示、 URL は auto-link）
  - 例:「[FMT:text]こんにちは😊 何かお手伝いできますか?」
  - 例:「[FMT:text]公式ストアはこちらです: https://naturism-diet.com」
- **詳細回答（比較・成分・複数項目）** → prefix なしで markdown 構造を使ってカード化
  - セクション見出し→「## 見出し」
  - 項目説明→「**ラベル**: 値」
  - リスト→「* 項目」
- 1回答250文字以内。 見出しは最大2〜3セクション

判定基準:
- 50 文字以下の単純応答 → 「[FMT:text]」
- URL を含む 200 文字以下 → 「[FMT:text]」
- 「比較」「成分」「価格」 等で複数項目を返す → カード化 (= prefix なし)
- 1 質問 1 回答が basic、 長くしない

## 商品おすすめロジック（「どれがいい？」「初めて」「おすすめは？」と聞かれたら）

**重要 (Plan A-3、 2026-05-24)**: user が **本人にあったおすすめ商品** を聞いてきた場合 (= 例:「私におすすめは?」「私に合うのはどれ?」「私はどれ買ったらいい?」「初めてでどれを選べばいい?」)、 想像で即答せず **応答冒頭に 「[FMT:quiz_invite]」 prefix を付けて 30 秒診断に誘導する**:
- 例:「[FMT:quiz_invite]あなたに合う商品を診断しますね💚」
- 例:「[FMT:quiz_invite]30 秒の診断で最適な商品をご提案します🌿」

prefix が検出されると、 user に「診断スタート ▶」 button 付きの flex が表示され、 5 質問 (= 食生活 / 目標 / 美容 / アレルギー / 経験) で精度高くおすすめできる。

ただし以下の場合は **prefix 不要、 普通の回答**:
- 「3 種類の違いは?」 等の **比較情報** 質問 → markdown 構造で flex
- 「どれが一番安い?」 等の **客観事実** 質問 → 「Blue が ¥64/日 で最安です」 等の即答 (= [FMT:text] OK)
- 「Blue の成分は?」 等の **個別商品情報** 質問 → 詳細回答

== fallback (= prefix 使わない時の基準) ==:
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

### 1. naturism Blue（🩵ブルー）― エントリーモデル
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
 * Layer 2: AIRouter による自然言語応答
 */
export async function generateAiResponse(
  router: AIRouter,
  db: D1Database,
  friendId: string,
  friendScore: number,
  friendCreatedAt: string,
  userMessage: string,
  systemPromptOverride?: string,
  friendContext?: AiResponseFriendContext,
): Promise<AiResponseResult> {
  try {
    const tags = await getFriendTags(db, friendId);
    const tagNames = tags.map((t) => t.name);

    const basePrompt = buildSystemPrompt(systemPromptOverride);
    // Phase 3.1: friend profile context を AI に注入 (= birth_month / age_group で個別化)
    const profileLines: string[] = [
      '\n\n## このユーザーの情報',
      `タグ: ${tagNames.length > 0 ? tagNames.join(', ') : 'なし'}`,
      `スコア: ${friendScore}pt`,
      `友だち追加日: ${friendCreatedAt}`,
    ];
    if (friendContext?.displayName) profileLines.push(`表示名: ${friendContext.displayName}`);
    if (friendContext?.birthMonth) profileLines.push(`誕生月: ${friendContext.birthMonth}月`);
    if (friendContext?.ageGroup) profileLines.push(`年代: ${friendContext.ageGroup}`);

    // Plan A-2 (2026-05-24): D1 から fact context を取得して prompt に注入 (= ハルシネーション防止)
    //   失敗しても空文字を返すので AI 応答は壊さない (fail-safe)
    const [broadcastsContext, couponContext] = await Promise.all([
      getActiveBroadcastsContext(db, friendContext?.lineAccountId ?? null),
      getFriendCouponContext(db, friendId),
    ]);

    const contextPrompt = basePrompt + profileLines.join('\n') + broadcastsContext + couponContext + '\n';

    // プロンプトインジェクション対策: 入力を 500 文字に制限
    const sanitizedMessage = userMessage.slice(0, 500);

    const result = await router.generateText('chat', {
      systemPrompt: contextPrompt,
      userMessage: sanitizedMessage,
    });

    if (result.text) {
      // Phase 3.1: 薬機法 NG word 検出 (= safety net、 既存 prompt 指示破りの monitoring)
      const ngResult = detectNgWords(result.text);
      // Phase 3.1: conversation_logs INSERT (= best-effort、 失敗時も応答は壊さない)
      await insertConversationLog(db, {
        friendId,
        userMessage: sanitizedMessage,
        aiResponse: result.text,
        aiLayer: 'ai',
        aiModel: result.model,
        ngWordsDetected: ngResult.hasNg ? ngResult.detected : null,
        friendContext,
        tagNames,
        friendScore,
      }).catch((err) =>
        console.error('[ai-response] conversation_logs insert failed:', err instanceof Error ? err.message : String(err)),
      );
      if (ngResult.hasNg) {
        console.warn(
          `[ai-response] 薬機法 NG word detected: ${ngResult.detected.join(', ')} (friend=${friendId})`,
        );
      }
      return {
        text: result.text,
        layer: 'ai',
        model: result.model,
        ngDetected: ngResult.detected,
      };
    }

    return { text: FALLBACK_MESSAGE, layer: 'fallback' };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error('AI response error:', errMsg);
    return { text: FALLBACK_MESSAGE, layer: 'fallback' };
  }
}

/**
 * Phase 3.1 ULTRATHINK: conversation_logs INSERT (best-effort、 失敗時 caller 通知のみ)
 * 後の fine-tune data / admin での質問傾向分析 / NG 検知 trace 元として保存。
 */
async function insertConversationLog(
  db: D1Database,
  input: {
    friendId: string;
    userMessage: string;
    aiResponse: string;
    aiLayer: AiResponseResult['layer'];
    aiModel?: string;
    ngWordsDetected: string[] | null;
    friendContext?: AiResponseFriendContext;
    tagNames: string[];
    friendScore: number;
  },
): Promise<void> {
  const id = crypto.randomUUID();
  const friendContextJson = JSON.stringify({
    birthMonth: input.friendContext?.birthMonth ?? null,
    ageGroup: input.friendContext?.ageGroup ?? null,
    displayName: input.friendContext?.displayName ?? null,
    tags: input.tagNames,
    score: input.friendScore,
  });
  await db
    .prepare(
      `INSERT INTO conversation_logs
       (id, friend_id, user_message, ai_response, ai_layer, ai_model, ng_words_detected, friend_context)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.friendId,
      input.userMessage,
      input.aiResponse.slice(0, 4000), // 念のため上限 (= flex JSON で 4KB 程度)
      input.aiLayer,
      input.aiModel ?? null,
      input.ngWordsDetected ? JSON.stringify(input.ngWordsDetected) : null,
      friendContextJson,
    )
    .run();
}

/**
 * AI 診断テスト（デバッグ用）
 */
export async function testAiResponse(
  router: AIRouter,
  testMessage: string,
  systemPromptOverride?: string,
): Promise<{ success: boolean; text?: string; model?: string; error?: string }> {
  try {
    const prompt = buildSystemPrompt(systemPromptOverride);
    const result = await router.generateText('chat', {
      systemPrompt: prompt,
      userMessage: testMessage,
    });

    if (result.text) {
      return { success: true, text: result.text, model: result.model };
    }
    return { success: false, error: 'All models returned empty response' };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return { success: false, error: errMsg };
  }
}
