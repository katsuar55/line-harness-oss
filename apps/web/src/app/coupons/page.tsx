'use client'

import { useCallback, useEffect, useState } from 'react'
import { fetchApi } from '@/lib/api'
import Header from '@/components/layout/header'

// ============================================================
// 型定義 — worker GET /api/line-friend-coupons (Phase 5β-1d-2-followup)
// ============================================================

type CouponStatus = 'issued' | 'redeemed'
type CouponSource = 'shopify' | 'manual'

interface CouponRow {
  id: string
  friend_id: string
  display_name: string | null
  line_account_id: string | null
  coupon_code: string
  shopify_discount_code_id: string | null
  discount_value: number
  discount_currency: string
  issued_at: string
  expires_at: string | null
  status: CouponStatus
  source: CouponSource
  created_at: string
}

interface CouponsListData {
  coupons: CouponRow[]
  total: number
  limit: number
  offset: number
  hasMore: boolean
}

interface CouponsResponse {
  success: boolean
  data: CouponsListData
  error?: string
}

// ============================================================
// constants
// ============================================================

const LIMIT_PER_PAGE = 50

const STATUS_OPTIONS: Array<{ label: string; value: '' | CouponStatus }> = [
  { label: '— 全部 —', value: '' },
  { label: '発行済 (issued)', value: 'issued' },
  { label: '利用済 (redeemed)', value: 'redeemed' },
]

const SOURCE_OPTIONS: Array<{ label: string; value: '' | CouponSource }> = [
  { label: '— 全部 —', value: '' },
  { label: 'Shopify (自動)', value: 'shopify' },
  { label: 'manual', value: 'manual' },
]

// ============================================================
// helpers
// ============================================================

function formatJstShort(iso: string | null): string {
  if (!iso) return '—'
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    return d.toLocaleString('ja-JP', { hour12: false })
  } catch {
    return iso
  }
}

function formatPrice(value: number, currency: string): string {
  return currency === 'JPY' ? `¥${value.toLocaleString()}` : `${value} ${currency}`
}

function statusBadgeClass(status: CouponStatus): string {
  return status === 'redeemed'
    ? 'bg-purple-50 text-purple-700 border-purple-200'
    : 'bg-green-50 text-green-700 border-green-200'
}

function isExpired(expiresAt: string | null): boolean {
  if (!expiresAt) return false
  return new Date(expiresAt).getTime() < Date.now()
}

// ============================================================
// row
// ============================================================

function CouponRowItem({ row }: { row: CouponRow }) {
  const expired = isExpired(row.expires_at)
  return (
    <div className="border border-gray-200 rounded-lg bg-white px-3 py-2.5 flex items-center gap-3">
      <span className="text-xs text-gray-500 tabular-nums shrink-0 w-32">
        {formatJstShort(row.issued_at)}
      </span>
      <span className="text-sm font-mono text-gray-900 shrink-0 w-40 truncate" title={row.coupon_code}>
        {row.coupon_code}
      </span>
      <span className="text-sm text-gray-700 flex-1 truncate">
        {row.display_name ?? `(friend_id: ${row.friend_id.slice(0, 8)})`}
      </span>
      <span className="text-xs font-bold tabular-nums text-gray-800 shrink-0 w-16 text-right">
        {formatPrice(row.discount_value, row.discount_currency)}
      </span>
      <span
        className={`text-[10px] font-bold px-2 py-0.5 rounded-sm border shrink-0 ${statusBadgeClass(row.status)}`}
      >
        {row.status}
      </span>
      <span
        className={`text-[10px] px-2 py-0.5 rounded-sm border shrink-0 ${
          expired
            ? 'bg-red-50 text-red-700 border-red-200'
            : 'bg-gray-50 text-gray-600 border-gray-200'
        }`}
      >
        {expired ? '期限切れ' : row.expires_at ? formatJstShort(row.expires_at).split(' ')[0] : '無期限'}
      </span>
    </div>
  )
}

// ============================================================
// main page
// ============================================================

