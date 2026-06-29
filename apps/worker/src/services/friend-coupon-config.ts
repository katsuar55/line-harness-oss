/**
 * LINE 友だち限定クーポンの設定 (= ランク不問・全友だち向けの一律 % OFF クーポン)。
 *
 * 設計:
 *   - 設定は brand_config.metadata (JSON) の `friendCoupon` キーに格納 → 新規 migration 不要。
 *   - 既存ランク割引 (購入実績依存・gated) とは独立。「LINE が一番お得」を即時に出すための施策。
 *   - ON/OFF・割引%・コード(Shopify 側で作成した共有コード)・表示ラベル・補足を持つ。
 *   - 実際の割引適用は Shopify の discount code (cart permalink ?discount= / /discount/{code}) に委譲。
 */

export interface FriendCouponConfig {
  /** true = LIFF にクーポンカードを表示し、AI/導線で「LINE 限定 X%OFF」を出す */
  enabled: boolean;
  /** 割引率 (1-100、整数に丸め) */
  percent: number;
  /** Shopify 側で作成した割引コード (共有)。空なら enabled でも非表示 (= 設定不完全) */
  code: string;
  /** カードのラベル (例: LINE友だち限定クーポン) */
  label: string;
  /** 補足 (利用条件など。任意) */
  note: string;
}

export const FRIEND_COUPON_DEFAULTS: FriendCouponConfig = {
  enabled: false,
  percent: 5,
  code: '',
  label: 'LINE友だち限定クーポン',
  note: '',
};

function clampPercent(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return FRIEND_COUPON_DEFAULTS.percent;
  return Math.min(100, Math.max(1, Math.round(n)));
}

function toStr(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** brand_config.metadata.friendCoupon を正規化して読む (壊れた JSON / 欠損は default で吸収)。 */
export async function getFriendCouponConfig(db: D1Database): Promise<FriendCouponConfig> {
  const row = await db
    .prepare(`SELECT metadata FROM brand_config WHERE is_default = 1 LIMIT 1`)
    .bind()
    .first<{ metadata: string | null }>();
  if (!row) return { ...FRIEND_COUPON_DEFAULTS };
  let meta: Record<string, unknown> = {};
  try {
    meta = JSON.parse(row.metadata || '{}') as Record<string, unknown>;
  } catch {
    meta = {};
  }
  const fc = (meta.friendCoupon ?? {}) as Partial<FriendCouponConfig>;
  const label = toStr(fc.label).trim();
  return {
    enabled: fc.enabled === true,
    percent: clampPercent(fc.percent),
    code: toStr(fc.code).trim(),
    label: label || FRIEND_COUPON_DEFAULTS.label,
    note: toStr(fc.note),
  };
}

/**
 * friendCoupon 設定を patch でマージして保存 (= brand_config.metadata の他キーは保持)。
 * 未指定の field は現状値を維持する (partial update)。
 */
export async function setFriendCouponConfig(
  db: D1Database,
  patch: Partial<FriendCouponConfig>,
): Promise<FriendCouponConfig> {
  const row = await db
    .prepare(`SELECT metadata FROM brand_config WHERE is_default = 1 LIMIT 1`)
    .bind()
    .first<{ metadata: string | null }>();
  if (!row) throw new Error('brand_config default row not found');
  let meta: Record<string, unknown> = {};
  try {
    meta = JSON.parse(row.metadata || '{}') as Record<string, unknown>;
  } catch {
    meta = {};
  }
  const current = (meta.friendCoupon ?? {}) as Partial<FriendCouponConfig>;
  const merged: FriendCouponConfig = {
    enabled: patch.enabled !== undefined ? patch.enabled === true : current.enabled === true,
    percent: patch.percent !== undefined ? clampPercent(patch.percent) : clampPercent(current.percent),
    code: patch.code !== undefined ? toStr(patch.code).trim() : toStr(current.code).trim(),
    label:
      patch.label !== undefined
        ? toStr(patch.label).trim() || FRIEND_COUPON_DEFAULTS.label
        : toStr(current.label).trim() || FRIEND_COUPON_DEFAULTS.label,
    note: patch.note !== undefined ? toStr(patch.note) : toStr(current.note),
  };
  meta.friendCoupon = merged;
  const updatedAt = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
  await db
    .prepare(`UPDATE brand_config SET metadata = ?, updated_at = ? WHERE is_default = 1`)
    .bind(JSON.stringify(meta), updatedAt)
    .run();
  return merged;
}
