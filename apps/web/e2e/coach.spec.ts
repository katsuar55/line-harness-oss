import { test, expect } from '@playwright/test'

/**
 * E2E coverage for the 栄養コーチ ダッシュボード (/coach) admin page.
 *
 * Scope:
 *   - Auth gate: unauthenticated visit redirects to /login.
 *   - KPI cards: totals (生成数 / クリック / 購入 / CTR / CVR) render after
 *     /api/admin/coach/analytics resolves.
 *   - by-deficit table: rows from analytics.byDeficit render with the
 *     deficit key + Japanese label and CTR/CVR percentages.
 *   - SKU map: /api/admin/coach/sku-map rows render against the fixed
 *     5-row deficit-key grid (protein_low, fiber_low, iron_low,
 *     calorie_low, calorie_high) with ON/OFF active badges.
 *
 * All worker endpoints are mocked via page.route() against
 * NEXT_PUBLIC_API_URL (http://localhost:8787 by default). No real API
 * calls are made.
 */

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8787'

interface AnalyticsTotals {
  generated: number
  clicked: number
  converted: number
  ctr: number
  cvr: number
}

interface ByDeficitRow {
  deficitKey: string
  generatedCount: number
  clickedCount: number
  convertedCount: number
  ctr: number
  cvr: number
}

interface SkuMapItem {
  deficit_key: string
  shopify_product_id: string
  product_title: string
  copy_template: string
  is_active: number
  created_at: string
}

interface CoachMockState {
  hits: { analytics: number; skuMap: number }
}

/**
 * Configures localStorage with an API key so the AuthGuard does not
 * redirect, and routes every backend endpoint /coach reaches:
 *   - /api/line-accounts            (account-context bootstrap)
 *   - /api/admin/coach/analytics    (KPI + by-deficit)
 *   - /api/admin/coach/sku-map      (SKU map list)
 *
 * Returns a shared mock state so individual tests can assert on hit
 * counts when needed.
 */
async function setupCoachPage(
  page: import('@playwright/test').Page,
  options?: {
    totals?: Partial<AnalyticsTotals>
    byDeficit?: ByDeficitRow[]
    skuMap?: SkuMapItem[]
  },
): Promise<CoachMockState> {
  const state: CoachMockState = {
    hits: { analytics: 0, skuMap: 0 },
  }

  const totals: AnalyticsTotals = {
    generated: 100,
    clicked: 25,
    converted: 5,
    ctr: 0.25,
    cvr: 0.05,
    ...options?.totals,
  }

  const byDeficit: ByDeficitRow[] = options?.byDeficit ?? [
    {
      deficitKey: 'protein_low',
      generatedCount: 60,
      clickedCount: 18,
      convertedCount: 4,
      ctr: 0.3,
      cvr: 0.0667,
    },
    {
      deficitKey: 'fiber_low',
      generatedCount: 40,
      clickedCount: 7,
      convertedCount: 1,
      ctr: 0.175,
      cvr: 0.025,
    },
  ]

  const skuMap: SkuMapItem[] = options?.skuMap ?? [
    {
      deficit_key: 'protein_low',
      shopify_product_id: 'gid://shopify/Product/1001',
      product_title: 'naturism プロテイン',
      copy_template: 'タンパク質をしっかり補給',
      is_active: 1,
      created_at: '2026-04-01T00:00:00',
    },
    {
      deficit_key: 'fiber_low',
      shopify_product_id: 'gid://shopify/Product/1002',
      product_title: 'naturism ファイバー',
      copy_template: '食物繊維で腸内環境を整える',
      is_active: 1,
      created_at: '2026-04-01T00:00:00',
    },
    {
      deficit_key: 'iron_low',
      shopify_product_id: 'gid://shopify/Product/1003',
      product_title: 'naturism アイアン',
      copy_template: '鉄分でいきいき',
      is_active: 0,
      created_at: '2026-04-01T00:00:00',
    },
  ]

  await page.addInitScript(() => {
    window.localStorage.setItem('lh_api_key', 'e2e-test-key')
  })

  // Account-context bootstrap (provider calls this on mount; if it 404s
  // the layout can stay in a loading state forever).
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

  await page.route(`**/api/admin/coach/analytics**`, async (route) => {
    state.hits.analytics += 1
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: { totals, byDeficit },
      }),
    })
  })

  await page.route(`**/api/admin/coach/sku-map`, async (route) => {
    state.hits.skuMap += 1
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: skuMap }),
    })
  })

  return state
}

