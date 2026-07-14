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

// ===== エントリポイント =====

/**
 * メインカード: 契約があれば契約カード (最大5件カルーセル)、
 * 未連携なら連携導線、契約ゼロなら定期便のご案内。
 */
export async function buildSubscriptionMenuMessages(
  db: D1Database,
  friend: ConciergeFriend,
  liffUrl: string | undefined,
): Promise<ReadonlyArray<Message>> {
  if (!friend.shopify_customer_id) {
    return buildNotLinkedMessages(liffUrl);
  }
  const contracts = await getSubscriptionContractsByCustomerId(db, friend.shopify_customer_id);
  if (contracts.length === 0) {
    return buildNoContractMessages();
  }
  const bubbles = contracts.slice(0, 5).map((c) => buildContractBubble(c));
  const container: FlexContainer =
    bubbles.length === 1
      ? (bubbles[0] as unknown as FlexContainer)
      : ({ type: 'carousel', contents: bubbles } as unknown as FlexContainer);
  return [
    {
      type: 'flex',
      altText: '📦 ご契約中の定期便',
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

// ===== カードビルダー =====

function buildContractBubble(contract: SubscriptionContractRow): object {
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
    const estimate = formatJpDate(contract.next_billing_estimate);
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

  return {
    type: 'bubble',
    size: 'kilo',
    header: header('ご契約中の定期便', statusBadge.text, statusBadge.color),
    body: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '16px',
      spacing: 'sm',
      contents: [...bodyContents, ...buttons],
    },
    styles: { footer: { separator: true } },
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
  const accountUri = liffUrl ? `${liffUrl}#account` : MYPAGE_URL;
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
            'LINE でご契約情報を表示するには、ご購入時のメールアドレスの登録が必要です (初回のみ・約30秒)。',
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
          action: { type: 'uri', label: '📧 メールアドレスを登録する', uri: accountUri },
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
      altText: '定期便の確認にはメールアドレス登録が必要です',
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

/** 「変更・スキップの締切: ◯月◯日 (決済3日前) まで」。推定できない時は一般則のみ。 */
function deadlineText(contract: SubscriptionContractRow): string | null {
  if (contract.cancelled_at || contract.paused_at) return null;
  if (contract.next_billing_estimate) {
    const deadline = formatJpDate(addDays(contract.next_billing_estimate, -3));
    if (deadline) return `⏰ 変更・スキップ・解約の締切: ${deadline}ごろまで (次回決済の3日前)`;
  }
  return '⏰ 変更・スキップ・解約は次回決済日の3日前まで受付です';
}

/** YYYY-MM-DD → 「M月D日」。 */
export function formatJpDate(date: string | null | undefined): string | null {
  if (!date) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  return `${Number(m[2])}月${Number(m[3])}日`;
}
