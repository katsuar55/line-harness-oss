/**
 * Subscription Reminder Service — 定期購買リマインダー
 *
 * Cron で5分ごとに実行し、next_reminder_at が過去の
 * アクティブなリマインダーに対して LINE push を送信。
 * 送信後、次回リマインド日時を interval_days 分進める。
 *
 * Phase 6 PR-3: shopify_product_id がセットされていれば、
 * `purchase_cross_sell_map` から最大 2 件のクロスセル候補を
 * Flex bubble の body に追加する。
 */

import type { LineClient } from '@line-crm/line-sdk';
import { getCrossSellSuggestions, insertCronRunLog } from '@line-crm/db';
import { dispatch } from './channel-dispatcher.js';

/** cron-monitor が監視する job 名と一致させる */
export const SUBSCRIPTION_REMINDER_JOB_NAME = 'subscription-reminder';

interface ReminderRow {
  id: string;
  friend_id: string;
  product_title: string;
  interval_days: number;
  next_reminder_at: string;
  shopify_product_id: string | null;
}

interface CrossSellEntry {
  recommendedProductId: string;
  recommendedTitle: string;
  reason: string | null;
}

/**
 * クロスセル候補の取得 + 商品タイトル解決。
 * 商品タイトルが取れない場合は recommended_product_id を fallback として使う。
 */
async function loadCrossSellEntries(
  db: D1Database,
  sourceProductId: string,
  limit = 2,
): Promise<CrossSellEntry[]> {
  const rules = await getCrossSellSuggestions(db, sourceProductId, { limit });
  if (rules.length === 0) return [];

  const entries: CrossSellEntry[] = [];
  for (const rule of rules) {
    let title = rule.recommended_product_id;
    try {
      const row = await db
        .prepare('SELECT title FROM shopify_products WHERE shopify_product_id = ? LIMIT 1')
        .bind(rule.recommended_product_id)
        .first<{ title: string }>();
      if (row?.title) title = row.title;
    } catch {
      // best-effort: fallback to product id
    }
    entries.push({
      recommendedProductId: rule.recommended_product_id,
      recommendedTitle: title,
      reason: rule.reason,
    });
  }
  return entries;
}

/**
 * クロスセル候補を bubble body に追加するためのコンポーネントを生成。
 * 候補がなければ空配列を返す。
 */
export function buildCrossSellComponents(entries: CrossSellEntry[]): unknown[] {
  if (entries.length === 0) return [];
  const items: unknown[] = [
    { type: 'separator', margin: 'md' },
    {
      type: 'text',
      text: '🎁 こちらもおすすめ',
      weight: 'bold',
      size: 'sm',
      color: '#0EA5E9',
      margin: 'md',
    },
  ];
  for (const e of entries) {
    items.push({
      type: 'box',
      layout: 'vertical',
      spacing: 'xs',
      margin: 'sm',
      contents: [
        {
          type: 'text',
          text: `・${e.recommendedTitle}`,
          size: 'sm',
          color: '#374151',
          wrap: true,
        },
        ...(e.reason
          ? [
              {
                type: 'text',
                text: e.reason,
                size: 'xxs',
                color: '#9CA3AF',
                wrap: true,
              },
            ]
          : []),
      ],
    });
  }
  return items;
}

export interface SubscriptionReminderResult {
  /** due (送信対象) と判定された件数 */
  dueCount: number;
  /** 実際に push が成功した件数 */
  sentCount: number;
  /** push 中に発生した例外件数 */
  errorCount: number;
}

