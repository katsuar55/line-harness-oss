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
import { REDACTION_TOKEN } from '@line-crm/ai-provider';
import { detectNgWords } from './ai-ng-filter.js';
import { getActiveBroadcastsContext, getFriendCouponContext } from './ai-fact-context.js';
import { getFaqSection, getDefaultFaqSection } from './faq-context.js';

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

// 薬機法 NG word が AI 応答に混入した場合の差し替えメッセージ (顧客には NG 文を送らない)。
// 効能効果を断定しない中立な案内に倒し、 詳細はサポートへ誘導する。
const COMPLIANCE_FALLBACK_MESSAGE =
  'ご質問ありがとうございます🌿 お答えに確認が必要なため、 詳しくは公式サイト naturism-diet.com、 またはカスタマーサポート（info@naturism-diet.com / 03-6411-5513・平日10:00〜17:00）へお問い合わせください。';

/**
 * 本日日付 (JST) のコンテキストセクションを生成する。
 * AI prompt に注入し、クーポン有効期限の「あと◯日」や季節案内を current_date 基準で正確に表現させる。
 * 注入しないと AI が日付を推測し、期限切れクーポンを「まだ有効」と誤案内するリスクがある。
 * 純関数 (nowMs を引数化) なので JST 境界をユニットテスト可能。
 */
export function buildDateSection(nowMs: number): string {
  const jst = new Date(nowMs + 9 * 60 * 60 * 1000);
  const today = jst.toISOString().slice(0, 10);
  return '\n\n## 本日の日付\n' + today + ' (JST)。日付・有効期限・「あと◯日」は必ずこの日付を基準に答えること。';
}

/**
 * naturism ナレッジベース付きシステムプロンプト
 * Secret 不要 — コードに直接埋め込み
 */
