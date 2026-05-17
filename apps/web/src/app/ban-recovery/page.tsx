'use client'

import { useState, useEffect, useCallback } from 'react'
import Header from '@/components/layout/header'
import {
  api,
  type BanRecoveryStats,
  type RecoveredFriend,
  type BlockedFriend,
} from '@/lib/api'
import { useAccount } from '@/contexts/account-context'
import CcPromptButton from '@/components/cc-prompt-button'

type DaysFilter = 7 | 14 | 30 | 90

const ccPrompts = [
  {
    title: 'ブロック復活施策の立案',
    prompt: `直近のブロック復活トレンドを分析し、再アプローチ施策を立案してください。
1. 復活した友だちの人数推移と典型パターン
2. ブロック中の友だちを再 follow に誘導する施策
3. 復活直後の友だちへのウェルカム再送 / 特典提示 案
具体的なメッセージ案も提示してください。`,
  },
  {
    title: '常習離脱者の特定',
    prompt: `unfollow_count >= 2 のリピート離脱友だちを分析してください。
1. リピート離脱者数と全体に占める割合
2. 離脱パターン (タグ / 流入経路 / 購買履歴 の共通点)
3. 配信頻度の調整 / セグメント除外 などの対策案
レポートしてください。`,
  },
]

function formatDateTime(iso: string | null): string {
  if (!iso) return '-'
  return new Date(iso).toLocaleString('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function daysSince(iso: string | null): string {
  if (!iso) return ''
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 0) return ''
  const days = Math.floor(ms / (24 * 60 * 60 * 1000))
  if (days === 0) return '今日'
  if (days === 1) return '1 日前'
  if (days < 30) return `${days} 日前`
  const months = Math.floor(days / 30)
  return `${months} ヶ月前`
}

function StatCard({
  label,
  value,
  hint,
  accent,
}: {
  label: string
  value: number
  hint?: string
  accent: 'green' | 'red' | 'yellow' | 'blue'
}) {
  const palette = {
    green: 'border-green-200 bg-green-50 text-green-700',
    red: 'border-red-200 bg-red-50 text-red-700',
    yellow: 'border-yellow-200 bg-yellow-50 text-yellow-700',
    blue: 'border-blue-200 bg-blue-50 text-blue-700',
  }[accent]
  return (
    <div className={`rounded-lg border ${palette} px-4 py-3`}>
      <p className="text-xs font-medium opacity-80">{label}</p>
      <p className="text-2xl font-bold mt-1">{value.toLocaleString()}</p>
      {hint && <p className="text-[11px] opacity-60 mt-0.5">{hint}</p>}
    </div>
  )
}

function FriendAvatar({ pictureUrl, displayName }: { pictureUrl: string | null; displayName: string | null }) {
  if (pictureUrl) {
    return <img src={pictureUrl} alt="" className="w-10 h-10 rounded-full flex-shrink-0" />
  }
  return (
    <div className="w-10 h-10 rounded-full bg-gray-200 flex items-center justify-center flex-shrink-0">
      <span className="text-gray-500 text-sm">{(displayName || '?').charAt(0)}</span>
    </div>
  )
}