export async function processSubscriptionReminders(
  db: D1Database,
  lineClient: LineClient,
  liffUrl: string,
): Promise<SubscriptionReminderResult> {
  const now = new Date().toISOString();
  const metrics: SubscriptionReminderResult = { dueCount: 0, sentCount: 0, errorCount: 0 };

  // 1. Get due reminders
  //
  // 🚨 稼働中の定期便契約を持つ友だちには送らない (2026-08-18)。
  //   この cron は「単発購入者への再購入促し」であり、既に定期便が動いている顧客へ
  //   「ワンタッチで再注文」を push すると**定期便と二重の単発注文**を促してしまう。
  //   実際に 30 日周期のリマインダーが 100 日周期の稼働契約者へ届いた (本番実測・
  //   届いたのはテスト行を持つ owner 1 名のみで実顧客への誤送信はゼロ)。
  //   行を消すのではなく送信側で除外する: 契約が**解約** (cancelled_at) されたら
  //   リマインダーは自動で復活する = 単発購入者に戻った顧客への促しは温存される。
  //   **一時停止 (paused_at) 中も除外したまま** — 停止は「単発購入者に戻った」では
  //   ないので復活させない (復活は解約 or 停止解除のみ)。
  //   ⚠️ own-billing (Phase 3 卒業・own_sub_contracts) を実顧客に開くときは、
  //   この NOT EXISTS に own_sub_contracts (status='active'|'paused') も足すこと。
  //   足さないと own-billing のみの契約者に同じ二重注文促しが再発する (レビュー指摘)。
  const { results: dueReminders } = await db
    .prepare(
      `SELECT sr.id, sr.friend_id, sr.product_title, sr.interval_days,
              sr.next_reminder_at, sr.shopify_product_id
       FROM subscription_reminders sr
       WHERE sr.is_active = 1 AND sr.next_reminder_at <= ?
         AND NOT EXISTS (
           SELECT 1 FROM friends f
             JOIN subscription_contracts c ON c.shopify_customer_id = f.shopify_customer_id
            WHERE f.id = sr.friend_id
              AND c.cancelled_at IS NULL
         )
       LIMIT 50`,
    )
    .bind(now)
    .all<ReminderRow>();

  metrics.dueCount = dueReminders?.length ?? 0;

  if (!dueReminders || dueReminders.length === 0) {
    // due 0 件でも cron 死活監視のため heartbeat を残す (Phase 6 PR-6)
    await recordCronHeartbeat(db, metrics);
    return metrics;
  }

  for (const reminder of dueReminders) {
    try {
      // 1. Friend lookup + 2. prefs を claim より前に判定し、 skip 対象は claim しない
      //    (= 不要な lease を残して 10 分毎 churn させないため)。
      const friend = await db
        .prepare('SELECT line_user_id FROM friends WHERE id = ?')
        .bind(reminder.friend_id)
        .first<{ line_user_id: string }>();

      if (!friend?.line_user_id) continue;

      const prefs = await db
        .prepare('SELECT reorder_reminder FROM friend_notification_preferences WHERE friend_id = ?')
        .bind(reminder.friend_id)
        .first<{ reorder_reminder: number }>();

      // Default ON if no prefs record
      if (prefs && !prefs.reorder_reminder) continue;

      // 3. 送信前 atomic claim: next_reminder_at を lease(now+10min) に CAS で進められた実行だけ送信。
      //    重複 cron が同じ reminder を二重送信するのを防ぐ (#103 step claim と同設計)。
      //    送信成功は手順6で本来の next に上書き / dispatcher skip は次サイクルへ advance / 失敗は lease で10分後 retry。
      const leaseUntil = new Date(Date.now() + 10 * 60_000).toISOString();
      const claim = await db
        .prepare(
          'UPDATE subscription_reminders SET next_reminder_at = ? WHERE id = ? AND next_reminder_at = ? AND is_active = 1',
        )
        .bind(leaseUntil, reminder.id, reminder.next_reminder_at)
        .run();
      if ((claim.meta?.changes ?? 0) !== 1) continue; // 別実行が claim 済

      // 4. Cross-sell suggestions (best-effort)
      let crossSellEntries: CrossSellEntry[] = [];
      if (reminder.shopify_product_id) {
        try {
          crossSellEntries = await loadCrossSellEntries(db, reminder.shopify_product_id, 2);
        } catch (err) {
          // cross-sell 取得失敗でも本文は送る。 但し silent にせず可観測化する。
          console.warn('subscription-reminder: loadCrossSellEntries failed:', err instanceof Error ? err.message : String(err));
        }
      }

      // 5. Send LINE push message
      const reorderUrl = liffUrl ? `${liffUrl}?page=reorder` : '';
      const bodyContents: unknown[] = [
        {
          type: 'text',
          text: '🔔 再購入のお知らせ',
          weight: 'bold',
          size: 'md',
          color: '#059669',
        },
        {
          type: 'text',
          text: `${reminder.product_title}の再購入時期になりました。`,
          size: 'sm',
          color: '#555555',
          wrap: true,
        },
        {
          type: 'text',
          text: `${reminder.interval_days}日サイクルで設定中`,
          size: 'xs',
          color: '#999999',
        },
        ...buildCrossSellComponents(crossSellEntries),
      ];

      const message = {
        type: 'flex' as const,
        altText: `${reminder.product_title}の再購入時期です`,
        contents: {
          type: 'bubble',
          size: crossSellEntries.length > 0 ? 'mega' : 'kilo',
          body: {
            type: 'box',
            layout: 'vertical',
            spacing: 'md',
            contents: bodyContents,
          },
          footer: reorderUrl
            ? {
                type: 'box',
                layout: 'vertical',
                contents: [
                  {
                    type: 'button',
                    action: {
                      type: 'uri',
                      label: 'ワンタッチで再注文',
                      uri: reorderUrl,
                    },
                    style: 'primary',
                    color: '#06C755',
                  },
                ],
              }
            : undefined,
        },
      };

      // Round 4 PR-3 統合 (2026-05-01): 直接 pushMessage していたのを ChannelDispatcher 経由に。
      // PR-6 で email fallback / channel='both' を導入する際、本 call-site だけ
      // dispatch input.channel を切り替えれば対応できる。現状は LINE-only behavior 不変。
      const dispatchResult = await dispatch(
        { db, lineClient },
        {
          recipient: { friend: { id: reminder.friend_id, lineUserId: friend.line_user_id } },
          channel: 'line',
          // 法令上は marketing。PR-6 で email 配信を有効にしたとき自動で
          // "配信停止リンク" 注入 + email_subscribers の opt-out 尊重がかかる。
          category: 'marketing',
          sourceKind: 'reorder',
          linePayload: { messages: [message] },
        },
      );

      const lineResult = dispatchResult.results.find((r) => r.channel === 'line');
      if (lineResult?.status === 'sent') {
        metrics.sentCount++;
        // 6. Update next_reminder_at (送信成功時): lease を本来の次サイクルに上書き
        const nextAt = new Date(Date.now() + reminder.interval_days * 86400000).toISOString();
        await db
          .prepare('UPDATE subscription_reminders SET next_reminder_at = ?, last_sent_at = ?, updated_at = ? WHERE id = ?')
          .bind(nextAt, now, now, reminder.id)
          .run();
      } else if (lineResult?.status === 'failed') {
        // 一時的な送信失敗: lease(now+10min) をそのまま残し 10 分後に retry させる。
        metrics.errorCount++;
      } else {
        // dispatcher skip (not_following / blacklisted 等): 本サイクルは送らず、 lease を
        // 本来の次サイクルへ advance して 10 分毎の churn を防ぐ (last_sent_at は更新しない)。
        const nextAt = new Date(Date.now() + reminder.interval_days * 86400000).toISOString();
        await db
          .prepare('UPDATE subscription_reminders SET next_reminder_at = ?, updated_at = ? WHERE id = ?')
          .bind(nextAt, now, reminder.id)
          .run();
      }
      // skipped (not_following / blacklisted / no_friend) は metrics に計上しない
      // (旧コードでは not_following でも push API error になり errorCount に計上されていたが、
      //  dispatcher の skip は legitimate gating として errorCount から除外する)
    } catch {
      // Continue with next reminder on failure (dispatcher 例外等の予期しないケース)
      metrics.errorCount++;
    }
  }

  // Phase 6 PR-6: cron-monitor 連携用 heartbeat (success として記録)
  await recordCronHeartbeat(db, metrics);

  return metrics;
}

/**
 * cron_run_logs に subscription-reminder の実行結果を記録する。
 * cron-monitor.ts の DEFAULT_RULES に同名 job を登録すると、
 * 24 時間以上 silent な場合に Discord アラートが出る。
 *
 * fail-safe: 記録失敗で cron 全体を止めない。
 */
async function recordCronHeartbeat(
  db: D1Database,
  metrics: SubscriptionReminderResult,
): Promise<void> {
  try {
    await insertCronRunLog(db, {
      jobName: SUBSCRIPTION_REMINDER_JOB_NAME,
      status: 'success',
      metrics: {
        due: metrics.dueCount,
        sent: metrics.sentCount,
        errors: metrics.errorCount,
      },
    });
  } catch (err) {
    console.error(
      '[subscription-reminder] cron_run_logs insert failed',
      err instanceof Error ? err.name : 'unknown',
    );
  }
}
