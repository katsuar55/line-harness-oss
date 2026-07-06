/**
 * AI message builder (Plan A-4、 2026-05-24)
 *
 * 役割:
 *   AI 応答 text を、 内容に応じて plain text Message or flex Message に変換する。
 *
 * 判定 priority:
 *   1. AI が冒頭に `[FMT:text]` prefix を付けた → strip して plain text Message 返却
 *      (= AI 自身が判断、 system prompt で URL only / 短い挨拶等は付けるよう指示)
 *   2. heuristics fallback (= prefix なし時):
 *      - markdown 構造 (= `## ` / `**...**:` / `* ` / `・` / `【】`) なし
 *        AND 50 文字以下 → plain text (短い挨拶等)
 *      - markdown 構造なし AND URL を含み 200 文字以下 → plain text (URL は LINE で auto-link)
 *      - それ以外 → flex (= 既存 buildAiFlexJson、 セクション化された詳細回答向け)
 *
 * 背景 (= 5/24 リハーサル #5):
 *   - 旧: AI 応答を一律 flex に変換 → URL も flex 内 text 化されて tap しづらい不便
 *   - 新: short / URL-centric は plain text、 detail は flex (= context-aware)
 *
 * 関連:
 *   - apps/worker/src/services/ai-response.ts (= system prompt の「## 出力形式」 で prefix 案内)
 *   - apps/worker/src/routes/webhook.ts (= caller)
 */

import type { Message, FlexContainer } from '@line-crm/line-sdk';
import { buildQuickQuizInviteMessage } from './quick-quiz.js';

const FMT_TEXT_PREFIX = '[FMT:text]';
// marker のみで本文が空の応答 (LLM の空振り) — marker を顧客に見せず、正直な聞き直しに倒す
const MARKER_ONLY_FALLBACK = 'うまくお答えできませんでした。お手数ですが、もう一度お送りいただけますか🌿';
const FMT_QUIZ_INVITE_PREFIX = '[FMT:quiz_invite]'; // Plan A-3 (2026-05-24): AI が「おすすめ」 intent 検出時に返す
const FMT_PRICE_TABLE_PREFIX = '[FMT:price_table]'; // Plan A-6 (2026-05-24): AI が価格比較質問検出時に返す → grid flex
const SHORT_TEXT_THRESHOLD = 50; // 字以下で markdown 構造なしなら text
const URL_TEXT_THRESHOLD = 200; // URL 含む短文なら text

