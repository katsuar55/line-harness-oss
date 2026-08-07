/**
 * サブスク・コンシェルジュ (WI-1, docs/SUBSCRIPTION_ULTRAPLAN_2026-07-14.md)
 *
 * リッチメニュー「サブスク」postback / intent「サブスク・定期便」から呼ばれ、
 * 契約状態カード (Flex) をトーク内に返す。Phase 1 では操作の実行はマイページ
 * (Huckleberry 定期購買、新型カスタマーアカウント: メール+6桁コード) へ最短誘導し、
 * Phase 3 (自社課金基盤) で同じカードの裏側だけを自社 mutation に差し替える。
 *
 * UI 原則 (採点次元):
 *   - 現状を先に見せる (次回お届け推定・回数)。推定は必ず「ごろ」+ マイページ確認導線
 *   - 締切「次回決済日の3日前」を常設表示 (現状この事前告知は他に存在しない)
 *   - マイページで許可されていない操作 (周期変更・他商品追加) は案内しない (迷子ゼロ)
 *   - 解約導線を隠さない (改正特商法の趣旨)。引き止めはスキップ/一時停止の提示 1 画面のみ
 *   - 失敗時は正直に謝る (false-success 禁止)
 *   - ブランド: teal 基調 (#0f766e / #0ABAB5)、LINE 黄緑は使わない
 */
import type { Message, FlexContainer } from '@line-crm/line-sdk';
import {
  getSubscriptionContractsByCustomerId,
  getSubscriptionContract,
  type SubscriptionContractRow,
} from '@line-crm/db';
import { addDays } from './subscription-contracts.js';

/**
 * 変更・スキップ・解約の締切 = 次回決済日の **3 日前**。
 *
 * リマインドの送信窓 (`subscription-billing-reminder.ts` の LEAD_DAYS_MIN/MAX = 3/7) の
 * **下限がこの値と一致している**ことが設計の前提: 下限 = 締切当日が最後のレーンになる。
 * どちらかを動かす時は必ず両方を見ること (片方だけ動かすと「締切を過ぎた契約に
 * まだ間に合う体の案内を送る」か「まだ間に合う契約に 1 通も送らない」のどちらかになる)。
 */
export const BILLING_DEADLINE_LEAD_DAYS = 3;

const TEAL_DARK = '#0f766e';
const TEAL = '#0ABAB5';
const TEXT_MAIN = '#334155';
const TEXT_SUB = '#94a3b8';
const CORAL = '#d9573d';

/** マイページ入口。新型カスタマーアカウントのログイン (メール+6桁) を経て定期購買一覧へ。 */
export const MYPAGE_URL = 'https://naturism-diet.com/account';
const SHOP_TEIKI_URL = 'https://naturism-diet.com/collections';

export interface ConciergeFriend {
  readonly id: string;
  readonly display_name: string | null;
  readonly shopify_customer_id: string | null;
}

export type GuideOp = 'skip' | 'date' | 'cancel_pause';

/**
 * カードの動作モード (§10-5)。
 * subIntent=true (= SUB_INTENT_ENABLED 配下でのみ true にすること) で契約カードの操作ボタンが
 * 「ガイド表示 (teiki_guide)」から「意思の受理 (sub_intent)」に変わる。
 * gate OFF では従来どおり相談導線のみ = 受け皿の無い死んだボタンを出さない (§10 実装順序 5)。
 */
export interface CardMode {
  readonly subIntent?: boolean;
}

/** §3-3: sub_intent postback のスキーマ版。互換を壊す変更で上げる (旧版は受理せず期限切れ扱い)。 */
export const SUB_INTENT_POSTBACK_VERSION = '1';

/**
 * §3-3 古い吹き出し対策: postback に y(サイクル識別子)/d0(提示予定日)/v(版) を必ず載せる。
 * y の形式は services/sub-intents.ts の buildCycleKey と同一 (`{contract_id}:{YYYY-MM-DD|unknown}`)。
 * 直接 import しないのは循環回避 (sub-intents → concierge の既存依存があるため) —
 * 同一性はテストが buildCycleKey の実出力と突合して固定する。
 */
