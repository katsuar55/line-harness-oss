'use client'

import { useState, useEffect, useMemo, useCallback } from 'react'
import { api, type AbandonedCart, type AbandonedCartStatus } from '@/lib/api'
import Header from '@/components/layout/header'

interface CartStats {
  pending: number
  notified: number
  recovered: number
}

interface LineItem {
  title?: string
  quantity?: number
  price?: number | string
  variant_title?: string
}

const STATUS_LABELS: Record<AbandonedCartStatus, string> = {
  pending: '通知待ち',
  notified: '通知済み',
  recovered: '復元',
  cancelled: 'キャンセル',
}

const STATUS_COLORS: Record<AbandonedCartStatus, string> = {
  pending: 'bg-yellow-100 text-yellow-800',
  notified: 'bg-blue-100 text-blue-800',
  recovered: 'bg-green-100 text-green-800',
  cancelled: 'bg-gray-100 text-gray-600',
}

function formatPrice(value: number, currency = 'JPY'): string {
  if (!Number.isFinite(value)) return '—'
  const rounded = Math.round(value)
  if (currency === 'JPY') return `¥${rounded.toLocaleString()}`
  return `${rounded.toLocaleString()} ${currency}`
}

function formatDateTime(iso: string | null): string {
  if (!iso) return '—'
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    return d.toLocaleString('ja-JP', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return iso
  }
}

