import { test, expect } from '@playwright/test'

test.describe('auth guard', () => {
  test('redirects unauthenticated users from / to /login', async ({ page }) => {
    await page.goto('/')
    await page.waitForURL('**/login', { timeout: 10_000 })
    await expect(page).toHaveURL(/\/login$/)
  })

  test('redirects unauthenticated users from /dashboard to /login', async ({ page }) => {
    await page.goto('/dashboard')
    await page.waitForURL('**/login', { timeout: 10_000 })
    await expect(page).toHaveURL(/\/login$/)
  })

  test('redirects unauthenticated users from /birthday-collection to /login', async ({ page }) => {
    await page.goto('/birthday-collection')
    await page.waitForURL('**/login', { timeout: 10_000 })
    await expect(page).toHaveURL(/\/login$/)
  })
})
