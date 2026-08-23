/**
 * Shop タブ v2 — 再購入グリッドと購入導線の**唯一の導出点** (2026-08-23)。
 *
 * 設計の要: 一覧に出す「割引ラベル」と、購入時に permalink へ載せる「割引コード」を
 * **同じ 1 回の導出**から派生させる。別々に計算すると「ラベルは出ているのに URL は素」
 * (= 表示が嘘になる) という乖離が必ず起きる。
 *
 * 表示の正直さ (景表法・有利誤認の回避):
 *   - ランク割引ラベルは **サーバがその URL に実際にコードを載せた行だけ** に出す
 *   - MIN_SUBTOTAL_JPY (¥2,000) 未満はコードが checkout で無言で外れるので載せない
 *     (= ラベルも出さない)。ただし「割引対象外です」とは書かない — ¥2,000 は
 *     **注文小計**の条件で、2 個買えば適用されるため否定断定は嘘になる
 *   - 割引後の確定金額は出さない (他クーポンと併用可・送料別で必ずズレる)
 *   - compare_at_price 由来の「◯%OFF」は出さない (価格履歴の根拠がリポジトリに無い)
 */
import { getShopifyProducts, getShopifyOrders, getActiveRankDiscountCode } from '@line-crm/db';
import type { ShopifyProduct } from '@line-crm/db';
import { buildCartPermalink, toNumericVariantId } from './cart-permalink.js';
import { MIN_SUBTOTAL_JPY } from './shopify-coupon-issuer.js';
import { STOREFRONT_DOMAIN, storefrontProductUrl } from './storefront-domain.js';
import { activeSubscriptionProductIds, type ActiveSubscriptionProducts } from './reorder-guard.js';

/** グリッドに出す 1 商品 (クライアントへはこの形だけを返す — 生の line_items は返さない)。 */
export interface ShopGridItem {
  productId: string;
  title: string;
  imageUrl: string | null;
  /** 表示用の税込単価。出せないときは null (「¥0」「NaN」を構造的に出さない) */
  priceJpy: number | null;
  /** 商品ページ (定期便セレクタが見られる導線。必ず 1 本残す) */
  productUrl: string | null;
  /** 定期便で届いている / お休み中 / 表示しない */
  subscriptionState: 'active' | 'paused' | null;
  /** ランク割引が**実際に適用される**行か (ラベルはこれが真のときだけ出す) */
  discounted: boolean;
  /** 適用される割引率 (discounted が真のときのみ 1 以上) */
  discountPercent: number;
}

/** 1 リクエストぶんの導出コンテキスト。一覧と購入で同じものを使う。 */
export interface ShopContext {
  products: ShopifyProduct[];
  /** variant id (数値文字列) → product 行 + variant */
  variantIndex: Map<string, { product: ShopifyProduct; variant: Record<string, unknown> }>;
  /** product_id → product 行 */
  productIndex: Map<string, ShopifyProduct>;
  /** 過去に購入した product_id (新しい順) */
  purchasedOrder: string[];
  subs: ActiveSubscriptionProducts;
  rankDiscountCode: string | null;
  rankDiscountPercent: number;
}

/** 金額として出してよい値だけを通す。null/空/非有限/0 以下は「出さない」。 */
export function safeYen(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/** variants_json をパースして配列で返す (壊れていれば空配列)。 */
function parseVariants(raw: unknown): Array<Record<string, unknown>> {
  if (typeof raw !== 'string' || raw.length === 0) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as Array<Record<string, unknown>>) : [];
  } catch {
    return [];
  }
}

/**
 * 1 リクエストぶんの文脈を組む。
 * status で絞らない — 過去に買った商品が archived/draft に落ちていても
 * 画像と価格を引けるようにするため。
 */
export async function buildShopContext(
  db: D1Database,
  friendId: string,
): Promise<ShopContext> {
  const products = await getShopifyProducts(db, { limit: 100 });

  const variantIndex = new Map<string, { product: ShopifyProduct; variant: Record<string, unknown> }>();
  const productIndex = new Map<string, ShopifyProduct>();
  for (const p of products) {
    const pid = p.shopify_product_id;
    if (pid != null) productIndex.set(String(pid), p);
    for (const v of parseVariants(p.variants_json)) {
      // 数値 id と gid の両方を鍵にする (注文側は数値、カタログ側は両方持つ)
      for (const key of [v.id, v.admin_graphql_api_id]) {
        const num = toNumericVariantId(key as string | number | null | undefined);
        if (num) variantIndex.set(String(num), { product: p, variant: v });
      }
    }
  }

  // 過去購入 (新しい順・重複排除)。line_items は product_id → variant_id の 2 段で解決し、
  // 名前一致のあいまいマッチは実装しない (別商品を「前回ご購入」と偽るため)
  const purchasedOrder: string[] = [];
  const seen = new Set<string>();
  let orders: Array<Record<string, unknown>> = [];
  try {
    orders = await getShopifyOrders(db, { friendId, limit: 10 });
  } catch {
    orders = [];
  }
  for (const o of orders) {
    let items: Array<Record<string, unknown>> = [];
    try {
      const raw = o.line_items ? JSON.parse(o.line_items as string) : [];
      items = Array.isArray(raw) ? raw : [];
    } catch {
      continue;
    }
    for (const li of items) {
      let pid: string | null = null;
      if (li.product_id != null && productIndex.has(String(li.product_id))) {
        pid = String(li.product_id);
      } else {
        const num = toNumericVariantId(li.variant_id as string | number | null | undefined);
        const hit = num ? variantIndex.get(String(num)) : undefined;
        if (hit) pid = String(hit.product.shopify_product_id);
      }
      if (pid && !seen.has(pid)) {
        seen.add(pid);
        purchasedOrder.push(pid);
      }
    }
  }

  const subs = await activeSubscriptionProductIds(db, friendId);

  // ランク割引は**発行済みレコード**を出典にする (台帳の定義値ではなく、実際に使えるコード)。
  // 未発行 / gate off / 未連携 / 0% はコードが無いのでラベルを 1 byte も出さない
  let rankDiscountCode: string | null = null;
  let rankDiscountPercent = 0;
  try {
    const rec = await getActiveRankDiscountCode(db, friendId, new Date().toISOString());
    if (rec && rec.code) {
      rankDiscountCode = rec.code;
      rankDiscountPercent = Number(rec.discountPercent) || 0;
    }
  } catch {
    rankDiscountCode = null;
  }
  if (rankDiscountPercent <= 0) rankDiscountCode = null;

  return { products, variantIndex, productIndex, purchasedOrder, subs, rankDiscountCode, rankDiscountPercent };
}

