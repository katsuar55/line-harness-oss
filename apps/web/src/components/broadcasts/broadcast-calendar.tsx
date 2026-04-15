'use client'

import { useMemo, useState } from 'react'
import type { ApiBroadcast } from '@/lib/api'

interface BroadcastCalendarProps {
  broadcasts: ApiBroadcast[]
  getTagName: (tagId: string | null) => string | null
  onSelectBroadcast?: (b: ApiBroadcast) => void
}

const statusColor: Record<ApiBroadcast['status'], string> = {
  draft: 'bg-gray-200 text-gray-700',
  scheduled: 'bg-blue-100 text-blue-800',
  sending: 'bg-yellow-100 text-yellow-800',
  sent: 'bg-green-100 text-green-800',
}

function ymdKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function ymdKeyFromIso(iso: string): string {
  const d = new Date(iso)
  return ymdKey(d)
}

function getMonthGrid(year: number, month: number): Date[] {
  // month: 0-indexed. Returns 6 weeks × 7 days grid starting from Sunday.
  const firstOfMonth = new Date(year, month, 1)
  const startWeekday = firstOfMonth.getDay() // 0=Sun
  const gridStart = new Date(year, month, 1 - startWeekday)
  const days: Date[] = []
  for (let i = 0; i < 42; i++) {
    days.push(new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i))
  }
  return days
}

/**
 * Detect conflicts: same target tag (or both 'all') AND scheduledAt within 30 min window.
 */
function detectConflicts(items: ApiBroadcast[]): Set<string> {
  const conflicts = new Set<string>()
  const scheduled = items
    .filter((b) => (b.status === 'scheduled' || b.status === 'draft') && b.scheduledAt)
    .map((b) => ({ id: b.id, at: new Date(b.scheduledAt as string).getTime(), targetKey: b.targetType === 'all' ? 'all' : b.targetTagId ?? 'tag:unknown', b }))
    .sort((a, b) => a.at - b.at)

  const WINDOW_MS = 30 * 60 * 1000
  for (let i = 0; i < scheduled.length; i++) {
    for (let j = i + 1; j < scheduled.length; j++) {
      const diff = scheduled[j].at - scheduled[i].at
      if (diff > WINDOW_MS) break
      // audience overlap: both 'all', or same tag, or one is 'all' (fully overlaps all tag audiences)
      const a = scheduled[i].targetKey
      const b = scheduled[j].targetKey
      if (a === b || a === 'all' || b === 'all') {
        conflicts.add(scheduled[i].id)
        conflicts.add(scheduled[j].id)
      }
    }
  }
  return conflicts
}

