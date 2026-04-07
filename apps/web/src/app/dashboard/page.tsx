'use client'

import { useState, useEffect, useCallback } from 'react'
import { fetchApi } from '@/lib/api'
import Header from '@/components/layout/header'

interface Summary {
  friends: { total: number; following: number; newLast7Days: number }
  orders: { totalOrders: number; totalRevenue: number; ordersLast30Days: number; revenueLast30Days: number }
  intake: { activeUsers: number; totalLogs: number; logsLast7Days: number }
  referrals: { total: number }
}

interface TrendPoint {
  date: string
  new_friends?: number
  unfollowed?: number
  net?: number
  orders?: number
  revenue?: number
  rate?: number
  usersLogged?: number
  avgScore?: number
  good?: number
  normal?: number
  bad?: number
}

interface FunnelStage {
  stage: string
  label: string
  count: number
}

interface ReferralFunnel {
  funnel: FunnelStage[]
  conversionRates: { linkToAdd: number; addToPurchase: number; overall: number }
}

function formatYen(n: number): string {
  return '¥' + n.toLocaleString()
}

function MiniBarChart({ data, valueKey, color = '#06C755', height = 120 }: {
  data: TrendPoint[]
  valueKey: string
  color?: string
  height?: number
}) {
  if (data.length === 0) return <div className="text-xs text-gray-400 text-center py-8">データなし</div>
  const values = data.map((d) => (d as Record<string, unknown>)[valueKey] as number || 0)
  const max = Math.max(...values, 1)

  return (
    <div className="flex items-end gap-[2px]" style={{ height }}>
      {values.map((v, i) => {
        const h = Math.max(2, (v / max) * (height - 20))
        return (
          <div key={i} className="flex-1 flex flex-col items-center justify-end group relative">
            <div
              className="w-full rounded-t-sm transition-all hover:opacity-80"
              style={{ height: h, backgroundColor: color, minWidth: 3 }}
            />
            <div className="absolute -top-6 bg-gray-800 text-white text-[10px] px-1 rounded opacity-0 group-hover:opacity-100 whitespace-nowrap pointer-events-none">
              {data[i].date?.slice(5)}: {v}
            </div>
          </div>
        )
      })}
    </div>
  )
}

