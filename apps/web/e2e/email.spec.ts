import { test, expect } from '@playwright/test'

/**
 * E2E coverage for the メール配信 (/email) admin page introduced in
 * Round 4 PR-7.
 *
 * Scope:
 *   - Auth gate: unauthenticated visit redirects to /login.
 *   - KPI cards: the four primary KPI tiles (送信 / 配信完了 / 開封 /
 *     クリック) render the totals returned by /api/admin/email/kpi.
 *   - Templates list: rows from /api/admin/email/templates render with
 *     name, subject, and an active/inactive badge.
 *   - Subscribers status filter: changing the status dropdown to
 *     "解除済み" causes a new /api/admin/email/subscribers request with
 *     `?status=inactive` and the table re-renders.
 *
 * All worker endpoints are mocked via page.route() against
 * NEXT_PUBLIC_API_URL (http://localhost:8787 by default). No real API
 * calls are made.
 */

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8787'

interface KpiTotals {
  sent: number
  delivered: number
  opened: number
  clicked: number
  bounced: number
  complained: number
  unsubscribed: number
  fromDate: string
  toDate: string
}

interface KpiResponse {
  totals: KpiTotals
  byCategory: Array<{
    category: 'transactional' | 'marketing'
    sent: number
    delivered: number
    opened: number
    clicked: number
  }>
  subscribers: {
    total: number
    active: number
    inactive: number
    transactionalOnly: number
  }
}

interface SubscriberRow {
  id: string
  friend_id: string | null
  email: string
  is_active: number
  transactional_only: number
  unsubscribed_at: string | null
  bounce_count: number
  complaint_count: number
  consent_source: string | null
  consent_at: string
  created_at: string
  updated_at: string
}

interface TemplateRow {
  id: string
  name: string
  category: string
  subject: string
  html_content: string
  text_content: string
  preheader: string | null
  is_active: number
  created_at: string
  updated_at: string
}

interface MessageRow {
  id: string
  subscriberId: string
  email: string | null
  subject: string
  category: string
  sourceKind: string
  status: string
  openCount: number
  clickCount: number
  sentAt: string | null
  deliveredAt: string | null
  firstOpenedAt: string | null
  lastEventAt: string | null
  createdAt: string
}

interface EmailMockState {
  hits: {
    kpi: number
    subscribers: number
    templates: number
    messages: number
  }
  /** Captured ?status=... values from /api/admin/email/subscribers calls. */
  subscriberStatusQueries: string[]
}

/**
 * Configures localStorage with an API key so AuthGuard does not redirect,
 * and routes every backend endpoint /email reaches:
 *   - /api/line-accounts                 (account-context bootstrap)
 *   - /api/admin/email/kpi               (KPI tiles + category breakdown)
 *   - /api/admin/email/subscribers       (subscribers table)
 *   - /api/admin/email/templates         (templates table)
 *   - /api/admin/email/messages          (recent messages history)
 *
 * Returns a shared mock state so individual tests can assert on hit
 * counts and recorded subscriber-status queries.
 */