export default function BroadcastCalendar({ broadcasts, getTagName, onSelectBroadcast }: BroadcastCalendarProps) {
  const today = new Date()
  const [cursor, setCursor] = useState<{ year: number; month: number }>({
    year: today.getFullYear(),
    month: today.getMonth(),
  })

  const conflictIds = useMemo(() => detectConflicts(broadcasts), [broadcasts])

  const byDay = useMemo(() => {
    const map = new Map<string, ApiBroadcast[]>()
    for (const b of broadcasts) {
      const key = b.scheduledAt
        ? ymdKeyFromIso(b.scheduledAt)
        : b.sentAt
          ? ymdKeyFromIso(b.sentAt)
          : null
      if (!key) continue
      const arr = map.get(key) ?? []
      arr.push(b)
      map.set(key, arr)
    }
    return map
  }, [broadcasts])

  const days = useMemo(() => getMonthGrid(cursor.year, cursor.month), [cursor])
  const monthLabel = `${cursor.year}年${cursor.month + 1}月`

  const hasConflicts = conflictIds.size > 0
  const totalScheduled = broadcasts.filter((b) => b.status === 'scheduled').length

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-3">
          <button
            onClick={() => {
              const m = cursor.month - 1
              setCursor(m < 0 ? { year: cursor.year - 1, month: 11 } : { year: cursor.year, month: m })
            }}
            className="px-3 py-1 text-sm text-gray-700 hover:bg-gray-100 rounded-md"
            aria-label="前月"
          >
            ‹
          </button>
          <h2 className="text-sm font-semibold text-gray-900 min-w-[110px] text-center">{monthLabel}</h2>
          <button
            onClick={() => {
              const m = cursor.month + 1
              setCursor(m > 11 ? { year: cursor.year + 1, month: 0 } : { year: cursor.year, month: m })
            }}
            className="px-3 py-1 text-sm text-gray-700 hover:bg-gray-100 rounded-md"
            aria-label="翌月"
          >
            ›
          </button>
          <button
            onClick={() => setCursor({ year: today.getFullYear(), month: today.getMonth() })}
            className="px-3 py-1 text-xs text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-md"
          >
            今月
          </button>
        </div>
        <div className="flex items-center gap-3 text-xs text-gray-600">
          <span>予約: {totalScheduled}件</span>
          {hasConflicts && (
            <span className="inline-flex items-center gap-1 px-2 py-1 bg-amber-50 text-amber-800 border border-amber-200 rounded-md">
              ⚠ 配信重複の可能性: {conflictIds.size}件
            </span>
          )}
        </div>
      </div>

      {/* Weekday header */}
      <div className="grid grid-cols-7 border-b border-gray-200 bg-gray-50">
        {['日', '月', '火', '水', '木', '金', '土'].map((w, i) => (
          <div
            key={w}
            className={`px-2 py-1.5 text-xs font-medium text-center ${
              i === 0 ? 'text-red-500' : i === 6 ? 'text-blue-500' : 'text-gray-600'
            }`}
          >
            {w}
          </div>
        ))}
      </div>

      {/* Days grid */}
      <div className="grid grid-cols-7">
        {days.map((d, idx) => {
          const key = ymdKey(d)
          const inMonth = d.getMonth() === cursor.month
          const isToday = ymdKey(today) === key
          const items = byDay.get(key) ?? []
          return (
            <div
              key={idx}
              className={`min-h-[96px] border-b border-r border-gray-100 px-1.5 py-1 ${
                inMonth ? 'bg-white' : 'bg-gray-50/50'
              }`}
            >
              <div className="flex items-center justify-between mb-1">
                <span
                  className={`text-xs font-medium ${
                    !inMonth
                      ? 'text-gray-300'
                      : isToday
                        ? 'text-white bg-green-600 rounded-full w-5 h-5 inline-flex items-center justify-center'
                        : d.getDay() === 0
                          ? 'text-red-500'
                          : d.getDay() === 6
                            ? 'text-blue-500'
                            : 'text-gray-700'
                  }`}
                >
                  {d.getDate()}
                </span>
                {items.length > 0 && (
                  <span className="text-[10px] text-gray-400">{items.length}</span>
                )}
              </div>
              <div className="space-y-0.5">
                {items.slice(0, 3).map((b) => {
                  const hasConflict = conflictIds.has(b.id)
                  const time = b.scheduledAt
                    ? new Date(b.scheduledAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })
                    : ''
                  const target = b.targetType === 'all' ? '全員' : (getTagName(b.targetTagId) ?? 'タグ')
                  return (
                    <button
                      key={b.id}
                      onClick={() => onSelectBroadcast?.(b)}
                      className={`w-full text-left px-1.5 py-0.5 rounded text-[10px] truncate transition-colors ${statusColor[b.status]} ${
                        hasConflict ? 'ring-1 ring-amber-400' : ''
                      } hover:opacity-80`}
                      title={`${b.title}\n${time} / ${target}${hasConflict ? '\n⚠ 同時間帯に重複あり' : ''}`}
                    >
                      {hasConflict && <span className="mr-0.5">⚠</span>}
                      {time && <span className="font-mono mr-1">{time}</span>}
                      {b.title}
                    </button>
                  )
                })}
                {items.length > 3 && (
                  <div className="text-[10px] text-gray-400 px-1.5">他{items.length - 3}件</div>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* Legend */}
      <div className="px-4 py-2 border-t border-gray-200 flex flex-wrap items-center gap-3 text-[11px] text-gray-500">
        {(['draft', 'scheduled', 'sending', 'sent'] as const).map((s) => (
          <span key={s} className="inline-flex items-center gap-1">
            <span className={`inline-block w-2 h-2 rounded ${statusColor[s].split(' ')[0]}`} />
            {s === 'draft' ? '下書き' : s === 'scheduled' ? '予約済み' : s === 'sending' ? '送信中' : '送信完了'}
          </span>
        ))}
        <span className="inline-flex items-center gap-1">
          <span className="inline-block w-2 h-2 rounded ring-1 ring-amber-400 bg-white" />
          重複警告（±30分・同オーディエンス）
        </span>
      </div>
    </div>
  )
}
