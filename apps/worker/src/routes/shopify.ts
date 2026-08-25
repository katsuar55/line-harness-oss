import { Hono } from 'hono';
import {
  addPurchaseEvent,
  reconcilePurchaseEventAmount,
  upsertShopifyOrder,
  upsertShopifyCustomer,
  upsertShopifyProduct,
  getShopifyOrders,
  getShopifyOrderById,
  getShopifyCustomers,
  getShopifyOrderByShopifyId,
  getShopifyCustomerByShopifyId,
  linkShopifyCustomerToFriend,
  getSubscriptionContract,
  listContractsWithSkipBaselineDrift,
  insertCronRunLog,
  jstNow,
  type SubscriptionContractRow,
} from '@line-crm/db';
import type { Env } from '../index.js';
import { verifyShopifySignature } from '../utils/shopify-hmac.js';
import { getShopifyAccessToken } from '../services/shopify-token.js';
// 第2波-⑤: welcome クーポン redemption 追跡。 軽量 service のため static import
// (vi.mock + dynamic import 干渉トラップ回避、 CLAUDE.md テストルール準拠)。
import { processOrderCouponRedemption } from '../services/coupon-redemption.js';
import {
  processReferralRewardOnPurchase,
  activateAndNotifyNextReferralCoupon,
} from '../services/referral-reward.js';
import {
  deriveContractFromOrder,
  applyCustomerTagsToContracts,
  rebuildContractsFromD1,
  recordFlowMeasurement,
  toJstDate,
  isSubscriptionIngestEnabled,
} from '../services/subscription-contracts.js';
import { LineClient } from '@line-crm/line-sdk';

const shopify = new Hono<Env>();

// teiki-flow secret 未設定ログの flood 抑制フラグ (isolate ごと初回のみ、採点R4)
let warnedTeikiFlowSecretMissing = false;
/**
 * 401 の cron_run_logs 記録も isolate ごと初回のみに絞る。
 * この endpoint は auth skip-list に載っていて**誰でも叩ける**ため、無条件に記録すると
 * 未認証リクエストで D1 を膨らませられる。診断に必要なのは「401 が起きているか」であって
 * 回数ではないので、isolate ごと 1 回で十分 (isolate は頻繁に入れ替わる)。
 */
let loggedTeikiFlowUnauthorized = false;

/** teiki-flow 受信の outcome を記録する cron_run_logs の jobName (cron-monitor の監視対象) */
const TEIKI_FLOW_INGEST_JOB_NAME = 'teiki-flow-ingest';

// POST /api/integrations/teiki-flow — Shopify Flow「HTTP リクエストを送信」からの
// サブスク実測値受信 (WI-2)。Huckleberry の Flow Trigger が持つ「次回決済日」を受け取り、
// 推定 (derived) を実測 (flow) に昇格させる。設定手順: docs/TEIKI_FLOW_SETUP.md。
// 認可: 共有シークレットヘッダ (auth skip-list に POST 限定で登録済み、ここで検証)。
shopify.post('/api/integrations/teiki-flow', async (c) => {
  /**
   * 受信結果を cron_run_logs に残す (best-effort)。
   *
   * これが無いと「実測 0 件」の原因が **D1 からは一切切り分けられない**:
   * 「まだ発火していない」も「全送信が secret 不一致で 401」も「契約ID の変数間違いで
   * 全件 unknown_contract」も、どれも estimate_source='flow' が 0 件という同じ見え方になる。
   * これはこのプロジェクトが 2.5 ヶ月間気付かなかった障害と同じ「静かな失敗」の形。
   *
   * ⚠️ body の値 (契約ID・日付) は記録しない。件数と outcome だけで切り分けられる。
   */
  const logOutcome = async (outcome: string): Promise<void> => {
    try {
      await insertCronRunLog(c.env.DB, {
        jobName: TEIKI_FLOW_INGEST_JOB_NAME,
        status: outcome === 'measured' ? 'success' : 'partial',
        metrics: { outcome },
      });
    } catch (err) {
      // 記録の失敗で受信そのものを落とさない (Flow に不要な 5xx リトライをさせない)
      console.error('teiki-flow: outcome log failed:', err);
    }
  };

  const secret = c.env.TEIKI_FLOW_SECRET;
  if (!secret) {
    // 未設定も 401 に畳む (採点R3: 503 だと未認証呼び出し元に secret の設定状態が開示される)。
    // setup デバッグ用の区別はサーバ側ログのみ。isolate ごと初回のみ出力 (採点R4: 未認証
    // リクエストのスパムでログが flood しないように)。
    if (!warnedTeikiFlowSecretMissing) {
      warnedTeikiFlowSecretMissing = true;
      console.error('teiki-flow: TEIKI_FLOW_SECRET 未設定のため拒否 (docs/TEIKI_FLOW_SETUP.md)');
    }
    return c.json({ success: false, error: 'unauthorized' }, 401);
  }
  const provided = c.req.header('x-teiki-flow-secret') ?? '';
  if (!(await constantTimeEqual(provided, secret))) {
    if (!loggedTeikiFlowUnauthorized) {
      loggedTeikiFlowUnauthorized = true;
      await logOutcome('unauthorized');
    }
    return c.json({ success: false, error: 'unauthorized' }, 401);
  }
  // gate OFF 中は read-model を触らない (202 = Flow 側にリトライさせない)。
  // 収集 gate (INGEST) で判定する — 顧客可視 gate (MENU) を開ける前に実測値を貯めたい
  // (貯めないと日付の無い契約カードを顧客に見せることになる) ため。
  if (!isSubscriptionIngestEnabled(c.env)) {
    await logOutcome('gate_off');
    return c.json({ success: true, data: { skipped: 'gate_off' } }, 202);
  }

  // body の解釈エラーのみ 400。D1 等の実行時障害は 500 (Flow 側の再実行対象) に分ける (採点R1)
  let contractId = '';
  let date: string | null = null;
  try {
    const body = await c.req.json<{ contract_id?: string | number; next_billing_date?: string }>();
    contractId = body.contract_id != null ? String(body.contract_id).trim() : '';
    date = toJstDate(body.next_billing_date ?? null);
  } catch {
    await logOutcome('bad_request');
    return c.json({ success: false, error: 'JSON body を解釈できません' }, 400);
  }
  if (!contractId || !date) {
    await logOutcome('bad_request');
    return c.json(
      { success: false, error: 'contract_id と next_billing_date (日付) が必要です' },
      400,
    );
  }

  try {
    // 未知の契約 ID では phantom 行を作らない (注文 webhook 由来の既知契約のみ実測を受ける)。
    // 200 で受けるのは意図的 (採点R2): 契約作成トリガーが orders webhook より先着する race で
    // 4xx を返すと Shopify Flow は再試行せず実行ログも赤くなる。次のトリガーで自然回復する。
    // read-model の契約 ID は Huckleberry のタグ (`subscription-{ID}-plan` 等) 由来の素の ID。
    // Flow の変数ピッカーが GID (`gid://shopify/SubscriptionContract/123`) を返す可能性があるため、
    // 素の値で引けなければ末尾セグメントでも引く (取り違えないよう照合先は D1 の実在行のみ)。
    const resolved = await resolveContractRow(c.env.DB, contractId);
    if (!resolved) {
      console.info(`teiki-flow: unknown contract ${contractId} (derive 前の race の可能性)`);
      await logOutcome('unknown_contract');
      return c.json({
        success: true,
        data: {
          skipped: 'unknown_contract',
          contractId,
          // Flow の実行ログに出る唯一の手掛かり。設定直後の「全件 skipped」が
          // 「変数の選び間違い」なのか「新規契約の race」なのか切り分けられるようにする。
          hint: 'この契約IDに一致する行がありません。Body の contract_id に「契約ID」変数が入っているか確認してください (新規契約直後なら次回発火で自然回復します)',
        },
      });
    }
    // 実測はアンカーとして記録し、実効値 (= 未消化スキップぶんの先送り後) は service が決める。
    // raw upsert で estimate_source='flow' を書かないこと — 基準値が伴わない flow 行は
    // 次の refreshEstimate で skip 累計ぶんを丸ごと先送りする (migration 074)。
    const updated = await recordFlowMeasurement(c.env.DB, resolved, date);
    await logOutcome('measured');
    return c.json({
      success: true,
      data: {
        contractId: resolved.contract_id,
        // measured = 受け取った実測日。nextBillingEstimate = 実際に採用した日付。
        // 未消化スキップがあると先送りされ、周期不明なら null になる (日付を出さない誠実側)。
        measured: date,
        nextBillingEstimate: updated.next_billing_estimate,
        source: 'flow',
      },
    });
  } catch (err) {
    console.error('POST /api/integrations/teiki-flow error:', err);
    await logOutcome('error');
    return c.json({ success: false, error: 'internal error' }, 500);
  }
});