export function subIntentPostbackData(
  op: 'skip' | 'date' | 'pause' | 'cancel' | 'cancel_pause' | 'dismiss',
  contract: SubscriptionContractRow,
  extra?: Record<string, string>,
): string {
  const d0 = contract.next_billing_estimate?.slice(0, 10) ?? null;
  const params = new URLSearchParams();
  params.set('action', 'sub_intent');
  params.set('op', op);
  params.set('cid', contract.contract_id);
  params.set('y', `${contract.contract_id}:${d0 ?? 'unknown'}`);
  if (d0) params.set('d0', d0);
  params.set('v', SUB_INTENT_POSTBACK_VERSION);
  for (const [k, val] of Object.entries(extra ?? {})) params.set(k, val);
  return params.toString();
}

// ===== エントリポイント =====

/**
 * メインカード: 契約があれば契約カード (最大5件カルーセル)、
 * 未連携なら連携導線、契約ゼロなら定期便のご案内。
 */
export async function buildSubscriptionMenuMessages(
  db: D1Database,
  friend: ConciergeFriend,
  liffUrl: string | undefined,
  mode: CardMode = {},
): Promise<ReadonlyArray<Message>> {
  if (!friend.shopify_customer_id) {
    return buildNotLinkedMessages(liffUrl);
  }
  const contracts = await getSubscriptionContractsByCustomerId(db, friend.shopify_customer_id);
  if (contracts.length === 0) {
    return buildNoContractMessages();
  }
  const bubbles = contracts.slice(0, 5).map((c) => buildContractBubble(c, mode));
  const container: FlexContainer =
    bubbles.length === 1
      ? (bubbles[0] as unknown as FlexContainer)
      : ({ type: 'carousel', contents: bubbles } as unknown as FlexContainer);
  return [
    {
      type: 'flex',
      altText: '📦 定期便のご契約状況',
      contents: container,
    },
  ];
}

/**
 * 契約の所有者検証つき取得 (IDOR ガード)。
 * postback の contract id は改ざん可能な入力として扱い、必ず friend の顧客IDと突合する。
 */
export async function getContractForFriend(
  db: D1Database,
  friend: ConciergeFriend,
  contractId: string,
): Promise<SubscriptionContractRow | null> {
  if (!friend.shopify_customer_id) return null;
  const contract = await getSubscriptionContract(db, contractId);
  if (!contract) return null;
  if (contract.shopify_customer_id !== friend.shopify_customer_id) return null;
  return contract;
}

/** 操作ガイドカード: スキップ / お届け日変更 / 解約・一時停止。 */
export function buildGuideMessages(
  op: GuideOp,
  contract: SubscriptionContractRow,
): ReadonlyArray<Message> {
  const deadline = deadlineText(contract);
  if (op === 'skip') {
    return [
      buildGuideBubble({
        title: '📦 次回分をスキップする',
        lead: '次回以降のお届けを、一度に最大12回分までお休みできます。',
        steps: [
          'マイページにログイン (メールアドレス+6桁コード)',
          '「注文履歴」→「定期購買一覧」→「詳細の確認」',
          '「スキップ」をタップ',
        ],
        deadline,
        buttonLabel: 'マイページを開く',
      }),
    ];
  }
  if (op === 'date') {
    return [
      buildGuideBubble({
        title: '📅 お届け日を変更する',
        lead: '次回のお届け日を最長30日先まで変更できます。',
        steps: [
          'マイページにログイン (メールアドレス+6桁コード)',
          '「注文履歴」→「定期購買一覧」→「詳細の確認」',
          '「お届け日の変更」で日付を選択',
        ],
        deadline,
        buttonLabel: 'マイページを開く',
      }),
    ];
  }
  // cancel_pause: 引き止めは 1 画面のみ、解約導線は隠さない
  return [
    buildGuideBubble({
      title: '解約・一時停止のお手続き',
      lead:
        '商品が余りがちな場合は「スキップ」や「一時停止」でお届け間隔の調整もできます。\nもちろん解約のお手続きもマイページからいつでも可能です。',
      steps: [
        'マイページにログイン (メールアドレス+6桁コード)',
        '「注文履歴」→「定期購買一覧」→「詳細の確認」',
        '「一時停止」または「解約」をタップ',
      ],
      deadline,
      buttonLabel: 'マイページを開く',
    }),
  ];
}

/** DB/API 障害時の正直な謝罪 (false-success 禁止)。 */
export function buildConciergeErrorMessages(): ReadonlyArray<Message> {
  return [
    {
      type: 'text',
      text:
        '申し訳ありません、ただいま定期便情報をうまく確認できませんでした🙇\n時間をおいてもう一度お試しいただくか、マイページでご確認ください。\n' +
        MYPAGE_URL,
    },
  ];
}

