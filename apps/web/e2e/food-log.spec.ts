import { test, expect } from '@playwright/test'

/**
 * E2E coverage for the Phase 3 food-log → Phase 4/5 nutrition coach
 * pipeline as surfaced in the admin UI.
 *
 * Background:
 *   - The admin app does NOT expose a dedicated food-log list page —
 *     food images are received via the LIFF webhook and persisted in
 *     `food_logs`, but the only admin-side surface is the /coach
 *     dashboard which aggregates those food logs into nutrition
 *     deficit signals via /api/admin/coach/analytics.
 *
 *   - These tests therefore exercise the food-log → coach data flow by
 *     mocking the analytics endpoint with shapes that correspond to
 *     real food-log analyzer output (multiple deficit keys; or empty
 *     when no food logs exist for the period).
 *
 * Scope:
 *   - Empty state: when food logs in the selected period produce no
 *     deficit signals, the by-deficit table shows the empty message.
 *   - Multi-deficit rendering: when food log analysis produces several
 *     deficit signals, every one of them renders as its own row.
 *
 * All worker endpoints are mocked via page.route() — no real worker
 * dispatch, no LIFF webhook simulation.
 */

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8787'

interface ByDeficitRow {
  deficitKey: string
  generatedCount: number
  clickedCount: number
  convertedCount: number
  ctr: number
  cvr: number
}

interface AnalyticsTotals {
  generated: number
  clicked: number
  converted: number
  ctr: number
  cvr: number
}

/**
 * Configures localStorage for an authenticated session and routes the
 * coach analytics + sku-map endpoints with the supplied analytics
 * payload. The food-log → coach flow surfaces in the by-deficit table,
 * so callers control `byDeficit` per test.
 */
async function setupFoodLogScenario(
  page: import('@playwright/test').Page,
  analytics: { totals: AnalyticsTotals; byDeficit: ByDeficitRow[] },
): Promise<void> {
  await page.addInitScript(() => {
    window.localStorage.setItem('lh_api_key', 'e2e-test-key')
  })

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
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: analytics }),
    })
  })

  // SKU map is queried unconditionally by /coach on mount; return an
  // empty list so the page settles without surfacing fetch errors.
  await page.route(`**/api/admin/coach/sku-map`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: [] }),
    })
  })
}

test.describe('food-log → coach pipeline', () => {
  test('shows empty state when no food logs produced any deficit signals', async ({ page }) => {
    await setupFoodLogScenario(page, {
      totals: { generated: 0, clicked: 0, converted: 0, ctr: 0, cvr: 0 },
      byDeficit: [],
    })

    await page.goto('/coach')

    // The by-deficit card header is always visible; the empty message
    // appears only when byDeficit is an empty array.
    await expect(page.getByRole('heading', { name: '不足キー別 実績' })).toBeVisible()
    await expect(
      page.getByText('この期間に生成されたレコメンドはありません。'),
    ).toBeVisible()

    // KPI cards still render the zero totals (not the loading dash).
    const generatedCard = page.locator('.rounded-lg.p-3.text-center').filter({ hasText: '生成数' })
    await expect(generatedCard).toContainText('0')
  })

  test('renders one row per deficit key when food-log analysis surfaces multiple deficits', async ({
    page,
  }) => {
    // Simulate food-log analyzer output: 3 distinct deficit signals
    // (protein, fiber, iron) — each becomes its own row in the
    // by-deficit table on /coach.
    await setupFoodLogScenario(page, {
      totals: { generated: 30, clicked: 9, converted: 2, ctr: 0.3, cvr: 0.0667 },
      byDeficit: [
        {
          deficitKey: 'protein_low',
          generatedCount: 15,
          clickedCount: 5,
          convertedCount: 1,
          ctr: 0.3333,
          cvr: 0.0667,
        },
        {
          deficitKey: 'fiber_low',
          generatedCount: 10,
          clickedCount: 3,
          convertedCount: 1,
          ctr: 0.3,
          cvr: 0.1,
        },
        {
          deficitKey: 'iron_low',
          generatedCount: 5,
          clickedCount: 1,
          convertedCount: 0,
          ctr: 0.2,
          cvr: 0,
        },
      ],
    })

    await page.goto('/coach')

    const byDeficitCard = page.locator('div.bg-white.rounded-xl.border.p-5').filter({
      has: page.getByRole('heading', { name: '不足キー別 実績' }),
    })

    // All three deficit keys produced by the food-log analyzer should
    // be present, each with its Japanese label and counts.
    const proteinRow = byDeficitCard.locator('tbody tr').filter({ hasText: 'protein_low' })
    await expect(proteinRow).toContainText('たんぱく質 不足')
    await expect(proteinRow).toContainText('15')

    const fiberRow = byDeficitCard.locator('tbody tr').filter({ hasText: 'fiber_low' })
    await expect(fiberRow).toContainText('食物繊維 不足')
    await expect(fiberRow).toContainText('10')

    const ironRow = byDeficitCard.locator('tbody tr').filter({ hasText: 'iron_low' })
    await expect(ironRow).toContainText('鉄分 不足')
    await expect(ironRow).toContainText('5')

    // Empty-state message must NOT be visible when rows exist.
    await expect(
      page.getByText('この期間に生成されたレコメンドはありません。'),
    ).toBeHidden()
  })
})