/**
 * Flow から届いた契約 ID を D1 の実在行へ解決する。見つからなければ null。
 * 素の ID → GID の末尾セグメント の順に試す (phantom 行は作らないので、
 * 実在しない ID がどちらの形式で来ても結果は unknown_contract のまま)。
 */
async function resolveContractRow(
  db: D1Database,
  contractId: string,
): Promise<SubscriptionContractRow | null> {
  const direct = await getSubscriptionContract(db, contractId);
  if (direct) return direct;
  const tail = contractId.includes('/') ? contractId.slice(contractId.lastIndexOf('/') + 1) : '';
  if (tail) return getSubscriptionContract(db, tail);
  return null;
}

/** 共有シークレットの定数時間比較 (SHA-256 digest 同士を比較して長さ・内容の timing 差を消す)。 */
async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [da, dbuf] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  const ua = new Uint8Array(da);
  const ub = new Uint8Array(dbuf);
  let diff = 0;
  for (let i = 0; i < ua.length; i += 1) diff |= ua[i] ^ ub[i];
  return diff === 0;
}

// サブスク契約 read-model の一括再構築 (WI-1 バックフィル)。
// 既存 D1 (shopify_orders / shopify_customers) のタグから導出するだけで Shopify API は叩かない。
// 冪等 (何度実行しても同じ結果に収束)。認可は /api 共通 Bearer。
// **gate 非連動** (採点R1 修正): 有効化手順は migration 069 → rebuild → gate ON の順であり、
// gate ON 前に read-model を温めておく必要がある (gate ON 直後に空カードを出さないため)。
// read-model への書込は gate OFF 中の本番挙動に一切影響しない (読む経路が全て gate 内)。
// ⚠️ 再実行は「未消化スキップの先送り」を恒久的に消すため ?force=1 を要求する (採点R2)。
//    判定は **gate 状態ではなく drift の実在** で行う。
//    以前は収集 gate (INGEST || MENU) を条件にしていたが、`disable-subscription-ingest` を
//    先に実行してから rebuild すると第一項が false になり、**ガードが丸ごと消えて**
//    force 未指定でも素通りした (「rebuild 前に収集を止めておこう」は自然な判断なので踏みやすい)。
//    守りたいのは gate ではなく「消えると復元できない drift」そのものなので、直接それを見る。
//    全 gate OFF での bootstrap (migration → rebuild → gate ON) は drift 0 なので従来どおり通る。
shopify.post('/api/integrations/shopify/subscription-contracts/rebuild', async (c) => {
  if (c.req.query('force') !== '1') {
    // 1 件でもあれば拒否する (件数は報告のために取得。LIMIT で全件走査は避ける)
    const drifted = await listContractsWithSkipBaselineDrift(c.env.DB, 100);
    if (drifted.length > 0) {
      return c.json({
        success: false,
        error:
          `未消化のスキップ先送りが ${drifted.length}${drifted.length >= 100 ? '+' : ''} 件あります。` +
          'rebuild はこれを恒久的に消去し (履歴から復元不能)、スキップ済みの顧客へ 1 周期早い' +
          'リマインドが飛ぶ状態を作ります。Flow 実測アンカーの先送りも同様に巻き戻ります。' +
          '承知の上で実行する場合は ?force=1 を付けてください。',
      }, 409);
    }
  }
  try {
    const result = await rebuildContractsFromD1(c.env.DB);
    return c.json({ success: true, data: result });
  } catch (err) {
    console.error('POST subscription-contracts/rebuild error:', err);
    return c.json({ success: false, error: 'rebuild failed' }, 500);
  }
});

// ========== ヘルパー: Webhookログ ==========