/**
 * 決済7日前リマインド push (WI-2)。「変更・スキップの締切」を、締切前に届く
 * 唯一の事前通知として送る (既存の事前案内メールはお届け3日前 ≈ 決済後で間に合わない)。
 * リード文 + 操作ボタンつき契約カードの 2 メッセージ。
 */
export function buildBillingReminderMessages(
  contract: SubscriptionContractRow,
  daysUntilBilling?: number,
  mode: CardMode = {},
): ReadonlyArray<Message> {
  const estimate = formatJpDate(contract.next_billing_estimate);
  // 締切 = 決済3日前 (据置)。送信は決済 3〜7 日前の窓で起きるので、締切までの残り日数は
  // 0〜4 日の幅を取る。ここを「明日まで」固定にすると、7日前送信で**実際は4日あるのに
  // 「明日まで」と伝える嘘**になる (窓を [3,4] から [3,7] へ広げた際の副作用)。
  // 推定値なので断定を避け「お手続きの目安」として案内する (採点R1: 推定ズレ時の誤誘導防止)。
  const daysUntilDeadline =
    daysUntilBilling === undefined ? undefined : daysUntilBilling - BILLING_DEADLINE_LEAD_DAYS;
  const deadlinePhrase =
    daysUntilDeadline === undefined
      ? 'お早めのお手続きをおすすめします'
      : daysUntilDeadline <= 0
        ? '本日中のお手続きをおすすめします'
        : daysUntilDeadline === 1
          ? '明日までのお手続きをおすすめします'
          : `あと${daysUntilDeadline}日以内のお手続きをおすすめします`;
  // §10-5: 受理ボタン内包時は「このカードで完結する」ことを言う (マイページ往復を前提にしない)。
  // 締切の但し書きは維持 (推定である事実は変わらない)
  const howTo = mode.subIntent
    ? '下のカードのボタンから、そのままお手続きいただけます'
    : 'お早めにお手続きください';
  const lead = estimate
    ? `📦 まもなく定期便の次回お届け準備が始まります (${estimate}ごろ決済予定)。\n変更・スキップ・解約をご希望の場合は、${deadlinePhrase}🌿\n${mode.subIntent ? `${howTo}。\n` : ''}※正確な締切はマイページでご確認いただけます`
    : `📦 まもなく定期便の次回お届け準備が始まります。\n変更・スキップ・解約をご希望の場合は、${howTo}🌿`;
  return [
    { type: 'text', text: lead },
    {
      type: 'flex',
      altText: '📦 定期便 次回お届けのご案内',
      contents: buildContractBubble(contract, mode) as unknown as FlexContainer,
    },
  ];
}

/**
 * 一時停止リカバリ push (WI-2)。Huckleberry は決済失敗時に自動一時停止 (再決済なし) するため、
 * 気づかず実質解約になるのを LINE 通知で防ぐ。顧客タグ -pause の出現 (遷移) で 1 回だけ送る。
 * ⚠️ pause タグは原因 (決済失敗 vs 手動一時停止) を運ばないため、文言は**原因を断定しない**
 * (採点R1: 手動停止の顧客に「お支払いが確認できなかった」と虚偽通知しない)。
 */
export function buildPaymentRecoveryMessages(): ReadonlyArray<Message> {
  return [
    {
      type: 'text',
      text:
        '📦 定期便のお届けを一時停止しました。\nお心当たりがない場合は、お支払い方法に問題があった可能性があります。マイページからご確認・更新をお願いします🌿\n再開もマイページからいつでも可能です。\n' +
        MYPAGE_URL,
    },
  ];
}

// ===== カードビルダー =====

