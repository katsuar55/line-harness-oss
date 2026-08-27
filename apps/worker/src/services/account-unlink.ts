/**
 * アカウント連携の解除サービス (2026-08-28)
 *
 * DB の巻き戻し本体は packages/db の unlinkFriendFromShopifyCustomer (= 何を消して何を残すかの
 * 判断はそちらの冒頭コメントが正)。ここは **監査** と **Shopify metafield の後始末** を足す。
 *
 * ## 🚨 metafield を消さないと cron が連携を復活させうる
 * OTP 連携は成功時に Shopify customer の metafield へ line_user_id を書く
 * (services/account-link.ts の setCustomerLineUserIdMetafield)。一方 friend-customer-linker cron は
 * metafield を逆引きして friends.shopify_customer_id を埋め直す。
 * 両者の namespace は本番で別 (cron=FRIEND_LINK_METAFIELD_* / OTP=ACCOUNT_LINK_METAFIELD_*) だが、
 * **どちらの経路で連携したかは解除時点では判別できない**。片方だけ消すと、cron 由来で連携した顧客の
 * metafield が残って翌 02:00 に連携が復活する (本番の連携 10 件のうち 1 件は実際に cron 由来)。
 * したがって解除時は **2 系統とも消す** (best-effort、同値なら 1 回だけ)。
 *
 * ## 実行者の記録
 * 顧客自身の解除 (LIFF) と運用者の解除 (admin) を audit の actor で区別する。
 * 誤連携の是正なのか顧客の意思なのかを事後に切り分けられないと、再連携の可否を判断できない。
 */
import { unlinkFriendFromShopifyCustomer, type UnlinkResult } from '@line-crm/db';
import { auditSystem } from './audit-logger.js';
import { getShopifyAccessToken } from './shopify-token.js';
import { deleteCustomerLineUserIdMetafield } from './account-link-shopify.js';

const DEFAULT_METAFIELD_NAMESPACE = 'naturism';
const DEFAULT_METAFIELD_KEY = 'line_user_id';

export interface UnlinkEnv {
  DB: D1Database;
  SHOPIFY_STORE_DOMAIN?: string;
  SHOPIFY_CLIENT_ID?: string;
  SHOPIFY_CLIENT_SECRET?: string;
  SHOPIFY_TOKEN_ENCRYPTION_KEY?: string;
  /** OTP 連携が書き込む metafield (services/account-link.ts)。 */
  ACCOUNT_LINK_METAFIELD_NAMESPACE?: string;
  ACCOUNT_LINK_METAFIELD_KEY?: string;
  /**
   * cron (services/friend-customer-linker.ts) が**逆引きに使う** metafield。
   * ACCOUNT_LINK_* と別値のことがあるため、解除時は両方消す (= cron による復活の阻止)。
   */
  FRIEND_LINK_METAFIELD_NAMESPACE?: string;
  FRIEND_LINK_METAFIELD_KEY?: string;
}

export interface UnlinkOptions {
  friendId: string;
  /** 'customer' = 本人が LIFF から解除 / 'admin' = 運用者が代行。audit の actor に残る。 */
  actor: 'customer' | 'admin';
  /** 運用者の識別子 (admin のときのみ)。PII は入れない。 */
  actorId?: string | null;
  /** test 用注入。 */
  deleteMetafieldImpl?: typeof deleteCustomerLineUserIdMetafield;
  fetchImpl?: typeof fetch;
}

export interface UnlinkOutcome extends UnlinkResult {
  /** Shopify metafield を消せたか (未設定・失敗時 false)。連携解除の成否とは独立。 */
  readonly metafieldDeleted: boolean;
}

export async function unlinkAccount(env: UnlinkEnv, options: UnlinkOptions): Promise<UnlinkOutcome> {
  const result = await unlinkFriendFromShopifyCustomer(env.DB, options.friendId);

  // 未連携なら書込ゼロ = 監査も残さない (冪等な no-op)
  if (!result.unlinked) return { ...result, metafieldDeleted: false };

  // metafield の後始末 (best-effort)。ここで失敗しても D1 の解除は既に成立している。
  //
  // 🚨 **2 系統ぶん消す** (Codex P1 2026-08-28)。
  //   OTP 連携は ACCOUNT_LINK_METAFIELD_* に書き、cron (friend-customer-linker) は
  //   FRIEND_LINK_METAFIELD_* を読んで自動連携する。本番ではこの 2 つが別の値なので、
  //   ACCOUNT_LINK 側だけ消すと **cron 由来で連携した顧客の metafield が残り、翌 02:00 の
  //   cron が解除したはずの連携を復活させる**。本番の連携 10 件のうち 1 件は実際に cron 由来。
  //   どちらの経路で連携したかは解除時点では判別できないので、両方消すのが唯一安全な選択。
  let metafieldDeleted = false;
  try {
    if (env.SHOPIFY_STORE_DOMAIN) {
      const token = await getShopifyAccessToken(env.DB, env as unknown as Record<string, string | undefined>);
      const del = options.deleteMetafieldImpl ?? deleteCustomerLineUserIdMetafield;
      const fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
      const customerId = result.shopifyCustomerId as string;

      // 重複を除いた (namespace, key) の集合。同値なら 1 回だけ呼ぶ。
      const targets = new Map<string, { ns: string; key: string }>();
      const add = (ns: string, key: string) => targets.set(`${ns} ${key}`, { ns, key });
      add(
        env.ACCOUNT_LINK_METAFIELD_NAMESPACE || DEFAULT_METAFIELD_NAMESPACE,
        env.ACCOUNT_LINK_METAFIELD_KEY || DEFAULT_METAFIELD_KEY,
      );
      add(
        env.FRIEND_LINK_METAFIELD_NAMESPACE || DEFAULT_METAFIELD_NAMESPACE,
        env.FRIEND_LINK_METAFIELD_KEY || DEFAULT_METAFIELD_KEY,
      );

      // 全部消せて初めて true (1 つでも残ると cron に復活させられる余地が残る)
      let allOk = true;
      for (const { ns, key } of targets.values()) {
        const r = await del(env.SHOPIFY_STORE_DOMAIN, token, customerId, ns, key, fetchImpl);
        if (!r.ok) allOk = false;
      }
      metafieldDeleted = allOk;
    }
  } catch (err) {
    console.warn('[account-unlink] metafield delete failed (non-fatal):', err instanceof Error ? err.message : 'unknown');
  }

  // 監査 (PII なし)。cleared の内訳まで残すのは、誤連携の影響範囲を事後に測るため。
  await auditSystem(env.DB, {
    action: 'account_link.unlinked',
    // auditSystem の actorType は system/cron/webhook/api のみ。実行者の区別は metadata に持つ
    actorType: 'api',
    actorId: options.actorId ?? undefined,
    targetType: 'friend',
    targetId: options.friendId,
    result: 'success',
    metadata: {
      shopifyCustomerId: result.shopifyCustomerId,
      // 誤連携の是正 (admin) か顧客の意思 (customer) かは再連携の可否判断に要る
      unlinkedBy: options.actor,
      cleared: result.cleared,
      metafieldDeleted,
      // 🚨 連携特典 ¥300 の台帳は意図的に残している (二重発行防止の冪等キー)
      linkRewardLedgerKept: true,
    },
  });

  return { ...result, metafieldDeleted };
}