export default function CouponsPage() {
  const [status, setStatus] = useState<'' | CouponStatus>('')
  const [source, setSource] = useState<'' | CouponSource>('')
  const [days, setDays] = useState(30)
  const [offset, setOffset] = useState(0)

  const [data, setData] = useState<CouponsListData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams()
      if (status) params.set('status', status)
      if (source) params.set('source', source)
      if (days > 0) {
        const since = new Date(Date.now() - days * 86_400_000).toISOString()
        params.set('since', since)
      }
      params.set('limit', String(LIMIT_PER_PAGE))
      params.set('offset', String(offset))

      const res = await fetchApi<CouponsResponse>(`/api/line-friend-coupons?${params.toString()}`)
      if (res.success) {
        setData(res.data)
      } else {
        setError(res.error ?? '取得に失敗しました')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [status, source, days, offset])

  useEffect(() => {
    load()
  }, [load])

  const resetOffset = () => setOffset(0)

  return (
    <div className="min-h-screen bg-gray-50">
      <Header
        title="クーポン発行履歴"
        description="LINE 友だち追加クーポン (5β-1d-2) の発行・利用状況。 課題 1 監視に直結。"
      />

      <main className="max-w-6xl mx-auto px-4 lg:px-6 py-6 space-y-4">
        {/* filter UI */}
        <section className="bg-white border border-gray-200 rounded-lg p-4 space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="text-[11px] text-gray-500 block mb-1">status</label>
              <select
                value={status}
                onChange={(e) => {
                  setStatus(e.target.value as '' | CouponStatus)
                  resetOffset()
                }}
                className="w-full px-2 py-1.5 border border-gray-200 rounded-md text-sm bg-white"
              >
                {STATUS_OPTIONS.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-[11px] text-gray-500 block mb-1">source</label>
              <select
                value={source}
                onChange={(e) => {
                  setSource(e.target.value as '' | CouponSource)
                  resetOffset()
                }}
                className="w-full px-2 py-1.5 border border-gray-200 rounded-md text-sm bg-white"
              >
                {SOURCE_OPTIONS.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="flex items-center gap-2 pt-2 border-t border-gray-100">
            <span className="text-xs text-gray-500">期間 (過去):</span>
            {[7, 30, 90].map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => {
                  setDays(d)
                  resetOffset()
                }}
                className={`px-3 py-1 text-xs rounded-md border transition-colors ${
                  days === d
                    ? 'bg-[#06C755] text-white border-[#06C755]'
                    : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
                }`}
              >
                {d}日
              </button>
            ))}
            <button
              type="button"
              onClick={() => {
                setDays(0)
                resetOffset()
              }}
              className={`px-3 py-1 text-xs rounded-md border transition-colors ${
                days === 0
                  ? 'bg-[#06C755] text-white border-[#06C755]'
                  : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
              }`}
            >
              全期間
            </button>
          </div>
        </section>

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {loading && !data && (
          <div className="text-sm text-gray-500 py-8 text-center">読込中…</div>
        )}

        {data && (
          <>
            <div className="flex items-center justify-between">
              <p className="text-xs text-gray-500">
                {data.total.toLocaleString()} 件中 {data.offset + 1}-
                {Math.min(data.offset + data.coupons.length, data.total)} を表示
              </p>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setOffset(Math.max(0, offset - LIMIT_PER_PAGE))}
                  disabled={offset === 0 || loading}
                  className="px-3 py-1 text-xs rounded-md border border-gray-200 bg-white disabled:opacity-40"
                >
                  ← 前
                </button>
                <button
                  type="button"
                  onClick={() => setOffset(offset + LIMIT_PER_PAGE)}
                  disabled={!data.hasMore || loading}
                  className="px-3 py-1 text-xs rounded-md border border-gray-200 bg-white disabled:opacity-40"
                >
                  次 →
                </button>
              </div>
            </div>

            {data.coupons.length === 0 ? (
              <div className="bg-white border border-gray-200 rounded-lg p-8 text-sm text-gray-500 text-center">
                該当するクーポンはありません
              </div>
            ) : (
              <div className="space-y-1.5">
                {data.coupons.map((row) => (
                  <CouponRowItem key={row.id} row={row} />
                ))}
              </div>
            )}
          </>
        )}
      </main>
    </div>
  )
}
