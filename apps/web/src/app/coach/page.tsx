'use client'

import { useState, useEffect, useCallback } from 'react'
import { fetchApi } from '@/lib/api'
import type { ApiResponse } from '@line-crm/shared'

// ============================================================
// 型定義 — worker /api/admin/coach/* レスポンスに対応
// ============================================================

interface CoachAnalyticsTotals {
  generated: number
  clicked: number
  converted: number
  ctr: number
  cvr: number
}

interface ByDeficit {
  deficitKey: string
  generatedCount: number
  clickedCount: number
  convertedCount: number
  ctr: number
  cvr: number
}

interface AnalyticsResponse {
  totals: CoachAnalyticsTotals
  byDeficit: ByDeficit[]
}

interface SkuMapItem {
  deficit_key: string
  shopify_product_id: string
  product_title: string
  copy_template: string
  is_active: number
  created_at: string
}

interface SkuMapForm {
  deficitKey: string
  shopifyProductId: string
  productTitle: string
  copyTemplate: string
  isActive: boolean
}

const DEFICIT_KEYS: ReadonlyArray<string> = [
  'protein_low',
  'fiber_low',
  'iron_low',
  'calorie_low',
  'calorie_high',
]

const DEFICIT_LABELS: Record<string, string> = {
  protein_low: 'たんぱく質 不足',
  fiber_low: '食物繊維 不足',
  iron_low: '鉄分 不足',
  calorie_low: 'カロリー 不足',
  calorie_high: 'カロリー 過多',
}

// ============================================================
// 日付ヘルパー
// ============================================================

function formatDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function defaultDateRange(): { from: string; to: string } {
  const today = new Date()
  const past = new Date()
  past.setDate(past.getDate() - 29)
  return { from: formatDate(past), to: formatDate(today) }
}

function formatPercent(n: number): string {
  return `${(n * 100).toFixed(1)}%`
}

// ============================================================
// Page
// ============================================================

