/**
 * Phase 6 PR-2 — Shopify orders/create を起点に
 * subscription_reminders を自動 enroll するサービス。
 *
 * 設計:
 *   - line_items の各商品に対し estimateRepurchaseInterval() で間隔を取得
 *   - 既存の active な (friend_id, shopify_product_id) があれば skip
 *     (ユーザー手動設定 / 過去の同商品購入を尊重)
 *   - なければ INSERT
 *
 * 例外:
 *   - 1 line_item の失敗が他商品の enroll を止めないよう、try/catch で隔離
 *   - DB 例外は上位で throw されたら呼び出し側 (webhook async work) で握り潰す
 */

import {
  estimateRepurchaseInterval,
  type EstimateResult,
} from './repurchase-estimator.js';

// ============================================================
// 型定義
// ============================================================

export interface RawLineItem {
  product_id?: number | string | null;
  variant_id?: number | string | null;
  title?: string | null;
  name?: string | null;
}

export interface EnrollInput {
  db: D1Database;
  friendId: string;
  shopifyOrderId: string;
  lineItems: unknown[];
}

export interface EnrolledItem {
  shopifyProductId: string;
  productTitle: string;
  intervalDays: number;
  source: EstimateResult['source'];
  action: 'inserted' | 'skipped_existing' | 'skipped_invalid';
  subscriptionReminderId?: string;
  reason?: string;
}

export interface EnrollResult {
  enrolled: EnrolledItem[];
  errors: { productId: string | null; message: string }[];
}

// ============================================================
// pure 関数
// ============================================================

/**
 * line_items から (product_id, title) のペアを抽出。
 * 同一注文内の重複 product_id は最初の 1 件のみ採用 (LINE push を 1 商品 1 通に制限)。
 */
export function extractEnrollableItems(
  lineItems: unknown[],
): { shopifyProductId: string; productTitle: string; variantId: string | null }[] {
  const seen = new Set<string>();
  const out: {
    shopifyProductId: string;
    productTitle: string;
    variantId: string | null;
  }[] = [];

  for (const raw of lineItems) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as RawLineItem;
    const pid = item.product_id;
    if (pid === undefined || pid === null) continue;
    const idStr = String(pid).trim();
    if (!idStr) continue;
    if (seen.has(idStr)) continue;
    seen.add(idStr);

    const title =
      (typeof item.title === 'string' && item.title.trim()) ||
      (typeof item.name === 'string' && item.name.trim()) ||
      idStr;

    const vid =
      item.variant_id !== undefined && item.variant_id !== null
        ? String(item.variant_id).trim() || null
        : null;

    out.push({
      shopifyProductId: idStr,
      productTitle: title,
      variantId: vid,
    });
  }

  return out;
}

// ============================================================
// メイン処理
// ============================================================

/**
 * 注文 1 件分の自動 enroll を実行。
 * line_items が空 / friend が紐付かない場合は何もしない。
 */
export async function enrollSubscriptionsFromOrder(
  input: EnrollInput,
): Promise<EnrollResult> {
  const { db, friendId, shopifyOrderId, lineItems } = input;
  const result: EnrollResult = { enrolled: [], errors: [] };

  if (!friendId || !shopifyOrderId) return result;
  if (!Array.isArray(lineItems) || lineItems.length === 0) return result;

  const items = extractEnrollableItems(lineItems);
  if (items.length === 0) return result;

  for (const item of items) {
    try {
      // 既存の active リマインダー有無を確認
      const existing = await db
        .prepare(
          `SELECT id FROM subscription_reminders
           WHERE friend_id = ? AND shopify_product_id = ? AND is_active = 1
           LIMIT 1`,
        )
        .bind(friendId, item.shopifyProductId)
        .first<{ id: string }>();

      if (existing?.id) {
        result.enrolled.push({
          shopifyProductId: item.shopifyProductId,
          productTitle: item.productTitle,
          intervalDays: 0,
          source: 'manual',
          action: 'skipped_existing',
          subscriptionReminderId: existing.id,
          reason: 'active reminder already exists',
        });
        continue;
      }

      // 推定
      const estimate = await estimateRepurchaseInterval({
        db,
        friendId,
        shopifyProductId: item.shopifyProductId,
        productTitle: item.productTitle,
      });

      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      const nextAt = new Date(
        Date.now() + estimate.intervalDays * 86_400_000,
      ).toISOString();

      await db
        .prepare(
          `INSERT INTO subscription_reminders
            (id, friend_id, product_title, variant_id, interval_days,
             next_reminder_at, last_sent_at, is_active, source_order_id,
             shopify_product_id, interval_source, sample_size,
             created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, NULL, 1, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          id,
          friendId,
          item.productTitle,
          item.variantId,
          estimate.intervalDays,
          nextAt,
          shopifyOrderId,
          item.shopifyProductId,
          estimate.source,
          estimate.sampleSize,
          now,
          now,
        )
        .run();

      result.enrolled.push({
        shopifyProductId: item.shopifyProductId,
        productTitle: item.productTitle,
        intervalDays: estimate.intervalDays,
        source: estimate.source,
        action: 'inserted',
        subscriptionReminderId: id,
      });
    } catch (err) {
      result.errors.push({
        productId: item.shopifyProductId,
        message: err instanceof Error ? err.message.slice(0, 200) : 'unknown',
      });
    }
  }

  return result;
}