test.describe('coach page', () => {
  test('redirects unauthenticated users from /coach to /login', async ({ page }) => {
    // Auth gate is enforced client-side via AuthGuard reading
    // localStorage['lh_api_key']. Verify the canonical contract.
    await page.goto('/coach')
    await page.waitForURL('**/login', { timeout: 10_000 })
    await expect(page).toHaveURL(/\/login$/)
  })

  test('renders KPI cards from /api/admin/coach/analytics totals', async ({ page }) => {
    const state = await setupCoachPage(page, {
      totals: { generated: 100, clicked: 25, converted: 5, ctr: 0.25, cvr: 0.05 },
    })

    await page.goto('/coach')

    await expect(page.getByRole('heading', { name: '栄養コーチ ダッシュボード' })).toBeVisible()

    // Each KPI card uses `rounded-lg p-3 text-center` and contains the
    // numeric value above the Japanese label. Filter by label to pick
    // the right card, then assert on its rendered value.
    const generatedCard = page.locator('.rounded-lg.p-3.text-center').filter({ hasText: '生成数' })
    const clickedCard = page.locator('.rounded-lg.p-3.text-center').filter({ hasText: 'クリック' })
    const convertedCard = page.locator('.rounded-lg.p-3.text-center').filter({ hasText: '購入 (CV)' })
    const ctrCard = page.locator('.rounded-lg.p-3.text-center').filter({ hasText: 'CTR' })
    const cvrCard = page.locator('.rounded-lg.p-3.text-center').filter({ hasText: 'CVR' })

    await expect(generatedCard).toContainText('100')
    await expect(clickedCard).toContainText('25')
    await expect(convertedCard).toContainText('5')
    // Page formats with formatPercent → one decimal digit.
    await expect(ctrCard).toContainText('25.0%')
    await expect(cvrCard).toContainText('5.0%')

    expect(state.hits.analytics).toBeGreaterThanOrEqual(1)
  })

  test('renders by-deficit table rows with key + Japanese label + percentages', async ({ page }) => {
    await setupCoachPage(page, {
      byDeficit: [
        {
          deficitKey: 'protein_low',
          generatedCount: 60,
          clickedCount: 18,
          convertedCount: 4,
          ctr: 0.3,
          cvr: 0.0667,
        },
        {
          deficitKey: 'iron_low',
          generatedCount: 12,
          clickedCount: 3,
          convertedCount: 0,
          ctr: 0.25,
          cvr: 0,
        },
      ],
    })

    await page.goto('/coach')

    await expect(page.getByRole('heading', { name: '不足キー別 実績' })).toBeVisible()

    // Anchor the assertions inside the by-deficit table, since the page
    // also has a SKU map table that reuses the same deficit_key text.
    const byDeficitCard = page.locator('div.bg-white.rounded-xl.border.p-5').filter({
      has: page.getByRole('heading', { name: '不足キー別 実績' }),
    })

    const proteinRow = byDeficitCard.locator('tbody tr').filter({ hasText: 'protein_low' })
    await expect(proteinRow).toContainText('たんぱく質 不足')
    await expect(proteinRow).toContainText('60')
    await expect(proteinRow).toContainText('18')
    await expect(proteinRow).toContainText('30.0%')

    const ironRow = byDeficitCard.locator('tbody tr').filter({ hasText: 'iron_low' })
    await expect(ironRow).toContainText('鉄分 不足')
    await expect(ironRow).toContainText('12')
    await expect(ironRow).toContainText('25.0%')
  })

  test('renders SKU map rows with ON/OFF active badges and 編集 / 追加 buttons', async ({ page }) => {
    await setupCoachPage(page)

    await page.goto('/coach')

    await expect(page.getByRole('heading', { name: 'SKU マッピング' })).toBeVisible()

    // The SKU map renders all 5 fixed deficit keys, regardless of which
    // are present in the API response. Verify the seeded ones show
    // their product titles, and the unseeded ones show "—" + 追加.
    const skuCard = page.locator('div.bg-white.rounded-xl.border.p-5').filter({
      has: page.getByRole('heading', { name: 'SKU マッピング' }),
    })

    const proteinRow = skuCard.locator('tbody tr').filter({ hasText: 'protein_low' })
    await expect(proteinRow).toContainText('naturism プロテイン')
    await expect(proteinRow).toContainText('ON')
    await expect(proteinRow.getByRole('button', { name: '編集' })).toBeVisible()

    const ironRow = skuCard.locator('tbody tr').filter({ hasText: 'iron_low' })
    await expect(ironRow).toContainText('naturism アイアン')
    await expect(ironRow).toContainText('OFF')

    // calorie_low has no SKU map entry in the default fixture → 追加 button.
    const calorieLowRow = skuCard.locator('tbody tr').filter({ hasText: 'calorie_low' })
    await expect(calorieLowRow.getByRole('button', { name: '追加' })).toBeVisible()
  })
})
