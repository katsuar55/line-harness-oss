'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { fetchApi } from '@/lib/api'
import Header from '@/components/layout/header'

// ============================================================
// 型 — worker GET /api/google-audit/latest
// ============================================================

interface AuditRun {
  id: string
  run_at: string
  trigger: string
  status: string
  total_products: number
  products_with_issues: number
  high_severity_count: number
  medium_severity_count: number
  low_severity_count: number
  issues_by_category: string | null
  duration_ms: number | null
  error_message: string | null
  created_at: string
}

interface ProductIssue {
  id: string
  run_id: string
  shopify_product_id: string
  product_title: string
  product_handle: string | null
  category: string
  severity: string
  field: string | null
  original_value: string | null
  suggested_value: string | null
  applied: number
  applied_at: string | null
  applied_by: string | null
  metadata: string | null
  created_at: string
}

interface LatestResponse {
  success: boolean
  data: {
    run: AuditRun | null
    issues: ProductIssue[]
  }
  error?: string
}

interface RunResponse {
  success: boolean
  data?: {
    runId: string
    status: string
    totalProducts: number
    productsWithIssues: number
    highSeverityCount: number
    mediumSeverityCount: number
    lowSeverityCount: number
    issuesByCategory: Record<string, number>
    durationMs: number
    errorMessage?: string
  }
  error?: string
}

interface ApplyResponse {
  success: boolean
  data?: {
    dryRun: boolean
    applied?: { field: string; before: string | null; after: string | null }
    error?: string
  }
  error?: string
}

// ============================================================
// helpers
// ============================================================

function formatJstShort(iso: string | null): string {
  if (!iso) return '—'
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    return d.toLocaleString('ja-JP', { hour12: false }).slice(0, 16)
  } catch {
    return iso
  }
}

function severityColor(s: string): string {
  switch (s) {
    case 'high':
      return 'bg-red-100 text-red-700 border-red-200'
    case 'medium':
      return 'bg-amber-100 text-amber-700 border-amber-200'
    case 'low':
      return 'bg-gray-100 text-gray-700 border-gray-200'
    default:
      return 'bg-gray-100 text-gray-700'
  }
}

function categoryLabel(c: string): string {
  const labels: Record<string, string> = {
    ng_keyword: '薬機法 NG keyword',
    missing_gtin: 'GTIN 未設定',
    missing_gpc: 'Google Product Category 未設定',
    missing_brand: 'brand 不一致',
    missing_image: '画像なし',
    inventory_zero: '在庫 0',
    missing_description: '説明文なし',
    image_overlay_suspected: '画像 overlay 疑い',
    price_inconsistency: '価格不一致',
    invalid_identifier_exists: 'identifier_exists 不正',
  }
  return labels[c] ?? c
}

// ============================================================
// row (expandable detail + apply button)
// ============================================================

interface IssueRowProps {
  issue: ProductIssue
  onApply: (issueId: string, dryRun: boolean) => Promise<ApplyResponse>
  busy: boolean
}

