/**
 * @line-crm/email-sdk — Email channel SDK (Round 4 PR-1)
 *
 * 公開 API:
 * - EmailMessage / EmailResult / EmailCategory / EmailSourceKind (型)
 * - EmailProvider (interface)
 * - ResendClient (実装)
 * - EmailRenderer (テンプレ → 完成 HTML / text)
 */

export * from './types.js';
export * from './provider.js';
export { ResendClient } from './resend-client.js';
export type { ResendClientOptions } from './resend-client.js';
export { EmailRenderer } from './renderer.js';
export type { EmailRendererOptions } from './renderer.js';