async function setupEmailPage(
  page: import('@playwright/test').Page,
  options?: {
    kpi?: Partial<KpiResponse> & { totals?: Partial<KpiTotals> }
    subscribers?: SubscriberRow[]
    templates?: TemplateRow[]
    messages?: MessageRow[]
  },
): Promise<EmailMockState> {
  const state: EmailMockState = {
    hits: { kpi: 0, subscribers: 0, templates: 0, messages: 0 },
    subscriberStatusQueries: [],
  }

  const baseTotals: KpiTotals = {
    sent: 1200,
    delivered: 1100,
    opened: 440,
    clicked: 88,
    bounced: 12,
    complained: 2,
    unsubscribed: 5,
    fromDate: '2026-04-02',
    toDate: '2026-05-02',
    ...options?.kpi?.totals,
  }

  const kpi: KpiResponse = {
    totals: baseTotals,
    byCategory: options?.kpi?.byCategory ?? [
      { category: 'marketing', sent: 1000, delivered: 920, opened: 380, clicked: 75 },
      { category: 'transactional', sent: 200, delivered: 180, opened: 60, clicked: 13 },
    ],
    subscribers: options?.kpi?.subscribers ?? {
      total: 50,
      active: 40,
      inactive: 8,
      transactionalOnly: 2,
    },
  }

  const subscribers: SubscriberRow[] = options?.subscribers ?? [
    {
      id: 'sub_1',
      friend_id: 'friend_abc12345',
      email: 'alice@example.com',
      is_active: 1,
      transactional_only: 0,
      unsubscribed_at: null,
      bounce_count: 0,
      complaint_count: 0,
      consent_source: 'manual',
      consent_at: '2026-04-01T00:00:00',
      created_at: '2026-04-01T00:00:00',
      updated_at: '2026-04-01T00:00:00',
    },
    {
      id: 'sub_2',
      friend_id: null,
      email: 'bob@example.com',
      is_active: 0,
      transactional_only: 0,
      unsubscribed_at: '2026-04-15T00:00:00',
      bounce_count: 0,
      complaint_count: 0,
      consent_source: 'form',
      consent_at: '2026-03-20T00:00:00',
      created_at: '2026-03-20T00:00:00',
      updated_at: '2026-04-15T00:00:00',
    },
  ]

  const templates: TemplateRow[] = options?.templates ?? [
    {
      id: 'tpl_1',
      name: 'ウェルカム',
      category: 'marketing',
      subject: 'naturism へようこそ!',
      html_content: '<h1>Welcome</h1>',
      text_content: 'Welcome',
      preheader: '初回特典のご案内',
      is_active: 1,
      created_at: '2026-04-01T00:00:00',
      updated_at: '2026-04-10T00:00:00',
    },
    {
      id: 'tpl_2',
      name: 'カート復帰',
      category: 'marketing',
      subject: 'カートに商品が残っています',
      html_content: '<p>戻ってきてください</p>',
      text_content: '戻ってきてください',
      preheader: null,
      is_active: 0,
      created_at: '2026-04-01T00:00:00',
      updated_at: '2026-04-12T00:00:00',
    },
  ]

  const messages: MessageRow[] = options?.messages ?? [
    {
      id: 'msg_1',
      subscriberId: 'sub_1',
      email: 'alice@example.com',
      subject: 'naturism へようこそ!',
      category: 'marketing',
      sourceKind: 'broadcast',
      status: 'delivered',
      openCount: 1,
      clickCount: 0,
      sentAt: '2026-05-01T09:00:00',
      deliveredAt: '2026-05-01T09:00:05',
      firstOpenedAt: '2026-05-01T10:00:00',
      lastEventAt: '2026-05-01T10:00:00',
      createdAt: '2026-05-01T09:00:00',
    },
  ]

  await page.addInitScript(() => {
    window.localStorage.setItem('lh_api_key', 'e2e-test-key')
  })

  // Account-context bootstrap.
  await page.route(`${API_BASE}/api/line-accounts`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: [
          {
            id: 'acc_e2e',
            channelId: 'channel_e2e',
            name: 'naturism (e2e)',
            displayName: 'naturism (e2e)',
            isActive: true,
          },
        ],
      }),
    })
  })

  await page.route(`**/api/admin/email/kpi**`, async (route) => {
    state.hits.kpi += 1
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: kpi }),
    })
  })

  await page.route(`**/api/admin/email/subscribers**`, async (route) => {
    const req = route.request()
    if (req.method() === 'GET') {
      state.hits.subscribers += 1
      const url = new URL(req.url())
      const status = url.searchParams.get('status') ?? ''
      state.subscriberStatusQueries.push(status)
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: { subscribers } }),
      })
      return
    }
    // POST / PATCH on subscribers — not exercised in current tests but
    // return a generic success so the page's mutate handlers do not
    // surface unexpected errors if a future test triggers them.
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: null }),
    })
  })

  await page.route(`**/api/admin/email/templates**`, async (route) => {
    const req = route.request()
    if (req.method() === 'GET') {
      state.hits.templates += 1
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: { templates } }),
      })
      return
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: null }),
    })
  })

  await page.route(`**/api/admin/email/messages**`, async (route) => {
    state.hits.messages += 1
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: { messages } }),
    })
  })

  return state
}