function buildContractBubble(contract: SubscriptionContractRow, mode: CardMode = {}): object {
  const statusBadge = contract.cancelled_at
    ? { text: '解約済み', color: TEXT_SUB }
    : contract.paused_at
      ? { text: '一時停止中', color: CORAL }
      : { text: 'ご利用中', color: TEAL };

  const bodyContents: object[] = [
    {
      type: 'box',
      layout: 'horizontal',
      contents: [
        {
          type: 'text',
          text: contract.plan_name ?? '定期便プラン',
          size: 'sm',
          color: TEXT_MAIN,
          weight: 'bold',
          wrap: true,
          flex: 1,
        },
      ],
    },
  ];

  if (contract.cancelled_at) {
    bodyContents.push(rowText('この契約は解約済みです。再開はいつでも歓迎です🌿'));
  } else if (contract.paused_at) {
    bodyContents.push(
      rowText(
        'お届けを一時停止中です。お支払いの問題で停止された場合は、マイページからお支払い方法をご確認ください。',
      ),
    );
  } else {
    // 推定が過去日のまま stale な場合 (webhook 欠落等) は日付を出さない (採点R2: 過去の締切を表示しない)
    const estimate = isStaleEstimate(contract.next_billing_estimate)
      ? null
      : formatJpDate(contract.next_billing_estimate);
    bodyContents.push(
      kvRow('次回の決済予定', estimate ? `${estimate}ごろ *` : 'マイページでご確認ください'),
    );
    if (contract.order_count) {
      kvPush(bodyContents, 'お届け回数', `${contract.order_count}回目`);
    }
    if (estimate) {
      bodyContents.push({
        type: 'text',
        text: '* 商品のお届けは決済の2〜4日後ごろです。お届け日を変更された場合はずれることがあります。正確な日付はマイページでご確認ください。',
        size: 'xxs',
        color: TEXT_SUB,
        wrap: true,
        margin: 'sm',
      });
    }
    const deadline = deadlineText(contract);
    if (deadline) {
      bodyContents.push({
        type: 'text',
        text: deadline,
        size: 'xxs',
        color: CORAL,
        wrap: true,
        margin: 'sm',
      });
    }
  }

  const buttons: object[] = [];
  if (!contract.cancelled_at && !contract.paused_at) {
    if (mode.subIntent) {
      // §10-5: 意思の受理ボタン (SUB_INTENT_ENABLED 配下でのみ描画)。
      // §3: 結果はラベルでなく「ボタン直上の本文行」へ (ラベルは単一行・切詰めで日付から消える)。
      // §3-2: 移行前 (executor=human) は結果を断定せず「お申し込み」が読める語にする。
      bodyContents.push(...buildSkipResultLine(contract));
      buttons.push(
        // §3-1: ラベルは全角 8 字以内の動詞句。§7: 実行ボタンは solid #0f766e (白文字 4.5:1 以上)・height md
        {
          type: 'button',
          style: 'primary',
          color: TEAL_DARK,
          height: 'md',
          margin: 'md',
          action: {
            type: 'postback',
            label: '今回はお休み',
            data: subIntentPostbackData('skip', contract),
            displayText: '今回の定期便をお休みしたいです',
          },
        },
        // §2: 日付変更は 1〜2 タップ — datetimepicker で希望日の選択とタップを 1 動作に畳む
        {
          type: 'button',
          style: 'primary',
          color: TEAL_DARK,
          height: 'md',
          margin: 'sm',
          action: {
            type: 'datetimepicker',
            label: '日付を変える',
            data: subIntentPostbackData('date', contract),
            mode: 'date',
            ...datePickerBounds(contract),
          },
        },
        // §7-3 例外: 解約・お休みの導線は常設 (特商法)。2 タップ目の確認カードで受理する
        {
          type: 'button',
          style: 'secondary',
          height: 'md',
          margin: 'sm',
          action: {
            type: 'postback',
            label: 'お休み・解約',
            data: subIntentPostbackData('cancel_pause', contract),
            displayText: '一時停止・解約について',
          },
        },
        {
          type: 'button',
          style: 'link',
          height: 'sm',
          margin: 'sm',
          action: { type: 'uri', label: '商品・数量の変更はこちら', uri: MYPAGE_URL },
        },
      );
    } else {
      buttons.push(
        primaryButton('📦 次回をスキップ', postbackData('skip', contract.contract_id), TEAL_DARK),
        primaryButton('📅 お届け日を変更', postbackData('date', contract.contract_id), TEAL),
        {
          type: 'button',
          style: 'secondary',
          height: 'sm',
          margin: 'sm',
          action: {
            type: 'postback',
            label: '解約・一時停止',
            data: postbackData('cancel_pause', contract.contract_id),
            displayText: '解約・一時停止について',
          },
        },
        {
          type: 'button',
          style: 'link',
          height: 'sm',
          margin: 'sm',
          action: { type: 'uri', label: '商品・数量の変更はこちら', uri: MYPAGE_URL },
        },
      );
    }
  } else {
    buttons.push({
      type: 'button',
      style: 'primary',
      color: TEAL_DARK,
      height: 'sm',
      margin: 'md',
      action: {
        type: 'uri',
        label: contract.cancelled_at ? '🌿 定期便をもう一度見る' : 'マイページで確認する',
        uri: contract.cancelled_at ? SHOP_TEIKI_URL : MYPAGE_URL,
      },
    });
  }

  // 解約済み/一時停止では「ご契約中」と自己矛盾しない状態非依存の題字にする (採点R2)
  const headerTitle =
    contract.cancelled_at || contract.paused_at ? '定期便のご契約' : 'ご契約中の定期便';
  return {
    type: 'bubble',
    size: 'kilo',
    header: header(headerTitle, statusBadge.text, statusBadge.color),
    body: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '16px',
      spacing: 'sm',
      contents: [...bodyContents, ...buttons],
    },
  };
}

