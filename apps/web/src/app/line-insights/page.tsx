'use client'

import { useCallback, useEffect, useState } from 'react'
import { fetchApi } from '@/lib/api'
import Header from '@/components/layout/header'

// ============================================================
// 型定義 — worker GET /api/line-insights/overview (Phase 5β-5a)
// ============================================================

interface InsightsWindow {
  days: number
}

interface AiReplyRate {
  totalOutgoing: number
  aiReplies: number
  manualReplies: number
  scenarioReplies: number
  broadcastMessages: number
  other: number
  aiPct: number
}

interface BroadcastStats {
  totalBroadcasts: number
  totalDelivered: number
  totalTarget: number
  deliverRate: number
}

interface ScenarioStats {
  statusCounts: Array<{ status: string; count: number }>
  activeByScenario: Array<{ scenario_id: string; count: number }>
}

interface CouponStats {
  totalIssued: number
  redeemed: number
  issuedLastNDays: number
  failByStage: Array<{ stage: string; count: number }>
  succeededLastNDays: number
  failedLastNDays: number
  threwLastNDays: number
}

interface LineInsightsData {
  window: InsightsWindow
  aiReplyRate: AiReplyRate
  broadcasts: BroadcastStats
  scenarios: ScenarioStats
  coupons: CouponStats
}

interface LineInsightsResponse {
  success: boolean
  data: LineInsightsData
  error?: string
}

// ============================================================
// stat card (= opt-in-campaign/page.tsx と同じ pattern、 inline で page scope 維持)
// ============================================================

function StatCard({
  label,
  value,
  hint,
  accent = '#06C755',
}: {
  label: string
  value: number | string
  hint?: string
  accent?: string
}) {
  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4 flex flex-col gap-1">
      <p className="text-[11px] text-gray-500 uppercase tracking-wide">{label}</p>
      <p className="text-2xl font-bold" style={{ color: accent }}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </p>
      {hint && <p className="text-[11px] text-gray-400">{hint}</p>}
    </div>
  )
}

