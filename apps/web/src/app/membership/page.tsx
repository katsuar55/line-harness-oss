'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { fetchApi } from '@/lib/api'
import Header from '@/components/layout/header'

// ============================================================
// 型 — worker GET /api/membership/*
// ============================================================

interface MembershipTier {
  id: string
  name: string
  displayOrder: number
  minTotalPurchaseJpy: number
  minReferralCount: number
  perks: {
    discountPercent?: number
    prioritySupport?: boolean
    exclusiveProducts?: string[]
    affiliateCode?: boolean
  }
  badgeEmoji: string | null
  badgeColor: string | null
  isActive: boolean
}

interface MembershipStatsResponse {
  success: boolean
  data: {
    totalMembers: number
    byTier: Record<string, { count: number; totalPurchaseJpy: number }>
    tiers: MembershipTier[]
  }
  error?: string
}

interface MemberRow {
  id: string
  friend_id: string
  current_tier_id: string
  total_purchase_jpy: number
  total_referral_count: number
  last_purchase_at: string | null
  last_promotion_at: string | null
  joined_at: string
  display_name: string | null
  line_user_id: string | null
}

interface MembersResponse {
  success: boolean
  data: {
    members: MemberRow[]
    total: number
    limit: number
    offset: number
  }
  error?: string
}

interface PromoteResponse {
  success: boolean
  data?: { fromTier: string; toTier: string; promoted: boolean; reason: string | null }
  error?: string
}

// ============================================================
// helpers
// ============================================================

function formatJstShort(iso: string | null): string {
  if (!iso) return '—'
  try {
    const d = new Date(iso)
    return new Intl.DateTimeFormat('ja-JP', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'Asia/Tokyo',
    }).format(d)
  } catch {
    return iso
  }
}

function formatJpy(n: number): string {
  return `¥${n.toLocaleString('ja-JP')}`
}

// ============================================================
// main page
// ============================================================

