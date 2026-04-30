/**
 * Email SDK 型定義 + Zod schema (Round 4 PR-1)
 *
 * 設計方針:
 * - すべての送信は EmailMessage で正規化される
 * - category と sourceKind は Phase 6 / 法令準拠の追跡に必須
 * - provider 抽象化のため EmailProvider interface を別途定義 (provider.ts)
 */

import { z } from 'zod';

// ============================================================
// 法令上の区分 (特定電子メール法 / GDPR 準拠)
// ============================================================

/**
 * - transactional: 注文確認 / 配送通知 / 領収書 → 同意不要で送信可
 *                  (取引上当然の連絡、特定電子メール法 第 3 条 1 項 但書 適用)
 * - marketing: ニュースレター / 再購入リマインダー / クロスセル → 明示的同意必須
 */
export const EmailCategory = z.enum(['transactional', 'marketing']);
export type EmailCategory = z.infer<typeof EmailCategory>;

/**
 * 送信元種別 (Phase 6 連携で「どの cron / 機能起点か」を追跡)
 */
export const EmailSourceKind = z.enum([
  'reorder', // 再購入リマインダー
  'cross_sell', // クロスセル push
  'broadcast', // 一斉配信
  'transactional', // 注文確認 / 配送通知
  'manual', // 手動送信
]);
export type EmailSourceKind = z.infer<typeof EmailSourceKind>;

// ============================================================
// EmailMessage (provider に渡す正規化された送信単位)
// ============================================================

export const EmailMessage = z.object({
  /** 受信者メールアドレス (1 件のみ。複数宛先は呼び出し側で展開) */
  to: z.string().email(),
  /** 送信元 (例: noreply@mail.naturism.example) */
  from: z.string().email(),
  /** 件名 (1 行) */
  subject: z.string().min(1).max(998), // RFC 5322 上限
  /** HTML 本文 (法定フッター + List-Unsubscribe は EmailRenderer が注入) */
  html: z.string().min(1),
  /** plain text fallback (multipart 必須) */
  text: z.string().min(1),
  /** Reply-To (オプション。サポート問い合わせ用) */
  replyTo: z.string().email().optional(),
  /** 任意の追加ヘッダ (List-Unsubscribe 等は EmailRenderer 経由で設定推奨) */
  headers: z.record(z.string(), z.string()).optional(),
  /** Resend / SendGrid の tag 機能 (provider が解釈) */
  tags: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
  /** 法令上の区分。配信ゲート判定に必須 */
  category: EmailCategory,
  /** 送信元種別 (KPI 計測に必須) */
  sourceKind: EmailSourceKind,
  /** 関連 Shopify order ID (reorder/cross_sell の追跡) */
  sourceOrderId: z.string().optional(),
});
export type EmailMessage = z.infer<typeof EmailMessage>;

// ============================================================
// EmailResult (provider 送信結果)
// ============================================================

export const EmailResult = z.object({
  /** provider が返した message ID (webhook 照合に使う) */
  providerMessageId: z.string(),
  /** provider 名 (Resend / SendGrid 等) */
  provider: z.string(),
  /** 送信時刻 (ISO 8601 / JST) */
  sentAt: z.string(),
});
export type EmailResult = z.infer<typeof EmailResult>;

// ============================================================
// レンダリング用 (テンプレ → EmailMessage 変換)
// ============================================================

export interface RenderInput {
  /** subject template (例: '{{name}} 様、ご注文ありがとうございます') */
  subjectTemplate: string;
  /** html body template (mustache 風 {{var}}) */
  htmlTemplate: string;
  /** text body template */
  textTemplate: string;
  /** preheader (inbox preview text) */
  preheader?: string;
  /** 変数 (例: { name: '田中', orderNumber: '12345' }) */
  variables: Record<string, string>;
  /** subscriber ID (List-Unsubscribe HMAC token 生成用) */
  subscriberId: string;
  /** category (フッターの法令文言を決定) */
  category: EmailCategory;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
  /** List-Unsubscribe ヘッダ用 URL */
  unsubscribeUrl: string;
}