export default function BanRecoveryPage() {
  const { selectedAccountId } = useAccount()
  const [days, setDays] = useState<DaysFilter>(30)
  const [stats, setStats] = useState<BanRecoveryStats | null>(null)
  const [recovered, setRecovered] = useState<RecoveredFriend[]>([])
  const [blocked, setBlocked] = useState<BlockedFriend[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const loadData = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await api.banRecovery.get({
        accountId: selectedAccountId || undefined,
        days,
        limit: 50,
      })
      if (res.success) {
        setStats(res.data.stats)
        setRecovered(res.data.recentlyRecovered)
        setBlocked(res.data.currentlyBlocked)
      } else {
        setError(res.error || '読み込みに失敗しました')
      }
    } catch {
      setError('ネットワークエラーが発生しました')
    } finally {
      setLoading(false)
    }
  }, [selectedAccountId, days])

  useEffect(() => {
    loadData()
  }, [loadData])

  return (
    <div className="min-h-screen bg-gray-50">
      <Header title="ブロック復活施策" />
      <main className="max-w-6xl mx-auto px-4 py-6">
        {/* Days filter */}
        <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
          <p className="text-sm text-gray-500">
            ブロック → 再 follow した友だちの追跡と、 現在ブロック中の友だちへの再アプローチ用一覧。
          </p>
          <div className="flex gap-1 bg-white rounded-lg border p-0.5">
            {[7, 14, 30, 90].map((d) => (
              <button
                key={d}
                onClick={() => setDays(d as DaysFilter)}
                className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                  days === d ? 'bg-green-500 text-white' : 'text-gray-600 hover:bg-gray-50'
                }`}
              >
                直近 {d} 日
              </button>
            ))}
          </div>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded text-red-700 text-sm">
            {error}
          </div>
        )}

        {/* KPI cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
          <StatCard
            label="現在 follow 中"
            value={stats?.totalFollowers ?? 0}
            hint="is_following=1"
            accent="green"
          />
          <StatCard
            label="現在ブロック中"
            value={stats?.totalBlocked ?? 0}
            hint="is_following=0"
            accent="red"
          />
          <StatCard
            label={`直近 ${days} 日に復活`}
            value={stats?.recoveredLastNDays ?? 0}
            hint="last_refollowed_at の集計"
            accent="blue"
          />
          <StatCard
            label="リピート離脱"
            value={stats?.repeatBlockers ?? 0}
            hint="unfollow_count ≥ 2"
            accent="yellow"
          />
        </div>

        {/* Two-column lists */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Recently recovered */}
          <section className="bg-white rounded-lg border border-gray-200 overflow-hidden">
            <header className="px-4 py-3 border-b border-gray-200 flex items-center justify-between bg-green-50/50">
              <h2 className="text-sm font-bold text-gray-900">
                ✨ 復活した友だち
                <span className="ml-2 text-xs text-gray-500 font-normal">
                  ({recovered.length} 件)
                </span>
              </h2>
              <span className="text-[11px] text-gray-400">last_refollowed_at DESC</span>
            </header>
            <div className="divide-y divide-gray-100 max-h-[60vh] overflow-y-auto">
              {loading ? (
                Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="px-4 py-3 animate-pulse">
                    <div className="h-3 bg-gray-200 rounded w-32 mb-2" />
                    <div className="h-2 bg-gray-100 rounded w-20" />
                  </div>
                ))
              ) : recovered.length === 0 ? (
                <p className="text-center text-gray-400 text-sm py-8">復活した友だちはまだいません</p>
              ) : (
                recovered.map((f) => (
                  <div key={f.friendId} className="px-4 py-3 flex items-center gap-3 hover:bg-gray-50">
                    <FriendAvatar pictureUrl={f.pictureUrl} displayName={f.displayName} />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-gray-900 truncate">
                        {f.displayName || '名前なし'}
                      </p>
                      <p className="text-[11px] text-gray-500 mt-0.5">
                        復活: {formatDateTime(f.lastRefollowedAt)}
                        <span className="text-gray-400 ml-1">({daysSince(f.lastRefollowedAt)})</span>
                      </p>
                      {f.unfollowCount > 1 && (
                        <p className="text-[11px] text-yellow-700 mt-0.5">
                          ⚠ 累計 {f.unfollowCount} 回離脱
                        </p>
                      )}
                    </div>
                    <a
                      href={`/friend-detail?id=${encodeURIComponent(f.friendId)}`}
                      className="text-xs text-green-700 hover:text-green-900 hover:underline flex-shrink-0"
                    >
                      詳細 →
                    </a>
                  </div>
                ))
              )}
            </div>
          </section>

          {/* Currently blocked */}
          <section className="bg-white rounded-lg border border-gray-200 overflow-hidden">
            <header className="px-4 py-3 border-b border-gray-200 flex items-center justify-between bg-red-50/50">
              <h2 className="text-sm font-bold text-gray-900">
                🚫 現在ブロック中
                <span className="ml-2 text-xs text-gray-500 font-normal">
                  ({blocked.length} 件)
                </span>
              </h2>
              <span className="text-[11px] text-gray-400">last_unfollowed_at DESC</span>
            </header>
            <div className="divide-y divide-gray-100 max-h-[60vh] overflow-y-auto">
              {loading ? (
                Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="px-4 py-3 animate-pulse">
                    <div className="h-3 bg-gray-200 rounded w-32 mb-2" />
                    <div className="h-2 bg-gray-100 rounded w-20" />
                  </div>
                ))
              ) : blocked.length === 0 ? (
                <p className="text-center text-gray-400 text-sm py-8">ブロック中の友だちはいません</p>
              ) : (
                blocked.map((f) => (
                  <div key={f.friendId} className="px-4 py-3 flex items-center gap-3 hover:bg-gray-50">
                    <FriendAvatar pictureUrl={f.pictureUrl} displayName={f.displayName} />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-gray-900 truncate">
                        {f.displayName || '名前なし'}
                      </p>
                      <p className="text-[11px] text-gray-500 mt-0.5">
                        離脱: {formatDateTime(f.lastUnfollowedAt)}
                        <span className="text-gray-400 ml-1">({daysSince(f.lastUnfollowedAt)})</span>
                      </p>
                      {f.unfollowCount > 1 && (
                        <p className="text-[11px] text-yellow-700 mt-0.5">
                          ⚠ 累計 {f.unfollowCount} 回離脱
                        </p>
                      )}
                    </div>
                    <a
                      href={`/friend-detail?id=${encodeURIComponent(f.friendId)}`}
                      className="text-xs text-red-700 hover:text-red-900 hover:underline flex-shrink-0"
                    >
                      詳細 →
                    </a>
                  </div>
                ))
              )}
            </div>
          </section>
        </div>

        <p className="text-[11px] text-gray-400 mt-6">
          Phase 5α-7 / Ultraplan v4 — migration 049 で追加された{' '}
          <code>last_unfollowed_at</code> / <code>last_refollowed_at</code> /{' '}
          <code>unfollow_count</code> を集計しています。 LINE webhook の follow / unfollow event
          受信時に自動更新されます。
        </p>
      </main>
      <CcPromptButton prompts={ccPrompts} />
    </div>
  )
}