export default function DashboardPage() {
  const [summary, setSummary] = useState<Summary | null>(null)
  const [friendsTrend, setFriendsTrend] = useState<TrendPoint[]>([])
  const [revenueTrend, setRevenueTrend] = useState<TrendPoint[]>([])
  const [intakeRateTrend, setIntakeRateTrend] = useState<TrendPoint[]>([])
  const [healthScoreTrend, setHealthScoreTrend] = useState<TrendPoint[]>([])
  const [referralFunnel, setReferralFunnel] = useState<ReferralFunnel | null>(null)
  const [days, setDays] = useState(30)
  const [loading, setLoading] = useState(true)

  const loadData = useCallback(async () => {
    setLoading(true)
    try {
      const [sumRes, fRes, rRes, iRes, hRes, rfRes] = await Promise.all([
        fetchApi<{ success: boolean; data: Summary }>('/api/dashboard/summary'),
        fetchApi<{ success: boolean; data: { trend: TrendPoint[] } }>(`/api/dashboard/friends-trend?days=${days}`),
        fetchApi<{ success: boolean; data: { trend: TrendPoint[] } }>(`/api/dashboard/revenue-trend?days=${days}`),
        fetchApi<{ success: boolean; data: { trend: TrendPoint[] } }>(`/api/dashboard/intake-rate?days=${days}`),
        fetchApi<{ success: boolean; data: { trend: TrendPoint[] } }>(`/api/dashboard/health-score?days=${days}`),
        fetchApi<{ success: boolean; data: ReferralFunnel }>('/api/dashboard/referral-funnel'),
      ])
      if (sumRes.success) setSummary(sumRes.data)
      if (fRes.success) setFriendsTrend(fRes.data.trend)
      if (rRes.success) setRevenueTrend(rRes.data.trend)
      if (iRes.success) setIntakeRateTrend(iRes.data.trend)
      if (hRes.success) setHealthScoreTrend(hRes.data.trend)
      if (rfRes.success) setReferralFunnel(rfRes.data)
    } catch {
      /* ignore */
    } finally {
      setLoading(false)
    }
  }, [days])

  useEffect(() => { loadData() }, [loadData])

  return (
    <div className="min-h-screen bg-gray-50">
      <Header />
      <main className="max-w-6xl mx-auto px-4 py-6">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold text-gray-900">ダッシュボード</h1>
          <div className="flex gap-1 bg-white rounded-lg border p-0.5">
            {[7, 30, 90].map((d) => (
              <button
                key={d}
                onClick={() => setDays(d)}
                className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                  days === d ? 'bg-green-600 text-white' : 'text-gray-500 hover:bg-gray-50'
                }`}
              >
                {d}日
              </button>
            ))}
          </div>
        </div>

        {loading && !summary ? (
          <div className="text-center py-12 text-gray-400">読み込み中...</div>
        ) : summary ? (
          <>
            {/* Summary Cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
              <div className="bg-white rounded-xl p-4 shadow-sm">
                <p className="text-xs text-gray-500">友だち（フォロー中）</p>
                <p className="text-2xl font-bold text-gray-800">{summary.friends.following.toLocaleString()}</p>
                <p className="text-xs text-green-600 mt-1">+{summary.friends.newLast7Days} (7日)</p>
              </div>
              <div className="bg-white rounded-xl p-4 shadow-sm">
                <p className="text-xs text-gray-500">売上（30日）</p>
                <p className="text-2xl font-bold text-gray-800">{formatYen(summary.orders.revenueLast30Days)}</p>
                <p className="text-xs text-gray-500 mt-1">{summary.orders.ordersLast30Days}件</p>
              </div>
              <div className="bg-white rounded-xl p-4 shadow-sm">
                <p className="text-xs text-gray-500">服用記録（7日）</p>
                <p className="text-2xl font-bold text-gray-800">{summary.intake.logsLast7Days}</p>
                <p className="text-xs text-gray-500 mt-1">アクティブ {summary.intake.activeUsers}人</p>
              </div>
              <div className="bg-white rounded-xl p-4 shadow-sm">
                <p className="text-xs text-gray-500">紹介成立</p>
                <p className="text-2xl font-bold text-gray-800">{summary.referrals.total}</p>
                <p className="text-xs text-gray-500 mt-1">累計</p>
              </div>
            </div>

            {/* Charts */}
            <div className="grid md:grid-cols-2 gap-4">
              <div className="bg-white rounded-xl p-5 shadow-sm">
                <h3 className="text-sm font-bold text-gray-700 mb-4">友だち増減</h3>
                <MiniBarChart data={friendsTrend} valueKey="new_friends" color="#06C755" />
                <div className="flex justify-between text-[10px] text-gray-400 mt-1">
                  <span>{friendsTrend[0]?.date?.slice(5) || ''}</span>
                  <span>{friendsTrend[friendsTrend.length - 1]?.date?.slice(5) || ''}</span>
                </div>
              </div>

              <div className="bg-white rounded-xl p-5 shadow-sm">
                <h3 className="text-sm font-bold text-gray-700 mb-4">売上推移</h3>
                <MiniBarChart data={revenueTrend} valueKey="revenue" color="#3B82F6" />
                <div className="flex justify-between text-[10px] text-gray-400 mt-1">
                  <span>{revenueTrend[0]?.date?.slice(5) || ''}</span>
                  <span>{revenueTrend[revenueTrend.length - 1]?.date?.slice(5) || ''}</span>
                </div>
              </div>
            </div>

            {/* Intake Rate & Health Score Charts */}
            <div className="grid md:grid-cols-2 gap-4 mt-4">
              <div className="bg-white rounded-xl p-5 shadow-sm">
                <h3 className="text-sm font-bold text-gray-700 mb-4">服用率推移 (%)</h3>
                <MiniBarChart data={intakeRateTrend} valueKey="rate" color="#10B981" />
                <div className="flex justify-between text-[10px] text-gray-400 mt-1">
                  <span>{intakeRateTrend[0]?.date?.slice(5) || ''}</span>
                  <span>{intakeRateTrend[intakeRateTrend.length - 1]?.date?.slice(5) || ''}</span>
                </div>
              </div>

              <div className="bg-white rounded-xl p-5 shadow-sm">
                <h3 className="text-sm font-bold text-gray-700 mb-4">体調スコア推移</h3>
                <MiniBarChart data={healthScoreTrend} valueKey="avgScore" color="#F59E0B" height={120} />
                <div className="flex justify-between text-[10px] text-gray-400 mt-1">
                  <span>{healthScoreTrend[0]?.date?.slice(5) || ''}</span>
                  <span>{healthScoreTrend[healthScoreTrend.length - 1]?.date?.slice(5) || ''}</span>
                </div>
              </div>
            </div>

            {/* Referral Funnel */}
            {referralFunnel && (
              <div className="mt-4 bg-white rounded-xl p-5 shadow-sm">
                <h3 className="text-sm font-bold text-gray-700 mb-4">紹介コンバージョン漏斗</h3>
                <div className="space-y-3">
                  {referralFunnel.funnel.map((stage, i) => {
                    const maxCount = Math.max(...referralFunnel.funnel.map((s) => s.count), 1)
                    const widthPct = Math.max(8, (stage.count / maxCount) * 100)
                    const colors = ['#06C755', '#3B82F6', '#8B5CF6']
                    return (
                      <div key={stage.stage}>
                        <div className="flex justify-between text-xs text-gray-600 mb-1">
                          <span>{stage.label}</span>
                          <span className="font-bold">{stage.count}人</span>
                        </div>
                        <div className="h-6 bg-gray-100 rounded-full overflow-hidden">
                          <div
                            className="h-full rounded-full transition-all"
                            style={{ width: `${widthPct}%`, backgroundColor: colors[i] }}
                          />
                        </div>
                        {i < referralFunnel.funnel.length - 1 && (
                          <p className="text-[10px] text-gray-400 text-right mt-0.5">
                            → {i === 0 ? referralFunnel.conversionRates.linkToAdd : referralFunnel.conversionRates.addToPurchase}%
                          </p>
                        )}
                      </div>
                    )
                  })}
                  <p className="text-xs text-gray-500 text-center mt-2">
                    全体コンバージョン率: <span className="font-bold text-purple-600">{referralFunnel.conversionRates.overall}%</span>
                  </p>
                </div>
              </div>
            )}

            {/* Total Stats */}
            <div className="mt-4 bg-white rounded-xl p-5 shadow-sm">
              <h3 className="text-sm font-bold text-gray-700 mb-3">累計</h3>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                <div>
                  <p className="text-gray-500">友だち総数</p>
                  <p className="font-bold text-gray-800">{summary.friends.total.toLocaleString()}</p>
                </div>
                <div>
                  <p className="text-gray-500">注文総数</p>
                  <p className="font-bold text-gray-800">{summary.orders.totalOrders.toLocaleString()}</p>
                </div>
                <div>
                  <p className="text-gray-500">売上累計</p>
                  <p className="font-bold text-gray-800">{formatYen(summary.orders.totalRevenue)}</p>
                </div>
                <div>
                  <p className="text-gray-500">服用記録総数</p>
                  <p className="font-bold text-gray-800">{summary.intake.totalLogs.toLocaleString()}</p>
                </div>
              </div>
            </div>
          </>
        ) : null}
      </main>
    </div>
  )
}
