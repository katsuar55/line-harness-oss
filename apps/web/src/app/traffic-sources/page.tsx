'use client'

import { useEffect, useState } from 'react'
import { api, type TrafficSourceStat } from '@/lib/api'
import Header from '@/components/layout/header'

interface TrafficData {
  sources: TrafficSourceStat[]
  totals: {
    totalClicks: number
    identifiedClicks: number
    uniqueFriends: number
    clicks30d: number
    clicks7d: number
  }
}

function formatNumber(n: number): string {
  return n.toLocaleString('ja-JP')
}

function formatPercent(n: number): string {
  return `${(n * 100).toFixed(1)}%`
}

function formatRelativeTime(iso: string | null): string {
  if (!iso) return '未クリック'
  const d = new Date(iso)
  const diff = Date.now() - d.getTime()
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return 'たった今'
  if (minutes < 60) return `${minutes}分前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}時間前`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}日前`
  return d.toLocaleDateString('ja-JP')
}

function tryParseUtm(url: string): { source?: string; medium?: string; campaign?: string } {
  try {
    const u = new URL(url)
    return {
      source: u.searchParams.get('utm_source') ?? undefined,
      medium: u.searchParams.get('utm_medium') ?? undefined,
      campaign: u.searchParams.get('utm_campaign') ?? undefined,
    }
  } catch {
    return {}
  }
}

type SortKey = 'totalClicks' | 'uniqueFriends' | 'clicks30d' | 'identificationRate'

export default function TrafficSourcesPage() {
  const [data, setData] = useState<TrafficData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('totalClicks')
  const [filter, setFilter] = useState('')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    api.trackedLinks
      .trafficSources()
      .then((res) => {
        if (cancelled) return
        if (res.success) {
          setData(res.data)
        } else {
          setError(res.error)
        }
      })
      .catch(() => {
        if (!cancelled) setError('流入データの取得に失敗しました')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const sources = data?.sources ?? []
  const filtered = filter
    ? sources.filter(
        (s) =>
          s.linkName.toLowerCase().includes(filter.toLowerCase()) ||
          s.originalUrl.toLowerCase().includes(filter.toLowerCase()),
      )
    : sources
  const sorted = [...filtered].sort((a, b) => b[sortKey] - a[sortKey])
  const maxClicks = sorted.reduce((m, s) => Math.max(m, s.totalClicks), 0)

  // Aggregate by UTM source/medium/campaign for grouped breakdown
  const utmGroups = new Map<string, { clicks: number; friends: number; links: number }>()
  for (const s of sources) {
    const utm = tryParseUtm(s.originalUrl)
    const key = utm.source
      ? `${utm.source}${utm.medium ? ` / ${utm.medium}` : ''}${utm.campaign ? ` / ${utm.campaign}` : ''}`
      : '(UTMなし)'
    const current = utmGroups.get(key) ?? { clicks: 0, friends: 0, links: 0 }
    current.clicks += s.totalClicks
    current.friends += s.uniqueFriends
    current.links += 1
    utmGroups.set(key, current)
  }
  const utmSorted = Array.from(utmGroups.entries()).sort((a, b) => b[1].clicks - a[1].clicks)

  return (
    <div>
      <Header title="流入経路分析" />

      {error && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
          {error}
        </div>
      )}

      {/* Stat cards */}
      {data && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
          <StatCard label="総クリック" value={formatNumber(data.totals.totalClicks)} />
          <StatCard label="識別済クリック" value={formatNumber(data.totals.identifiedClicks)} />
          <StatCard label="ユニーク友だち" value={formatNumber(data.totals.uniqueFriends)} />
          <StatCard label="30日クリック" value={formatNumber(data.totals.clicks30d)} />
          <StatCard label="7日クリック" value={formatNumber(data.totals.clicks7d)} />
        </div>
      )}

      {/* UTM breakdown */}
      {utmSorted.length > 0 && (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 mb-4 overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-900">UTMキャンペーン別</h2>
            <span className="text-xs text-gray-500">{utmSorted.length}グループ</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[480px]">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500">source / medium / campaign</th>
                  <th className="px-4 py-2 text-right text-xs font-medium text-gray-500">クリック</th>
                  <th className="px-4 py-2 text-right text-xs font-medium text-gray-500">ユニーク友だち</th>
                  <th className="px-4 py-2 text-right text-xs font-medium text-gray-500">リンク数</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {utmSorted.map(([key, val]) => (
                  <tr key={key} className="hover:bg-gray-50">
                    <td className="px-4 py-2 text-sm text-gray-700 font-mono text-xs">{key}</td>
                    <td className="px-4 py-2 text-right text-sm text-gray-900">{formatNumber(val.clicks)}</td>
                    <td className="px-4 py-2 text-right text-sm text-gray-900">{formatNumber(val.friends)}</td>
                    <td className="px-4 py-2 text-right text-sm text-gray-500">{formatNumber(val.links)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Per-link breakdown */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between gap-2 flex-wrap">
          <h2 className="text-sm font-semibold text-gray-900">トラッキングリンク別</h2>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="名前/URLで絞り込み"
              className="text-xs border border-gray-300 rounded-md px-2 py-1 w-48 focus:outline-none focus:ring-1 focus:ring-green-500"
            />
            <select
              value={sortKey}
              onChange={(e) => setSortKey(e.target.value as SortKey)}
              className="text-xs border border-gray-300 rounded-md px-2 py-1 bg-white focus:outline-none focus:ring-1 focus:ring-green-500"
            >
              <option value="totalClicks">並び替え: 総クリック</option>
              <option value="uniqueFriends">ユニーク友だち</option>
              <option value="clicks30d">30日クリック</option>
              <option value="identificationRate">識別率</option>
            </select>
          </div>
        </div>

        {loading ? (
          <div className="p-8 text-center text-sm text-gray-500">読み込み中...</div>
        ) : sorted.length === 0 ? (
          <div className="p-8 text-center text-sm text-gray-500">
            トラッキングリンクがありません。「友だち」→「トラッキングリンク」から作成してください。
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px]">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500">リンク名</th>
                  <th className="px-4 py-2 text-right text-xs font-medium text-gray-500">総クリック</th>
                  <th className="px-4 py-2 text-right text-xs font-medium text-gray-500">30日</th>
                  <th className="px-4 py-2 text-right text-xs font-medium text-gray-500">7日</th>
                  <th className="px-4 py-2 text-right text-xs font-medium text-gray-500">ユニーク友だち</th>
                  <th className="px-4 py-2 text-right text-xs font-medium text-gray-500">識別率</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500">最終クリック</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {sorted.map((s) => (
                  <tr key={s.linkId} className="hover:bg-gray-50">
                    <td className="px-4 py-2">
                      <div className="text-sm font-medium text-gray-900">{s.linkName}</div>
                      <div className="text-[10px] text-gray-400 truncate max-w-[280px]">{s.originalUrl}</div>
                      {/* Visual bar */}
                      {maxClicks > 0 && (
                        <div className="mt-1 h-1 bg-gray-100 rounded overflow-hidden max-w-[240px]">
                          <div
                            className="h-full bg-green-500"
                            style={{ width: `${(s.totalClicks / maxClicks) * 100}%` }}
                          />
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right text-sm font-medium text-gray-900">
                      {formatNumber(s.totalClicks)}
                    </td>
                    <td className="px-4 py-2 text-right text-sm text-gray-700">{formatNumber(s.clicks30d)}</td>
                    <td className="px-4 py-2 text-right text-sm text-gray-700">{formatNumber(s.clicks7d)}</td>
                    <td className="px-4 py-2 text-right text-sm text-gray-700">{formatNumber(s.uniqueFriends)}</td>
                    <td className="px-4 py-2 text-right text-sm text-gray-700">
                      {s.totalClicks > 0 ? formatPercent(s.identificationRate) : '-'}
                    </td>
                    <td className="px-4 py-2 text-xs text-gray-500">{formatRelativeTime(s.lastClickAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 px-4 py-3">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-xl font-semibold text-gray-900 mt-1">{value}</div>
    </div>
  )
}