interface GuideBubbleInput {
  readonly title: string;
  readonly lead: string;
  readonly steps: ReadonlyArray<string>;
  readonly deadline: string | null;
  readonly buttonLabel: string;
}

function buildGuideBubble(input: GuideBubbleInput): Message {
  const stepRows = input.steps.map((s, i) => ({
    type: 'box',
    layout: 'horizontal',
    margin: 'sm',
    contents: [
      { type: 'text', text: `${i + 1}`, size: 'xs', color: TEAL, weight: 'bold', flex: 0 },
      { type: 'text', text: s, size: 'xs', color: TEXT_MAIN, wrap: true, flex: 1, margin: 'sm' },
    ],
  }));

  const bodyContents: object[] = [
    { type: 'text', text: input.lead, size: 'sm', color: TEXT_MAIN, wrap: true },
    ...stepRows,
  ];
  if (input.deadline) {
    bodyContents.push({
      type: 'text',
      text: input.deadline,
      size: 'xxs',
      color: CORAL,
      wrap: true,
      margin: 'md',
    });
  }
  bodyContents.push({
    type: 'button',
    style: 'primary',
    color: TEAL_DARK,
    height: 'sm',
    margin: 'md',
    action: { type: 'uri', label: input.buttonLabel, uri: MYPAGE_URL },
  });

  const bubble = {
    type: 'bubble',
    size: 'kilo',
    header: header(input.title, null, null),
    body: { type: 'box', layout: 'vertical', paddingAll: '16px', contents: bodyContents },
  };
  return { type: 'flex', altText: input.title, contents: bubble as unknown as FlexContainer };
}

function buildNotLinkedMessages(liffUrl: string | undefined): ReadonlyArray<Message> {
  // 連携フロー (email OTP → friends.shopify_customer_id) の UI は /liff/my-rank 側にある。
  // #account (マイアカウントタブ) はメール配信設定のみで連携できない行き止まり (採点R2 HIGH)。
  const accountUri = liffUrl ? `${liffUrl}#rank` : MYPAGE_URL;
  const bubble = {
    type: 'bubble',
    size: 'kilo',
    header: header('定期便の確認', null, null),
    body: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '16px',
      spacing: 'sm',
      contents: [
        {
          type: 'text',
          text:
            'LINE でご契約情報を表示するには、ご購入時のメールアドレスでのアカウント連携が必要です (初回のみ・約30秒)。',
          size: 'sm',
          color: TEXT_MAIN,
          wrap: true,
        },
        {
          type: 'button',
          style: 'primary',
          color: TEAL_DARK,
          height: 'sm',
          margin: 'md',
          action: { type: 'uri', label: '📧 アカウント連携する (約30秒)', uri: accountUri },
        },
        {
          type: 'button',
          style: 'secondary',
          height: 'sm',
          margin: 'sm',
          action: { type: 'uri', label: 'マイページで直接確認する', uri: MYPAGE_URL },
        },
      ],
    },
  };
  return [
    {
      type: 'flex',
      altText: '定期便の確認にはアカウント連携が必要です',
      contents: bubble as unknown as FlexContainer,
    },
  ];
}

