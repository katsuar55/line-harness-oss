'use client'

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { fetchApi } from '@/lib/api'
import Header from '@/components/layout/header'

// ============================================================
// 型定義 — worker GET /api/audit-logs (Phase 5β-1d-2f-followup)
// ============================================================

type AuditResult = 'success' | 'failure'
type AuditActorType = 'admin' | 'system' | 'cron' | 'webhook' | 'api'

interface AuditLog {
  id: string
  line_account_id: string | null
  actor_type: AuditActorType
  actor_id: string | null
  actor_name: string | null
  action: string
  target_type: string | null
  target_id: string | null
  request_id: string | null
  ip_hash: string | null
  user_agent: string | null
  before_value: string | null
  after_value: string | null
  result: AuditResult
  error_message: string | null
  metadata: string
  created_at: string
}

interface AuditLogsListData {
  logs: AuditLog[]
  total: number
  limit: number
  offset: number
  hasMore: boolean
}

interface AuditLogsResponse {
  success: boolean
  data: AuditLogsListData
  error?: string
}

// ============================================================
// プリセット filter
// ============================================================

const ACTION_PREFIX_PRESETS: Array<{ label: string; value: string }> = [
  { label: '— 全部 —', value: '' },
  { label: 'LINE 友だち追加クーポン (5β-1d-2)', value: 'line_friend_coupon.' },
  { label: 'broadcast.*', value: 'broadcast.' },
  { label: 'cron.*', value: 'cron.' },
  { label: 'admin.*', value: 'admin.' },
]

const ACTOR_TYPE_OPTIONS: Array<{ label: string; value: '' | AuditActorType }> = [
  { label: '— 全部 —', value: '' },
  { label: 'webhook', value: 'webhook' },
  { label: 'cron', value: 'cron' },
  { label: 'system', value: 'system' },
  { label: 'admin', value: 'admin' },
  { label: 'api', value: 'api' },
]

const RESULT_OPTIONS: Array<{ label: string; value: '' | AuditResult }> = [
  { label: '— 全部 —', value: '' },
  { label: '成功', value: 'success' },
  { label: '失敗', value: 'failure' },
]

const LIMIT_PER_PAGE = 100

// ============================================================
// helpers
// ============================================================

function formatJstShort(iso: string): string {
  // iso may be `2026-05-20T10:00:00.000+09:00` or `2026-05-20T01:00:00.000Z`
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    return d.toLocaleString('ja-JP', { hour12: false })
  } catch {
    return iso
  }
}