function IssueRow({ issue, onApply, busy }: IssueRowProps) {
  const [open, setOpen] = useState(false)
  const [applyResult, setApplyResult] = useState<ApplyResponse['data'] | null>(null)
  const [applyError, setApplyError] = useState<string | null>(null)

  const handleDryRun = async () => {
    setApplyError(null)
    try {
      const r = await onApply(issue.id, true)
      if (r.success && r.data) setApplyResult(r.data)
      else setApplyError(r.error ?? 'dry-run failed')
    } catch (e) {
      setApplyError(e instanceof Error ? e.message : String(e))
    }
  }
  const handleActualApply = async () => {
    setApplyError(null)
    try {
      const r = await onApply(issue.id, false)
      if (r.success && r.data) setApplyResult(r.data)
      else setApplyError(r.error ?? 'apply failed')
    } catch (e) {
      setApplyError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div
      className={`border rounded-lg bg-white ${
        issue.applied === 1 ? 'border-emerald-200 bg-emerald-50/30' : 'border-gray-200'
      }`}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full px-3 py-2.5 flex items-center gap-3 text-left hover:bg-gray-50 transition-colors"
        aria-expanded={open}
      >
        <span
          className={`text-[10px] font-bold px-1.5 py-0.5 rounded-sm border shrink-0 uppercase ${severityColor(issue.severity)}`}
        >
          {issue.severity}
        </span>
        <span className="text-xs text-gray-500 shrink-0 w-44 truncate" title={categoryLabel(issue.category)}>
          {categoryLabel(issue.category)}
        </span>
        <span className="text-sm text-gray-800 truncate flex-1" title={issue.product_title}>
          {issue.product_title}
        </span>
        {issue.applied === 1 ? (
          <span className="text-[10px] px-1.5 py-0.5 rounded-sm font-bold bg-emerald-100 text-emerald-700">
            APPLIED
          </span>
        ) : (
          <span className="text-[10px] px-1.5 py-0.5 rounded-sm font-bold bg-orange-100 text-orange-700">
            PENDING
          </span>
        )}
        <span
          className={`text-gray-400 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
          aria-hidden
        >
          ▶
        </span>
      </button>

      {open && (
        <div className="border-t border-gray-100 px-3 py-3 text-xs space-y-2 bg-gray-50">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <span className="text-gray-500">shopify_product_id: </span>
              <span className="font-mono text-gray-800 break-all text-[11px]">{issue.shopify_product_id}</span>
            </div>
            <div>
              <span className="text-gray-500">field: </span>
              <span className="font-mono text-gray-800">{issue.field ?? '—'}</span>
            </div>
          </div>

          {issue.original_value && (
            <div>
              <p className="text-gray-500 mb-1">before:</p>
              <pre className="bg-red-50 border border-red-200 rounded p-2 text-[11px] overflow-x-auto whitespace-pre-wrap break-all text-red-900">
                {issue.original_value}
              </pre>
            </div>
          )}
          {issue.suggested_value && (
            <div>
              <p className="text-gray-500 mb-1">suggested (after):</p>
              <pre className="bg-emerald-50 border border-emerald-200 rounded p-2 text-[11px] overflow-x-auto whitespace-pre-wrap break-all text-emerald-900">
                {issue.suggested_value}
              </pre>
            </div>
          )}

          {issue.applied === 0 && (
            <div className="flex gap-2 pt-2 border-t border-gray-200">
              <button
                type="button"
                onClick={handleDryRun}
                disabled={busy}
                className="px-3 py-1 text-xs rounded-md border border-sky-300 bg-sky-50 text-sky-700 hover:bg-sky-100 disabled:opacity-40"
              >
                Dry-run (preview)
              </button>
              <button
                type="button"
                onClick={handleActualApply}
                disabled={busy}
                className="px-3 py-1 text-xs rounded-md border border-[#06C755] bg-[#06C755] text-white hover:bg-[#05a847] disabled:opacity-40"
              >
                Apply (actual)
              </button>
            </div>
          )}

          {applyResult && (
            <div
              className={`text-[11px] rounded p-2 border ${
                applyResult.dryRun
                  ? 'bg-sky-50 border-sky-200 text-sky-700'
                  : 'bg-emerald-50 border-emerald-200 text-emerald-700'
              }`}
            >
              {applyResult.dryRun ? '[DRY-RUN] ' : '[APPLIED] '}
              field={applyResult.applied?.field}
              before={applyResult.applied?.before?.slice(0, 50) ?? '—'} →
              after={applyResult.applied?.after?.slice(0, 50) ?? '—'}
            </div>
          )}
          {applyError && (
            <div className="text-[11px] rounded p-2 border bg-red-50 border-red-200 text-red-700">
              {applyError}
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

export default function GoogleAuditPage() {
  const [severityFilter, setSeverityFilter] = useState<string>('')
  const [categoryFilter, setCategoryFilter] = useState<string>('')
  const [pendingOnly, setPendingOnly] = useState(false)

  const [data, setData] = useState<{ run: AuditRun | null; issues: ProductIssue[] } | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyIssueId, setBusyIssueId] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [runResult, setRunResult] = useState<RunResponse['data'] | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams()
      if (severityFilter) params.set('severity', severityFilter)
      if (categoryFilter) params.set('category', categoryFilter)
      if (pendingOnly) params.set('pendingOnly', 'true')

      const res = await fetchApi<LatestResponse>(`/api/google-audit/latest?${params.toString()}`)
      if (res.success) setData(res.data)
      else setError(res.error ?? '取得に失敗しました')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [severityFilter, categoryFilter, pendingOnly])

  useEffect(() => {
    load()
  }, [load])

  const handleApply = useCallback(
    async (issueId: string, dryRun: boolean): Promise<ApplyResponse> => {
      setBusyIssueId(issueId)
      try {
        const res = await fetchApi<ApplyResponse>(
          `/api/google-audit/issues/${encodeURIComponent(issueId)}/apply`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ dryRun, appliedBy: 'admin-ui' }),
          },
        )
        if (res.success && !dryRun) {
          await load()
        }
        return res
      } finally {
        setBusyIssueId(null)
      }
    },
    [load],
  )

  const handleRunNow = async () => {
    setRunning(true)
    setRunResult(null)
    setError(null)
    try {
      const res = await fetchApi<RunResponse>('/api/google-audit/run', { method: 'POST' })
      if (res.success && res.data) {
        setRunResult(res.data)
        await load()
      } else {
        setError(res.error ?? 'audit run failed')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setRunning(false)
    }
  }

  const categoryOptions = useMemo(() => {
    if (!data?.run?.issues_by_category) return []
    try {
      const parsed = JSON.parse(data.run.issues_by_category) as Record<string, number>
      return Object.keys(parsed).sort()
    } catch {
      return []
    }
  }, [data])

  return (
    <div className="min-h-screen bg-gray-50">
      <Header
        title="Shopify-Google Merchant 監査"
        description="Merchant Center 商品掲載 issue を audit + 自動修復。 薬機法 NG keyword scan + metafield (= GTIN / GPC / brand) 不足検出 + dry-run apply。 直接 LP launch blocker (= Markets 設定) は admin で別途修正、 本 page は将来予防的監視。"
      />

      <main className="max-w-6xl mx-auto px-4 lg:px-6 py-6 space-y-4">
        {data?.run && (
          <section className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <StatCard label="total products" value={data.run.total_products} />
            <StatCard
              label="products w/ issues"
              value={data.run.products_with_issues}
              accent={data.run.products_with_issues > 0 ? 'amber' : 'emerald'}
            />
            <StatCard label="high" value={data.run.high_severity_count} accent="red" />
            <StatCard label="medium" value={data.run.medium_severity_count} accent="amber" />
            <StatCard label="low" value={data.run.low_severity_count} />
          </section>
        )}

        {/* filter + action */}
        <section className="bg-white border border-gray-200 rounded-lg p-4 space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div>
              <label className="text-[11px] text-gray-500 block mb-1">severity</label>
              <select
                value={severityFilter}
                onChange={(e) => setSeverityFilter(e.target.value)}
                className="w-full px-2 py-1.5 border border-gray-200 rounded-md text-sm bg-white"
              >
                <option value="">— 全部 —</option>
                <option value="high">high</option>
                <option value="medium">medium</option>
                <option value="low">low</option>
              </select>
            </div>
            <div>
              <label className="text-[11px] text-gray-500 block mb-1">category</label>
              <select
                value={categoryFilter}
                onChange={(e) => setCategoryFilter(e.target.value)}
                className="w-full px-2 py-1.5 border border-gray-200 rounded-md text-sm bg-white"
              >
                <option value="">— 全部 —</option>
                {categoryOptions.map((c) => (
                  <option key={c} value={c}>
                    {categoryLabel(c)}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex items-end">
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={pendingOnly}
                  onChange={(e) => setPendingOnly(e.target.checked)}
                  className="cursor-pointer"
                />
                <span className="text-gray-700">未適用のみ表示</span>
              </label>
            </div>
          </div>

          <div className="flex items-center gap-2 pt-2 border-t border-gray-100">
            <button
              type="button"
              onClick={handleRunNow}
              disabled={running}
              className="px-3 py-1.5 text-xs rounded-md border border-[#06C755] bg-[#06C755] text-white hover:bg-[#05a847] disabled:opacity-40"
            >
              {running ? 'audit 実行中…' : '今すぐ audit (= 手動 trigger)'}
            </button>
            {data?.run && (
              <span className="text-xs text-gray-600">
                直近 run: {formatJstShort(data.run.run_at)} (= {data.run.trigger} / {data.run.status})
              </span>
            )}
            {runResult && (
              <span className="text-xs text-gray-600">
                fetched={runResult.totalProducts} issues={runResult.productsWithIssues} high=
                {runResult.highSeverityCount} ({runResult.durationMs}ms)
              </span>
            )}
          </div>
        </section>

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">{error}</div>
        )}

        {loading && !data && (
          <div className="text-sm text-gray-500 py-8 text-center">読込中…</div>
        )}

        {data && !data.run && (
          <div className="bg-white border border-gray-200 rounded-lg p-8 text-sm text-gray-500 text-center">
            まだ audit が一度も実行されていません。 「今すぐ audit」 button から最初の run を実行してください。
          </div>
        )}

        {data && data.run && (
          <section className="space-y-1.5">
            {data.issues.length === 0 ? (
              <div className="bg-white border border-gray-200 rounded-lg p-8 text-sm text-gray-500 text-center">
                該当する issue はありません 🎉
              </div>
            ) : (
              data.issues.map((issue) => (
                <IssueRow
                  key={issue.id}
                  issue={issue}
                  busy={busyIssueId === issue.id}
                  onApply={handleApply}
                />
              ))
            )}
          </section>
        )}
      </main>
    </div>
  )
}

// ============================================================
// helpers
// ============================================================

interface StatCardProps {
  label: string
  value: number
  accent?: 'emerald' | 'red' | 'amber' | 'sky'
}

function StatCard({ label, value, accent }: StatCardProps) {
  const colors: Record<string, string> = {
    emerald: 'text-emerald-700',
    red: 'text-red-700',
    amber: 'text-amber-700',
    sky: 'text-sky-700',
  }
  return (
    <div className="bg-white border border-gray-200 rounded-lg p-3">
      <p className="text-[11px] text-gray-500">{label}</p>
      <p className={`text-2xl font-bold ${accent ? colors[accent] : 'text-gray-800'}`}>{value}</p>
    </div>
  )
}
