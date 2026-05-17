'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { fetchApi } from '@/lib/api'
import Header from '@/components/layout/header'

// ============================================================
// 型定義 — worker GET /api/admin/email/opt-in/kpi (Phase 5β-1d-3)
// ============================================================

interface OptInKpiWindow {
  days: number
  fromDate: string
  toDate: string
}

interface OptInKpiTotals {
  all: number
  new: number
  reConsent: number
  reactivated: number
  web: number
  liff: number
  other: number
}

interface OptInKpiTrendPoint {
  date: string
  count: number
}

interface OptInKpiData {
  window: OptInKpiWindow
  totals: OptInKpiTotals
  trend: OptInKpiTrendPoint[]
  candidatesRemaining: number
}

interface OptInKpiResponse {
  success: boolean
  data: OptInKpiData
  error?: string
}

// ============================================================
// 自前 SVG MiniBarChart (dashboard/page.tsx と同じ pattern、
// 重複だが page scope を minimal にするため inline。
// 将来 components/charts/MiniBarChart.tsx に extract 可能)
// ============================================================

function MiniBarChart({
  data,
  color = '#06C755',
  height = 140,
}: {
  data: OptInKpiTrendPoint[]
  color?: string
  height?: number
}) {
  if (data.length === 0) {
    return <div className="text-xs text-gray-400 text-center py-8">データなし</div>
  }
  const max = Math.max(...data.map((d) => d.count), 1)
  return (
    <div className="flex items-end gap-[2px]" style={{ height }}>
      {data.map((point) => {
        const h = Math.max(2, (point.count / max) * (height - 24))
        return (
          <div key={point.date} className="flex-1 flex flex-col items-center justify-end group relative">
            <div
              className="w-full rounded-t-sm transition-all hover:opacity-80"
              style={{ height: h, backgroundColor: color, minWidth: 3 }}
            />
            <div className="absolute -top-6 bg-gray-800 text-white text-[10px] px-1 rounded opacity-0 group-hover:opacity-100 whitespace-nowrap pointer-events-none">
              {point.date.slice(5)}: {point.count}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ============================================================
// stat card
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

// ============================================================
// channel bar (2 列、 比較表示)
// ============================================================

function ChannelBar({ web, liff }: { web: number; liff: number }) {
  const total = web + liff
  const webPct = total === 0 ? 0 : Math.round((web / total) * 100)
  const liffPct = total === 0 ? 0 : Math.round((liff / total) * 100)
  return (
    <div className="space-y-3">
      <div>
        <div className="flex justify-between text-xs mb-1">
          <span className="font-medium text-gray-700">Web (transactional 経由)</span>
          <span className="text-gray-500">
            {web.toLocaleString()} 件 ({webPct}%)
          </span>
        </div>
        <div className="h-3 bg-gray-100 rounded">
          <div
            className="h-3 rounded"
            style={{ width: `${webPct}%`, backgroundColor: '#3B82F6' }}
          />
        </div>
      </div>
      <div>
        <div className="flex justify-between text-xs mb-1">
          <span className="font-medium text-gray-700">LIFF (LINE 友だち経由)</span>
          <span className="text-gray-500">
            {liff.toLocaleString()} 件 ({liffPct}%)
          </span>
        </div>
        <div className="h-3 bg-gray-100 rounded">
          <div
            className="h-3 rounded"
            style={{ width: `${liffPct}%`, backgroundColor: '#06C755' }}
          />
        </div>
      </div>
    </div>
  )
}

// ============================================================
// page
// ============================================================

const DAYS_OPTIONS = [7, 14, 30, 90] as const

export default function OptInCampaignPage() {
  const [days, setDays] = useState<(typeof DAYS_OPTIONS)[number]>(30)
  const [data, setData] = useState<OptInKpiData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetchApi<OptInKpiResponse>(`/api/admin/email/opt-in/kpi?days=${days}`)
      if (!res.success) {
        setError(res.error ?? '取得に失敗しました')
        setData(null)
        return
      }
      setData(res.data)
    } catch (err) {
      // raw err.message を UI に直接 echo すると、 上流 (CF / proxy / 中間器) からの message が DOM に流れる
      // 可能性があるため generic message のみ表示し、 詳細は console に残す (security-reviewer feedback)
      console.warn('[opt-in-kpi] fetch failed:', err)
      setError('データの取得に失敗しました。 画面を再読み込みしてください。')
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [days])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <>
      <Header title="Opt-in 再取得 dashboard" />
      <div className="p-4 lg:p-6 max-w-6xl mx-auto space-y-6">
        {/* header */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm text-gray-500">
              marketing opt-in の取得状況を可視化します。 audit_logs (action=&apos;email.opt_in&apos;) を集計。
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">期間:</span>
            {DAYS_OPTIONS.map((d) => (
              <button
                key={d}
                onClick={() => setDays(d)}
                className={`px-3 py-1.5 text-xs font-medium rounded transition-colors ${
                  days === d
                    ? 'bg-green-100 text-green-700 border border-green-300'
                    : 'bg-white text-gray-600 border border-gray-200 hover:bg-gray-50'
                }`}
              >
                {d}日
              </button>
            ))}
            <button
              onClick={load}
              className="px-3 py-1.5 text-xs font-medium bg-white text-gray-600 border border-gray-200 rounded hover:bg-gray-50"
              aria-label="更新"
            >
              ↻
            </button>
          </div>
        </div>

        {loading && (
          <div className="bg-white border border-gray-200 rounded-lg p-8 text-center text-sm text-gray-500">
            読み込み中...
          </div>
        )}
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-700">
            エラー: {error}
          </div>
        )}

        {data && !loading && !error && (
          <>
            {/* window 表示 */}
            <p className="text-xs text-gray-400">
              集計対象: {data.window.fromDate} 〜 {data.window.toDate} ({data.window.days} 日間)
            </p>

            {/* totals — 4 stat cards */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <StatCard
                label="合計 opt-in"
                value={data.totals.all}
                hint={`期間内 全 outcome 合算`}
                accent="#06C755"
              />
              <StatCard
                label="新規 (new)"
                value={data.totals.new}
                hint="email 初回登録 + 同意"
                accent="#3B82F6"
              />
              <StatCard
                label="再同意 (re_consent)"
                value={data.totals.reConsent}
                hint="transactional_only から marketing 同意へ"
                accent="#F59E0B"
              />
              <StatCard
                label="復活 (reactivated)"
                value={data.totals.reactivated}
                hint="unsubscribed → resubscribe"
                accent="#A855F7"
              />
            </div>

            {/* trend */}
            <div className="bg-white border border-gray-200 rounded-lg p-4">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-bold text-gray-800">日次推移</h2>
                <span className="text-[11px] text-gray-400">{data.window.days} 日間</span>
              </div>
              <MiniBarChart data={data.trend} color="#06C755" height={160} />
            </div>

            {/* channel breakdown */}
            <div className="bg-white border border-gray-200 rounded-lg p-4">
              <h2 className="text-sm font-bold text-gray-800 mb-3">流入経路</h2>
              <ChannelBar web={data.totals.web} liff={data.totals.liff} />
              {data.totals.other > 0 && (
                <p className="text-[11px] text-gray-400 mt-2">
                  ※ outcome 不明 (other): {data.totals.other} 件
                </p>
              )}
            </div>

            {/* candidates */}
            <div className="bg-white border border-gray-200 rounded-lg p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-sm font-bold text-gray-800 mb-1">招待送信 候補 (残数)</h2>
                  <p className="text-xs text-gray-500">
                    shopify_customers (email あり) のうち、 marketing 同意未取得の件数
                  </p>
                </div>
                <p className="text-3xl font-bold" style={{ color: '#06C755' }}>
                  {data.candidatesRemaining.toLocaleString()}
                </p>
              </div>
              <div className="mt-3">
                <Link
                  href="/email"
                  className="inline-flex items-center gap-1 text-xs font-medium text-green-700 hover:text-green-800"
                >
                  招待を送る (/email ページへ) →
                </Link>
              </div>
            </div>
          </>
        )}
      </div>
    </>
  )
}