function parseLineItems(raw: string): LineItem[] {
  try {
    const parsed = JSON.parse(raw) as LineItem[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

interface StatCardProps {
  label: string
  value: number | string
  sub?: string
  color: string
}

function StatCard({ label, value, sub, color }: StatCardProps) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
      <p className="text-xs font-medium text-gray-500">{label}</p>
      <p className={`mt-2 text-3xl font-bold ${color}`}>{value}</p>
      {sub && <p className="mt-1 text-xs text-gray-400">{sub}</p>}
    </div>
  )
}

interface DetailModalProps {
  cart: AbandonedCart | null
  onClose: () => void
  onResent: () => void
}

function DetailModal({ cart, onClose, onResent }: DetailModalProps) {
  const [resending, setResending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!cart) return null

  const items = parseLineItems(cart.line_items)
  const canResend = cart.status === 'pending' || cart.status === 'notified'

  const handleResend = async () => {
    if (!canResend) return
    setError(null)
    setResending(true)
    try {
      const res = await api.abandonedCarts.resend(cart.id)
      if (!res.success) {
        setError(res.error ?? '再送に失敗しました')
      } else {
        if (res.data?.status && !res.data.status.startsWith('sent')) {
          setError(`スキップされました: ${res.data.status}`)
        }
        onResent()
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '再送エラー')
    } finally {
      setResending(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-white rounded-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
          <div>
            <h3 className="text-lg font-bold text-gray-900">かご落ち詳細</h3>
            <p className="text-xs text-gray-500 mt-0.5">Checkout ID: {cart.shopify_checkout_id}</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600" aria-label="閉じる">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-6 space-y-5">
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <p className="text-xs text-gray-500">ステータス</p>
              <span className={`inline-block mt-1 px-2 py-0.5 rounded text-xs font-medium ${STATUS_COLORS[cart.status]}`}>
                {STATUS_LABELS[cart.status]}
              </span>
            </div>
            <div>
              <p className="text-xs text-gray-500">合計金額</p>
              <p className="mt-1 font-semibold">{formatPrice(cart.total_price, cart.currency)}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500">メール</p>
              <p className="mt-1 break-all">{cart.email ?? '—'}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500">友だち連携</p>
              <p className="mt-1">{cart.friend_id ? '✅ マッチ済み' : '⚠️ 未マッチ'}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500">作成日時</p>
              <p className="mt-1">{formatDateTime(cart.created_at)}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500">通知予定</p>
              <p className="mt-1">{formatDateTime(cart.notification_scheduled_at)}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500">通知済み</p>
              <p className="mt-1">{formatDateTime(cart.notified_at)}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500">復元日時</p>
              <p className="mt-1">{formatDateTime(cart.recovered_at)}</p>
            </div>
          </div>

          {items.length > 0 && (
            <div>
              <p className="text-xs text-gray-500 mb-2">商品一覧（{items.length}点）</p>
              <div className="border border-gray-200 rounded-lg divide-y divide-gray-100">
                {items.map((item, i) => (
                  <div key={i} className="px-3 py-2 flex items-center justify-between text-sm">
                    <div>
                      <p className="font-medium text-gray-900">{item.title ?? '（商品名なし）'}</p>
                      {item.variant_title && (
                        <p className="text-xs text-gray-500">{item.variant_title}</p>
                      )}
                    </div>
                    <div className="text-right">
                      <p className="text-gray-700">× {item.quantity ?? 1}</p>
                      {item.price !== undefined && (
                        <p className="text-xs text-gray-500">{formatPrice(Number(item.price), cart.currency)}</p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {cart.checkout_url && (
            <div>
              <p className="text-xs text-gray-500 mb-1">Checkout URL</p>
              <a
                href={cart.checkout_url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-blue-600 hover:underline break-all"
              >
                {cart.checkout_url}
              </a>
            </div>
          )}

          {error && (
            <div className="px-3 py-2 bg-red-50 border border-red-200 rounded text-xs text-red-700">{error}</div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-gray-200 flex items-center justify-between">
          <p className="text-xs text-gray-500">
            {cart.friend_id ? '手動で LINE プッシュ通知を送信できます' : '友だちID未マッチのため送信不可'}
          </p>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm border border-gray-200 rounded-lg hover:bg-gray-50"
            >
              閉じる
            </button>
            {canResend && cart.friend_id && (
              <button
                onClick={handleResend}
                disabled={resending}
                className="px-4 py-2 text-sm text-white rounded-lg disabled:opacity-50"
                style={{ backgroundColor: '#06C755' }}
              >
                {resending ? '送信中…' : '📤 手動送信'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export default function AbandonedCartsPage() {
  const [carts, setCarts] = useState<AbandonedCart[]>([])
  const [stats, setStats] = useState<CartStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState<'all' | AbandonedCartStatus>('all')
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<AbandonedCart | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [listRes, statsRes] = await Promise.allSettled([
        api.abandonedCarts.list({
          status: statusFilter === 'all' ? undefined : statusFilter,
          limit: 200,
        }),
        api.abandonedCarts.stats(),
      ])
      if (listRes.status === 'fulfilled' && listRes.value.success) {
        setCarts(listRes.value.data ?? [])
      }
      if (statsRes.status === 'fulfilled' && statsRes.value.success) {
        setStats(statsRes.value.data ?? null)
      }
    } finally {
      setLoading(false)
    }
  }, [statusFilter])

  useEffect(() => {
    load()
  }, [load])

  const filtered = useMemo(() => {
    if (!search.trim()) return carts
    const q = search.toLowerCase()
    return carts.filter(
      (c) =>
        (c.email ?? '').toLowerCase().includes(q) ||
        (c.shopify_checkout_id ?? '').toLowerCase().includes(q),
    )
  }, [carts, search])

  const recoveryRate = useMemo(() => {
    if (!stats) return '—'
    const total = stats.notified + stats.recovered
    if (total === 0) return '—'
    return `${Math.round((stats.recovered / total) * 100)}%`
  }, [stats])

  return (
    <div className="max-w-7xl mx-auto p-6 pt-20 lg:pt-6">
      <Header
        title="かご落ち通知"
        description="Shopify のかご落ち履歴と復元状況を管理します"
      />

      {/* 統計カード */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <StatCard
          label="通知待ち"
          value={stats?.pending ?? 0}
          sub="Cron 実行待ち"
          color="text-yellow-600"
        />
        <StatCard
          label="通知済み"
          value={stats?.notified ?? 0}
          sub="LINE 送信完了"
          color="text-blue-600"
        />
        <StatCard
          label="復元（CV）"
          value={stats?.recovered ?? 0}
          sub="注文完了"
          color="text-green-600"
        />
        <StatCard
          label="復元率"
          value={recoveryRate}
          sub="復元 / (通知+復元)"
          color="text-gray-900"
        />
      </div>

      {/* フィルタ */}
      <div className="bg-white rounded-xl border border-gray-200 p-4 mb-4 flex flex-col lg:flex-row gap-3 items-stretch lg:items-center">
        <div className="flex gap-1 flex-wrap">
          {(['all', 'pending', 'notified', 'recovered', 'cancelled'] as const).map((s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                statusFilter === s
                  ? 'bg-gray-900 text-white'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              {s === 'all' ? '全て' : STATUS_LABELS[s]}
            </button>
          ))}
        </div>
        <div className="flex-1">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="メール / Checkout ID で検索"
            className="w-full px-3 py-1.5 border border-gray-200 rounded-lg text-sm"
          />
        </div>
        <button
          onClick={load}
          className="px-3 py-1.5 text-xs border border-gray-200 rounded-lg hover:bg-gray-50"
        >
          🔄 更新
        </button>
      </div>

      {/* テーブル */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {loading ? (
          <div className="p-10 text-center text-sm text-gray-500">読み込み中…</div>
        ) : filtered.length === 0 ? (
          <div className="p-10 text-center text-sm text-gray-500">
            {search ? '該当するかご落ちが見つかりません' : 'かご落ちデータはまだありません'}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs text-gray-500 uppercase">
                <tr>
                  <th className="px-4 py-3 text-left">状態</th>
                  <th className="px-4 py-3 text-left">メール</th>
                  <th className="px-4 py-3 text-left">商品</th>
                  <th className="px-4 py-3 text-right">合計</th>
                  <th className="px-4 py-3 text-left">友だち</th>
                  <th className="px-4 py-3 text-left">作成</th>
                  <th className="px-4 py-3 text-left">通知</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filtered.map((cart) => {
                  const items = parseLineItems(cart.line_items)
                  const itemLabel = items[0]?.title
                    ? items.length > 1
                      ? `${items[0].title} 他${items.length - 1}点`
                      : items[0].title
                    : '—'
                  return (
                    <tr key={cart.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3">
                        <span className={`px-2 py-0.5 rounded text-xs font-medium ${STATUS_COLORS[cart.status]}`}>
                          {STATUS_LABELS[cart.status]}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-gray-700 max-w-[180px] truncate">{cart.email ?? '—'}</td>
                      <td className="px-4 py-3 text-gray-700 max-w-[220px] truncate">{itemLabel}</td>
                      <td className="px-4 py-3 text-right font-medium">
                        {formatPrice(cart.total_price, cart.currency)}
                      </td>
                      <td className="px-4 py-3">
                        {cart.friend_id ? (
                          <span className="text-green-600 text-xs">✅ 連携</span>
                        ) : (
                          <span className="text-gray-400 text-xs">未連携</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-500">{formatDateTime(cart.created_at)}</td>
                      <td className="px-4 py-3 text-xs text-gray-500">{formatDateTime(cart.notified_at)}</td>
                      <td className="px-4 py-3 text-right">
                        <button
                          onClick={() => setSelected(cart)}
                          className="text-xs text-blue-600 hover:underline"
                        >
                          詳細
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <p className="mt-4 text-xs text-gray-400">
        ※ Cron は5分ごとに実行され、<code>notification_scheduled_at</code> を過ぎた「通知待ち」を自動送信します。
        友だち未マッチ / ブラックリスト / ブロック中の場合はスキップされます。
      </p>

      <DetailModal cart={selected} onClose={() => setSelected(null)} onResent={() => { setSelected(null); load() }} />
    </div>
  )
}