function buildNoContractMessages(): ReadonlyArray<Message> {
  const bubble = {
    type: 'bubble',
    size: 'kilo',
    header: header('naturism の定期便', null, null),
    body: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '16px',
      spacing: 'sm',
      contents: [
        {
          type: 'text',
          text: '現在ご契約中の定期便はありません。',
          size: 'sm',
          color: TEXT_MAIN,
          wrap: true,
        },
        {
          type: 'text',
          text: '定期便なら 2回目から5%OFF・送料無料。スキップや解約のお手続きはマイページから、LINE がいつでも最短でご案内します🌿',
          size: 'xs',
          color: TEXT_SUB,
          wrap: true,
        },
        {
          type: 'button',
          style: 'primary',
          color: TEAL_DARK,
          height: 'sm',
          margin: 'md',
          action: { type: 'uri', label: '🛍 定期便を見てみる', uri: SHOP_TEIKI_URL },
        },
      ],
    },
  };
  return [
    {
      type: 'flex',
      altText: 'naturism の定期便のご案内',
      contents: bubble as unknown as FlexContainer,
    },
  ];
}

// ===== 小物 =====

function header(title: string, badge: string | null, badgeColor: string | null): object {
  const contents: object[] = [
    { type: 'text', text: '🌿', size: 'sm', flex: 0 },
    {
      type: 'text',
      text: title,
      size: 'xs',
      color: '#ffffff',
      weight: 'bold',
      gravity: 'center',
      margin: 'sm',
      flex: 1,
      wrap: true,
    },
  ];
  if (badge) {
    contents.push({
      type: 'text',
      text: badge,
      size: 'xxs',
      color: '#ffffff',
      align: 'end',
      gravity: 'center',
      flex: 0,
    });
  }
  return {
    type: 'box',
    layout: 'horizontal',
    backgroundColor: badgeColor === CORAL ? '#9a3412' : TEAL_DARK,
    paddingAll: '12px',
    contents,
  };
}

function rowText(text: string): object {
  return { type: 'text', text, size: 'xs', color: TEXT_MAIN, wrap: true, margin: 'sm' };
}

function kvRow(key: string, value: string): object {
  return {
    type: 'box',
    layout: 'horizontal',
    margin: 'sm',
    contents: [
      { type: 'text', text: key, size: 'xs', color: TEXT_SUB, flex: 0 },
      { type: 'text', text: value, size: 'xs', color: TEXT_MAIN, wrap: true, align: 'end', flex: 1 },
    ],
  };
}

function kvPush(arr: object[], key: string, value: string): void {
  arr.push(kvRow(key, value));
}

/**
 * §3: 「押す前に結果が読める」— skip ボタン直上の本文行。
 * §3-2: derived は「ごろ」必須。移行前は結果を断定せず「お申し込み」表現。
 * 結果日付を出せない (推定/周期不明) 場合は操作の意味だけを書く (日付を捏造しない)。
 * §7-2: 日付行は size xl / bold / #0f766e。
 */
function buildSkipResultLine(contract: SubscriptionContractRow): object[] {
  const estimate =
    contract.next_billing_estimate && !isStaleEstimate(contract.next_billing_estimate)
      ? contract.next_billing_estimate.slice(0, 10)
      : null;
  const next =
    estimate && contract.interval_days && contract.interval_days > 0
      ? formatJpDate(addDays(estimate, contract.interval_days))
      : null;
  if (!next) {
    return [
      {
        type: 'text',
        text: '「今回はお休み」を押すと、次回分をお休みするお申し込みになります (次のお届け予定はマイページでご確認ください)',
        size: 'sm',
        color: TEXT_MAIN,
        wrap: true,
        margin: 'md',
      },
    ];
  }
  const goro = contract.estimate_source === 'flow' ? '' : 'ごろ';
  return [
    {
      type: 'text',
      text: `押すと 次回は ${next}${goro} に変わるお申し込みになります`,
      size: 'xl',
      weight: 'bold',
      color: TEAL_DARK,
      wrap: true,
      margin: 'md',
    },
  ];
}

/**
 * 日付変更 datetimepicker の可動域。min = 明日 (過去日を選ばせない) /
 * max = 推定日 + 30 日 (マイページの「最長30日先まで」に合わせる。推定不明は今日 + 60 日)。
 * initial は推定日 (可動域内にクランプ)。
 */
function datePickerBounds(contract: SubscriptionContractRow): {
  initial: string;
  min: string;
  max: string;
} {
  const today = todayJst();
  const min = addDays(today, 1);
  const estimate =
    contract.next_billing_estimate && !isStaleEstimate(contract.next_billing_estimate)
      ? contract.next_billing_estimate.slice(0, 10)
      : null;
  const max = estimate ? addDays(estimate, 30) : addDays(today, 60);
  let initial = estimate ?? addDays(today, 7);
  if (initial < min) initial = min;
  if (initial > max) initial = max;
  return { initial, min, max };
}

