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

import type { Message } from '@line-crm/line-sdk';

const FMT_TEXT_PREFIX = '[FMT:text]';
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
  if (trimmedRaw.startsWith(FMT_TEXT_PREFIX)) {
    const stripped = trimmedRaw.slice(FMT_TEXT_PREFIX.length).trim();
    return { type: 'text', text: stripped || trimmedRaw };
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

// テスト用 export
export const __test__ = {
  FMT_TEXT_PREFIX,
  SHORT_TEXT_THRESHOLD,
  URL_TEXT_THRESHOLD,
  URL_REGEX,
  MARKDOWN_STRUCTURE_REGEX,
};