const URL_REGEX = /https?:\/\/[^\s]+/i;
const MARKDOWN_STRUCTURE_REGEX = /^(##\s+|[■●▶]|\*\*[^*]+\*\*[:：]|[*・\-•]\s+|【[^】]+】)/m;

/**
 * AI 応答 text を Message (= text or flex) に変換する。
 *
 * @param text AI 応答 raw text
 * @returns LINE Message ({ type: 'text', ... } or { type: 'flex', altText, contents })
 */
export function buildAiMessage(text: string): Message {
  // 1. prefix check
  const trimmedRaw = text.trim();
  // Plan A-3: [FMT:quiz_invite] prefix → quick_quiz 招待 flex Message (= 「診断スタート ▶」 button)
  // prefix 後の text は無視 (= AI 解説文が無くても button だけで自然な誘導が可能)
  if (trimmedRaw.startsWith(FMT_QUIZ_INVITE_PREFIX)) {
    return buildQuickQuizInviteMessage();
  }
  // Plan A-6: [FMT:price_table] prefix → 価格一覧 grid table flex (= 3 商品 × 価格 grid)
  // 価格 data は ai-response.ts system prompt と同じ source (= hardcoded constant)、 ハルシネーション 0
  if (trimmedRaw.startsWith(FMT_PRICE_TABLE_PREFIX)) {
    return buildPriceTableMessage();
  }
  if (trimmedRaw.startsWith(FMT_TEXT_PREFIX)) {
    const stripped = trimmedRaw.slice(FMT_TEXT_PREFIX.length).trim();
    // marker のみ (本文なし) は raw を返すと marker が顧客に露出する → fallback (review 2026-07-07)
    return { type: 'text', text: stripped || MARKER_ONLY_FALLBACK };
  }

  // 1b. tolerant cleanup: LLM は marker を typo/変形することがある
  //     (実測 2026-06-28: llama-4-scout が [FMT:text] を [FMAT:text] と出力)。
  //     素の exact-prefix check だけだと、 変形 marker は fallback flex に落ちて
  //     `[FMAT:text]…` が顧客に**そのまま可視化**される。 内側 keyword で route し、
  //     marker token を strip して marker 文字列が顧客に漏れないようにする。
  //     keyword=英小文字+_ / prefix=英字2-8 のみを marker とみなす (日本語の [〜] や
  //     【〜】 は ASCII でないため誤検出しない)。
  const mangledMarker = trimmedRaw.match(/^\[[A-Za-z]{2,8}:([a-z_]{2,20})\]\s*/);
  if (mangledMarker) {
    if (mangledMarker[1] === 'quiz_invite') return buildQuickQuizInviteMessage();
    if (mangledMarker[1] === 'price_table') return buildPriceTableMessage();
    const cleaned = trimmedRaw.slice(mangledMarker[0].length).trim();
    if (cleaned) return buildAiMessage(cleaned); // strip 後の本文を再評価 (先頭 marker は除去済)
    return { type: 'text', text: MARKER_ONLY_FALLBACK }; // marker のみ — 素通しで顧客に見せない
  }

  // 1c. 日本語変形 marker (実機 2026-07-04: 「[フォーマット:text]」 が顧客に露出)。
  //     LLM は prefix 部分を日本語へ翻訳することがある (フォーマット/形式 等)。全角コロン・
  //     全角括弧の変形も許容する。誤 strip を避けるため、prefix が何であっても
  //     **keyword が既知 3 種に完全一致する場合のみ** marker とみなす
  //     (= 「[お得:sale]」 「[重要]」 のような正当な括弧書きは保持される)。
  const jaMarker = trimmedRaw.match(/^[\[［][^\[\]［］:：]{2,12}[:：](text|quiz_invite|price_table)[\]］]\s*/);
  if (jaMarker) {
    if (jaMarker[1] === 'quiz_invite') return buildQuickQuizInviteMessage();
    if (jaMarker[1] === 'price_table') return buildPriceTableMessage();
    const cleaned = trimmedRaw.slice(jaMarker[0].length).trim();
    if (cleaned) return buildAiMessage(cleaned);
    return { type: 'text', text: MARKER_ONLY_FALLBACK }; // marker のみ — 素通しで顧客に見せない
  }

  // 2. heuristics
  const hasStructure = MARKDOWN_STRUCTURE_REGEX.test(trimmedRaw);
  const length = trimmedRaw.length;
  const hasUrl = URL_REGEX.test(trimmedRaw);

  if (!hasStructure) {
    if (length <= SHORT_TEXT_THRESHOLD) {
      return { type: 'text', text: trimmedRaw };
    }
    if (hasUrl && length <= URL_TEXT_THRESHOLD) {
      return { type: 'text', text: trimmedRaw };
    }
  }

  // 3. fallback: flex
  return {
    type: 'flex',
    altText: 'naturism AI 応答',
    contents: JSON.parse(buildAiFlexJson(trimmedRaw)),
  };
}

/**
 * AI 応答 text を flex Message JSON string に変換する (= 既存実装、 webhook.ts から移植)。
 *
 * markdown 風 text (= `## 見出し` / `**ラベル**: 値` / `* 項目`) を flex bubble に rendering。
 * caller は `buildMessage('flex', returnedJson)` で Message 化する。
 */
export function buildAiFlexJson(text: string): string {
  const lines = text.split('\n').filter((line) => line.trim());
  const bodyContents: object[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // セクション見出し（## / ■ / ● / ▶ / 【】）
    if (/^(##\s+|[■●▶])/.test(trimmed) || /^【.+】$/.test(trimmed)) {
      const label = trimmed
        .replace(/^##\s+/, '')
        .replace(/^[■●▶]\s*/, '')
        .replace(/^【/, '')
        .replace(/】$/, '');
      bodyContents.push({
        type: 'box',
        layout: 'horizontal',
        backgroundColor: '#f0fdf4',
        cornerRadius: 'md',
        paddingAll: '10px',
        margin: bodyContents.length > 0 ? 'lg' : 'none',
        contents: [
          {
            type: 'box',
            layout: 'vertical',
            width: '3px',
            backgroundColor: '#06C755',
            cornerRadius: '2px',
            contents: [{ type: 'filler' }],
          },
          {
            type: 'text',
            text: label,
            size: 'sm',
            weight: 'bold',
            color: '#15803d',
            wrap: true,
            margin: 'sm',
          },
        ],
      });
    }
    // テーブル行: **ラベル**: 値
    else if (/^\*\*[^*]+\*\*[:：]\s*.+/.test(trimmed)) {
      const match = trimmed.match(/^\*\*([^*]+)\*\*[:：]\s*(.+)/);
      if (match) {
        bodyContents.push({
          type: 'box',
          layout: 'horizontal',
          spacing: 'md',
          margin: 'sm',
          paddingStart: '6px',
          contents: [
            { type: 'text', text: match[1], size: 'xs', color: '#15803d', weight: 'bold', flex: 3, wrap: false },
            { type: 'text', text: match[2], size: 'xs', color: '#1e293b', flex: 7, wrap: true },
          ],
        });
      }
    }
    // テーブル行: ラベル: 値（コロンが前半15文字以内にある）
    else if (/^[^:：\n]{1,15}[:：]\s*.+/.test(trimmed) && !/^https?:/.test(trimmed)) {
      const colonIdx = trimmed.search(/[:：]/);
      const label = trimmed.slice(0, colonIdx).trim();
      const value = trimmed.slice(colonIdx + 1).trim();
      bodyContents.push({
        type: 'box',
        layout: 'horizontal',
        spacing: 'md',
        margin: 'sm',
        paddingStart: '6px',
        contents: [
          { type: 'text', text: label, size: 'xs', color: '#15803d', weight: 'bold', flex: 3, wrap: false },
          { type: 'text', text: value, size: 'xs', color: '#1e293b', flex: 7, wrap: true },
        ],
      });
    }
    // 箇条書き（* ・ - • で始まる）
    else if (/^[*・\-•]\s+/.test(trimmed)) {
      const itemText = trimmed.replace(/^[*・\-•]\s+/, '');
      bodyContents.push({
        type: 'box',
        layout: 'horizontal',
        spacing: 'sm',
        margin: 'sm',
        paddingStart: '8px',
        contents: [
          { type: 'text', text: '▸', size: 'xs', color: '#06C755', flex: 0, gravity: 'top' },
          { type: 'text', text: itemText, size: 'sm', color: '#334155', wrap: true },
        ],
      });
    }
    // 区切り線
    else if (/^-{3,}$/.test(trimmed)) {
      bodyContents.push({ type: 'separator', margin: 'lg', color: '#e2e8f0' });
    }
    // 通常テキスト
    else {
      bodyContents.push({
        type: 'text',
        text: trimmed,
        size: 'sm',
        color: '#334155',
        wrap: true,
        margin: bodyContents.length > 0 ? 'md' : 'none',
      });
    }
  }

  if (bodyContents.length === 0) {
    bodyContents.push({ type: 'text', text, size: 'sm', color: '#334155', wrap: true });
  }

  const bubble = {
    type: 'bubble',
    header: {
      type: 'box',
      layout: 'horizontal',
      backgroundColor: '#06C755',
      paddingAll: '12px',
      cornerRadius: 'none',
      contents: [
        { type: 'text', text: '🌿', size: 'sm', flex: 0 },
        { type: 'text', text: 'naturism', size: 'xs', color: '#ffffff', weight: 'bold', gravity: 'center', margin: 'sm' },
        { type: 'filler' },
        { type: 'text', text: 'AI応答', size: 'xxs', color: '#d1fae5', gravity: 'center' },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      contents: bodyContents,
      paddingAll: '16px',
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '12px',
      backgroundColor: '#f8fafc',
      contents: [
        {
          type: 'box',
          layout: 'horizontal',
          justifyContent: 'center',
          spacing: 'xs',
          contents: [
            { type: 'text', text: '詳しくは', size: 'xxs', color: '#94a3b8', flex: 0 },
            { type: 'text', text: 'info@kenkoex.com', size: 'xxs', color: '#06C755', weight: 'bold', flex: 0, decoration: 'underline' },
            { type: 'text', text: 'まで📩', size: 'xxs', color: '#94a3b8', flex: 0 },
          ],
        },
      ],
    },
    styles: {
      header: { separator: false },
      body: { separator: false },
      footer: { separator: true },
    },
  };

  return JSON.stringify(bubble);
}

/**
 * Plan A-6 (2026-05-24): 3 商品 × 価格 grid table flex Message を build。
 *
 * 価格 source: ai-response.ts system prompt と同期 (= hardcoded、 ハルシネーション 0)
 *   - Blue: 180粒個包装 ¥2,376 / 600粒VP ¥6,415 / 1日 ¥64
 *   - Pink: 180粒個包装 ¥2,830 / 600粒VP ¥7,538 / 1日 ¥75
 *   - Premium: 180粒個包装 ¥3,564 / 900粒VP ¥14,904 / 1日 ¥149
 *
 * 5,500 円以上で送料無料 footer note + 公式ストア button。
 */
export function buildPriceTableMessage(): Message {
  return {
    type: 'flex',
    altText: '💰 価格一覧 (税込)',
    contents: buildPriceTableFlex() as unknown as FlexContainer,
  };
}

interface PriceRow {
  emoji: string;
  name: string;
  color: string;
  singlePack: string;
  valuePack: string;
  perDay: string;
}

const PRICE_ROWS: ReadonlyArray<PriceRow> = [
  { emoji: '🩵', name: 'Blue', color: '#0ABAB5', singlePack: '¥2,376', valuePack: '¥6,415', perDay: '¥64' },
  { emoji: '💗', name: 'Pink', color: '#ec4899', singlePack: '¥2,830', valuePack: '¥7,538', perDay: '¥75' },
  { emoji: '🩶', name: 'Premium', color: '#64748b', singlePack: '¥3,564', valuePack: '¥14,904', perDay: '¥149' },
];

function buildPriceTableFlex(): object {
  const headerRow = {
    type: 'box',
    layout: 'horizontal',
    spacing: 'sm',
    paddingAll: '8px',
    backgroundColor: '#f0fdf4',
    cornerRadius: '4px',
    contents: [
      { type: 'text', text: '商品', size: 'xxs', weight: 'bold', color: '#15803d', flex: 3, align: 'start' },
      { type: 'text', text: '180粒', size: 'xxs', weight: 'bold', color: '#15803d', flex: 3, align: 'center' },
      { type: 'text', text: 'VP', size: 'xxs', weight: 'bold', color: '#15803d', flex: 3, align: 'center' },
      { type: 'text', text: '1日', size: 'xxs', weight: 'bold', color: '#15803d', flex: 2, align: 'center' },
    ],
  };

  const dataRows = PRICE_ROWS.map((row) => ({
    type: 'box',
    layout: 'horizontal',
    spacing: 'sm',
    paddingAll: '8px',
    margin: 'sm',
    contents: [
      {
        type: 'box',
        layout: 'horizontal',
        flex: 3,
        contents: [
          { type: 'text', text: row.emoji, size: 'xs', flex: 0 },
          { type: 'text', text: row.name, size: 'xs', weight: 'bold', color: row.color, flex: 1, margin: 'xs', align: 'start' },
        ],
      },
      { type: 'text', text: row.singlePack, size: 'xs', color: '#1e293b', flex: 3, align: 'center' },
      { type: 'text', text: row.valuePack, size: 'xs', color: '#1e293b', flex: 3, align: 'center' },
      { type: 'text', text: row.perDay, size: 'xs', weight: 'bold', color: '#06C755', flex: 2, align: 'center' },
    ],
  }));

  const interleaved: object[] = [headerRow];
  for (const row of dataRows) {
    interleaved.push({ type: 'separator', margin: 'sm', color: '#e2e8f0' });
    interleaved.push(row);
  }

  return {
    type: 'bubble',
    size: 'kilo',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#06C755',
      paddingAll: '12px',
      contents: [
        { type: 'text', text: '💰 価格一覧 (税込)', size: 'sm', weight: 'bold', color: '#ffffff', align: 'center' },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '12px',
      spacing: 'none',
      contents: [
        ...interleaved,
        { type: 'separator', margin: 'lg', color: '#e2e8f0' },
        {
          type: 'box',
          layout: 'vertical',
          margin: 'md',
          spacing: 'xs',
          contents: [
            { type: 'text', text: '※ VP = バリューパック', size: 'xxs', color: '#64748b', wrap: true },
            { type: 'text', text: '※ 1日 = VP 価格÷粒数で 1 日換算', size: 'xxs', color: '#64748b', wrap: true },
            { type: 'text', text: '🎁 5,500 円以上で送料無料', size: 'xs', color: '#15803d', weight: 'bold', wrap: true, margin: 'sm' },
          ],
        },
      ],
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '12px',
      spacing: 'sm',
      contents: [
        { type: 'button', action: { type: 'uri', label: '公式ストアで購入', uri: 'https://naturism-diet.com/' }, style: 'primary', color: '#06C755', height: 'sm' },
      ],
    },
  };
}

// テスト用 export
export const __test__ = {
  FMT_TEXT_PREFIX,
  FMT_QUIZ_INVITE_PREFIX,
  FMT_PRICE_TABLE_PREFIX,
  SHORT_TEXT_THRESHOLD,
  URL_TEXT_THRESHOLD,
  URL_REGEX,
  MARKDOWN_STRUCTURE_REGEX,
  PRICE_ROWS,
  buildPriceTableFlex,
};
