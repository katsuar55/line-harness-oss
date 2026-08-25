/**
 * Intent Router (= 5/26 ULTRATHINK fix、 deterministic keyword routing、 Plan A+ patch)
 *
 * 役割:
 *   AI に prefix を任せると Llama/Qwen が rule を無視するため、 重要 intent は
 *   webhook level で keyword 検出し、 deterministic に固定応答を返す safety net。
 *
 *   - Plan A-3 (quick_quiz invite) AI prefix → keyword routing に格上げ
 *   - Plan A-6 (price_table) AI prefix → keyword routing に格上げ
 *   - Plan A-1 (ポイント等 未実装機能) AI 応答禁止 → keyword routing で即固定応答
 *   - #10-1 (2026-06-12): 会員ランクは未実装扱いをやめ my_rank intent でマイランク LIFF へ誘導
 *
 * 優先順位 (= webhook.ts text path):
 *   1. auto_replies keyword match (= 既存)
 *   2. **intent-router.detectIntent (= 本 service)** ← 新規 Layer 1.5
 *   3. AI 応答 (= Layer 2、 上記すべて miss なら)
 *
 * keyword 設計:
 *   - 部分一致 (= includes) で対応、 case sensitive
 *   - キーワード一覧は各 intent ごとに array で集約、 維持しやすく
 *   - 「価格」 等の 1 char 短いものは auto_replies match が先に走るため、
 *     ここでは「価格教えて」 「価格比較」 等の **長い phrase** のみ catch
 *
 * fail-safe:
 *   - detectIntent は null 返却で fallthrough (= AI path に流れる)
 *   - intent matched でも reply 失敗時は caller が catch + log
 */

import type { Message } from '@line-crm/line-sdk';
import { buildPriceTableMessage } from './ai-message-builder.js';
import { buildQuickQuizInviteMessage } from './quick-quiz.js';
import { buildProductCompareFlex, buildMyCouponFlex } from './welcome-postback.js';
import { getFriendActiveCoupon } from './ai-fact-context.js';
import { buildSubscriptionMenuMessages, MYPAGE_URL } from './subscription-concierge.js';

export type Intent =
  | { readonly type: 'quiz_invite'; readonly reason: string }
  | { readonly type: 'price_table'; readonly reason: string }
  | { readonly type: 'product_compare'; readonly reason: string }
  | { readonly type: 'my_coupon'; readonly reason: string }
  | { readonly type: 'my_rank'; readonly reason: string }
  | { readonly type: 'referral'; readonly reason: string }
  | { readonly type: 'subscription'; readonly reason: string }
  | { readonly type: 'feature_unavailable'; readonly feature: string; readonly reason: string };

export interface IntentRouteResult {
  readonly intent: Intent;
  readonly messages: ReadonlyArray<Message>;
  readonly matchedKeyword: string;
}

/** async build 用の context (= my_coupon の D1 SELECT / my_rank の LIFF URL 等で利用) */
export interface IntentBuildContext {
  readonly db: D1Database;
  readonly friendId: string;
  /** マイランク LIFF への誘導 URL base (= webhook caller が env.LIFF_URL を渡す。 未設定なら rich menu 誘導に fallback) */
  readonly liffUrl?: string;
  /** §10-5: 受理レイヤー有効時、契約カードを受理ボタン付きで返す (入口による見た目の分裂を作らない) */
  readonly subIntentEnabled?: boolean;
  /**
   * 紹介報酬 gate (REFERRAL_REWARD_ENABLED)。**紹介した側**への ¥500 は gate off の間 1 円も出ない
   * (referral-reward.ts:372 で完全 no-op) ため、off のときに「お互いに」と書くと景表法の有利誤認になる。
   * LIFF ポータルの紹介ヒーロー / 招待文と**同じ規約**で分岐する (liff-pages.ts の REFERRAL_REWARD_ON)。
   */
  readonly referralRewardOn?: boolean;
}

interface PatternRule {
  readonly keywords: ReadonlyArray<string>;
  readonly intent: Intent;
  /** これらの語を含むメッセージではこのパターンを発火させない (誤爆ガード、後続パターンへ継続) */
  readonly negativeKeywords?: ReadonlyArray<string>;
}

