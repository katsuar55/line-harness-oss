/**
 * Phase 6 PR-1 — 再購入間隔の推定サービス
 *
 * subscription_reminders.interval_days を決めるため、以下の優先順で値を返す:
 *
 *   1. user_history       — 同一友だちが同じ shopify_product_id を 2 回以上購入していれば
 *                            実績の平均間隔 (clamp 7-90 日)
 *   2. product_default    — product_repurchase_intervals テーブルに登録済み
 *   3. title_keyword      — 商品名に「30日分」「60日」等の数字キーワードがあれば抽出
 *   4. fallback           — デフォルト 30 日
 *
 * すべて pure に近い構造 (DB 呼び出しは依存注入可能) でテスト容易性を重視する。
 */

import type {
  IntervalSource,
  ProductRepurchaseInterval,
} from '@line-crm/db';
import {
  computeUserPurchaseInterval,
  getProductInterval,
} from '@line-crm/db';

// ============================================================
// 定数
// ============================================================

/** デフォルト再購入間隔 (商品定義もユーザー履歴もないとき) */
export const DEFAULT_INTERVAL_DAYS = 30;

/** clamp 範囲 (短すぎ / 長すぎる推定値の暴発を防ぐ) */
export const MIN_INTERVAL_DAYS = 7;
export const MAX_INTERVAL_DAYS = 90;

// ============================================================
// 型定義
// ============================================================

export interface EstimateInput {
  db: D1Database;
  friendId: string;
  shopifyProductId: string | null | undefined;
  productTitle?: string | null;
}

export interface EstimateResult {
  intervalDays: number;
  source: IntervalSource;
  sampleSize: number;
  productTitle: string | null;
}

/**
 * テスト用に DB 呼び出しを差し替え可能にするための薄いラッパー型。
 */
export interface EstimatorDeps {
  computeUserHistory?: typeof computeUserPurchaseInterval;
  getProductDefault?: typeof getProductInterval;
}

// ============================================================
// pure 関数
// ============================================================

/**
 * 値を [MIN, MAX] にクランプし、整数に丸める。
 */
export function clampInterval(days: number): number {
  if (!Number.isFinite(days)) return DEFAULT_INTERVAL_DAYS;
  const rounded = Math.round(days);
  if (rounded < MIN_INTERVAL_DAYS) return MIN_INTERVAL_DAYS;
  if (rounded > MAX_INTERVAL_DAYS) return MAX_INTERVAL_DAYS;
  return rounded;
}

/**
 * 商品名から日数を表すキーワードを抽出 (例: "プロテイン30日分" → 30)。
 *
 * 対応パターン:
 *   - "30日分" / "30 日分" / "30日"
 *   - "30days" / "30 days" / "30day"
 *   - 数字は半角・全角どちらも許容
 */
export function extractDaysFromTitle(title: string | null | undefined): number | null {
  if (!title) return null;
  // 全角数字 → 半角化
  const normalized = title.replace(/[０-９]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0xfee0),
  );
  // 「30日分」「30 日」「30days」等を許容
  const m = normalized.match(/(\d{1,3})\s*(?:日(?:分)?|day(?:s)?)/i);
  if (!m) return null;
  const n = Number.parseInt(m[1] ?? '', 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

// ============================================================
// メイン推定関数
// ============================================================

/**
 * 友だち + 商品の組合せで再購入間隔を推定する。
 *
 * - shopify_product_id が無ければ user_history も product_default も
 *   調べられないので title_keyword または fallback のみ。
 * - 例外は呼び出し側に委ね、ここでは throw する。
 */
export async function estimateRepurchaseInterval(
  input: EstimateInput,
  deps: EstimatorDeps = {},
): Promise<EstimateResult> {
  const { db, friendId, shopifyProductId, productTitle } = input;
  const computeUserHistory = deps.computeUserHistory ?? computeUserPurchaseInterval;
  const getProductDefault = deps.getProductDefault ?? getProductInterval;

  // 1. ユーザー履歴ベース (商品 ID が必要)
  if (shopifyProductId) {
    try {
      const hist = await computeUserHistory(db, friendId, shopifyProductId);
      if (hist && hist.sampleSize > 0) {
        return {
          intervalDays: clampInterval(hist.averageDays),
          source: 'user_history',
          sampleSize: hist.sampleSize,
          productTitle: productTitle ?? null,
        };
      }
    } catch {
      // best-effort: フォールスルーする
    }
  }

  // 2. 商品マスタ default
  if (shopifyProductId) {
    try {
      const product: ProductRepurchaseInterval | null = await getProductDefault(
        db,
        shopifyProductId,
      );
      if (product) {
        return {
          intervalDays: clampInterval(product.default_interval_days),
          source: 'product_default',
          sampleSize: product.sample_size,
          productTitle: product.product_title ?? productTitle ?? null,
        };
      }
    } catch {
      // best-effort
    }
  }

  // 3. 商品名から推定
  const fromTitle = extractDaysFromTitle(productTitle);
  if (fromTitle !== null) {
    return {
      intervalDays: clampInterval(fromTitle),
      source: 'auto_estimated',
      sampleSize: 0,
      productTitle: productTitle ?? null,
    };
  }

  // 4. fallback
  return {
    intervalDays: DEFAULT_INTERVAL_DAYS,
    source: 'fallback',
    sampleSize: 0,
    productTitle: productTitle ?? null,
  };
}
