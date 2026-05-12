/**
 * brand_config DB layer (Phase 5α-9 / Ultraplan v4 大方針 2)
 *
 * 役割:
 *   - 業種非依存コア + 業種プラグイン設計の基盤
 *   - email_templates / scenarios の {{brand_name}} {{shop_url}} 等の変数値を提供
 *   - line_account_id ごとに別 brand を運用可能 (multi-brand)
 *   - line_account_id NULL の「default brand」 を必ず 1 行保持 (system fallback)
 *
 * 設計方針:
 *   - getBrandConfigForAccount(db, accountId|null): account-specific が無ければ default を返す
 *   - getDefaultBrandConfig(db): is_default=1 row を返す (migration 047 で seed 済)
 *   - upsertBrandConfig: id 衝突時は UPDATE (created_at 保持、 updated_at 更新)
 *
 * 関連: packages/db/migrations/047_brand_config.sql
 */

import { jstNow } from './utils.js';

export interface BrandConfig {
  id: string;
  line_account_id: string | null;
  is_default: number;
  brand_name: string;
  company_name: string | null;
  support_email: string | null;
  shop_url: string | null;
  subscription_url: string | null;
  primary_color: string;
  intro_product_label: string | null;
  logo_url: string | null;
  /** JSON 文字列。 industry / plan / 業種固有設定 等 */
  metadata: string;
  created_at: string;
  updated_at: string;
}

/**
 * テンプレ送信時 variables に注入する形 (key 名は {{brand_name}} 等の placeholder と対応)。
 * NULL/undefined 値は空文字列として返す (template 内の {{var}} が空に展開されるため)。
 */
export interface BrandVariables {
  brand_name: string;
  company_name: string;
  support_email: string;
  shop_url: string;
  subscription_url: string;
  primary_color: string;
  intro_product_label: string;
  logo_url: string;
}

export function brandToVariables(brand: BrandConfig): BrandVariables {
  return {
    brand_name: brand.brand_name,
    company_name: brand.company_name ?? '',
    support_email: brand.support_email ?? '',
    shop_url: brand.shop_url ?? '',
    subscription_url: brand.subscription_url ?? '',
    primary_color: brand.primary_color,
    intro_product_label: brand.intro_product_label ?? '',
    logo_url: brand.logo_url ?? '',
  };
}

/**
 * default brand を取得 (is_default=1 row、 migration 047 で seed 済)。
 * 1 行も無い場合は null (異常系、 caller が fallback ハンドリング)。
 */
export async function getDefaultBrandConfig(
  db: D1Database,
): Promise<BrandConfig | null> {
  // .bind() を経由するのは worker test の fake D1 が prepare().first() 直接呼び未対応のため
  return db
    .prepare(`SELECT * FROM brand_config WHERE is_default = 1 LIMIT 1`)
    .bind()
    .first<BrandConfig>();
}

/**
 * account-specific な brand を取得。 account 指定が NULL or 該当 row が無ければ default を返す。
 *
 * 用途: send-email-action / scenario delivery 等で「この account の brand 値が欲しい」 とき。
 * caller が friend.line_account_id を取得して渡す。
 */
export async function getBrandConfigForAccount(
  db: D1Database,
  accountId: string | null | undefined,
): Promise<BrandConfig | null> {
  if (accountId) {
    const account = await db
      .prepare(`SELECT * FROM brand_config WHERE line_account_id = ? LIMIT 1`)
      .bind(accountId)
      .first<BrandConfig>();
    if (account) return account;
  }
  return getDefaultBrandConfig(db);
}

export interface UpsertBrandConfigInput {
  id: string;
  lineAccountId?: string | null;
  isDefault?: boolean;
  brandName: string;
  companyName?: string | null;
  supportEmail?: string | null;
  shopUrl?: string | null;
  subscriptionUrl?: string | null;
  primaryColor?: string;
  introProductLabel?: string | null;
  logoUrl?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * brand_config を UPSERT (id 衝突時は UPDATE、 created_at 保持)。
 * 注意: is_default=1 は partial unique index で 1 行のみ強制 (2 行目を作ると CONSTRAINT エラー)。
 */
export async function upsertBrandConfig(
  db: D1Database,
  input: UpsertBrandConfigInput,
): Promise<BrandConfig> {
  const now = jstNow();
  const metadata = JSON.stringify(input.metadata ?? {});
  await db
    .prepare(
      `INSERT INTO brand_config (
        id, line_account_id, is_default, brand_name, company_name, support_email,
        shop_url, subscription_url, primary_color, intro_product_label, logo_url, metadata,
        created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        line_account_id = excluded.line_account_id,
        is_default = excluded.is_default,
        brand_name = excluded.brand_name,
        company_name = excluded.company_name,
        support_email = excluded.support_email,
        shop_url = excluded.shop_url,
        subscription_url = excluded.subscription_url,
        primary_color = excluded.primary_color,
        intro_product_label = excluded.intro_product_label,
        logo_url = excluded.logo_url,
        metadata = excluded.metadata,
        updated_at = excluded.updated_at`,
    )
    .bind(
      input.id,
      input.lineAccountId ?? null,
      input.isDefault ? 1 : 0,
      input.brandName,
      input.companyName ?? null,
      input.supportEmail ?? null,
      input.shopUrl ?? null,
      input.subscriptionUrl ?? null,
      input.primaryColor ?? '#06C755',
      input.introProductLabel ?? null,
      input.logoUrl ?? null,
      metadata,
      now,
      now,
    )
    .run();
  const result = await db
    .prepare(`SELECT * FROM brand_config WHERE id = ?`)
    .bind(input.id)
    .first<BrandConfig>();
  if (!result) throw new Error(`upsertBrandConfig: failed to read back id=${input.id}`);
  return result;
}