// 上から順に check、 最初に match した keyword で確定
const PATTERNS: ReadonlyArray<PatternRule> = [
  // ========= quick_quiz invite (= 5 質問 chain 誘導) =========
  {
    keywords: [
      '私におすすめ', '私にぴったり', '私に合う', '私にあう', '私はどれ',
      'おすすめは何', 'おすすめは?', 'おすすめは？', 'おすすめ教えて', 'おすすめを教えて',
      'どれがいい', 'どれがおすすめ', 'どれを買え', 'どれを選', 'どれが合う', 'どれにすべき',
      '初めてでどれ', '何を選べ', '何を買え',
    ],
    intent: { type: 'quiz_invite', reason: 'product recommendation intent' },
  },

  // ========= price_table (= 3 商品 grid flex) =========
  // 5/26 user feedback: 「価格」 単独でも grid 形式で返したい → 「価格」 を keyword に追加。
  // auto_replies の旧「価格」 text row は deactivate 済 (= scripts/intent-router-bootstrap.sql)。
  //
  // **重要: 長い phrase を先頭に、 短い keyword を末尾に置く** (= matchedKeyword の specificity 確保)。
  {
    keywords: [
      // 明示的 phrase (= 長い、 specific) を先頭に
      '価格教えて', '価格を教えて', '価格一覧', '価格比較', '価格表',
      '料金教えて', '料金を教えて', '値段教えて', '値段を教えて', '値段一覧',
      'いくらする', 'いくらします', 'いくらですか', '3 種類の価格', '3種類の価格',
      '3 つの価格', '3つの価格', 'すべての価格', '全部の価格',
      'どれが一番安い', 'どれが安い', '一番安いのは',
      // 単独 keyword (= 短い、 fallback) を末尾に
      '価格', '値段', '料金',
    ],
    intent: { type: 'price_table', reason: 'price comparison intent' },
  },

  // ========= product_compare (= 3 商品比較 flex、 PR 2: 「違い」 Step 7 fix) =========
  {
    keywords: [
      '3 種類の違い', '3種類の違い', '3 種類比較', '3種類比較',
      'Blue Pink Premium', 'BluePinkPremium', 'BluePremium',
      '商品比較', '比較教えて', '比較を教えて',
      // 短形 fallback
      '違い教えて', '違い', '比較',
    ],
    intent: { type: 'product_compare', reason: 'product comparison intent' },
  },

  // ========= my_coupon (= friend coupon flex + code text、 PR 2: Step 3 UX) =========
  {
    keywords: [
      '私のクーポン', 'マイクーポン', 'クーポンコード', 'クーポン教えて', 'クーポンある',
      '使えるクーポン', 'クーポンは', 'coupon',
    ],
    intent: { type: 'my_coupon', reason: 'user coupon query' },
  },

  // ========= my_rank (= マイランク LIFF 誘導、 #10-1 2026-06-12) =========
  // 旧: feature_unavailable「近日リリース予定」 → マイランク LIFF (/liff/my-rank) は稼働中のため誤回答だった。
  // rich-menus.ts の「マイランク」ボタンと同じ `${liffUrl}#rank` 規約で誘導 (async build で liffUrl 注入)。
  {
    keywords: ['会員ランク', 'マイランク', 'ランクは何', 'ランクなに', '私のランク', '私のステータス'],
    intent: { type: 'my_rank', reason: 'my rank LIFF is live' },
  },

  // ========= feature_unavailable (= 未実装機能、 固定応答) =========
  // ポイント / マイル
  {
    keywords: ['ポイント残高', 'ポイント教えて', 'マイル教えて', '私のポイント', '私のマイル', 'ポイントいくつ', 'マイル何個'],
    intent: { type: 'feature_unavailable', feature: 'ポイント / マイル', reason: 'unimplemented' },
  },
  // ========= referral (= 友だち紹介 LIFF 誘導、 2026-06-29 監査 rank 8) =========
  // 旧: feature_unavailable「近日リリース予定」 → 友だち紹介はリッチメニュー +
  //   LIFF (/liff/portal#referral) で稼働中のため誤回答だった。my_rank と同じ live-LIFF 誘導に格上げ。
  //   (割引「500円OFF」自体の開始時期は別途案内。 共有/リンク/ランキング機構は live)
  {
    keywords: ['紹介プログラム', '紹介制度', 'リファラル', '友だち紹介', '友達紹介', '紹介して', '紹介の', '紹介コード'],
    intent: { type: 'referral', reason: 'referral LIFF is live' },
  },
  // ========= subscription (= サブスク・コンシェルジュ、 WI-1 2026-07-14) =========
  // リッチメニュー「サブスク」postback と同じカードへ。gate (SUBSCRIPTION_MENU_ENABLED) OFF の間は
  // webhook 側が detectIntent の disabledIntents でこのパターンを skip する (= 後続パターンへ
  // fall-through、gate OFF で挙動が厳密にゼロ変更)。
  // **bare の「定期」「解約」「スキップ」は入れない** (採点R1 HIGH): includes 部分一致のため
  // 「定期的に飲む」「メルマガの解約」「朝食をスキップ」等の無関係な相談を乗っ取り、
  // matched=true で AI 応答まで封じてしまう。複合形 + 意図形のみ列挙する。
  // (Layer 1 auto_replies が先に走るため、既存 FAQ「定期解約」等の応答は温存される)
  {
    keywords: [
      'サブスクリプション', 'サブスクの解約', 'サブスク解約', 'サブスク',
      '定期便の解約', '定期の解約', '定期解約', '定期便の変更', '定期便',
      '定期購入', '定期購買', '定期コース', '定期をやめ', '定期便をやめ',
      'スキップしたい', 'スキップの方法', 'スキップする方法', 'スキップできます',
      '解約したい', '解約方法', '解約手続き', '解約の仕方', '解約したく',
    ],
    // 「メルマガの解約方法」等、定期便以外の解約相談を乗っ取らない (採点R2)
    negativeKeywords: ['メルマガ', 'メールマガジン', 'ニュースレター', 'メール配信'],
    intent: { type: 'subscription', reason: 'subscription concierge is live' },
  },
  // アンバサダー
  {
    keywords: ['アンバサダー'],
    intent: { type: 'feature_unavailable', feature: 'アンバサダープログラム', reason: 'unimplemented' },
  },
  // バッジ / 称号
  {
    keywords: ['専用バッジ', 'バッジ教えて', '称号', '私のバッジ'],
    intent: { type: 'feature_unavailable', feature: '専用バッジ / 称号', reason: 'unimplemented' },
  },
];

