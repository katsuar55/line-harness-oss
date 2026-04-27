import { test, expect } from '@playwright/test'

/**
 * E2E coverage for the 誕生月収集 (birthday-collection) admin page.
 *
 * Scope:
 *   - Auth gate: unauthenticated visit redirects to /login.
 *   - Stats render: registered/unregistered numbers visible after auth.
 *   - Preview: POST /api/birthday-collection/preview is called and the
 *     returned message text is rendered inside the preview card.
 *   - Dry-run default: clicking "テスト実行 (DryRun)" sends dryRun=true and
 *     surfaces the DryRun confirmation banner.
 *   - Live send confirmation: "本送信" requires the explicit
 *     confirmation modal ("本送信" typed in the input) before any
 *     dryRun=false request fires.
 *
 * All worker endpoints are mocked via page.route() against
 * NEXT_PUBLIC_API_URL (http://localhost:8787 in CI). No real API calls.
 */

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8787'

const PREVIEW_TEXT =
  'naturismをご愛用いただきありがとうございます！\nお誕生月を教えてください。'

interface MockState {
  /** Last body received by /api/birthday-collection/send */
  lastSendBody: { dryRun?: boolean; customText?: string } | null
  /** Number of times each endpoint was hit */
  hits: { stats: number; preview: number; send: number }
}

/**
 * Set the API key in localStorage *before* any page script runs, so the
 * AuthGuard sees an authenticated session on first render.
 *
 * Wires page.route() handlers for every backend endpoint the page touches:
 *   - /api/line-accounts            (account-context bootstrap)
 *   - /api/birthday-collection/stats
 *   - /api/birthday-collection/preview
 *   - /api/birthday-collection/send
 *
 * Returns a shared MockState so individual tests can assert on what the
 * page sent to the backend.
 */
async function setupAuthedPage(
  page: import('@playwright/test').Page,
  overrides?: { unregistered?: number; registered?: number; total?: number },
): Promise<MockState> {
  const state: MockState = {
    lastSendBody: null,
    hits: { stats: 0, preview: 0, send: 0 },
  }

  const stats = {
    total: overrides?.total ?? 1000,
    registered: overrides?.registered ?? 600,
    unregistered: overrides?.unregistered ?? 400,
  }

  await page.addInitScript(() => {
    window.localStorage.setItem('lh_api_key', 'e2e-test-key')
  })

  // Account context bootstrap — return a single account so the provider
  // settles into a non-loading state without hitting the real worker.
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

  await page.route(`**/api/birthday-collection/stats**`, async (route) => {
    state.hits.stats += 1
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: stats }),
    })
  })

  await page.route(`**/api/birthday-collection/preview`, async (route) => {
    state.hits.preview += 1
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          type: 'text',
          text: PREVIEW_TEXT,
          quickReply: {
            items: Array.from({ length: 12 }, (_, i) => ({
              type: 'action',
              action: {
                type: 'postback',
                label: `${i + 1}月`,
                data: `birthday_month=${i + 1}`,
              },
            })),
          },
        },
      }),
    })
  })

  await page.route(`**/api/birthday-collection/send`, async (route) => {
    state.hits.send += 1
    const raw = route.request().postData() ?? '{}'
    try {
      state.lastSendBody = JSON.parse(raw) as MockState['lastSendBody']
    } catch {
      state.lastSendBody = null
    }
    const dryRun = state.lastSendBody?.dryRun !== false
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: dryRun
          ? { dryRun: true, targetCount: stats.unregistered }
          : {
              dryRun: false,
              targetCount: stats.unregistered,
              sent: stats.unregistered,
              errors: 0,
            },
      }),
    })
  })

  return state
}

test.describe('birthday-collection page', () => {
  // The unauthenticated-redirect contract for /birthday-collection is
  // exercised in apps/web/e2e/auth-guard.spec.ts (canonical home for
  // cross-cutting auth behavior). Don't duplicate it here.

  test('renders registered / unregistered stats after authentication', async ({ page }) => {
    await setupAuthedPage(page, { total: 1000, registered: 600, unregistered: 400 })

    await page.goto('/birthday-collection')

    await expect(page.getByRole('heading', { name: '誕生月収集' })).toBeVisible()
    await expect(page.getByText('合計フォロワー')).toBeVisible()

    // Each stats card is `<div class="bg-gray-50 rounded-lg ...">` with
    // a numeric <p> above its label <p>. Anchor on the card class and
    // filter by the label substring — Playwright's `filter({ hasText })`
    // matches descendants, so this works regardless of which child holds
    // the label text.
    const totalCard = page.locator('.bg-gray-50.rounded-lg').filter({ hasText: '合計フォロワー' })
    const registeredCard = page.locator('.bg-gray-50.rounded-lg').filter({ hasText: '誕生月 登録済' })
    const unregisteredCard = page.locator('.bg-gray-50.rounded-lg').filter({ hasText: '未登録 (送信対象)' })

    await expect(totalCard).toContainText('1000')
    await expect(registeredCard).toContainText('600')
    await expect(unregisteredCard).toContainText('400')
  })

  test('preview API is called and the returned message text renders', async ({ page }) => {
    const state = await setupAuthedPage(page)

    await page.goto('/birthday-collection')

    // Preview kicks off automatically on mount; wait for the text to appear.
    await expect(page.getByText(PREVIEW_TEXT)).toBeVisible({ timeout: 10_000 })
    expect(state.hits.preview).toBeGreaterThanOrEqual(1)

    // The 12 month chips should also be rendered alongside the preview text.
    for (const m of [1, 6, 12]) {
      await expect(page.getByText(`${m}月`, { exact: true }).first()).toBeVisible()
    }
  })

  test('dry-run button sends dryRun=true and shows the DryRun banner', async ({ page }) => {
    const state = await setupAuthedPage(page, { unregistered: 400 })

    await page.goto('/birthday-collection')
    await expect(page.getByText(PREVIEW_TEXT)).toBeVisible()

    await page.getByRole('button', { name: /テスト実行 \(DryRun\)/ }).click()

    await expect(page.getByText('DryRun 完了')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByText(/送信対象:\s*400\s*人/)).toBeVisible()

    expect(state.hits.send).toBe(1)
    expect(state.lastSendBody?.dryRun).toBe(true)
  })

  test('live send requires explicit confirmation before firing', async ({ page }) => {
    const state = await setupAuthedPage(page, { unregistered: 400 })

    await page.goto('/birthday-collection')
    await expect(page.getByText(PREVIEW_TEXT)).toBeVisible()

    // Open the confirmation modal.
    await page.getByRole('button', { name: /^本送信 \(/ }).click()
    await expect(page.getByRole('heading', { name: '本送信の確認' })).toBeVisible()

    // The execute button stays disabled until the magic phrase is typed.
    const executeButton = page.getByRole('button', { name: '送信実行' })
    await expect(executeButton).toBeDisabled()

    // Wrong phrase keeps it disabled and must NOT trigger any send.
    await page.getByPlaceholder('本送信').fill('送信して')
    await expect(executeButton).toBeDisabled()
    expect(state.hits.send).toBe(0)

    // Correct phrase enables it; clicking fires dryRun=false exactly once.
    await page.getByPlaceholder('本送信').fill('本送信')
    await expect(executeButton).toBeEnabled()
    await executeButton.click()

    await expect(page.getByText('本送信 完了')).toBeVisible({ timeout: 10_000 })
    expect(state.hits.send).toBe(1)
    expect(state.lastSendBody?.dryRun).toBe(false)
  })
})
