'use client'

import { useState, useEffect, useCallback } from 'react'
import { fetchApi } from '@/lib/api'
import type { ApiResponse } from '@line-crm/shared'

// ============================================================
// 型定義 — worker /api/admin/reorder/* レスポンスに対応
// ============================================================

interface SummaryTotals {
  enrolled: number
  active: number
  pushed: number
  pushedRecent: number
  fromDate: string
  toDate: string
}

interface BySourceRow {
  source: string
  count: number
  active: number
}

interface RecentRow {
  id: string
  friendId: string
  friendName: string | null
  productTitle: string
  intervalDays: number
  intervalSource: string | null
  nextReminderAt: string
  lastSentAt: string | null
  isActive: boolean
  createdAt: string
}

interface SummaryResponse {
  totals: SummaryTotals
  bySource: BySourceRow[]
  recent: RecentRow[]
}

interface CrossSellRule {
  source_product_id: string
  recommended_product_id: string
  reason: string | null
  priority: number
  is_active: number
  created_at: string
  updated_at: string
}

interface ProductIntervalRow {
  shopify_product_id: string
  product_title: string | null
  default_interval_days: number
  source: string
  sample_size: number
  notes: string | null
  created_at: string
  updated_at: string
}

interface CrossSellForm {
  sourceProductId: string
  recommendedProductId: string
  reason: string
  priority: number
  isActive: boolean
}

interface ProductIntervalForm {
  shopifyProductId: string
  productTitle: string
  defaultIntervalDays: number
  source: string
  notes: string
}

const SOURCE_LABEL: Record<string, string> = {
  manual: '手動',
  product_default: '商品デフォルト',
  user_history: 'ユーザー履歴',
  seed: 'シード',
  auto_estimated: '商品名推定',
  fallback: '標準 (30日)',
}

const VALID_SOURCES = ['manual', 'product_default', 'user_history', 'seed', 'auto_estimated', 'fallback']

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

function formatJstDate(iso: string | null | undefined): string {
  if (!iso) return '-'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '-'
  return d.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })
}

function sourceLabel(s: string | null | undefined): string {
  if (!s) return '-'
  return SOURCE_LABEL[s] ?? s
}

// ============================================================
// Page
// ============================================================