export default function MembershipPage() {
  const [stats, setStats] = useState<MembershipStatsResponse['data'] | null>(null)
  const [members, setMembers] = useState<MemberRow[]>([])
  const [tierFilter, setTierFilter] = useState<string>('')
  const [loadingStats, setLoadingStats] = useState(true)
  const [loadingMembers, setLoadingMembers] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [promoteTarget, setPromoteTarget] = useState<MemberRow | null>(null)
  const [promoteToTier, setPromoteToTier] = useState<string>('')
  const [promoteReason, setPromoteReason] = useState<string>('')
  const [promoting, setPromoting] = useState(false)

  const loadStats = useCallback(async () => {
    setLoadingStats(true)
    try {
      const res = await fetchApi<MembershipStatsResponse>('/api/membership/stats')
      if (!res.success) throw new Error(res.error ?? 'failed')
      setStats(res.data)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to load stats')
    } finally {
      setLoadingStats(false)
    }
  }, [])

  const loadMembers = useCallback(async () => {
    setLoadingMembers(true)
    try {
      const qs = tierFilter ? `?tier=${encodeURIComponent(tierFilter)}` : ''
      const res = await fetchApi<MembersResponse>(`/api/membership/members${qs}`)
      if (!res.success) throw new Error(res.error ?? 'failed')
      setMembers(res.data.members)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to load members')
    } finally {
      setLoadingMembers(false)
    }
  }, [tierFilter])

  useEffect(() => {
    loadStats()
  }, [loadStats])

  useEffect(() => {
    loadMembers()
  }, [loadMembers])

  const tierMap = useMemo(() => {
    if (!stats) return new Map<string, MembershipTier>()
    return new Map(stats.tiers.map((t) => [t.id, t]))
  }, [stats])

  const onPromote = async () => {
    if (!promoteTarget || !promoteToTier) return
    setPromoting(true)
    try {
      const res = await fetchApi<PromoteResponse>(
        `/api/membership/members/${encodeURIComponent(promoteTarget.friend_id)}/promote`,
        {
          method: 'POST',
          body: JSON.stringify({ toTierId: promoteToTier, reason: promoteReason }),
        },
      )
      if (!res.success) throw new Error(res.error ?? 'failed')
      setPromoteTarget(null)
      setPromoteToTier('')
      setPromoteReason('')
      await Promise.all([loadStats(), loadMembers()])
    } catch (e) {
      alert(e instanceof Error ? e.message : 'failed to promote')
    } finally {
      setPromoting(false)
    }
  }

  return (
    <>
      <Header title="会員ランク" />
      <main className="p-6 max-w-7xl mx-auto">
        {error && (
          <div className="mb-4 rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {/* stats */}
        <section className="mb-8">
          <h2 className="text-sm font-semibold text-slate-600 mb-3">サマリー</h2>
          {loadingStats || !stats ? (
            <div className="text-sm text-slate-500">読み込み中...</div>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
              <StatCard label="総会員数" value={String(stats.totalMembers)} accent="#06C755" />
              {stats.tiers.map((t) => {
                const bucket = stats.byTier[t.id]
                return (
                  <StatCard
                    key={t.id}
                    label={`${t.badgeEmoji ?? ''} ${t.name}`}
                    value={String(bucket?.count ?? 0)}
                    accent={t.badgeColor ?? '#94a3b8'}
                    subLabel={
                      bucket?.totalPurchaseJpy
                        ? `累計 ${formatJpy(bucket.totalPurchaseJpy)}`
                        : undefined
                    }
                  />
                )
              })}
            </div>
          )}
        </section>

        {/* filter */}
        <section className="mb-3 flex items-center gap-3">
          <h2 className="text-sm font-semibold text-slate-600">会員一覧</h2>
          <select
            value={tierFilter}
            onChange={(e) => setTierFilter(e.target.value)}
            className="text-sm border border-slate-300 rounded-md px-2 py-1"
          >
            <option value="">全 tier</option>
            {stats?.tiers.map((t) => (
              <option key={t.id} value={t.id}>
                {t.badgeEmoji} {t.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => {
              loadStats()
              loadMembers()
            }}
            className="text-xs text-slate-500 hover:text-slate-700 underline"
          >
            再読込
          </button>
        </section>

        {/* members table */}
        <section className="rounded-lg border border-slate-200 bg-white overflow-x-auto">
          {loadingMembers ? (
            <div className="p-6 text-sm text-slate-500">読み込み中...</div>
          ) : members.length === 0 ? (
            <div className="p-6 text-sm text-slate-500">該当会員なし</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs text-slate-600">
                <tr>
                  <th className="text-left px-3 py-2">friend</th>
                  <th className="text-left px-3 py-2">tier</th>
                  <th className="text-right px-3 py-2">累計購入</th>
                  <th className="text-right px-3 py-2">紹介</th>
                  <th className="text-left px-3 py-2">最終購入</th>
                  <th className="text-left px-3 py-2">最終昇格</th>
                  <th className="text-left px-3 py-2">入会</th>
                  <th className="text-right px-3 py-2">操作</th>
                </tr>
              </thead>
              <tbody>
                {members.map((m) => {
                  const tier = tierMap.get(m.current_tier_id)
                  return (
                    <tr key={m.id} className="border-t border-slate-100">
                      <td className="px-3 py-2 truncate max-w-[180px]">
                        {m.display_name ?? <span className="text-slate-400">名前なし</span>}
                      </td>
                      <td className="px-3 py-2">
                        <span
                          className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs"
                          style={{
                            backgroundColor: `${tier?.badgeColor ?? '#94a3b8'}22`,
                            color: tier?.badgeColor ?? '#475569',
                          }}
                        >
                          {tier?.badgeEmoji} {tier?.name ?? m.current_tier_id}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {formatJpy(m.total_purchase_jpy)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{m.total_referral_count}</td>
                      <td className="px-3 py-2 text-slate-500">
                        {formatJstShort(m.last_purchase_at)}
                      </td>
                      <td className="px-3 py-2 text-slate-500">
                        {formatJstShort(m.last_promotion_at)}
                      </td>
                      <td className="px-3 py-2 text-slate-500">
                        {formatJstShort(m.joined_at)}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <button
                          type="button"
                          className="text-xs text-blue-600 hover:underline"
                          onClick={() => {
                            setPromoteTarget(m)
                            setPromoteToTier(m.current_tier_id)
                            setPromoteReason('')
                          }}
                        >
                          tier 変更
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </section>

        {/* manual promote modal */}
        {promoteTarget && (
          <div
            className="fixed inset-0 bg-black/30 flex items-center justify-center z-50"
            onClick={() => setPromoteTarget(null)}
          >
            <div
              className="bg-white rounded-lg p-6 w-full max-w-sm m-3"
              onClick={(e) => e.stopPropagation()}
            >
              <h3 className="text-base font-semibold mb-3">tier 手動変更</h3>
              <p className="text-xs text-slate-500 mb-3">
                対象: {promoteTarget.display_name ?? promoteTarget.friend_id}
              </p>
              <label className="block text-xs font-medium text-slate-600 mb-1">移行先 tier</label>
              <select
                value={promoteToTier}
                onChange={(e) => setPromoteToTier(e.target.value)}
                className="w-full border border-slate-300 rounded-md px-2 py-1.5 text-sm mb-3"
              >
                {stats?.tiers.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.badgeEmoji} {t.name}
                  </option>
                ))}
              </select>
              <label className="block text-xs font-medium text-slate-600 mb-1">理由 (audit_logs 記録)</label>
              <input
                type="text"
                value={promoteReason}
                onChange={(e) => setPromoteReason(e.target.value)}
                placeholder="例: VIP customer 特例"
                className="w-full border border-slate-300 rounded-md px-2 py-1.5 text-sm mb-4"
              />
              <div className="flex gap-2 justify-end">
                <button
                  type="button"
                  onClick={() => setPromoteTarget(null)}
                  className="text-sm px-3 py-1.5 text-slate-600 hover:bg-slate-100 rounded-md"
                  disabled={promoting}
                >
                  キャンセル
                </button>
                <button
                  type="button"
                  onClick={onPromote}
                  disabled={promoting || !promoteToTier}
                  className="text-sm px-3 py-1.5 bg-green-600 text-white rounded-md hover:bg-green-700 disabled:opacity-50"
                >
                  {promoting ? '変更中...' : '変更'}
                </button>
              </div>
            </div>
          </div>
        )}
      </main>
    </>
  )
}

// ============================================================
// StatCard
// ============================================================

function StatCard({
  label,
  value,
  accent,
  subLabel,
}: {
  label: string
  value: string
  accent: string
  subLabel?: string
}) {
  return (
    <div
      className="rounded-lg border border-slate-200 bg-white p-3"
      style={{ borderLeft: `4px solid ${accent}` }}
    >
      <div className="text-xs text-slate-500">{label}</div>
      <div className="text-xl font-bold mt-1" style={{ color: accent }}>
        {value}
      </div>
      {subLabel && <div className="text-[10px] text-slate-400 mt-0.5">{subLabel}</div>}
    </div>
  )
}