/** 購入計画 (permalink とラベルの根拠を 1 つの戻り値にまとめる)。 */
export interface ShopBuyPlan {
  url: string | null;
  priceJpy: number | null;
  discounted: boolean;
  discountPercent: number;
}

/**
 * その商品の購入 URL と割引の適用可否を決める。
 * **一覧と購入の両方がこれを呼ぶ** — 別導出にすると表示と実際が乖離する。
 */
export function resolveShopBuyPlan(ctx: ShopContext, product: ShopifyProduct): ShopBuyPlan {
  const variants = parseVariants(product.variants_json);
  const first = variants[0] ?? null;
  const variantId = first ? toNumericVariantId((first.id ?? first.admin_graphql_api_id) as never) : null;

  // 価格は**その variant の値**を優先する。products.price は「先頭 variant の価格」でしかなく、
  // multi-variant 商品では顧客が見る値と食い違う
  const priceJpy = safeYen(first?.price) ?? safeYen(product.price);

  const eligible =
    ctx.rankDiscountCode !== null && priceJpy !== null && priceJpy >= MIN_SUBTOTAL_JPY;

  const url = variantId
    ? buildCartPermalink(STOREFRONT_DOMAIN, [{ variantId, quantity: 1 }], eligible ? ctx.rankDiscountCode : null)
    : null;

  return {
    url,
    priceJpy,
    // URL を作れなかった行にラベルだけ出さない (「割引適用済み」の虚偽を構造的に防ぐ)
    discounted: eligible && url !== null,
    discountPercent: eligible && url !== null ? ctx.rankDiscountPercent : 0,
  };
}

/**
 * グリッドの中身: **過去購入の商品だけ** (新しい順)。
 *
 * ⚠️ 2026-08-23 Katsu 指示で「取扱商品で埋める」をやめた:
 *   同じ Shop タブの下に LINE UP (全商品) があるため、埋めると同じ商品が 2 度並び
 *   ページが伸びるだけで使いにくくなる。「再購入」は名前どおり買ったものだけを出す。
 *   購入履歴が無ければ空 (呼び出し側が案内文を出す)。
 */
export function buildShopGrid(ctx: ShopContext, limit = 12): ShopGridItem[] {
  const items: ShopGridItem[] = [];
  const used = new Set<string>();

  const push = (product: ShopifyProduct): void => {
    const pid = product.shopify_product_id != null ? String(product.shopify_product_id) : null;
    if (!pid || used.has(pid)) return;
    used.add(pid);

    const plan = resolveShopBuyPlan(ctx, product);
    const inSubs = ctx.subs.productIds.has(pid);
    items.push({
      productId: pid,
      title: String(product.title ?? ''),
      imageUrl: product.image_url ?? null,
      priceJpy: plan.priceJpy,
      productUrl: storefrontProductUrl(product.handle),
      subscriptionState: inSubs ? (ctx.subs.allPaused ? 'paused' : 'active') : null,
      discounted: plan.discounted,
      discountPercent: plan.discountPercent,
    });
  };

  for (const pid of ctx.purchasedOrder) {
    const p = ctx.productIndex.get(pid);
    if (p) push(p);
    if (items.length >= limit) return items;
  }
  return items;
}

/**
 * 購入時に確認 (ack) を求めるべきか。
 *
 * 🚨 「分からない」は必ず安全側 (確認を求める) に倒す。分からない形は 2 つある:
 *   (a) 稼働契約はあるが**どの注文にも辿り着けない** (productIds が空)
 *   (b) 稼働契約が複数あり、**一部の契約しか注文まで辿れていない** (allContractsResolved=false)
 *
 * 当初は (a) だけを見ていたが、採点ループが (b) を実測で突いた:
 * 契約 C1 (注文がローカルにある) と C2 (お届けが 60 日窓の外で注文が無い) を持つ顧客では
 * productIds={A} で size > 0 になるため、C2 の商品 B を**無確認で単発購入できてしまう**。
 * 「size > 0 なら全部わかった」は不明の代理指標で、本命の不明分布がその窓の内側にある
 * (memory: feedback_proxy_signal_fails_where_it_matters と同型)。
 *
 * バッジは助言、これが最終防壁 — 誤検出のコストは「1 タップ増える」= 回復可能。
 */
export function needsSubscriptionAck(ctx: ShopContext, productId: string): boolean {
  if (!ctx.subs.hasActiveContract) return false;
  // 稼働契約の中身を全部は把握できていない → どの商品でも確認する
  if (!ctx.subs.allContractsResolved) return true;
  return ctx.subs.productIds.has(productId);
}