async function logWebhook(
  db: D1Database,
  topic: string,
  shopifyId: string | undefined,
  status: string,
  summary?: string,
  error?: string,
): Promise<void> {
  try {
    const now = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().replace('Z', '');
    await db
      .prepare(
        `INSERT INTO shopify_webhook_log (topic, shopify_id, status, summary, error, received_at) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(topic, shopifyId ?? null, status, summary ?? null, error ?? null, now)
      .run();
  } catch (err) {
    console.error('Webhook log write failed:', err);
  }
}

// ========== ヘルパー: friend マッチング + users.email/phone back-fill (Round 4 PR-0) ==========
//
// Phase 6 KPI レポートで判明した課題:
//   users.email が常に NULL → email マッチング 0 件 → Phase 6 PR-2 enroll が永遠に発火しない
//
// 対策:
//   1. 既存通り email → phone の順で friend を引き当てる
//   2. **片方で見つかった時、もう片方が NULL なら Shopify 側の値で back-fill**
//      (email で見つかったら phone を、phone で見つかったら email を埋める)
//   3. これにより LINE Console の email scope 申請承認が遅れていても、
//      Shopify 注文経由で users.email を蓄積できる
//
// 副次効果: 将来 LIFF login で email scope 取得が動き出した時、
//   既に email が入っていれば再度同期する必要なし。

export interface MatchResult {
  friendId: string | null;
  matchedBy: 'email' | 'phone' | null;
  backfilled: 'email' | 'phone' | 'none';
}

export async function findFriendAndBackfill(
  db: D1Database,
  email: string | undefined,
  phone: string | undefined,
): Promise<MatchResult> {
  let userId: string | null = null;
  let userRow: { id: string; email: string | null; phone: string | null } | null = null;
  let matchedBy: 'email' | 'phone' | null = null;

  // 1. email 優先で user を検索
  if (email) {
    const u = await db
      .prepare(`SELECT id, email, phone FROM users WHERE email = ?`)
      .bind(email)
      .first<{ id: string; email: string | null; phone: string | null }>();
    if (u) {
      userId = u.id;
      userRow = u;
      matchedBy = 'email';
    }
  }

  // 2. phone fallback
  const normalizedPhone = phone ? phone.replace(/[^0-9+]/g, '') : null;
  if (!userId && normalizedPhone) {
    const u = await db
      .prepare(`SELECT id, email, phone FROM users WHERE phone = ?`)
      .bind(normalizedPhone)
      .first<{ id: string; email: string | null; phone: string | null }>();
    if (u) {
      userId = u.id;
      userRow = u;
      matchedBy = 'phone';
    }
  }

  // 3. 見つからない場合は何もせず null を返す
  if (!userId || !userRow) {
    return { friendId: null, matchedBy: null, backfilled: 'none' };
  }

  // 4. 反対側のフィールドが NULL なら Shopify 値で back-fill
  let backfilled: MatchResult['backfilled'] = 'none';
  if (matchedBy === 'phone' && email && (!userRow.email || userRow.email === '')) {
    // phone で見つかったが email が空 → Shopify email を埋める
    await db
      .prepare(`UPDATE users SET email = ? WHERE id = ? AND (email IS NULL OR email = '')`)
      .bind(email, userId)
      .run();
    backfilled = 'email';
  } else if (matchedBy === 'email' && normalizedPhone && (!userRow.phone || userRow.phone === '')) {
    // email で見つかったが phone が空 → Shopify phone を埋める
    await db
      .prepare(`UPDATE users SET phone = ? WHERE id = ? AND (phone IS NULL OR phone = '')`)
      .bind(normalizedPhone, userId)
      .run();
    backfilled = 'phone';
  }

  // 5. friend を取得
  const friend = await db
    .prepare(`SELECT id FROM friends WHERE user_id = ?`)
    .bind(userId)
    .first<{ id: string }>();

  return {
    friendId: friend?.id ?? null,
    matchedBy,
    backfilled,
  };
}

// ========== Shopify Webhookレシーバー ==========

shopify.post('/api/integrations/shopify/webhook', async (c) => {
  try {
    const shopifySecret = (c.env as unknown as Record<string, string | undefined>).SHOPIFY_WEBHOOK_SECRET;
    let body: Record<string, unknown>;

    // 署名検証に使うシークレット（SHOPIFY_WEBHOOK_SECRET → SHOPIFY_CLIENT_SECRET の優先順）
    const envRecord = c.env as unknown as Record<string, string | undefined>;
    const webhookSecret = envRecord.SHOPIFY_WEBHOOK_SECRET;
    const clientSecret = envRecord.SHOPIFY_CLIENT_SECRET;
    const signingSecret = webhookSecret || clientSecret;

    if (signingSecret) {
      // 署名検証モード（本番環境）
      const hmacHeader = c.req.header('X-Shopify-Hmac-Sha256') ?? '';
      const rawBody = await c.req.text();

      // まず主シークレットで検証
      let valid = await verifyShopifySignature(signingSecret, rawBody, hmacHeader);

      // 主シークレットで失敗した場合、もう一方で再試行
      if (!valid && webhookSecret && clientSecret && webhookSecret !== clientSecret) {
        valid = await verifyShopifySignature(clientSecret, rawBody, hmacHeader);
        if (valid) {
          console.warn('Shopify HMAC: succeeded with CLIENT_SECRET, not WEBHOOK_SECRET — consider updating SHOPIFY_WEBHOOK_SECRET');
          // セキュリティイベントとしてD1に記録（WEBHOOK_SECRETの不一致を追跡）
          const secTopic = c.req.header('X-Shopify-Topic') ?? 'unknown';
          await logWebhook(c.env.DB, secTopic, undefined, 'security_warning', 'HMAC verified via CLIENT_SECRET fallback — SHOPIFY_WEBHOOK_SECRET may be misconfigured');
        }
      }

      if (!valid) {
        const topic = c.req.header('X-Shopify-Topic') ?? '';
        const debugInfo = `hmac_len=${hmacHeader.length} body_len=${rawBody.length} tried=${webhookSecret ? 'webhook+client' : 'client_only'}`;
        console.error(`Shopify HMAC failed: ${debugInfo}`);
        await logWebhook(c.env.DB, topic, undefined, 'auth_failed', `HMAC verification failed: ${debugInfo}`);
        return c.json({ success: false, error: 'Shopify signature verification failed' }, 401);
      }
      body = JSON.parse(rawBody) as Record<string, unknown>;
    } else {
      // シークレット未設定 — セキュリティのため本番では拒否
      console.error('Shopify webhook rejected: no signing secret configured');
      return c.json({ success: false, error: 'Webhook secret not configured' }, 500);
    }

    const topic = c.req.header('X-Shopify-Topic') ?? '';
    const db = c.env.DB;

    // 注文イベント
    // 会員ランクの原資 (member_purchase_events) の取り込み。
    // **既定 ON**: off で出荷すると「本番でずっと壊れていた状態」をそのまま出すことになる。
    // 止めたいときだけ MEMBER_INGEST_ENABLED='false' を投入する (redeploy 不要の kill switch)。
    // 返金系の financial_status。 これが届いたら記録済みの購入額を実額へ付け替える
    const REFUND_STATUSES = new Set(['refunded', 'partially_refunded', 'voided']);
    const MEMBER_INGEST_ON =
      (c.env as unknown as Record<string, string | undefined>).MEMBER_INGEST_ENABLED !== 'false';

    if (topic === 'orders/create' || topic === 'orders/updated') {
      const shopifyOrderId = String(body.id ?? '');

      // 冪等性チェック（orders/create の重複受信対策）
      if (topic === 'orders/create') {
        const existing = await getShopifyOrderByShopifyId(db, shopifyOrderId);
        if (existing) {
          return c.json({ success: true, data: { message: 'Already processed' } });
        }
      }

      const customer = body.customer as Record<string, unknown> | undefined;
      const email = (body.email as string) ?? (customer?.email as string) ?? undefined;
      const phone = (body.phone as string) ?? (customer?.phone as string) ?? undefined;
      const shopifyCustomerId = customer?.id ? String(customer.id) : undefined;
      const totalPrice = body.total_price ? Number(body.total_price) : undefined;
      const lineItemsRaw = body.line_items as Array<Record<string, unknown>> | undefined;
      // 会員ランクの原資 (member_purchase_events) 用。 Shopify の注文作成時刻をそのまま使う —
      // ここを now にすると orders/updated で届いた**古い注文**が直近12ヶ月に誤計上され、
      // ランクが膨張する (migration 063 で occurred_at を足した理由そのもの)。
      const orderFinancialStatus = (body.financial_status as string) ?? '';
      const orderOccurredAt = (body.created_at as string) ?? null;

      await logWebhook(db, topic, shopifyOrderId, 'received', `order #${body.order_number ?? '?'} ¥${body.total_price ?? '?'}`);

      const order = await upsertShopifyOrder(db, {
        shopifyOrderId,
        shopifyCustomerId,
        email,
        phone,
        totalPrice,
        currency: (body.currency as string) ?? 'JPY',
        financialStatus: (body.financial_status as string) ?? undefined,
        fulfillmentStatus: (body.fulfillment_status as string) ?? undefined,
        orderNumber: body.order_number ? Number(body.order_number) : undefined,
        lineItems: lineItemsRaw ? JSON.stringify(lineItemsRaw) : undefined,
        tags: (body.tags as string) ?? undefined,
        // order_created_at = Shopify の実注文日時 (WI-1 採点R2)。サブスク rebuild が推定アンカーに
        // 使う (D1 行の created_at は到達時刻で、手動 sync 由来の行では取り込み時刻になるため)。
        metadata: JSON.stringify({
          source: 'webhook',
          topic,
          order_created_at: (body.created_at as string) ?? null,
        }),
      });

      await logWebhook(db, topic, shopifyOrderId, 'processed', `saved as ${order.id}`);

      // サブスク契約 read-model 導出 (WI-1, docs/SUBSCRIPTION_ULTRAPLAN_2026-07-14.md)。
      // gate OFF なら完全 no-op (= migration 069 未適用でも安全)。失敗しても注文処理は継続。
      if (isSubscriptionIngestEnabled(c.env)) {
        try {
          await deriveContractFromOrder(db, {
            tags: (body.tags as string) ?? null,
            lineItemsJson: lineItemsRaw ? JSON.stringify(lineItemsRaw) : null,
            shopifyOrderId,
            shopifyCustomerId: shopifyCustomerId ?? null,
            orderCreatedAt: (body.created_at as string) ?? null,
          });
        } catch (err) {
          console.error('subscription contract derive (order) failed:', err);
        }
      }

      // 非同期処理: フレンドマッチング・タグ付け・イベント発火
      const orderAsyncWork = (async () => {
          try {
            // Round 4 PR-0: 共通ヘルパーで match + back-fill (email/phone 相互補完)
            const matchResult = await findFriendAndBackfill(db, email, phone);
            let friendId = matchResult.friendId;

            if (matchResult.backfilled !== 'none') {
              await logWebhook(
                db, topic, shopifyOrderId, 'backfilled',
                `users.${matchResult.backfilled} populated from Shopify ${topic}`,
              );
            }

            // 2026-07-30 fallback: email/phone で見つからなくても、アカウント連携
            // (App Proxy / magic-link) 済みの顧客は friends.shopify_customer_id で確定紐付けできる。
            // これが無いと「LINE 側にメール未登録の連携済み顧客」の注文が unlinked のまま残り、
            // LIFF の注文履歴・配送状況・購買セグメントから静かに漏れる。
            if (!friendId && shopifyCustomerId) {
              const linked = await db
                .prepare(`SELECT id FROM friends WHERE shopify_customer_id = ?`)
                .bind(shopifyCustomerId)
                .first<{ id: string }>();
              if (linked) {
                friendId = linked.id;
                await logWebhook(db, topic, shopifyOrderId, 'matched', 'friend matched via shopify_customer_id link');
              }
            }

            if (friendId) {
              // 注文にフレンドIDを紐付け
              await db
                .prepare(`UPDATE shopify_orders SET friend_id = ?, updated_at = ? WHERE shopify_order_id = ?`)
                .bind(friendId, jstNow(), shopifyOrderId)
                .run();

              // Shopify顧客とフレンドを紐付け
              if (shopifyCustomerId) {
                await linkShopifyCustomerToFriend(db, shopifyCustomerId, friendId);
              }

              // 自動タグ付け: shopify_customer
              const shopifyTag = await db
                .prepare(`SELECT id FROM tags WHERE name = ?`)
                .bind('shopify_customer')
                .first<{ id: string }>();
              if (shopifyTag) {
                await db
                  .prepare(`INSERT OR IGNORE INTO friend_tags (friend_id, tag_id, assigned_at) VALUES (?, ?, ?)`)
                  .bind(friendId, shopifyTag.id, jstNow())
                  .run();
              }

              // ─── 会員ランクの原資を記録 (2026-08-26) ───
              // 🚨 syncOrderToMember は使わない。 あれは orders/paid 用で、内部で
              //    checkAndNotifyForFriend → **LINE push「◯◯会員ランクへ昇格しました」** を撃つ。
              //    その文言は members/membership_tiers (0/3/5/8% ・ ¥0/1万/3万/10万) 由来で、
              //    ミニアプリが見せる NATURISM_RANK_DEFS (0/2/4/6/8% ・ ¥0/1/1.2万/2.4万/4.5万) とは
              //    **別の制度**。 同じ顧客に食い違う 2 つのランク名を送ることになるので撃たせない。
              //    friend は上で解決済みなので addPurchaseEvent を直接呼ぶ (二重解決もしない)。
              //
              // 🚨 なぜ orders/paid ではなくここか: orders/paid は **購読されていない**
              //    (routes/shopify.ts の webhookTopics に無い)。 本番実測でも
              //    member_purchase_events は 21 行すべて source='backfill' で、
              //    webhook 由来は**開設以来 0 行**。 実際に届く webhook で記録する
              //    (coupon-redemption.ts が同じ理由で orders/create を使っているのと同じ判断)。
              // 返金・取消の反映 (Codex P1)。 いったん paid で記録した注文が後から返金されても
              // ランクが下がらないと、返金済みの売上で最大 8% OFF + NLR- コードが出続ける。
              // 金額は Shopify の current_total_price (返金後の実額) を優先し、無ければ全額返金扱い。
              if (MEMBER_INGEST_ON && REFUND_STATUSES.has(orderFinancialStatus)) {
                try {
                  const rawCurrent = body.current_total_price;
                  const current = rawCurrent === undefined || rawCurrent === null ? NaN : Number(rawCurrent);
                  const nextAmount = Number.isFinite(current) ? current : 0;
                  const r = await reconcilePurchaseEventAmount(db, shopifyOrderId, nextAmount);
                  if (r.changed) {
                    await logWebhook(db, topic, shopifyOrderId, 'refund-reconciled', `${r.from} -> ${r.to}`);
                  }
                } catch (err) {
                  console.error('[shopify-webhook] refund reconcile failed:', err instanceof Error ? err.message : String(err));
                }
              }

              if (MEMBER_INGEST_ON && orderFinancialStatus === 'paid') {
                try {
                  await addPurchaseEvent(db, {
                    shopifyOrderId,
                    friendId,
                    amountJpy: totalPrice ?? 0,
                    currency: (body.currency as string) ?? 'JPY',
                    orderNumber: body.order_number ? Number(body.order_number) : null,
                    email: email ?? null,
                    phone: phone ?? null,
                    source: 'webhook',
                    occurredAt: orderOccurredAt,
                    metadata: { topic, financialStatus: orderFinancialStatus },
                  });
                } catch (err) {
                  // 記録に失敗しても注文処理そのものは止めない (冪等なので次の updated で回収される)
                  console.error('[shopify-webhook] addPurchaseEvent failed:', err instanceof Error ? err.message : String(err));
                }
              }

              // 自動タグ付け: purchased
              const purchasedTag = await db
                .prepare(`SELECT id FROM tags WHERE name = ?`)
                .bind('purchased')
                .first<{ id: string }>();
              if (purchasedTag) {
                await db
                  .prepare(`INSERT OR IGNORE INTO friend_tags (friend_id, tag_id, assigned_at) VALUES (?, ?, ?)`)
                  .bind(friendId, purchasedTag.id, jstNow())
                  .run();
              }

              // イベントバスに発火（自動化ルール用）。
              // orders/updated は fulfillment/tag/refund 等の更新でも届くため、
              // purchase_completed は orders/create のみで発火させ automation/scoring の
              // 多重実行を防ぐ (subscription enroller と同じ topic ガード)。
              if (topic === 'orders/create') {
                const { fireEvent } = await import('../services/event-bus.js');
                const { buildEmailDispatchConfig } = await import(
                  '../services/email-dispatch-config.js'
                );
                await fireEvent(
                  db,
                  'purchase_completed',
                  {
                    friendId,
                    eventData: { source: 'shopify', shopifyOrderId, amount: totalPrice },
                  },
                  undefined,
                  undefined,
                  buildEmailDispatchConfig(c.env),
                );
              }

              // Phase 6 PR-2: 再購入リマインダー自動 enroll (orders/create のみ)
              if (topic === 'orders/create' && lineItemsRaw && lineItemsRaw.length > 0) {
                try {
                  const { enrollSubscriptionsFromOrder } = await import(
                    '../services/subscription-enroller.js'
                  );
                  await enrollSubscriptionsFromOrder({
                    db,
                    friendId,
                    shopifyOrderId,
                    lineItems: lineItemsRaw,
                  });
                } catch (enrollErr) {
                  console.error('subscription enroll failed:', enrollErr);
                }
              }
            }
          } catch (err) {
            console.error('Shopify webhook async processing error (order):', err);
          }
        })();
      try { c.executionCtx.waitUntil(orderAsyncWork); } catch { /* no exec ctx in tests */ }

      // 第2波-⑤: welcome クーポン redemption 追跡。
      //   注文に乗った discount_codes を line_friend_coupons.coupon_code と照合し、 初回のみ
      //   redeemed_at/status='redeemed' を atomic 更新する (冪等)。 orders/paid は本番未購読のため
      //   購読済の本 topic を hook。 friend マッチ非依存 (coupon_code → friend_id で誰の coupon か判る)。
      //   注文の主処理 (orderAsyncWork) とは独立した best-effort タスクとして隔離。
      const couponRedemptionWork = (async () => {
        try {
          const redemption = await processOrderCouponRedemption(db, { body, shopifyOrderId, topic });

          // 紹介クーポン: referred が「¥500 クーポンを利用して購入」した = welcome クーポンを redeem した
          //   時にだけ、 紹介者 (referrer) に ¥500 実クーポンを発行 + LINE push (gated、 冪等)。
          //   pending reward が無い organic buyer (= 紹介経由でない) は no-op。 gate off なら完全 dormant。
          //   ※ redeemedFriendIds = 今回初めて redeemed を確定した coupon の所有 friend (= 利用者)。
          if (redemption.redeemedFriendIds.length > 0) {
            const lineClient = new LineClient(c.env.LINE_CHANNEL_ACCESS_TOKEN);
            for (const referredFriendId of redemption.redeemedFriendIds) {
              await processReferralRewardOnPurchase(db, c.env, lineClient, { referredFriendId });
            }
          }

          // 順次活性化 T1 (R1, 2026-08-13): 紹介クーポンの初回 redemption 勝者イベントで、
          //   その friend の queue から次の 1 枚を活性化 + LINE push。
          //   起点は redeemedReferralFriendIds (勝者のみ) = orders/updated 連投では空になるため
          //   二重活性化しない (第二防壁は DB 層の単文 UPDATE claim)。
          if (redemption.redeemedReferralFriendIds.length > 0) {
            const lineClient = new LineClient(c.env.LINE_CHANNEL_ACCESS_TOKEN);
            for (const friendId of redemption.redeemedReferralFriendIds) {
              await activateAndNotifyNextReferralCoupon(db, c.env, lineClient, { friendId });
            }
          }
        } catch (err) {
          console.error('Shopify webhook coupon redemption error:', err);
        }
      })();
      try { c.executionCtx.waitUntil(couponRedemptionWork); } catch { /* no exec ctx in tests */ }

      return c.json({ success: true, data: { id: order.id, shopifyOrderId: order.shopify_order_id } });
    }

    // 顧客イベント
    if (topic === 'customers/create' || topic === 'customers/update') {
      const shopifyCustomerId = String(body.id ?? '');
      const email = (body.email as string) ?? undefined;
      const phone = (body.phone as string) ?? undefined;

      await logWebhook(db, topic, shopifyCustomerId, 'received', `${body.first_name ?? ''} ${body.last_name ?? ''}`);

      const customer = await upsertShopifyCustomer(db, {
        shopifyCustomerId,
        email,
        phone,
        firstName: (body.first_name as string) ?? undefined,
        lastName: (body.last_name as string) ?? undefined,
        ordersCount: body.orders_count ? Number(body.orders_count) : undefined,
        totalSpent: body.total_spent ? Number(body.total_spent) : undefined,
        tags: (body.tags as string) ?? undefined,
        metadata: JSON.stringify({ source: 'webhook', topic }),
      });

      await logWebhook(db, topic, shopifyCustomerId, 'processed', `saved as ${customer.id}`);

      // サブスク契約状態の反映 (WI-1): 顧客タグ subscription-{ID}-cancel/-pause/-skip-count/-plan。
      // 解約・一時停止・スキップの検知経路。gate OFF なら完全 no-op。
      if (isSubscriptionIngestEnabled(c.env)) {
        try {
          // WI-2 (採点R1/R2 再設計): pause/resume 遷移のリカバリマーカーは
          // applyCustomerTagsToContracts が pause 書込と同一 upsert で原子的に管理する。
          // 送信は teiki-billing-reminder cron (JST 10-20時窓・CAS claim・失敗リトライ) が担う。
          //
          // ⚠️ 送信面が生きていない期間はマーカーを立てない。立てても送られず、
          // 送信面を開けた瞬間に数週間前の一時停止まで遡って「決済に失敗しました」が
          // 一斉送信される (rebuild の suppressRecoveryMarkers と同じ罠)。
          //
          // 抑止条件は **送信条件の否定と厳密に一致させる**こと。
          // 以前は MENU だけを見ていたが、cron の送信条件は REMINDER && MENU (2 gate) なので、
          // 手順どおり MENU → (数日〜数週の実機確認) → REMINDER と段階投入すると、
          // その差分期間がまるごと無防備になり、REMINDER を入れた瞬間に溜まった分が一斉に飛ぶ。
          const sendingLive =
            c.env.SUBSCRIPTION_MENU_ENABLED === 'true' &&
            c.env.SUBSCRIPTION_REMINDER_ENABLED === 'true';
          await applyCustomerTagsToContracts(db, shopifyCustomerId, (body.tags as string) ?? null, {
            suppressRecoveryMarkers: !sendingLive,
          });
        } catch (err) {
          console.error('subscription contract derive (customer) failed:', err);
        }
      }

      // 非同期処理: フレンドマッチング (Round 4 PR-0: 共通ヘルパー化)
      const customerAsyncWork = (async () => {
          try {
            const matchResult = await findFriendAndBackfill(db, email, phone);

            if (matchResult.backfilled !== 'none') {
              await logWebhook(
                db, topic, shopifyCustomerId, 'backfilled',
                `users.${matchResult.backfilled} populated from Shopify ${topic}`,
              );
            }

            if (matchResult.friendId) {
              await linkShopifyCustomerToFriend(db, shopifyCustomerId, matchResult.friendId);
            }
          } catch (err) {
            console.error('Shopify webhook async processing error (customer):', err);
          }
        })();
      try { c.executionCtx.waitUntil(customerAsyncWork); } catch { /* no exec ctx in tests */ }

      return c.json({ success: true, data: { id: customer.id, shopifyCustomerId: customer.shopify_customer_id } });
    }

    // 未対応のトピック
    await logWebhook(db, topic, String(body.id ?? ''), 'skipped', 'Unhandled topic');
    return c.json({ success: true, data: { message: `Topic '${topic}' received but not processed` } });
  } catch (err) {
    console.error('POST /api/integrations/shopify/webhook error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ========== Shopify Product Webhookレシーバー ==========

shopify.post('/api/integrations/shopify/webhook/product', async (c) => {
  try {
    const envRecord = c.env as unknown as Record<string, string | undefined>;
    const signingSecret = envRecord.SHOPIFY_WEBHOOK_SECRET || envRecord.SHOPIFY_CLIENT_SECRET;
    let body: Record<string, unknown>;

    if (signingSecret) {
      const hmacHeader = c.req.header('X-Shopify-Hmac-Sha256') ?? '';
      const rawBody = await c.req.text();
      let valid = await verifyShopifySignature(signingSecret, rawBody, hmacHeader);

      // フォールバック: CLIENT_SECRET で再試行
      if (!valid && envRecord.SHOPIFY_WEBHOOK_SECRET && envRecord.SHOPIFY_CLIENT_SECRET
          && envRecord.SHOPIFY_WEBHOOK_SECRET !== envRecord.SHOPIFY_CLIENT_SECRET) {
        valid = await verifyShopifySignature(envRecord.SHOPIFY_CLIENT_SECRET, rawBody, hmacHeader);
      }

      if (!valid) {
        return c.json({ success: false, error: 'Shopify signature verification failed' }, 401);
      }
      body = JSON.parse(rawBody) as Record<string, unknown>;
    } else {
      console.error('Shopify product webhook rejected: no signing secret configured');
      return c.json({ success: false, error: 'Webhook secret not configured' }, 500);
    }

    const topic = c.req.header('X-Shopify-Topic') ?? '';
    const db = c.env.DB;
    const shopifyProductId = String(body.id ?? '');

    await logWebhook(db, topic, shopifyProductId, 'received', String(body.title ?? ''));

    if (topic === 'products/delete') {
      // 論理削除: ステータスを archived に変更
      await db
        .prepare(`UPDATE shopify_products SET status = 'archived', updated_at = ? WHERE shopify_product_id = ?`)
        .bind(jstNow(), shopifyProductId)
        .run();
      await logWebhook(db, topic, shopifyProductId, 'processed', 'archived');
      return c.json({ success: true, data: { message: 'Product archived', shopifyProductId } });
    }

    // products/create, products/update
    const variants = body.variants as Array<Record<string, unknown>> | undefined;
    const firstVariant = variants?.[0];
    const images = body.images as Array<Record<string, unknown>> | undefined;
    const firstImage = images?.[0];
    const storeDomain = (c.env as unknown as Record<string, string | undefined>).SHOPIFY_STORE_DOMAIN ?? '';

    const statusRaw = (body.status as string) ?? 'active';
    const status = ['active', 'draft', 'archived'].includes(statusRaw)
      ? (statusRaw as 'active' | 'draft' | 'archived')
      : 'draft';

    await upsertShopifyProduct(db, {
      shopifyProductId,
      title: String(body.title ?? ''),
      description: (body.body_html as string) ?? null,
      vendor: (body.vendor as string) ?? null,
      productType: (body.product_type as string) ?? null,
      handle: (body.handle as string) ?? null,
      status,
      imageUrl: (firstImage?.src as string) ?? null,
      price: firstVariant?.price != null ? String(firstVariant.price) : null,
      compareAtPrice: firstVariant?.compare_at_price != null ? String(firstVariant.compare_at_price) : null,
      tags: (body.tags as string) ?? null,
      variantsJson: variants ? JSON.stringify(variants) : null,
      storeUrl: storeDomain ? `https://${storeDomain}/products/${body.handle ?? ''}` : null,
    });

    await logWebhook(db, topic, shopifyProductId, 'processed', `"${body.title}" ${status}`);
    return c.json({ success: true, data: { shopifyProductId, title: body.title } });
  } catch (err) {
    console.error('POST /api/integrations/shopify/webhook/product error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ========== Shopify注文一覧 ==========

shopify.get('/api/integrations/shopify/orders', async (c) => {
  try {
    const friendId = c.req.query('friendId') ?? undefined;
    const email = c.req.query('email') ?? undefined;
    const limit = Number(c.req.query('limit') ?? '100');
    const offset = Number(c.req.query('offset') ?? '0');

    const items = await getShopifyOrders(c.env.DB, { friendId, email, limit, offset });
    return c.json({
      success: true,
      data: items.map((e) => ({
        id: e.id,
        shopifyOrderId: e.shopify_order_id,
        shopifyCustomerId: e.shopify_customer_id,
        friendId: e.friend_id,
        email: e.email,
        phone: e.phone,
        totalPrice: e.total_price,
        currency: e.currency,
        financialStatus: e.financial_status,
        fulfillmentStatus: e.fulfillment_status,
        orderNumber: e.order_number,
        lineItems: e.line_items ? JSON.parse(e.line_items as string) : null,
        tags: e.tags,
        metadata: e.metadata ? JSON.parse(e.metadata as string) : null,
        createdAt: e.created_at,
        updatedAt: e.updated_at,
      })),
    });
  } catch (err) {
    console.error('GET /api/integrations/shopify/orders error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ========== Shopify注文詳細 ==========

shopify.get('/api/integrations/shopify/orders/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const item = await getShopifyOrderById(c.env.DB, id);
    if (!item) {
      return c.json({ success: false, error: 'Order not found' }, 404);
    }
    return c.json({
      success: true,
      data: {
        id: item.id,
        shopifyOrderId: item.shopify_order_id,
        shopifyCustomerId: item.shopify_customer_id,
        friendId: item.friend_id,
        email: item.email,
        phone: item.phone,
        totalPrice: item.total_price,
        currency: item.currency,
        financialStatus: item.financial_status,
        fulfillmentStatus: item.fulfillment_status,
        orderNumber: item.order_number,
        lineItems: item.line_items ? JSON.parse(item.line_items as string) : null,
        tags: item.tags,
        metadata: item.metadata ? JSON.parse(item.metadata as string) : null,
        createdAt: item.created_at,
        updatedAt: item.updated_at,
      },
    });
  } catch (err) {
    console.error('GET /api/integrations/shopify/orders/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ========== Shopify顧客一覧 ==========

shopify.get('/api/integrations/shopify/customers', async (c) => {
  try {
    const friendId = c.req.query('friendId') ?? undefined;
    const email = c.req.query('email') ?? undefined;
    const limit = Number(c.req.query('limit') ?? '100');
    const offset = Number(c.req.query('offset') ?? '0');

    const items = await getShopifyCustomers(c.env.DB, { friendId, email, limit, offset });
    return c.json({
      success: true,
      data: items.map((e) => ({
        id: e.id,
        shopifyCustomerId: e.shopify_customer_id,
        friendId: e.friend_id,
        email: e.email,
        phone: e.phone,
        firstName: e.first_name,
        lastName: e.last_name,
        ordersCount: e.orders_count,
        totalSpent: e.total_spent,
        tags: e.tags,
        metadata: e.metadata ? JSON.parse(e.metadata as string) : null,
        createdAt: e.created_at,
        updatedAt: e.updated_at,
      })),
    });
  } catch (err) {
    console.error('GET /api/integrations/shopify/customers error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ========== Shopify手動同期 ==========

shopify.post('/api/integrations/shopify/sync', async (c) => {
  try {
    const db = c.env.DB;
    const storeDomain = (c.env as unknown as Record<string, string | undefined>).SHOPIFY_STORE_DOMAIN;

    if (!storeDomain) {
      return c.json({ success: false, error: 'SHOPIFY_STORE_DOMAIN is not configured' }, 400);
    }

    // SSRF防止: storeDomain がShopifyドメインであることを検証
    if (!/^[a-z0-9-]+\.myshopify\.com$/.test(storeDomain)) {
      return c.json({ success: false, error: 'Invalid SHOPIFY_STORE_DOMAIN format' }, 400);
    }

    const accessToken = await getShopifyAccessToken(db, c.env as unknown as Record<string, string | undefined>);
    const apiVersion = '2025-07';
    const headers = {
      'X-Shopify-Access-Token': accessToken,
      'Content-Type': 'application/json',
    };

    // --- 商品同期 ---
    const productsRes = await fetch(
      `https://${storeDomain}/admin/api/${apiVersion}/products.json`,
      { headers },
    );
    if (!productsRes.ok) {
      console.error(`Shopify Products API error: ${productsRes.status}`);
      return c.json(
        { success: false, error: `Shopify Products API returned ${productsRes.status}` },
        502,
      );
    }

    const productsData = (await productsRes.json()) as {
      products: Array<Record<string, unknown>>;
    };
    const products = productsData.products ?? [];

    let productsSynced = 0;
    for (const p of products) {
      const variants = p.variants as Array<Record<string, unknown>> | undefined;
      const firstVariant = variants?.[0];
      const images = p.images as Array<Record<string, unknown>> | undefined;
      const firstImage = images?.[0];

      await upsertShopifyProduct(db, {
        shopifyProductId: String(p.id),
        title: String(p.title ?? ''),
        description: (p.body_html as string) ?? null,
        vendor: (p.vendor as string) ?? null,
        productType: (p.product_type as string) ?? null,
        handle: (p.handle as string) ?? null,
        status: ['active', 'draft', 'archived'].includes(p.status as string)
          ? (p.status as 'active' | 'draft' | 'archived')
          : 'active',
        imageUrl: (firstImage?.src as string) ?? null,
        price: firstVariant?.price != null ? String(firstVariant.price) : null,
        compareAtPrice: firstVariant?.compare_at_price != null
          ? String(firstVariant.compare_at_price)
          : null,
        tags: (p.tags as string) ?? null,
        variantsJson: variants ? JSON.stringify(variants) : null,
        storeUrl: `https://${storeDomain}/products/${p.handle ?? ''}`,
      });
      productsSynced++;
    }

    // --- 注文同期 ---
    const ordersRes = await fetch(
      `https://${storeDomain}/admin/api/${apiVersion}/orders.json?status=any&limit=50`,
      { headers },
    );
    if (!ordersRes.ok) {
      console.error(`Shopify Orders API error: ${ordersRes.status}`);
      return c.json(
        { success: false, error: `Shopify Orders API returned ${ordersRes.status}` },
        502,
      );
    }

    const ordersData = (await ordersRes.json()) as {
      orders: Array<Record<string, unknown>>;
    };
    const orders = ordersData.orders ?? [];

    let ordersSynced = 0;
    for (const o of orders) {
      const customer = o.customer as Record<string, unknown> | undefined;
      const lineItemsRaw = o.line_items as Array<Record<string, unknown>> | undefined;

      await upsertShopifyOrder(db, {
        shopifyOrderId: String(o.id),
        shopifyCustomerId: customer?.id ? String(customer.id) : undefined,
        email: (o.email as string) ?? (customer?.email as string) ?? undefined,
        phone: (o.phone as string) ?? (customer?.phone as string) ?? undefined,
        totalPrice: o.total_price ? Number(o.total_price) : undefined,
        currency: (o.currency as string) ?? 'JPY',
        financialStatus: (o.financial_status as string) ?? undefined,
        fulfillmentStatus: (o.fulfillment_status as string) ?? undefined,
        orderNumber: o.order_number ? Number(o.order_number) : undefined,
        lineItems: lineItemsRaw ? JSON.stringify(lineItemsRaw) : undefined,
        tags: (o.tags as string) ?? undefined,
        // order_created_at = REST payload の実注文日時 (採点R3)。COALESCE 上書きで webhook 保存分の
        // アンカーを破壊しないため、手動 sync でも必ず含める (サブスク rebuild の推定アンカー)。
        metadata: JSON.stringify({
          source: 'manual_sync',
          order_created_at: (o.created_at as string) ?? null,
        }),
      });
      ordersSynced++;
    }

    // --- 顧客同期 ---
    const customersRes = await fetch(
      `https://${storeDomain}/admin/api/${apiVersion}/customers.json?limit=250`,
      { headers },
    );
    let customersSynced = 0;
    if (customersRes.ok) {
      const customersData = (await customersRes.json()) as {
        customers: Array<Record<string, unknown>>;
      };
      const customers = customersData.customers ?? [];

      for (const cust of customers) {
        await upsertShopifyCustomer(db, {
          shopifyCustomerId: String(cust.id),
          email: (cust.email as string) ?? undefined,
          phone: (cust.phone as string) ?? undefined,
          firstName: (cust.first_name as string) ?? undefined,
          lastName: (cust.last_name as string) ?? undefined,
          ordersCount: cust.orders_count ? Number(cust.orders_count) : undefined,
          totalSpent: cust.total_spent ? Number(cust.total_spent) : undefined,
          tags: (cust.tags as string) ?? undefined,
          metadata: JSON.stringify({ source: 'manual_sync' }),
        });
        customersSynced++;
      }
    }

    return c.json({
      success: true,
      data: {
        message: 'Shopify sync completed',
        productsSynced,
        ordersSynced,
        customersSynced,
      },
    });
  } catch (err) {
    console.error('POST /api/integrations/shopify/sync error:', err);
    return c.json({ success: false, error: 'Shopify sync failed' }, 500);
  }
});

// ========== Shopify Webhook登録 ==========

shopify.post('/api/integrations/shopify/webhooks/register', async (c) => {
  try {
    const db = c.env.DB;
    const storeDomain = (c.env as unknown as Record<string, string | undefined>).SHOPIFY_STORE_DOMAIN;
    if (!storeDomain) {
      return c.json({ success: false, error: 'SHOPIFY_STORE_DOMAIN not configured' }, 400);
    }

    const token = await getShopifyAccessToken(db, c.env as unknown as Record<string, string | undefined>);
    const workerUrl = c.env.WORKER_URL || new URL(c.req.url).origin;
    const apiVersion = '2025-07';

    const webhookTopics = [
      { topic: 'orders/create', address: `${workerUrl}/api/integrations/shopify/webhook` },
      { topic: 'orders/updated', address: `${workerUrl}/api/integrations/shopify/webhook` },
      { topic: 'customers/create', address: `${workerUrl}/api/integrations/shopify/webhook` },
      { topic: 'customers/update', address: `${workerUrl}/api/integrations/shopify/webhook` },
      { topic: 'products/create', address: `${workerUrl}/api/integrations/shopify/webhook/product` },
      { topic: 'products/update', address: `${workerUrl}/api/integrations/shopify/webhook/product` },
      { topic: 'products/delete', address: `${workerUrl}/api/integrations/shopify/webhook/product` },
      { topic: 'fulfillments/create', address: `${workerUrl}/api/integrations/shopify/webhook/fulfillment` },
      { topic: 'fulfillments/update', address: `${workerUrl}/api/integrations/shopify/webhook/fulfillment` },
      // Task#3 (2026-06-12): 再入荷通知の駆動 webhook。旧実装は購読自体が漏れており通知が永遠に発火しなかった
      { topic: 'inventory_levels/update', address: `${workerUrl}/api/integrations/shopify/webhook/inventory` },
    ];

    const results: Array<{ topic: string; status: string; id?: string }> = [];

    for (const wh of webhookTopics) {
      const res = await fetch(
        `https://${storeDomain}/admin/api/${apiVersion}/webhooks.json`,
        {
          method: 'POST',
          headers: {
            'X-Shopify-Access-Token': token,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            webhook: {
              topic: wh.topic,
              address: wh.address,
              format: 'json',
            },
          }),
        },
      );

      if (res.ok) {
        const data = (await res.json()) as { webhook: { id: number } };
        results.push({ topic: wh.topic, status: 'created', id: String(data.webhook.id) });
      } else {
        const errBody = await res.text();
        // 既に登録済みの場合は "already exists" が含まれる
        if (errBody.includes('already') || errBody.includes('taken')) {
          results.push({ topic: wh.topic, status: 'already_exists' });
        } else {
          results.push({ topic: wh.topic, status: `error: ${res.status}` });
        }
      }
    }

    return c.json({ success: true, data: { webhooks: results } });
  } catch (err) {
    console.error('POST /api/integrations/shopify/webhooks/register error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ========== Shopify Webhook一覧 ==========

shopify.get('/api/integrations/shopify/webhooks', async (c) => {
  try {
    const db = c.env.DB;
    const storeDomain = (c.env as unknown as Record<string, string | undefined>).SHOPIFY_STORE_DOMAIN;
    if (!storeDomain) {
      return c.json({ success: false, error: 'SHOPIFY_STORE_DOMAIN not configured' }, 400);
    }

    const token = await getShopifyAccessToken(db, c.env as unknown as Record<string, string | undefined>);
    const apiVersion = '2025-07';

    const res = await fetch(
      `https://${storeDomain}/admin/api/${apiVersion}/webhooks.json`,
      { headers: { 'X-Shopify-Access-Token': token } },
    );

    if (!res.ok) {
      const body = await res.text();
      return c.json({ success: false, error: `Shopify API ${res.status}: ${body}` }, 502);
    }

    const data = (await res.json()) as {
      webhooks: Array<{ id: number; topic: string; address: string; created_at: string }>;
    };

    return c.json({
      success: true,
      data: data.webhooks.map((w) => ({
        id: w.id,
        topic: w.topic,
        address: w.address,
        createdAt: w.created_at,
      })),
    });
  } catch (err) {
    console.error('GET /api/integrations/shopify/webhooks error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { shopify };