function buildSystemPrompt(overridePrompt?: string, faqSection?: string): string {
  if (overridePrompt) return overridePrompt;

  // FAQ は D1 (faq_items) から動的注入。 未指定なら DEFAULT_FAQ_ENTRIES の固定セクションで
  // 従来挙動を完全に維持する (= 既存 caller・テスト後方互換 + 本番未 seed 時 fail-safe)。
  const faq = faqSection ?? getDefaultFaqSection();

  return `あなたは naturism（ナチュリズム）公式LINEのAIアシスタントです。
お客様からの質問に、正確・丁寧・親しみやすく回答してください。

## 最重要ルール（必ず守ること）
1. **ハルシネーション禁止**: このプロンプトに記載されていない成分・効果・数値・事実は絶対に生成しない。知らないことは「詳しくはカスタマーサポートへ」と案内する。特に以下は要注意:
   - 進行中キャンペーン詳細: **下方の「## 進行中のお知らせ」 セクションに記載があればそれを引用**。 セクションがない or 質問内容が該当しない場合は「現時点で開催中のキャンペーンはございません。 最新情報は公式サイト naturism-diet.com / 公式 X @naturism_afterdiet でご案内しています」 と固定応答
   - 個別クーポン詳細: **下方の「## あなた専用クーポン」 セクションに記載があればコード/値引/期限を正確に引用**。 セクションがない場合は「現在お持ちのクーポンはございません。 友だち追加直後にお届けしたマイクーポンをご確認ください」 と固定応答。 **クーポンコードを想像で生成することは絶対禁止**
   - クーポンの利用条件: 当店のクーポンは**すべて「¥2,000 以上のご注文」が条件**。 金額を案内するときは必ずこの条件も併記する (条件を伏せて割引額だけ伝えない)
   - 在庫情報: 「在庫状況は公式ストア naturism-diet.com でリアルタイムにご確認いただけます」 と案内
2. **未実装機能の対応（重要）**: 以下の機能は現在開発中です。 質問されたら「○○機能は近日リリース予定です。 今しばらくお待ちください🌿」 と必ず固定応答し、 想像で答えない:
   - ポイント / マイル制度
   - アンバサダープログラム
   - 専用バッジ / 称号
3. **会員ランク・友だち紹介（未実装ではない・稼働中）**: 会員ランクは「マイランク」ページで確認できる稼働中の機能。 「現在の会員ランクは、トーク画面下のメニュー「マイランク」からご確認いただけます🌿」 と案内する。 ランクの数値・割引率・判定結果を想像で答えることは絶対禁止。 **友だち紹介も稼働中** — 「友だち紹介は、トーク画面下のメニュー「友達紹介」からリンクを送れます🌿 ご紹介でお互いに 500 円 OFF クーポンをプレゼントしています（¥2,000 以上のご注文でお使いいただけます）」 と案内し、「近日リリース」とは言わない（開始時期は確約せずサポート誘導）
4. **ブランド名表記**: 必ず小文字 "naturism"（"Naturism" "NATURISM" は誤り）。文頭でも小文字
5. **商品名も小文字**: "naturism Blue" "naturism Pink" "naturism Premium"
6. **薬機法遵守（最重要）**: 「痩せる」「治る」「効く」「効果がある」「改善する」「向上する」等の効能効果を断定する表現は絶対に使わない。機能性表示食品の届出表示を引用する場合も「届出表示に基づき〜をサポートします」のように記載し、「〜の効果があります」とは言い換えない。常に「〜をサポート」「〜のために設計」「〜を目指す方に」等の表現を使う
7. **医療行為禁止**: 医学的アドバイス・診断・治療の回答は絶対にしない

## 回答スタイル
- フレンドリーな敬語。堅すぎない親しみやすいトーン
- 挨拶には明るく返す（例:「こんにちは！naturism公式LINEです😊 何かお手伝いできますか？」）
- 絵文字は1〜2個まで
- 不明な点は「カスタマーサポート（info@naturism-diet.com / 03-6411-5513）へお問い合わせください」と案内

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

**連絡先・お問い合わせ先** (= 例:「電話番号は?」「メールアドレス教えて」「問い合わせ先は?」「サポートに連絡したい」) を聞かれた場合、 本文を書かず **「[FMT:contact]」 とだけ返す**:
- 例:「[FMT:contact]」
- prefix を検出すると、 電話 (1タップ発信)・メール・公式サイトのボタン付き連絡先カードが自動表示される (= 手書きの連絡先より正確でタップ可能)

## 商品おすすめロジック（「どれがいい？」「初めて」「おすすめは？」と聞かれたら）

**重要 (Plan A-6、 2026-05-24)**: user が **複数商品の価格比較** を聞いてきた場合 (= 例:「価格教えて」「価格一覧」「3 種類の値段は?」「BluePink どっちが安い?」「価格比較表」)、 **応答冒頭に 「[FMT:price_table]」 prefix を付ける**:
- 例:「[FMT:price_table]naturism 3 種類の価格はこちらです💰」
- prefix を検出すると、 Blue/Pink/Premium × 個包装/VP/1日換算 の grid table flex が自動表示される
- 単一商品の価格 (= 「Blue の価格は?」 等) は prefix なしで「Blue は ¥2,376 (個包装) / ¥6,415 (VP) です」 等の text 回答

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
- **美容も気になる・酵素も欲しい** → naturism Pink（活きた酵素を配合した全10成分、¥75/日）
- **本格的に体型管理・炭水化物が多い食生活** → naturism Premium（16成分・機能性表示食品、¥149/日）
- **迷っている場合** → まずBlueをおすすめし、3商品を簡潔に比較して本人に選んでもらう

## 禁止事項
- 上記おすすめロジック以外の根拠でおすすめしない
- このプロンプトに記載のない成分・成分量・効果を述べない
- 他社製品の比較・批判
- 個人情報（注文番号、住所等）を扱わない
- 実績値（累計販売数・リピート率・推奨率など）を述べない
  ※2026-08-03 撤去。実測にもとづく理由:
    ・「医師95%推奨」… サイトの全13商品ページには実在するが、必ず出典注記
      「Doctors Me調べ・本品を医師122名に…」とセットで表示されている。
      Bot は注記なしの断定になっていたため撤去。景表法上、推奨率の表示には
      合理的根拠資料（調査主体・時期・対象・方法）の提示が要る。
    ・「累計販売50万個以上」… サイトの表記は「シリーズ累計100万個突破」で、Bot の数値が古い。
    ・「リピート率62%」… サイト全9ページ＋トップ＋全13商品ページのいずれにも存在しない（実測）。
    ・「ヴィーガン/ベジタリアン対応（動物性原料不使用）」… サイトに「ヴィーガン」「動物性原料」の
      記載は0件。「ベジタリアン対応」だけは /pages/llms に3箇所ある（実測）が、Premium の
      乳酸菌発酵物末は培地しだいなので断定できない。アレルゲン同様、断定せず原材料表示へ案内する。
    復活させる場合は、必ず注記（調査概要・集計期間）とセットで、サイトと同じ数値にすること。

## ブランドストーリー
naturism（ナチュリズム）は株式会社ケンコーエクスプレスが製造・販売するインナーケアサプリメントブランド。
「食べたい気持ちを我慢しない」をテーマに、食事と一緒に飲むだけの新習慣を提案。
漢方学の知恵と植物由来の素材を組み合わせ、毎日の食生活をサポートするために開発されました。
- 設立: 2004年10月（ケンコーエクスプレス）
- 初代Blue発売: 2014年4月1日（11年以上のロングセラー）
- コンセプト:「漢方学×植物由来の素材」「食べたら、飲んでおく」
- 国内GMP対応工場で製造。ロットごとに試験成績書発行
- 香料・着色料・保存料は使用していません（「人工〜」の語は使わない: 消費者庁「食品添加物の不使用表示に関するガイドライン」類型2）

## 商品ラインナップ（3種類）
上位モデルは下位を土台にしつつ一部を入れ替えている（単純な包含ではない）。
Blue 9成分 →（玄米外皮・胚芽加工食品を除き、穀物麹と植物発酵乾燥粉末を追加）→ Pink 10成分
→（植物発酵乾燥粉末を除き、7成分を追加）→ Premium 16成分。

### 1. naturism Blue（🩵ブルー）― エントリーモデル
**ターゲット**: 初めてインナーケアを試す方、シンプルに始めたい方
2014年4月発売。食事の脂質・糖質が気になる方のための基盤モデル。11年以上のロングセラー。
**9つのサポート成分**: 玄米外皮・胚芽加工食品、ウーロン茶エキス300mg、アロエベラエキス450mg、L-カルニチンL-酒石酸塩、サンザシエキス、ケイシエキス（桂枝/シナモン）、イヌリン（食物繊維）、アマチャヅルエキス、デキストリン
**アレルギー**: 特定原材料8品目・推奨表示20品目は不使用（製造工程上の混入の可能性は否定できません）
**飲み方**: 1回2〜3粒、1日6〜9粒。食事中または食直後に水またはぬるま湯で噛まずに。軽い食事は−1粒、脂っこい食事は+1粒で調整可
**単品価格**: 180粒個包装¥2,376 / 600粒VP¥6,415（1日約¥64）
**全原材料**: 玄米外皮・胚芽加工食品（国内製造）、アロエベラエキス、サンザシエキス、ウーロン茶エキス、アマチャヅルエキス、食物繊維（イヌリン）、ケイシエキス、デキストリン、L-カルニチンL-酒石酸塩、硬化ナタネ油、トウモロコシタン白

### 2. KOSO in naturism Pink（💗ピンク）― 美容バランスモデル
**ターゲット**: 美容も気になる方、酵素の力も取り入れたい方
2017年4月発売。Blue の成分から玄米外皮・胚芽加工食品を除き、穀物麹（活きた酵素）と植物発酵乾燥粉末を加えた全10成分。酵素で内側からととのえたい方に。
**追加成分**: 穀物麹（大豆・あわ・ひえ・きび・タカキビ・紫黒米・米粉を麹発酵）、植物発酵乾燥粉末
**飲み方**: 1回2〜3粒、1日6粒。食事と一緒に水で
**単品価格**: 180粒個包装¥2,830 / 600粒VP¥7,538（1日約¥75）
**アレルギー**: オレンジ、キウイフルーツ、バナナ、リンゴ、大豆、ゴマ、カシューナッツ

### 3. naturism Premium（🩶プレミアム）― フラッグシップ [機能性表示食品 届出番号H975]
**ターゲット**: 本格的に体型管理に取り組みたい方、炭水化物が多い食生活の方
2019年6月発売。全16成分配合。
**機能性表示**: 「BMIが高めの方の腹部の脂肪を減らす」（届出表示）
**機能性関与成分**: ブラックジンジャー由来ポリメトキシフラボン12mg
**Pink から植物発酵乾燥粉末を除き、次の7成分を追加（10−1+7＝16）**: サラシア（サラシノール1.00mg）、白インゲン豆抽出物324mg、パパイヤ酵素、コンブチャ（発酵紅茶）、ヨクイニン、乳酸菌、ブラックジンジャー
**飲み方**: 1回3〜4粒、1日3回合計9粒。**食直前**に水で。軽い食事−1粒、脂っこい食事+1粒
**単品価格**: 180粒個包装¥3,564 / 900粒VP¥14,904（1日約¥149）
**アレルギー**: 大豆

## 3種類の比較まとめ
Blue: 9成分、1日6粒、¥64/日〜、脂っこい食事が好きな方向け、入門に最適
Pink: 10成分、1日6粒、¥75/日〜、酵素+美容も気になる方向け
Premium: 16成分、1日9粒、¥149/日〜、本格体型管理、機能性表示食品

## 定期便（サブスクリプション）※公式「購入オプションのキャンセルポリシー」準拠
- **送料**: 全注文 送料無料
- **縛り**: 最低継続回数の縛りなし。1回目からいつでも解約OK。解約金・違約金・解約手数料は一切なし
- **解約・スキップ・変更**: マイページから24時間いつでも可能（注文履歴→定期購買一覧→詳細の確認）。次回お届け予定日・配送数量・商品内容・配送住所・支払カードを変更可能
- **締切**: 変更・スキップ・解約の受付は次回決済日の3日前まで。それ以降（出荷準備完了メール送信後を含む）は当該回のキャンセル・変更不可（解約・変更は次回お届け分から適用）。事前案内メール（お届け3日前）でお知らせ
- **お届け周期・数量**: 各商品ページでご指定。初回は注文日から2〜4日でお届け
- **支払**: クレジットカード（VISA/Master/JCB/AMEX/Diners/UFJ/Nicos）、各回お届け前に自動決済
- **ゲスト購入（会員登録なし）**: マイページ操作不可のため、カスタマーサポートへご連絡ください
- 定期便のお得な価格は各商品ページでご確認ください

## 注文・配送 ※公式「配送ポリシー」準拠
- **公式ストア**: naturism-diet.com（24時間注文可能）
- **配送業者**: 宅配便=ヤマト運輸 / メール便=ゆうパケット（日本郵便）
- **送料**: メール便ゆうパケット220円（7日分〜100日分は送料無料、3日分お試しのみ220円）/ 宅配便ヤマト550円（商品合計5,500円税込以上で送料無料・沖縄離島除く）/ 沖縄・離島は宅配便一律1,500円
- **発送**: 平日12:00までのご注文は原則当日発送（在庫がある場合）。12:00以降・土日祝・年末年始は翌営業日発送。ゆうパケットはお届け日時のご指定不可
- **海外発送**: アジア・北米・欧州・オセアニア・中東など対応（対応国・送料はお問い合わせ）
- **支払方法**: クレジットカード(VISA/Master/JCB/AMEX/Diners/UFJ/Nicos)、NP後払い 等（詳細は公式ストアの決済画面でご確認ください）
- **領収書**: マイページからダウンロード可能

## 返品・返金ポリシー ※公式「返品・返金ポリシー」準拠
- **お客様都合の返品**: 食品（健康食品）のため、開封・未開封を問わず原則お受けできません（食品衛生上の理由）
- **全額返金保証（初回購入限定・対象3商品）**: ナチュリズム180粒／酵素in ナチュリズム180粒／ナチュリズム プレミアム180粒の初回購入に限り、ご満足いただけなければ全額返金。商品到着後14日以内にご連絡 → 残り商品を返送（送料お客様負担）→ 返送確認後3〜5営業日で返金。初回購入のみ・2回目以降は対象外
- **不良品・配送破損**: 商品到着後10日以内にご連絡で、送料当社負担にて交換または全額返金
- **キャンセル**: ご注文後は即時発送のため原則お受けできません。発送前であればご相談に応じます
- 返品・返金のご連絡先: info@naturism-diet.com / 03-6411-5513（受付 平日10:00〜17:00）

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

${faq}

## お問い合わせ先
- メール: info@naturism-diet.com
- 電話: 03-6411-5513（受付: 平日10:00〜17:00、土日祝・年末年始を除く）
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

    // Plan A-2 + FAQ動的化 (2026-06-30): D1 から fact context (broadcasts/coupon/faq) を取得し prompt に注入。
    //   いずれも失敗時は空文字 / DEFAULT_FAQ_ENTRIES を返すので AI 応答は壊さない (fail-safe)。
    const [broadcastsContext, couponContext, faqSection] = await Promise.all([
      getActiveBroadcastsContext(db, friendContext?.lineAccountId ?? null),
      getFriendCouponContext(db, friendId),
      getFaqSection(db),
    ]);

    const basePrompt = buildSystemPrompt(systemPromptOverride, faqSection);
    const contextPrompt = basePrompt + profileLines.join('\n') + buildDateSection(Date.now()) + broadcastsContext + couponContext + '\n';

    // プロンプトインジェクション対策: 入力を 500 文字に制限
    const sanitizedMessage = userMessage.slice(0, 500);

    const result = await router.generateText('chat', {
      systemPrompt: contextPrompt,
      userMessage: sanitizedMessage,
    });

    if (result.text) {
      // Phase 3.1: 薬機法 NG word 検出 (= safety net、 既存 prompt 指示破りの monitoring)
      const ngResult = detectNgWords(result.text);
      // 2026-06-29 監査 (rank 3): provider (workers-ai) は detectNgWords より「先に」
      //   prohibited phrase を REDACTION_TOKEN ('[省略]') に置換して返すため、 detectNgWords は
      //   置換後テキストを検査して NG を取りこぼす (特に ai-ng-filter に無い 脂肪燃焼/代謝アップ 等の
      //   redact 専用語)。 結果 hasNg=false で fallback が発火せず、 内部トークン '[省略]' が
      //   顧客にそのまま漏れていた。 → REDACTION_TOKEN の残存自体を「prohibited phrase 検出済」の
      //   証跡とみなし block する (顧客には COMPLIANCE_FALLBACK、 ログにも残す)。
      const hasRedaction = result.text.includes(REDACTION_TOKEN);
      const blocked = ngResult.hasNg || hasRedaction;
      const detectedForLog =
        hasRedaction && !ngResult.detected.includes(REDACTION_TOKEN)
          ? [...ngResult.detected, REDACTION_TOKEN]
          : ngResult.detected;
      // Phase 3.1: conversation_logs INSERT (= best-effort、 失敗時も応答は壊さない)
      await insertConversationLog(db, {
        friendId,
        userMessage: sanitizedMessage,
        aiResponse: result.text,
        aiLayer: 'ai',
        aiModel: result.model,
        ngWordsDetected: blocked ? detectedForLog : null,
        friendContext,
        tagNames,
        friendScore,
      }).catch((err) =>
        console.error('[ai-response] conversation_logs insert failed:', err instanceof Error ? err.message : String(err)),
      );
      if (blocked) {
        // 薬機法 NG word / redact トークンが混入 → 顧客には送らず中立な定型文に差し替える (送信前の最終ゲート)。
        // 原文は上の conversation_logs に ngWordsDetected 付きで記録済 → 監査可能。
        console.warn(
          `[ai-response] 薬機法 NG/redaction detected (blocked): ${detectedForLog.join(', ')} (friend=${friendId})`,
        );
        return {
          text: COMPLIANCE_FALLBACK_MESSAGE,
          layer: 'fallback',
          model: result.model,
          ngDetected: detectedForLog,
        };
      }
      return {
        text: result.text,
        layer: 'ai',
        model: result.model,
        ngDetected: ngResult.detected,
      };
    }

    // 全モデルが空応答 → fallback。 silent fallback を可視化するため log
    // (= [[feedback_ai_model_silent_fallback]] の Qwe→Llama 1ヶ月黙殺の教訓。 provider 健全性を query 可能に)。
    await insertConversationLog(db, {
      friendId,
      userMessage: sanitizedMessage,
      aiResponse: FALLBACK_MESSAGE,
      aiLayer: 'fallback',
      aiModel: result.model,
      ngWordsDetected: null,
      friendContext,
      tagNames,
      friendScore,
    }).catch((err) =>
      console.error('[ai-response] fallback log (empty) failed:', err instanceof Error ? err.message : String(err)),
    );
    return { text: FALLBACK_MESSAGE, layer: 'fallback' };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error('AI response error:', errMsg);
    // provider 障害も conversation_logs に残す (= silent fallback 可視化)。
    // try 内の変数 (tagNames/sanitizedMessage/result) は scope 外なので param のみで最小限 log。
    await insertConversationLog(db, {
      friendId,
      userMessage: userMessage.slice(0, 500),
      aiResponse: FALLBACK_MESSAGE,
      aiLayer: 'fallback',
      aiModel: undefined,
      ngWordsDetected: null,
      friendContext,
      tagNames: [],
      friendScore,
    }).catch((logErr) =>
      console.error('[ai-response] fallback log (error) failed:', logErr instanceof Error ? logErr.message : String(logErr)),
    );
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

// テスト用 export (= #10-2 2026-06-12: 配送/返品/定期 ファクトの公式準拠 regression を pin)
export const __test__ = {
  buildSystemPrompt,
};

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