export default function ReorderPage() {
  const initialRange = defaultDateRange()
  const [from, setFrom] = useState<string>(initialRange.from)
  const [to, setTo] = useState<string>(initialRange.to)

  const [summary, setSummary] = useState<SummaryResponse | null>(null)
  const [summaryLoading, setSummaryLoading] = useState(false)
  const [summaryError, setSummaryError] = useState<string | null>(null)

  const [crossSell, setCrossSell] = useState<CrossSellRule[] | null>(null)
  const [crossSellLoading, setCrossSellLoading] = useState(false)
  const [crossSellError, setCrossSellError] = useState<string | null>(null)
  const [editingCrossSell, setEditingCrossSell] = useState<CrossSellForm | null>(null)
  const [savingCS, setSavingCS] = useState(false)
  const [saveCSError, setSaveCSError] = useState<string | null>(null)

  const [intervals, setIntervals] = useState<ProductIntervalRow[] | null>(null)
  const [intervalsLoading, setIntervalsLoading] = useState(false)
  const [intervalsError, setIntervalsError] = useState<string | null>(null)
  const [editingInterval, setEditingInterval] = useState<ProductIntervalForm | null>(null)
  const [savingPI, setSavingPI] = useState(false)
  const [savePIError, setSavePIError] = useState<string | null>(null)

  // ----------------------------------------------------------
  // Loaders
  // ----------------------------------------------------------

  const loadSummary = useCallback(async () => {
    setSummaryLoading(true)
    setSummaryError(null)
    try {
      const params = new URLSearchParams({ from, to })
      const json = await fetchApi<ApiResponse<SummaryResponse>>(
        `/api/admin/reorder/summary?${params.toString()}`,
      )
      if (json.success) {
        setSummary(json.data)
      } else {
        setSummaryError(json.error || 'Failed to load summary')
      }
    } catch (err) {
      setSummaryError(err instanceof Error ? err.message : 'Network error')
    } finally {
      setSummaryLoading(false)
    }
  }, [from, to])

  const loadCrossSell = useCallback(async () => {
    setCrossSellLoading(true)
    setCrossSellError(null)
    try {
      const json = await fetchApi<ApiResponse<{ rules: CrossSellRule[] }>>(
        '/api/admin/reorder/cross-sell',
      )
      if (json.success) {
        setCrossSell(json.data.rules || [])
      } else {
        setCrossSellError(json.error || 'Failed to load cross-sell rules')
      }
    } catch (err) {
      setCrossSellError(err instanceof Error ? err.message : 'Network error')
    } finally {
      setCrossSellLoading(false)
    }
  }, [])

  const loadIntervals = useCallback(async () => {
    setIntervalsLoading(true)
    setIntervalsError(null)
    try {
      const json = await fetchApi<ApiResponse<{ intervals: ProductIntervalRow[] }>>(
        '/api/admin/reorder/product-intervals',
      )
      if (json.success) {
        setIntervals(json.data.intervals || [])
      } else {
        setIntervalsError(json.error || 'Failed to load intervals')
      }
    } catch (err) {
      setIntervalsError(err instanceof Error ? err.message : 'Network error')
    } finally {
      setIntervalsLoading(false)
    }
  }, [])

  useEffect(() => {
    loadSummary()
    loadCrossSell()
    loadIntervals()
  }, [loadSummary, loadCrossSell, loadIntervals])

  // ----------------------------------------------------------
  // Cross-sell save / delete
  // ----------------------------------------------------------

  const saveCrossSell = useCallback(async () => {
    if (!editingCrossSell) return
    setSavingCS(true)
    setSaveCSError(null)
    try {
      const json = await fetchApi<ApiResponse<unknown>>(
        '/api/admin/reorder/cross-sell',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(editingCrossSell),
        },
      )
      if (json.success) {
        setEditingCrossSell(null)
        await loadCrossSell()
      } else {
        setSaveCSError(json.error || 'Save failed')
      }
    } catch (err) {
      setSaveCSError(err instanceof Error ? err.message : 'Network error')
    } finally {
      setSavingCS(false)
    }
  }, [editingCrossSell, loadCrossSell])

  const deleteCrossSell = useCallback(
    async (sourceProductId: string, recommendedProductId: string) => {
      if (!confirm(`${sourceProductId} → ${recommendedProductId} のルールを削除しますか?`)) return
      try {
        const params = new URLSearchParams({ sourceProductId, recommendedProductId })
        const json = await fetchApi<ApiResponse<unknown>>(
          `/api/admin/reorder/cross-sell?${params.toString()}`,
          { method: 'DELETE' },
        )
        if (json.success) {
          await loadCrossSell()
        } else {
          alert(json.error || 'Delete failed')
        }
      } catch (err) {
        alert(err instanceof Error ? err.message : 'Network error')
      }
    },
    [loadCrossSell],
  )

  // ----------------------------------------------------------
  // Product interval save / delete
  // ----------------------------------------------------------

  const saveInterval = useCallback(async () => {
    if (!editingInterval) return
    setSavingPI(true)
    setSavePIError(null)
    try {
      const json = await fetchApi<ApiResponse<unknown>>(
        '/api/admin/reorder/product-intervals',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            shopifyProductId: editingInterval.shopifyProductId,
            productTitle: editingInterval.productTitle || undefined,
            defaultIntervalDays: editingInterval.defaultIntervalDays,
            source: editingInterval.source,
            notes: editingInterval.notes || undefined,
          }),
        },
      )
      if (json.success) {
        setEditingInterval(null)
        await loadIntervals()
      } else {
        setSavePIError(json.error || 'Save failed')
      }
    } catch (err) {
      setSavePIError(err instanceof Error ? err.message : 'Network error')
    } finally {
      setSavingPI(false)
    }
  }, [editingInterval, loadIntervals])

  const deleteInterval = useCallback(
    async (id: string) => {
      if (!confirm(`商品 ${id} の間隔設定を削除しますか?`)) return
      try {
        const json = await fetchApi<ApiResponse<unknown>>(
          `/api/admin/reorder/product-intervals/${encodeURIComponent(id)}`,
          { method: 'DELETE' },
        )
        if (json.success) {
          await loadIntervals()
        } else {
          alert(json.error || 'Delete failed')
        }
      } catch (err) {
        alert(err instanceof Error ? err.message : 'Network error')
      }
    },
    [loadIntervals],
  )

  // ----------------------------------------------------------
  // Render
  // ----------------------------------------------------------

  return (
    <div className="container mx-auto p-4 max-w-7xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">📦 再購入リマインダー</h1>
        <p className="text-sm text-gray-500 mt-1">
          Phase 6: subscription_reminders / cross-sell マップ / 商品別間隔の運用画面
        </p>
      </div>

      {/* Date range */}
      <div className="card bg-base-100 shadow-sm">
        <div className="card-body p-4">
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className="label py-1">
                <span className="label-text text-xs">開始日</span>
              </label>
              <input
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                className="input input-bordered input-sm"
              />
            </div>
            <div>
              <label className="label py-1">
                <span className="label-text text-xs">終了日</span>
              </label>
              <input
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                className="input input-bordered input-sm"
              />
            </div>
            <button
              onClick={loadSummary}
              disabled={summaryLoading}
              className="btn btn-primary btn-sm"
            >
              {summaryLoading ? '読み込み中...' : '更新'}
            </button>
          </div>
        </div>
      </div>

      {/* Summary KPIs */}
      <section>
        <h2 className="text-lg font-semibold mb-3">サマリー (期間内)</h2>
        {summaryError && (
          <div className="alert alert-error text-sm mb-3">
            <span>{summaryError}</span>
          </div>
        )}
        {summary && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <KpiCard label="登録数" value={summary.totals.enrolled} accent="emerald" />
            <KpiCard label="アクティブ" value={summary.totals.active} accent="green" />
            <KpiCard label="累計 push" value={summary.totals.pushed} accent="blue" />
            <KpiCard label="期間内 push" value={summary.totals.pushedRecent} accent="purple" />
          </div>
        )}
      </section>

      {/* By source breakdown */}
      {summary && summary.bySource.length > 0 && (
        <section>
          <h2 className="text-lg font-semibold mb-3">推定ソース別 (期間内 enroll)</h2>
          <div className="card bg-base-100 shadow-sm overflow-x-auto">
            <table className="table table-sm">
              <thead>
                <tr>
                  <th>ソース</th>
                  <th className="text-right">登録</th>
                  <th className="text-right">うちアクティブ</th>
                </tr>
              </thead>
              <tbody>
                {summary.bySource.map((r) => (
                  <tr key={r.source}>
                    <td>{sourceLabel(r.source)}</td>
                    <td className="text-right">{r.count}</td>
                    <td className="text-right">{r.active}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Recent reminders */}
      {summary && summary.recent.length > 0 && (
        <section>
          <h2 className="text-lg font-semibold mb-3">最近のリマインダー登録 (最大 20 件)</h2>
          <div className="card bg-base-100 shadow-sm overflow-x-auto">
            <table className="table table-sm">
              <thead>
                <tr>
                  <th>友だち</th>
                  <th>商品</th>
                  <th className="text-right">間隔</th>
                  <th>ソース</th>
                  <th>次回</th>
                  <th>最終 push</th>
                  <th>状態</th>
                </tr>
              </thead>
              <tbody>
                {summary.recent.map((r) => (
                  <tr key={r.id}>
                    <td>{r.friendName || r.friendId.slice(0, 8)}</td>
                    <td className="max-w-xs truncate">{r.productTitle}</td>
                    <td className="text-right">{r.intervalDays}日</td>
                    <td>{sourceLabel(r.intervalSource)}</td>
                    <td>{formatJstDate(r.nextReminderAt)}</td>
                    <td>{formatJstDate(r.lastSentAt)}</td>
                    <td>
                      {r.isActive ? (
                        <span className="badge badge-success badge-sm">配信中</span>
                      ) : (
                        <span className="badge badge-ghost badge-sm">停止</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Cross-sell rules */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold">クロスセルマップ</h2>
          <button
            onClick={() =>
              setEditingCrossSell({
                sourceProductId: '',
                recommendedProductId: '',
                reason: '',
                priority: 0,
                isActive: true,
              })
            }
            className="btn btn-primary btn-sm"
          >
            + ルール追加
          </button>
        </div>
        {crossSellError && (
          <div className="alert alert-error text-sm mb-3">
            <span>{crossSellError}</span>
          </div>
        )}
        <div className="card bg-base-100 shadow-sm overflow-x-auto">
          <table className="table table-sm">
            <thead>
              <tr>
                <th>商品 (購入)</th>
                <th>推奨</th>
                <th>理由</th>
                <th className="text-right">優先度</th>
                <th>有効</th>
                <th className="text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {crossSellLoading ? (
                <tr>
                  <td colSpan={6} className="text-center py-4">
                    読み込み中...
                  </td>
                </tr>
              ) : crossSell && crossSell.length > 0 ? (
                crossSell.map((r) => (
                  <tr key={`${r.source_product_id}|${r.recommended_product_id}`}>
                    <td className="font-mono text-xs">{r.source_product_id}</td>
                    <td className="font-mono text-xs">{r.recommended_product_id}</td>
                    <td className="max-w-xs truncate">{r.reason || '-'}</td>
                    <td className="text-right">{r.priority}</td>
                    <td>
                      {r.is_active ? (
                        <span className="badge badge-success badge-sm">ON</span>
                      ) : (
                        <span className="badge badge-ghost badge-sm">OFF</span>
                      )}
                    </td>
                    <td className="text-right space-x-1">
                      <button
                        onClick={() =>
                          setEditingCrossSell({
                            sourceProductId: r.source_product_id,
                            recommendedProductId: r.recommended_product_id,
                            reason: r.reason || '',
                            priority: r.priority,
                            isActive: r.is_active === 1,
                          })
                        }
                        className="btn btn-ghost btn-xs"
                      >
                        編集
                      </button>
                      <button
                        onClick={() =>
                          deleteCrossSell(r.source_product_id, r.recommended_product_id)
                        }
                        className="btn btn-ghost btn-xs text-error"
                      >
                        削除
                      </button>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={6} className="text-center py-4 text-gray-400">
                    まだルールがありません
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Product intervals */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold">商品別 推奨間隔</h2>
          <button
            onClick={() =>
              setEditingInterval({
                shopifyProductId: '',
                productTitle: '',
                defaultIntervalDays: 30,
                source: 'manual',
                notes: '',
              })
            }
            className="btn btn-primary btn-sm"
          >
            + 商品追加
          </button>
        </div>
        {intervalsError && (
          <div className="alert alert-error text-sm mb-3">
            <span>{intervalsError}</span>
          </div>
        )}
        <div className="card bg-base-100 shadow-sm overflow-x-auto">
          <table className="table table-sm">
            <thead>
              <tr>
                <th>Product ID</th>
                <th>タイトル</th>
                <th className="text-right">間隔 (日)</th>
                <th>ソース</th>
                <th className="text-right">サンプル</th>
                <th className="text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {intervalsLoading ? (
                <tr>
                  <td colSpan={6} className="text-center py-4">
                    読み込み中...
                  </td>
                </tr>
              ) : intervals && intervals.length > 0 ? (
                intervals.map((r) => (
                  <tr key={r.shopify_product_id}>
                    <td className="font-mono text-xs">{r.shopify_product_id}</td>
                    <td className="max-w-xs truncate">{r.product_title || '-'}</td>
                    <td className="text-right">{r.default_interval_days}</td>
                    <td>{sourceLabel(r.source)}</td>
                    <td className="text-right">{r.sample_size}</td>
                    <td className="text-right space-x-1">
                      <button
                        onClick={() =>
                          setEditingInterval({
                            shopifyProductId: r.shopify_product_id,
                            productTitle: r.product_title || '',
                            defaultIntervalDays: r.default_interval_days,
                            source: r.source,
                            notes: r.notes || '',
                          })
                        }
                        className="btn btn-ghost btn-xs"
                      >
                        編集
                      </button>
                      <button
                        onClick={() => deleteInterval(r.shopify_product_id)}
                        className="btn btn-ghost btn-xs text-error"
                      >
                        削除
                      </button>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={6} className="text-center py-4 text-gray-400">
                    まだ商品が登録されていません
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Cross-sell edit modal */}
      {editingCrossSell && (
        <div className="modal modal-open">
          <div className="modal-box">
            <h3 className="font-bold text-lg mb-4">クロスセルルール</h3>
            {saveCSError && (
              <div className="alert alert-error text-sm mb-3">
                <span>{saveCSError}</span>
              </div>
            )}
            <div className="space-y-3">
              <div>
                <label className="label py-1">
                  <span className="label-text text-xs">購入商品 ID (source) *</span>
                </label>
                <input
                  type="text"
                  value={editingCrossSell.sourceProductId}
                  onChange={(e) =>
                    setEditingCrossSell({ ...editingCrossSell, sourceProductId: e.target.value })
                  }
                  placeholder="gid://shopify/Product/12345 or 12345"
                  className="input input-bordered w-full"
                />
              </div>
              <div>
                <label className="label py-1">
                  <span className="label-text text-xs">推奨商品 ID (recommended) *</span>
                </label>
                <input
                  type="text"
                  value={editingCrossSell.recommendedProductId}
                  onChange={(e) =>
                    setEditingCrossSell({
                      ...editingCrossSell,
                      recommendedProductId: e.target.value,
                    })
                  }
                  placeholder="gid://shopify/Product/67890"
                  className="input input-bordered w-full"
                />
              </div>
              <div>
                <label className="label py-1">
                  <span className="label-text text-xs">理由 (LINE 表示用、最大 200 文字)</span>
                </label>
                <input
                  type="text"
                  value={editingCrossSell.reason}
                  onChange={(e) =>
                    setEditingCrossSell({ ...editingCrossSell, reason: e.target.value })
                  }
                  placeholder="例: 同梱で送料無料"
                  className="input input-bordered w-full"
                />
              </div>
              <div className="flex gap-3">
                <div className="flex-1">
                  <label className="label py-1">
                    <span className="label-text text-xs">優先度 (大きいほど上位)</span>
                  </label>
                  <input
                    type="number"
                    min={0}
                    max={1000}
                    value={editingCrossSell.priority}
                    onChange={(e) =>
                      setEditingCrossSell({
                        ...editingCrossSell,
                        priority: Number(e.target.value) || 0,
                      })
                    }
                    className="input input-bordered w-full"
                  />
                </div>
                <div className="flex-1">
                  <label className="label py-1">
                    <span className="label-text text-xs">状態</span>
                  </label>
                  <select
                    value={editingCrossSell.isActive ? 'on' : 'off'}
                    onChange={(e) =>
                      setEditingCrossSell({
                        ...editingCrossSell,
                        isActive: e.target.value === 'on',
                      })
                    }
                    className="select select-bordered w-full"
                  >
                    <option value="on">ON</option>
                    <option value="off">OFF</option>
                  </select>
                </div>
              </div>
            </div>
            <div className="modal-action">
              <button onClick={() => setEditingCrossSell(null)} className="btn btn-ghost">
                キャンセル
              </button>
              <button onClick={saveCrossSell} disabled={savingCS} className="btn btn-primary">
                {savingCS ? '保存中...' : '保存'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Product interval edit modal */}
      {editingInterval && (
        <div className="modal modal-open">
          <div className="modal-box">
            <h3 className="font-bold text-lg mb-4">商品別 推奨間隔</h3>
            {savePIError && (
              <div className="alert alert-error text-sm mb-3">
                <span>{savePIError}</span>
              </div>
            )}
            <div className="space-y-3">
              <div>
                <label className="label py-1">
                  <span className="label-text text-xs">Shopify Product ID *</span>
                </label>
                <input
                  type="text"
                  value={editingInterval.shopifyProductId}
                  onChange={(e) =>
                    setEditingInterval({ ...editingInterval, shopifyProductId: e.target.value })
                  }
                  placeholder="gid://shopify/Product/12345 or 12345"
                  className="input input-bordered w-full"
                />
              </div>
              <div>
                <label className="label py-1">
                  <span className="label-text text-xs">タイトル (任意)</span>
                </label>
                <input
                  type="text"
                  value={editingInterval.productTitle}
                  onChange={(e) =>
                    setEditingInterval({ ...editingInterval, productTitle: e.target.value })
                  }
                  className="input input-bordered w-full"
                />
              </div>
              <div className="flex gap-3">
                <div className="flex-1">
                  <label className="label py-1">
                    <span className="label-text text-xs">推奨間隔 (日, 7-90)</span>
                  </label>
                  <input
                    type="number"
                    min={7}
                    max={90}
                    value={editingInterval.defaultIntervalDays}
                    onChange={(e) =>
                      setEditingInterval({
                        ...editingInterval,
                        defaultIntervalDays: Number(e.target.value) || 30,
                      })
                    }
                    className="input input-bordered w-full"
                  />
                </div>
                <div className="flex-1">
                  <label className="label py-1">
                    <span className="label-text text-xs">ソース</span>
                  </label>
                  <select
                    value={editingInterval.source}
                    onChange={(e) =>
                      setEditingInterval({ ...editingInterval, source: e.target.value })
                    }
                    className="select select-bordered w-full"
                  >
                    {VALID_SOURCES.map((s) => (
                      <option key={s} value={s}>
                        {sourceLabel(s)}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div>
                <label className="label py-1">
                  <span className="label-text text-xs">メモ (任意、最大 500 文字)</span>
                </label>
                <textarea
                  value={editingInterval.notes}
                  onChange={(e) =>
                    setEditingInterval({ ...editingInterval, notes: e.target.value })
                  }
                  rows={2}
                  className="textarea textarea-bordered w-full"
                />
              </div>
            </div>
            <div className="modal-action">
              <button onClick={() => setEditingInterval(null)} className="btn btn-ghost">
                キャンセル
              </button>
              <button onClick={saveInterval} disabled={savingPI} className="btn btn-primary">
                {savingPI ? '保存中...' : '保存'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ============================================================
// KPI card
// ============================================================

interface KpiCardProps {
  label: string
  value: number
  accent: 'emerald' | 'green' | 'blue' | 'purple'
}

function KpiCard({ label, value, accent }: KpiCardProps) {
  const accentClass: Record<KpiCardProps['accent'], string> = {
    emerald: 'border-l-4 border-emerald-500',
    green: 'border-l-4 border-green-500',
    blue: 'border-l-4 border-blue-500',
    purple: 'border-l-4 border-purple-500',
  }
  return (
    <div className={`card bg-base-100 shadow-sm ${accentClass[accent]}`}>
      <div className="card-body p-4">
        <div className="text-xs text-gray-500">{label}</div>
        <div className="text-2xl font-bold">{value.toLocaleString()}</div>
      </div>
    </div>
  )
}