test.describe('email page', () => {
  test('redirects unauthenticated users from /email to /login', async ({ page }) => {
    // AuthGuard reads localStorage['lh_api_key'] client-side; without it
    // the user must land on /login.
    await page.goto('/email')
    await page.waitForURL('**/login', { timeout: 10_000 })
    await expect(page).toHaveURL(/\/login$/)
  })

  test('renders KPI cards from /api/admin/email/kpi totals', async ({ page }) => {
    const state = await setupEmailPage(page, {
      kpi: {
        totals: {
          sent: 1200,
          delivered: 1100,
          opened: 440,
          clicked: 88,
          bounced: 12,
          complained: 2,
          unsubscribed: 5,
          fromDate: '2026-04-02',
          toDate: '2026-05-02',
        },
      },
    })

    await page.goto('/email')

    await expect(page.getByRole('heading', { name: '📧 メール配信' })).toBeVisible()

    // KPI cards use the daisyUI `card bg-base-100 shadow-sm` shell with
    // a left-border accent, plus an inner card-body. Filter by label so
    // the locator is unambiguous against the rest of the page.
    const sentCard = page.locator('.card .card-body').filter({ hasText: '送信' })
    const deliveredCard = page
      .locator('.card .card-body')
      .filter({ hasText: '配信完了' })
    const openedCard = page.locator('.card .card-body').filter({ hasText: '開封' })
    const clickedCard = page
      .locator('.card .card-body')
      .filter({ hasText: 'クリック' })

    // .toLocaleString() emits "1,200" / "1,100" / "440" / "88" — assert
    // on the formatted strings to lock in the number formatting too.
    await expect(sentCard).toContainText('1,200')
    await expect(deliveredCard).toContainText('1,100')
    await expect(openedCard).toContainText('440')
    await expect(clickedCard).toContainText('88')

    expect(state.hits.kpi).toBeGreaterThanOrEqual(1)
  })

  test('renders templates list from /api/admin/email/templates', async ({ page }) => {
    await setupEmailPage(page, {
      templates: [
        {
          id: 'tpl_1',
          name: 'ウェルカム',
          category: 'marketing',
          subject: 'naturism へようこそ!',
          html_content: '<h1>Welcome</h1>',
          text_content: 'Welcome',
          preheader: '初回特典のご案内',
          is_active: 1,
          created_at: '2026-04-01T00:00:00',
          updated_at: '2026-04-10T00:00:00',
        },
        {
          id: 'tpl_2',
          name: 'カート復帰',
          category: 'marketing',
          subject: 'カートに商品が残っています',
          html_content: '<p>戻ってきてください</p>',
          text_content: '戻ってきてください',
          preheader: null,
          is_active: 0,
          created_at: '2026-04-01T00:00:00',
          updated_at: '2026-04-12T00:00:00',
        },
      ],
    })

    await page.goto('/email')

    await expect(page.getByRole('heading', { name: 'テンプレート' })).toBeVisible()

    // Anchor row queries inside the templates section to avoid bleed
    // from the messages history table (which also has 件名/状態 cols).
    const templatesSection = page
      .locator('section')
      .filter({ has: page.getByRole('heading', { name: 'テンプレート' }) })

    const welcomeRow = templatesSection
      .locator('tbody tr')
      .filter({ hasText: 'ウェルカム' })
    await expect(welcomeRow).toContainText('naturism へようこそ!')
    await expect(welcomeRow).toContainText('有効')

    const cartRow = templatesSection
      .locator('tbody tr')
      .filter({ hasText: 'カート復帰' })
    await expect(cartRow).toContainText('カートに商品が残っています')
    await expect(cartRow).toContainText('無効')
  })

  test('subscriber status filter switches the request to ?status=inactive', async ({
    page,
  }) => {
    const state = await setupEmailPage(page)

    await page.goto('/email')

    // Wait for the initial load (status=all) to land before changing
    // the dropdown — otherwise we can race the post-mount fetch.
    await expect
      .poll(() => state.hits.subscribers, { timeout: 5_000 })
      .toBeGreaterThanOrEqual(1)

    const initialHits = state.hits.subscribers

    // Change the status dropdown to "解除済み" → triggers a new fetch.
    await page.getByLabel('購読者ステータス').selectOption('inactive')

    await expect
      .poll(() => state.hits.subscribers, { timeout: 5_000 })
      .toBeGreaterThan(initialHits)

    // The new request must include status=inactive in its query string.
    expect(state.subscriberStatusQueries).toContain('inactive')
  })
})
