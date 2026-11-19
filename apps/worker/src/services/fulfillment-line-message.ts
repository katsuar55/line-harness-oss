/**
 * Shopify の発送 (fulfillments/create|update) のときに送る LINE の文を組み立てる。
 *
 * 2026-11-19: 領収書のページ (2Clover の公開ページ。注文番号 + 注文時のメールで表示) への
 * 案内を 1 行足した。Shopify の発送の確認メールに同じ日に入れた文と揃えている。
 * 通数 = 費用を増やさないため、吹き出しは 1 つのまま (改行で段落を分けるだけ)。
 */

/** 領収書を表示する公開ページ (2Clover。テナントは naturism 固定) */
export const RECEIPT_LOOKUP_URL = 'https://app.2clover.biz/receipt/lookup';

/** 注文番号として出してよい形 (例 #4625)。webhook 由来の文字列をそのまま文に混ぜないための allowlist */
const ORDER_NAME_PATTERN = /^#?[A-Za-z0-9_-]{1,32}$/;

/**
 * 発送の webhook と D1 の注文行から、お客様に見せる注文番号 (Shopify の order.name) を求める。
 *
 * 1. fulfillment.name は「注文名.発送の連番」(例 `#4625.1`) なので、最後の `.N` を外した部分を使う
 *    (店の注文番号の接頭辞をそのまま保てる)。
 * 2. 無ければ D1 の shopify_orders.order_number (整数) から `#4625` を作る。
 * 3. どちらも使えなければ null (文から番号の部分を省く)。
 */
export function resolveShopifyOrderName(
  fulfillmentName: unknown,
  orderNumber: unknown,
): string | null {
  if (typeof fulfillmentName === 'string') {
    const match = /^(.+)\.\d+$/.exec(fulfillmentName.trim());
    const name = match?.[1];
    if (name && ORDER_NAME_PATTERN.test(name)) {
      return name;
    }
  }

  const n = typeof orderNumber === 'string' ? Number(orderNumber) : orderNumber;
  if (typeof n === 'number' && Number.isSafeInteger(n) && n > 0) {
    return `#${n}`;
  }

  return null;
}

/** 領収書のページの案内文 (注文番号が分からないときは番号の部分を省く) */
export function buildReceiptGuide(orderName: string | null): string {
  // メールの文「注文番号 ({{ order.name }}) と、」と同じ形 (番号の後ろに半角スペース)
  const orderPart = orderName ? `注文番号 (${orderName}) ` : '注文番号';
  return `領収書が必要なお客様は、${orderPart}と、ご注文のときのメールアドレスを入れて表示してください: ${RECEIPT_LOOKUP_URL}`;
}

/** 発送の LINE の文 (1 通・吹き出し 1 つ) */
export function buildFulfillmentLineMessage(
  trackingNumber: string,
  orderName: string | null,
): string {
  return `ご注文の商品が発送されました！追跡番号: ${trackingNumber}\n\n${buildReceiptGuide(orderName)}`;
}