/**
 * §10-5: [お休み・解約] の確認カード (2 タップ目で受理)。
 * 引き止めは 1 画面のみ・解約導線は隠さない (§1-4 / §7-3)。
 * 破壊的操作 (解約) は色を変え、1 タップ実行ボタンとは別ボタンにする (§7-3)。
 */
export function buildCancelPauseChoiceMessages(
  contract: SubscriptionContractRow,
): ReadonlyArray<Message> {
  const bubble = {
    type: 'bubble',
    size: 'kilo',
    header: header('お休み・解約のお手続き', null, null),
    body: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '16px',
      spacing: 'sm',
      contents: [
        {
          type: 'text',
          text:
            '商品が余りがちな場合は、一時停止でお届けをいったん止めることもできます (再開はいつでも可能です)。\nもちろん解約のお申し込みも、このままお手続きいただけます。',
          size: 'sm',
          color: TEXT_MAIN,
          wrap: true,
        },
        {
          type: 'button',
          style: 'primary',
          color: TEAL_DARK,
          height: 'md',
          margin: 'md',
          action: {
            type: 'postback',
            label: '一時停止する',
            data: subIntentPostbackData('pause', contract),
            displayText: '定期便を一時停止したいです',
          },
        },
        {
          type: 'button',
          style: 'primary',
          color: CORAL,
          height: 'md',
          margin: 'sm',
          action: {
            type: 'postback',
            label: '解約を申し込む',
            data: subIntentPostbackData('cancel', contract),
            displayText: '定期便の解約を申し込みます',
          },
        },
        {
          type: 'button',
          style: 'secondary',
          height: 'md',
          margin: 'sm',
          action: {
            type: 'postback',
            label: '今はやめておく',
            data: subIntentPostbackData('dismiss', contract),
            displayText: '今はやめておきます',
          },
        },
      ],
    },
  };
  return [
    {
      type: 'flex',
      altText: 'お休み・解約のお手続き',
      contents: bubble as unknown as FlexContainer,
    },
  ];
}

function primaryButton(label: string, data: string, color: string): object {
  return {
    type: 'button',
    style: 'primary',
    color,
    height: 'sm',
    margin: 'md',
    action: { type: 'postback', label, data, displayText: label.replace(/^[^\s]+\s/, '') },
  };
}

function postbackData(op: GuideOp, contractId: string): string {
  const params = new URLSearchParams();
  params.set('action', 'teiki_guide');
  params.set('op', op);
  params.set('cid', contractId);
  return params.toString();
}

/**
 * 「変更・スキップ・解約の締切: ◯月◯日 (決済3日前) まで」。
 * 推定できない/過去日は一般則のみ。締切自体が過ぎている窓 (推定が今日〜2日後) では
 * 過去の締切日を出さず「締め切られている可能性」の注意に切り替える (採点R3)。
 */
function deadlineText(contract: SubscriptionContractRow): string | null {
  if (contract.cancelled_at || contract.paused_at) return null;
  const estimate = contract.next_billing_estimate;
  if (estimate && !isStaleEstimate(estimate)) {
    const deadlineDate = addDays(estimate, -BILLING_DEADLINE_LEAD_DAYS);
    if (deadlineDate < todayJst()) {
      return '⏰ 今回分の変更受付は締め切られている可能性があります。正確な状況はマイページでご確認ください';
    }
    const deadline = formatJpDate(deadlineDate);
    if (deadline) return `⏰ 変更・スキップ・解約の締切: ${deadline}ごろまで (次回決済の3日前)`;
  }
  return '⏰ 変更・スキップ・解約は次回決済日の3日前まで受付です';
}

/** 今日 (JST) の YYYY-MM-DD。 */
function todayJst(): string {
  return new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
}

/** 推定日が今日 (JST) より過去 = stale。過去の日付・締切をユーザーに見せない。 */
function isStaleEstimate(estimate: string | null): boolean {
  if (!estimate) return false;
  return estimate < todayJst();
}

/** YYYY-MM-DD → 「M月D日」。 */
export function formatJpDate(date: string | null | undefined): string | null {
  if (!date) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  return `${Number(m[2])}月${Number(m[3])}日`;
}