function tryParseJson(value: string | null | undefined): unknown {
  if (!value) return null
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function actorTypeColor(actor: AuditActorType): string {
  switch (actor) {
    case 'webhook':
      return '#06C755'
    case 'cron':
      return '#3b82f6'
    case 'admin':
      return '#8b5cf6'
    case 'system':
      return '#f59e0b'
    case 'api':
      return '#0ea5e9'
    default:
      return '#9ca3af'
  }
}

function resultBadgeClass(result: AuditResult): string {
  return result === 'success'
    ? 'bg-green-50 text-green-700 border-green-200'
    : 'bg-red-50 text-red-700 border-red-200'
}

// ============================================================
// row (expandable detail)
// ============================================================

function LogRow({ log }: { log: AuditLog }) {
  const [open, setOpen] = useState(false)
  const metadataParsed = useMemo(() => tryParseJson(log.metadata), [log.metadata])
  const beforeParsed = useMemo(() => tryParseJson(log.before_value), [log.before_value])
  const afterParsed = useMemo(() => tryParseJson(log.after_value), [log.after_value])
  const hasDetail =
    !!log.error_message ||
    !!log.metadata ||
    !!log.before_value ||
    !!log.after_value ||
    !!log.target_id

  return (
    <div className="border border-gray-200 rounded-lg bg-white">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full px-3 py-2.5 flex items-center gap-3 text-left hover:bg-gray-50 transition-colors"
        aria-expanded={open}
        disabled={!hasDetail}
      >
        <span className="text-xs text-gray-500 tabular-nums shrink-0 w-36">
          {formatJstShort(log.created_at)}
        </span>
        <span
          className="text-[10px] font-bold px-2 py-0.5 rounded-sm shrink-0 text-white"
          style={{ backgroundColor: actorTypeColor(log.actor_type) }}
        >
          {log.actor_type}
        </span>
        <span className="text-sm font-mono text-gray-800 truncate flex-1">
          {log.action}
        </span>
        <span
          className={`text-[10px] font-bold px-2 py-0.5 rounded-sm border shrink-0 ${resultBadgeClass(log.result)}`}
        >
          {log.result}
        </span>
        {hasDetail && (
          <span
            className={`text-gray-400 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
            aria-hidden
          >
            ▶
          </span>
        )}
      </button>
      {open && hasDetail && (
        <div className="border-t border-gray-100 px-3 py-3 text-xs space-y-2 bg-gray-50">
          {log.target_id && (
            <div className="flex gap-2">
              <span className="text-gray-500 w-20 shrink-0">target</span>
              <span className="font-mono text-gray-800 break-all">
                {log.target_type ? `${log.target_type}/` : ''}
                {log.target_id}
              </span>
            </div>
          )}
          {log.error_message && (
            <div className="flex gap-2">
              <span className="text-gray-500 w-20 shrink-0">error</span>
              <span className="text-red-700 break-all">{log.error_message}</span>
            </div>
          )}
          {metadataParsed !== null && (
            <div>
              <p className="text-gray-500 mb-1">metadata</p>
              <pre className="bg-white border border-gray-200 rounded p-2 text-[11px] overflow-x-auto">
                {JSON.stringify(metadataParsed, null, 2)}
              </pre>
            </div>
          )}
          {beforeParsed !== null && (
            <div>
              <p className="text-gray-500 mb-1">before</p>
              <pre className="bg-white border border-gray-200 rounded p-2 text-[11px] overflow-x-auto">
                {JSON.stringify(beforeParsed, null, 2)}
              </pre>
            </div>
          )}
          {afterParsed !== null && (
            <div>
              <p className="text-gray-500 mb-1">after</p>
              <pre className="bg-white border border-gray-200 rounded p-2 text-[11px] overflow-x-auto">
                {JSON.stringify(afterParsed, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ============================================================
// main page
// ============================================================

function AuditLogsPageInner() {
  // 5β-1d-2-followup polish: friend-detail から ?targetType=friend&targetId=X で hidden filter として受け取る
  const searchParams = useSearchParams()
  const targetIdFilter = searchParams.get('targetId') ?? ''
  const targetTypeFilter = searchParams.get('targetType') ?? ''

  // targetId 絞り込み時は action prefix の default (= line_friend_coupon.) を外す (= 全 action 見たい場合多い)
  const [actionPrefix, setActionPrefix] = useState(targetIdFilter ? '' : 'line_friend_coupon.')
  const [actionExact, setActionExact] = useState('')
  const [result, setResult] = useState<'' | AuditResult>('')
  const [actorType, setActorType] = useState<'' | AuditActorType>('')
  const [days, setDays] = useState(targetIdFilter ? 0 : 7) // targetId 時は全期間 default
  const [offset, setOffset] = useState(0)

  const [data, setData] = useState<AuditLogsListData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams()
      if (actionExact) params.set('action', actionExact)
      if (!actionExact && actionPrefix) params.set('actionPrefix', actionPrefix)
      if (result) params.set('result', result)
      if (actorType) params.set('actorType', actorType)
      // 5β-1d-2-followup polish: friend-detail からの target 絞り込み (URL param 経由)
      if (targetTypeFilter) params.set('targetType', targetTypeFilter)
      if (targetIdFilter) params.set('targetId', targetIdFilter)
      if (days > 0) {
        const since = new Date(Date.now() - days * 86_400_000).toISOString()
        params.set('since', since)
      }
      params.set('limit', String(LIMIT_PER_PAGE))
      params.set('offset', String(offset))

      const res = await fetchApi<AuditLogsResponse>(`/api/audit-logs?${params.toString()}`)
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
  }, [actionExact, actionPrefix, result, actorType, days, offset, targetIdFilter, targetTypeFilter])

  useEffect(() => {
    load()
  }, [load])

  // filter 変更時は offset を 0 にリセット (= 別 paginate context)
  const resetOffset = () => setOffset(0)

  return (
    <div className="min-h-screen bg-gray-50">
      <Header
        title="監査ログ"
        description="audit_logs テーブルの append-only ログを filter + pagination で閲覧。 5β-1d-2 課題 1 真因確定にも使う。"
      />

      <main className="max-w-6xl mx-auto px-4 lg:px-6 py-6 space-y-4">
        {/* 5β-1d-2-followup polish: target filter banner (= friend-detail から遷移時) */}
        {targetIdFilter && (
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 flex items-center justify-between text-sm">
            <span className="text-blue-700">
              ⓘ {targetTypeFilter && (
                <>
                  target_type=<code className="font-mono bg-white px-1.5 py-0.5 rounded text-xs">{targetTypeFilter}</code>{' '}
                </>
              )}
              target_id=<code className="font-mono bg-white px-1.5 py-0.5 rounded text-xs">{targetIdFilter.slice(0, 12)}...</code> で絞り込み中
            </span>
            <Link href="/audit-logs" className="text-xs text-blue-600 hover:underline">
              絞り込み解除 →
            </Link>
          </div>
        )}

        {/* filter UI */}
        <section className="bg-white border border-gray-200 rounded-lg p-4 space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
            <div>
              <label className="text-[11px] text-gray-500 block mb-1">action prefix</label>
              <select
                value={actionPrefix}
                onChange={(e) => {
                  setActionPrefix(e.target.value)
                  resetOffset()
                }}
                className="w-full px-2 py-1.5 border border-gray-200 rounded-md text-sm bg-white"
                disabled={!!actionExact}
              >
                {ACTION_PREFIX_PRESETS.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-[11px] text-gray-500 block mb-1">action exact (precise)</label>
              <input
                type="text"
                value={actionExact}
                onChange={(e) => {
                  setActionExact(e.target.value)
                  resetOffset()
                }}
                placeholder="例: line_friend_coupon.issue_failed"
                className="w-full px-2 py-1.5 border border-gray-200 rounded-md text-sm"
              />
            </div>
            <div>
              <label className="text-[11px] text-gray-500 block mb-1">result</label>
              <select
                value={result}
                onChange={(e) => {
                  setResult(e.target.value as '' | AuditResult)
                  resetOffset()
                }}
                className="w-full px-2 py-1.5 border border-gray-200 rounded-md text-sm bg-white"
              >
                {RESULT_OPTIONS.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-[11px] text-gray-500 block mb-1">actor</label>
              <select
                value={actorType}
                onChange={(e) => {
                  setActorType(e.target.value as '' | AuditActorType)
                  resetOffset()
                }}
                className="w-full px-2 py-1.5 border border-gray-200 rounded-md text-sm bg-white"
              >
                {ACTOR_TYPE_OPTIONS.map((a) => (
                  <option key={a.value} value={a.value}>
                    {a.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="flex items-center gap-2 pt-2 border-t border-gray-100">
            <span className="text-xs text-gray-500">期間 (過去):</span>
            {[1, 7, 30, 90].map((d) => (
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
                {d === 1 ? '24h' : `${d}日`}
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
                {Math.min(data.offset + data.logs.length, data.total)} を表示
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

            {data.logs.length === 0 ? (
              <div className="bg-white border border-gray-200 rounded-lg p-8 text-sm text-gray-500 text-center">
                該当する監査ログはありません
              </div>
            ) : (
              <div className="space-y-1.5">
                {data.logs.map((log) => (
                  <LogRow key={log.id} log={log} />
                ))}
              </div>
            )}
          </>
        )}
      </main>
    </div>
  )
}

// 5β-1d-2-followup polish: useSearchParams は Suspense boundary 必須 (Next.js 15)
export default function AuditLogsPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-gray-50">
          <Header title="監査ログ" />
          <div className="text-sm text-gray-500 py-8 text-center">読込中…</div>
        </div>
      }
    >
      <AuditLogsPageInner />
    </Suspense>
  )
}
