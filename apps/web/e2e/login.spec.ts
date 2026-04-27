import { test, expect } from '@playwright/test'

test.describe('login page', () => {
  test('renders the login form', async ({ page }) => {
    await page.goto('/login')
    await expect(page.getByRole('heading', { name: 'naturism' })).toBeVisible()
    await expect(page.getByPlaceholder('APIキーを入力')).toBeVisible()
    await expect(page.getByRole('button', { name: 'ログイン' })).toBeVisible()
  })

  test('keeps the submit button disabled until an api key is entered', async ({ page }) => {
    await page.goto('/login')
    const button = page.getByRole('button', { name: 'ログイン' })
    await expect(button).toBeDisabled()
    await page.getByPlaceholder('APIキーを入力').fill('dummy-key')
    await expect(button).toBeEnabled()
  })
})