export default function CoachPage() {
  const initialRange = defaultDateRange()
  const [from, setFrom] = useState<string>(initialRange.from)
  const [to, setTo] = useState<string>(initialRange.to)

  const [analytics, setAnalytics] = useState<AnalyticsResponse | null>(null)
  const [analyticsLoading, setAnalyticsLoading] = useState(false)
  const [analyticsError, setAnalyticsError] = useState<string | null>(null)

  const [skuMap, setSkuMap] = useState<SkuMapItem[] | null>(null)
  const [skuLoading, setSkuLoading] = useState(false)
  const [skuError, setSkuError] = useState<string | null>(null)

  // SKU 編集モーダル
  const [editing, setEditing] = useState<SkuMapForm | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const loadAnalytics = useCallback(async () => {
    setAnalyticsLoading(true)
    setAnalyticsError(null)
    try {
      const params = new URLSearchParams({ from, to })
      const json = await fetchApi<ApiResponse<AnalyticsResponse>>(
        `/api/admin/coach/analytics?${params.toString()}`,
      )
      if (json.success) {
        setAnalytics(json.data)
      } else {
        setAnalyticsError(json.error || '集計の取得に失敗しました')
      }
    } catch (err) {
      setAnalyticsError(
        err instanceof Error ? err.message : '集計の取得に失敗しました',
      )
    } finally {
      setAnalyticsLoading(false)
    }
  }, [from, to])

  const loadSkuMap = useCallback(async () => {
    setSkuLoading(true)
    setSkuError(null)
    try {
      const json = await fetchApi<ApiResponse<SkuMapItem[]>>(
        '/api/admin/coach/sku-map',
      )
      if (json.success) {
        setSkuMap(json.data)
      } else {
        setSkuError(json.error || 'SKU マップの取得に失敗しました')
      }
    } catch (err) {
      setSkuError(
        err instanceof Error ? err.message : 'SKU マップの取得に失敗しました',
      )
    } finally {
      setSkuLoading(false)
    }
  }, [])

  useEffect(() => {
    loadAnalytics()
  }, [loadAnalytics])

  useEffect(() => {
    loadSkuMap()
  }, [loadSkuMap])

  function openEdit(row: SkuMapItem | null, deficitKey?: string) {
    setSaveError(null)
    if (row) {
      setEditing({
        deficitKey: row.deficit_key,
        shopifyProductId: row.shopify_product_id,
        productTitle: row.product_title,
        copyTemplate: row.copy_template,
        isActive: row.is_active === 1,
      })
    } else {
      setEditing({
        deficitKey: deficitKey ?? 'protein_low',
        shopifyProductId: '',
        productTitle: '',
        copyTemplate: '',
        isActive: true,
      })
    }
  }

  function closeEdit() {
    setEditing(null)
    setSaveError(null)
  }

  async function saveSkuMap() {
    if (!editing) return
    setSaving(true)
    setSaveError(null)
    try {
      const json = await fetchApi<ApiResponse<null>>(
        '/api/admin/coach/sku-map',
        {
          method: 'PUT',
          body: JSON.stringify({
            deficitKey: editing.deficitKey,
            shopifyProductId: editing.shopifyProductId,
            productTitle: editing.productTitle,
            copyTemplate: editing.copyTemplate,
            isActive: editing.isActive,
          }),
        },
      )
      if (json.success) {
        setEditing(null)
        loadSkuMap()
      } else {
        setSaveError(json.error || '保存に失敗しました')
      }
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : '保存に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  // 各 deficit に対して SKU が登録されているかを判定するための索引
  const skuByKey = new Map<string, SkuMapItem>()
  for (const row of skuMap ?? []) {
    skuByKey.set(row.deficit_key, row)
  }

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-800">栄養コーチ ダッシュボード</h1>
        <p className="text-sm text-gray-500 mt-1">
          AI 栄養コーチの実績 (生成数 / クリック / CV / SKU 別 CTR) と、不足キーごとの推奨 SKU を管理します。
        </p>
      </div>

      {/* Date Range */}
      <div className="bg-white rounded-xl border p-5 mb-6">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-xs text-gray-500 mb-1">開始日</label>
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="px-3 py-2 border rounded-lg text-sm"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">終了日</label>
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="px-3 py-2 border rounded-lg text-sm"
            />
          </div>
          <button
            onClick={loadAnalytics}
            disabled={analyticsLoading}
            className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50"
          >
            {analyticsLoading ? '更新中…' : '更新'}
          </button>
        </div>
      </div>

      {/* KPI cards */}
      {analyticsError && (
        <div className="mb-4 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-3">
          {analyticsError}
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
        <KpiCard
          label="生成数"
          value={analytics?.totals.generated ?? '—'}
          tone="gray"
        />
        <KpiCard
          label="クリック"
          value={analytics?.totals.clicked ?? '—'}
          tone="blue"
        />
        <KpiCard
          label="購入 (CV)"
          value={analytics?.totals.converted ?? '—'}
          tone="green"
        />
        <KpiCard
          label="CTR"
          value={
            analytics ? formatPercent(analytics.totals.ctr) : '—'
          }
          tone="indigo"
        />
        <KpiCard
          label="CVR"
          value={
            analytics ? formatPercent(analytics.totals.cvr) : '—'
          }
          tone="emerald"
        />
      </div>

      {/* by-deficit table */}
      <div className="bg-white rounded-xl border p-5 mb-8">
        <h2 className="text-sm font-bold text-gray-700 mb-3">不足キー別 実績</h2>
        {analytics && analytics.byDeficit.length === 0 ? (
          <p className="text-xs text-gray-500">この期間に生成されたレコメンドはありません。</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-gray-500 border-b">
                <tr>
                  <th className="text-left py-2 px-2">不足キー</th>
                  <th className="text-right py-2 px-2">生成</th>
                  <th className="text-right py-2 px-2">クリック</th>
                  <th className="text-right py-2 px-2">CV</th>
                  <th className="text-right py-2 px-2">CTR</th>
                  <th className="text-right py-2 px-2">CVR</th>
                </tr>
              </thead>
              <tbody>
                {(analytics?.byDeficit ?? []).map((row) => (
                  <tr key={row.deficitKey} className="border-b last:border-0">
                    <td className="py-2 px-2 font-mono text-xs">
                      <span className="block">{row.deficitKey}</span>
                      <span className="text-[10px] text-gray-400">
                        {DEFICIT_LABELS[row.deficitKey] ?? ''}
                      </span>
                    </td>
                    <td className="text-right py-2 px-2">{row.generatedCount}</td>
                    <td className="text-right py-2 px-2">{row.clickedCount}</td>
                    <td className="text-right py-2 px-2">{row.convertedCount}</td>
                    <td className="text-right py-2 px-2">{formatPercent(row.ctr)}</td>
                    <td className="text-right py-2 px-2">{formatPercent(row.cvr)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* SKU map */}
      <div className="bg-white rounded-xl border p-5">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-bold text-gray-700">SKU マッピング</h2>
          <button
            onClick={loadSkuMap}
            disabled={skuLoading}
            className="text-xs px-3 py-1.5 rounded-lg border text-gray-600 hover:bg-gray-50 disabled:opacity-50"
          >
            {skuLoading ? '更新中…' : '更新'}
          </button>
        </div>

        {skuError && (
          <div className="mb-3 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-3">
            {skuError}
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs text-gray-500 border-b">
              <tr>
                <th className="text-left py-2 px-2">不足キー</th>
                <th className="text-left py-2 px-2">商品名</th>
                <th className="text-left py-2 px-2">Shopify Product ID</th>
                <th className="text-left py-2 px-2">コピー</th>
                <th className="text-center py-2 px-2">Active</th>
                <th className="py-2 px-2"></th>
              </tr>
            </thead>
            <tbody>
              {DEFICIT_KEYS.map((key) => {
                const row = skuByKey.get(key)
                return (
                  <tr key={key} className="border-b last:border-0 align-top">
                    <td className="py-2 px-2 font-mono text-xs">
                      <span className="block">{key}</span>
                      <span className="text-[10px] text-gray-400">
                        {DEFICIT_LABELS[key]}
                      </span>
                    </td>
                    <td className="py-2 px-2">{row?.product_title ?? <span className="text-gray-300">—</span>}</td>
                    <td className="py-2 px-2 font-mono text-xs">
                      {row?.shopify_product_id ?? <span className="text-gray-300">—</span>}
                    </td>
                    <td className="py-2 px-2 max-w-xs truncate">
                      {row?.copy_template ?? <span className="text-gray-300">—</span>}
                    </td>
                    <td className="text-center py-2 px-2">
                      {row ? (
                        row.is_active === 1 ? (
                          <span className="px-2 py-0.5 rounded-full bg-green-100 text-green-700 text-xs">
                            ON
                          </span>
                        ) : (
                          <span className="px-2 py-0.5 rounded-full bg-gray-100 text-gray-500 text-xs">
                            OFF
                          </span>
                        )
                      ) : (
                        <span className="text-gray-300">—</span>
                      )}
                    </td>
                    <td className="py-2 px-2 text-right">
                      <button
                        onClick={() => openEdit(row ?? null, key)}
                        className="text-xs px-3 py-1 rounded-lg border text-blue-600 hover:bg-blue-50"
                      >
                        {row ? '編集' : '追加'}
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Edit modal */}
      {editing && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
          onClick={closeEdit}
        >
          <div
            className="bg-white rounded-xl p-6 w-full max-w-lg mx-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-bold text-gray-800 mb-4">
              SKU マッピング編集
            </h2>

            <div className="space-y-3">
              <div>
                <label className="block text-xs text-gray-500 mb-1">
                  不足キー
                </label>
                <select
                  value={editing.deficitKey}
                  onChange={(e) =>
                    setEditing({ ...editing, deficitKey: e.target.value })
                  }
                  className="w-full px-3 py-2 border rounded-lg text-sm"
                >
                  {DEFICIT_KEYS.map((k) => (
                    <option key={k} value={k}>
                      {k} ({DEFICIT_LABELS[k]})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs text-gray-500 mb-1">
                  Shopify Product ID
                </label>
                <input
                  type="text"
                  value={editing.shopifyProductId}
                  onChange={(e) =>
                    setEditing({ ...editing, shopifyProductId: e.target.value })
                  }
                  placeholder="gid://shopify/Product/1234567890"
                  className="w-full px-3 py-2 border rounded-lg text-sm font-mono"
                />
              </div>

              <div>
                <label className="block text-xs text-gray-500 mb-1">
                  商品名 (max 100)
                </label>
                <input
                  type="text"
                  value={editing.productTitle}
                  maxLength={100}
                  onChange={(e) =>
                    setEditing({ ...editing, productTitle: e.target.value })
                  }
                  className="w-full px-3 py-2 border rounded-lg text-sm"
                />
                <p className="text-[10px] text-gray-400 text-right mt-1">
                  {editing.productTitle.length}/100
                </p>
              </div>

              <div>
                <label className="block text-xs text-gray-500 mb-1">
                  コピー (max 200)
                </label>
                <textarea
                  value={editing.copyTemplate}
                  maxLength={200}
                  rows={3}
                  onChange={(e) =>
                    setEditing({ ...editing, copyTemplate: e.target.value })
                  }
                  className="w-full px-3 py-2 border rounded-lg text-sm"
                />
                <p className="text-[10px] text-gray-400 text-right mt-1">
                  {editing.copyTemplate.length}/200
                </p>
              </div>

              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={editing.isActive}
                  onChange={(e) =>
                    setEditing({ ...editing, isActive: e.target.checked })
                  }
                />
                Active (LIFF / push に使う)
              </label>
            </div>

            {saveError && (
              <div className="mt-3 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-3">
                {saveError}
              </div>
            )}

            <div className="flex gap-2 mt-5">
              <button
                onClick={closeEdit}
                className="flex-1 py-2 rounded-lg border text-sm"
              >
                キャンセル
              </button>
              <button
                onClick={saveSkuMap}
                disabled={
                  saving ||
                  !editing.shopifyProductId.trim() ||
                  !editing.productTitle.trim() ||
                  !editing.copyTemplate.trim()
                }
                className="flex-1 py-2 rounded-lg bg-blue-600 text-white text-sm font-bold disabled:opacity-30"
              >
                {saving ? '保存中…' : '保存'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ============================================================
// 小コンポーネント
// ============================================================

interface KpiCardProps {
  label: string
  value: string | number
  tone: 'gray' | 'blue' | 'green' | 'indigo' | 'emerald'
}

const TONE_CLASSES: Record<KpiCardProps['tone'], string> = {
  gray: 'bg-gray-50 text-gray-800',
  blue: 'bg-blue-50 text-blue-700',
  green: 'bg-green-50 text-green-700',
  indigo: 'bg-indigo-50 text-indigo-700',
  emerald: 'bg-emerald-50 text-emerald-700',
}

function KpiCard({ label, value, tone }: KpiCardProps) {
  return (
    <div className={`rounded-lg p-3 text-center ${TONE_CLASSES[tone]}`}>
      <p className="text-2xl font-bold">{value}</p>
      <p className="text-xs text-gray-500 mt-1">{label}</p>
    </div>
  )
}