/**
 * text を intent に分類。 match なし → null (= AI flow に流れる)。
 *
 * @param text user message (= LINE で受信、 sanitize 済前提)
 * @param opts.disabledIntents 無効化する intent 種別 (= gate OFF の feature)。
 *   該当パターンを **skip して後続パターンの走査を続ける** (事後 null 化だと後続パターンを
 *   遮蔽して gate OFF でも挙動が変わってしまうため。採点R1 shadowing 修正)
 * @returns matched intent + messages、 nothing なら null
 */
export function detectIntent(
  text: string,
  opts?: { readonly disabledIntents?: ReadonlyArray<Intent['type']> },
): IntentRouteResult | null {
  const normalized = text.trim();
  if (normalized.length === 0) return null;

  for (const pattern of PATTERNS) {
    if (opts?.disabledIntents?.includes(pattern.intent.type)) continue;
    if (pattern.negativeKeywords?.some((ng) => normalized.includes(ng))) continue;
    for (const keyword of pattern.keywords) {
      if (normalized.includes(keyword)) {
        return {
          intent: pattern.intent,
          messages: buildMessagesForIntent(pattern.intent),
          matchedKeyword: keyword,
        };
      }
    }
  }
  return null;
}

function buildMessagesForIntent(intent: Intent): ReadonlyArray<Message> {
  switch (intent.type) {
    case 'quiz_invite':
      return [buildQuickQuizInviteMessage()];
    case 'price_table':
      return [buildPriceTableMessage()];
    case 'product_compare':
      return [
        {
          type: 'flex',
          altText: '🌿 naturism 3 種類の違い',
          contents: buildProductCompareFlex(),
        },
      ];
    case 'my_coupon':
      // sync build では coupon 不明 fallback、 実 reply は buildMessagesForIntentAsync 経由を期待
      return [
        {
          type: 'text',
          text: 'お持ちのクーポンを確認中です…少々お待ちください 🙏',
        },
      ];
    case 'my_rank':
      // sync build では liffUrl 不明 → rich menu 誘導 fallback、 実 reply は async 経由 (= liffUrl 付き) を期待
      return [
        {
          type: 'text',
          text: '🌿 現在の会員ランクは、トーク画面下のメニュー「マイランク」からご確認いただけます💝',
        },
      ];
    case 'referral':
      // sync build では liffUrl 不明 → rich menu 誘導 fallback、 実 reply は async 経由 (= liffUrl 付き)
      return [
        {
          type: 'text',
          text: '🌿 友だち紹介は、トーク画面下のメニュー「友達紹介」からリンクを送れます💝\nご紹介でお互いにおトクなクーポンをプレゼント🎁',
        },
      ];
    case 'subscription':
      // sync build では D1 不明 → マイページ誘導 fallback、 実 reply は async 経由 (= 契約カード) を期待
      return [
        {
          type: 'text',
          text: `🌿 定期便の確認・スキップ・解約はマイページからお手続きいただけます💝\n${MYPAGE_URL}`,
        },
      ];
    case 'feature_unavailable':
      return [
        {
          type: 'text',
          text: `🌿 ${intent.feature}機能は近日リリース予定です。\n今しばらくお待ちください💝\n\nリリースされ次第、 公式 LINE でお知らせします😊`,
        },
      ];
  }
}

