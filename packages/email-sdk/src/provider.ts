/**
 * EmailProvider 抽象 interface (Round 4 PR-1)
 *
 * 設計方針 (v2 改訂で provider 抽象化縮退):
 * - 現在の唯一の実装は ResendClient
 * - SendGrid 等の追加実装は障害発生 or 50k 通超え時に Issue 化
 * - interface は型レイヤだけ存在させ、将来の差し替えに備える
 */

import type { EmailMessage, EmailResult } from './types.js';

export interface EmailProvider {
  /**
   * メール 1 通を送信する。
   *
   * @throws send 失敗時 Error を throw (呼び出し側が catch + retry / log 判断)
   */
  send(message: EmailMessage): Promise<EmailResult>;
}