/** 4 category 横並び棒 (= aiReplyRate breakdown 用) */
function CategoryBar({
  data,
}: {
  data: Array<{ label: string; value: number; color: string }>
}) {
  const total = data.reduce((s, d) => s + d.value, 0)
  return (
    <div className="space-y-2">
      <div className="flex h-3 rounded-full overflow-hidden bg-gray-100">
        {data.map((d) => {
          const pct = total === 0 ? 0 : (d.value / total) * 100
          if (pct === 0) return null
          return (
            <div
              key={d.label}
              style={{ width: `${pct}%`, backgroundColor: d.color }}
              title={`${d.label}: ${d.value} (${pct.toFixed(1)}%)`}
            />
          )
        })}
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1">
        {data.map((d) => {
          const pct = total === 0 ? 0 : (d.value / total) * 100
          return (
            <div key={d.label} className="flex items-center gap-2 text-xs">
              <span
                className="w-2.5 h-2.5 rounded-sm shrink-0"
                style={{ backgroundColor: d.color }}
              />
              <span className="text-gray-600 truncate">{d.label}</span>
              <span className="ml-auto text-gray-400 tabular-nums">
                {d.value.toLocaleString()} ({pct.toFixed(1)}%)
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ============================================================
// section header
// ============================================================

function SectionHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="mb-3">
      <h2 className="text-base font-bold text-gray-900">{title}</h2>
      {subtitle && <p className="text-xs text-gray-500 mt-0.5">{subtitle}</p>}
    </div>
  )
}

// ============================================================
// main page
// ============================================================

export default function LineInsightsPage() {
  const [data, setData] = useState<LineInsightsData | null>(null)
  const [days, setDays] = useState(30)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetchApi<LineInsightsResponse>(
        `/api/line-insights/overview?days=${days}`,
      )
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
  }, [days])

  useEffect(() => {
    load()
  }, [load])

  return (
    <div className="min-h-screen bg-gray-50">
      <Header
        title="LINE Insight"
        description="AI 返信率 / 配信統計 / シナリオ / クーポン — LINE 特化分析 (主 dashboard は /dashboard)"
      />

      <main className="max-w-6xl mx-auto px-4 lg:px-6 py-6 space-y-6">
        {/* 期間切替 */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">期間:</span>
          {[7, 30, 90].map((d) => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={`px-3 py-1 text-xs rounded-md border transition-colors ${
                days === d
                  ? 'bg-[#06C755] text-white border-[#06C755]'
                  : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
              }`}
            >
              {d} 日
            </button>
          ))}
        </div>

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
            {/* ── 1. AI Reply Rate ── */}
            <section className="bg-white border border-gray-200 rounded-lg p-5">
              <SectionHeader
                title="AI 返信率 / 送信内訳"
                subtitle={`過去 ${data.window.days} 日の送信メッセージ ${data.aiReplyRate.totalOutgoing.toLocaleString()} 件`}
              />
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
                <StatCard
                  label="送信合計"
                  value={data.aiReplyRate.totalOutgoing}
                  accent="#06C755"
                />
                <StatCard
                  label="AI 返信"
                  value={data.aiReplyRate.aiReplies}
                  hint={`AI 比率 ${data.aiReplyRate.aiPct}%`}
                  accent="#8b5cf6"
                />
                <StatCard
                  label="手動返信"
                  value={data.aiReplyRate.manualReplies}
                  accent="#f59e0b"
                />
                <StatCard
                  label="シナリオ配信"
                  value={data.aiReplyRate.scenarioReplies}
                  accent="#3b82f6"
                />
              </div>
              <CategoryBar
                data={[
                  { label: 'AI 返信', value: data.aiReplyRate.aiReplies, color: '#8b5cf6' },
                  { label: '手動返信', value: data.aiReplyRate.manualReplies, color: '#f59e0b' },
                  { label: 'シナリオ', value: data.aiReplyRate.scenarioReplies, color: '#3b82f6' },
                  { label: 'broadcast', value: data.aiReplyRate.broadcastMessages, color: '#06C755' },
                  { label: 'その他', value: data.aiReplyRate.other, color: '#9ca3af' },
                ]}
              />
            </section>

            {/* ── 2. Broadcast 統計 ── */}
            <section className="bg-white border border-gray-200 rounded-lg p-5">
              <SectionHeader
                title="一斉配信 統計"
                subtitle={`過去 ${data.window.days} 日に sent になった broadcast (read / click は次 Phase)`}
              />
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <StatCard
                  label="配信回数"
                  value={data.broadcasts.totalBroadcasts}
                  accent="#06C755"
                />
                <StatCard
                  label="配信成功 (累計)"
                  value={data.broadcasts.totalDelivered}
                  hint={`対象 ${data.broadcasts.totalTarget.toLocaleString()}`}
                  accent="#06C755"
                />
                <StatCard
                  label="配信成功率"
                  value={`${data.broadcasts.deliverRate}%`}
                  hint="success_count / total_count"
                  accent="#3b82f6"
                />
                <StatCard
                  label="対象友だち (累計)"
                  value={data.broadcasts.totalTarget}
                  accent="#9ca3af"
                />
              </div>
            </section>

            {/* ── 3. Scenario 配信状況 ── */}
            <section className="bg-white border border-gray-200 rounded-lg p-5">
              <SectionHeader
                title="シナリオ配信状況"
                subtitle="friend_scenarios の status 別 + active scenario の breakdown"
              />
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <p className="text-xs text-gray-500 mb-2">status 別</p>
                  {data.scenarios.statusCounts.length === 0 ? (
                    <p className="text-xs text-gray-400">データなし</p>
                  ) : (
                    <div className="space-y-1.5">
                      {data.scenarios.statusCounts.map((s) => (
                        <div
                          key={s.status}
                          className="flex items-center justify-between border-b border-gray-100 pb-1 text-sm"
                        >
                          <span className="text-gray-700">{s.status}</span>
                          <span className="font-mono tabular-nums text-gray-900">
                            {s.count.toLocaleString()}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <div>
                  <p className="text-xs text-gray-500 mb-2">active な scenario_id 別</p>
                  {data.scenarios.activeByScenario.length === 0 ? (
                    <p className="text-xs text-gray-400">active なし</p>
                  ) : (
                    <div className="space-y-1.5">
                      {data.scenarios.activeByScenario.map((s) => (
                        <div
                          key={s.scenario_id}
                          className="flex items-center justify-between border-b border-gray-100 pb-1 text-sm"
                        >
                          <span className="text-gray-700 truncate" title={s.scenario_id}>
                            {s.scenario_id}
                          </span>
                          <span className="font-mono tabular-nums text-gray-900 shrink-0 ml-2">
                            {s.count.toLocaleString()}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </section>

            {/* ── 4. Coupon issue status ── */}
            <section className="bg-white border border-gray-200 rounded-lg p-5">
              <SectionHeader
                title="LINE 友だち追加クーポン"
                subtitle={`5β-1d-2 連動。 audit_logs 経由で失敗を可視化 (過去 ${data.window.days} 日)`}
              />
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
                <StatCard
                  label="累計発行"
                  value={data.coupons.totalIssued}
                  accent="#06C755"
                />
                <StatCard
                  label="期間内発行"
                  value={data.coupons.issuedLastNDays}
                  accent="#06C755"
                />
                <StatCard
                  label="redeemed"
                  value={data.coupons.redeemed}
                  hint={
                    data.coupons.totalIssued > 0
                      ? `${Math.round((data.coupons.redeemed / data.coupons.totalIssued) * 1000) / 10}% 利用`
                      : undefined
                  }
                  accent="#3b82f6"
                />
                <StatCard
                  label="audit 失敗"
                  value={data.coupons.failedLastNDays + data.coupons.threwLastNDays}
                  hint={`成功 ${data.coupons.succeededLastNDays}, throw ${data.coupons.threwLastNDays}`}
                  accent={
                    data.coupons.failedLastNDays + data.coupons.threwLastNDays > 0
                      ? '#ef4444'
                      : '#9ca3af'
                  }
                />
              </div>
              <div>
                <p className="text-xs text-gray-500 mb-2">失敗の stage 内訳 (audit_logs.metadata.stage)</p>
                {data.coupons.failByStage.length === 0 ? (
                  <p className="text-xs text-gray-400">失敗なし</p>
                ) : (
                  <div className="space-y-1.5">
                    {data.coupons.failByStage.map((s) => (
                      <div
                        key={s.stage}
                        className="flex items-center justify-between border-b border-gray-100 pb-1 text-sm"
                      >
                        <span className="text-gray-700">{s.stage}</span>
                        <span className="font-mono tabular-nums text-red-600">
                          {s.count.toLocaleString()}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </section>
          </>
        )}
      </main>
    </div>
  )
}