/**
 * async build (= D1 依存可能、 my_coupon 等で利用)。
 * 上記 sync `buildMessagesForIntent` の super-set、 webhook caller はこちらを使う。
 */
export async function buildMessagesForIntentAsync(
  intent: Intent,
  ctx: IntentBuildContext,
): Promise<ReadonlyArray<Message>> {
  if (intent.type === 'my_coupon') {
    const coupon = await getFriendActiveCoupon(ctx.db, ctx.friendId);
    if (!coupon) {
      return [
        {
          type: 'text',
          text: '現在お持ちのクーポンはございません🌿\n\n友だち追加直後にお届けしたマイクーポンをご確認ください💝',
        },
      ];
    }
    return [
      {
        type: 'flex',
        altText: `🎁 マイクーポン ${coupon.couponCode}`,
        contents: buildMyCouponFlex(coupon.couponCode, coupon.discountValue),
      },
      // 5/26 user feedback: クーポンコードは copy したいので **別 text message として送る** (= reply 内、 push 0 通追加)
      // LINE では text message を長押しで copy 可能
      {
        type: 'text',
        text: `🎁 クーポンコード：\n${coupon.couponCode}\n\n↑ 長押しでコピーして公式ストアでご利用ください💝`,
      },
    ];
  }
  if (intent.type === 'my_rank' && ctx.liffUrl) {
    // rich-menus.ts「マイランク」ボタンと同じ `${liffUrl}#rank` 規約 (= /liff/portal → /liff/my-rank redirect)
    return [
      {
        type: 'text',
        text: `🌿 現在の会員ランクは「マイランク」ページでご確認いただけます💝\n\n↓ こちらをタップ\n${ctx.liffUrl}#rank`,
      },
    ];
  }
  if (intent.type === 'subscription') {
    // サブスク・コンシェルジュ (WI-1): postback「サブスク」と同じ契約カードを返す。
    // friend の shopify_customer_id が必要なため D1 から直接引く (IntentBuildContext は friendId のみ)。
    const friend = await ctx.db
      .prepare(`SELECT id, display_name, shopify_customer_id FROM friends WHERE id = ?`)
      .bind(ctx.friendId)
      .first<{ id: string; display_name: string | null; shopify_customer_id: string | null }>();
    if (friend) {
      return buildSubscriptionMenuMessages(ctx.db, friend, ctx.liffUrl, { subIntent: ctx.subIntentEnabled === true });
    }
    return buildMessagesForIntent(intent);
  }
  if (intent.type === 'referral' && ctx.liffUrl) {
    // rich-menus.ts「友達紹介」ボタンと同じ `${liffUrl}#referral` 規約
    return [
      {
        type: 'text',
        // gate off の間は**紹介された側**にだけ確実に届くもの (友だち追加 welcome ¥500) を約束する。
        //   紹介した側の ¥500 は gate off で 1 円も出ないので、on になるまで書かない。
        text: ctx.referralRewardOn
          ? `🌿 友だち紹介はこちらから💝\nご紹介でお互いに 500 円 OFF クーポンをプレゼント🎁\n(¥2,000 以上のご注文でお使いいただけます)\n\n↓ こちらをタップ\n${ctx.liffUrl}#referral`
          : `🌿 友だち紹介はこちらから💝\nお友だちに 500 円 OFF クーポンをプレゼントできます🎁\n(¥2,000 以上のご注文でお使いいただけます)\n\n↓ こちらをタップ\n${ctx.liffUrl}#referral`,
      },
    ];
  }
  // 他 intent (+ liffUrl なし my_rank / referral) は sync build をそのまま流用
  return buildMessagesForIntent(intent);
}

// テスト用 export
export const __test__ = {
  PATTERNS,
  buildMessagesForIntent,
};
