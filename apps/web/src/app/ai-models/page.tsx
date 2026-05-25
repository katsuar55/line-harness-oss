'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { fetchApi } from '@/lib/api'
import Header from '@/components/layout/header'

// ============================================================
// 型 — worker GET /api/ai-models
// ============================================================

interface AiModelEntry {
  id: string
  modelId: string
  vendor: string
  family: string
  sizeLabel: string | null
  task: string
  capabilities: string[]
  contextWindow: number | null
  description: string | null
  isBeta: boolean
  isDeprecated: boolean
  primaryCandidate: boolean
  fallbackCandidate: boolean
  firstSeenAt: string
  lastSeenAt: string
  lastSyncedAt: string | null
  source: string
  isNewlyAdded?: boolean
}

interface AiModelStats {
  total: number
  active: number
  deprecated: number
  primaryCandidates: number
  fallbackCandidates: number
  byVendor: Record<string, number>
  byTask: Record<string, number>
}

interface AiModelsResponse {
  success: boolean
  data: {
    models: AiModelEntry[]
    stats: AiModelStats
  }
  error?: string
}

interface SyncResponse {
  success: boolean
  data?: {
    triggered: boolean
    skippedReason?: string
    fetched: number
    inserted: number
    updated: number
    newlyDeprecated: number
    errors: number
    newModelIds: string[]
    deprecatedModelIds: string[]
  }
  error?: string
}

interface CandidateUpdateResponse {
  success: boolean
  data?: { modelId: string; primary: boolean; fallback: boolean }
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

function vendorColor(vendor: string): string {
  switch (vendor) {
    case 'meta':
      return '#0866FF'
    case 'google':
      return '#4285F4'
    case 'qwen':
      return '#7C3AED'
    case 'openai':
      return '#10A37F'
    case 'mistral':
      return '#FA5E20'
    case 'baai':
      return '#0EA5E9'
    default:
      return '#6B7280'
  }
}

function CapabilityBadge({ cap }: { cap: string }) {
  const colors: Record<string, string> = {
    text: 'bg-gray-100 text-gray-700',
    vision: 'bg-purple-100 text-purple-700',
    audio: 'bg-pink-100 text-pink-700',
    'function-calling': 'bg-blue-100 text-blue-700',
    multilingual: 'bg-green-100 text-green-700',
    embedding: 'bg-amber-100 text-amber-700',
    translation: 'bg-teal-100 text-teal-700',
    'image-generation': 'bg-fuchsia-100 text-fuchsia-700',
  }
  return (
    <span
      className={`text-[10px] px-1.5 py-0.5 rounded-sm font-medium ${
        colors[cap] ?? 'bg-gray-100 text-gray-700'
      }`}
    >
      {cap}
    </span>
  )
}

// ============================================================
// row
// ============================================================

interface ModelRowProps {
  model: AiModelEntry
  onToggleCandidate: (modelId: string, kind: 'primary' | 'fallback', next: boolean) => Promise<void>
  busy: boolean
}

function ModelRow({ model, onToggleCandidate, busy }: ModelRowProps) {
  const [open, setOpen] = useState(false)
  const [localPrimary, setLocalPrimary] = useState(model.primaryCandidate)
  const [localFallback, setLocalFallback] = useState(model.fallbackCandidate)

  useEffect(() => {
    setLocalPrimary(model.primaryCandidate)
    setLocalFallback(model.fallbackCandidate)
  }, [model.primaryCandidate, model.fallbackCandidate])

  const handlePrimary = async () => {
    const next = !localPrimary
    setLocalPrimary(next)
    try {
      await onToggleCandidate(model.modelId, 'primary', next)
    } catch {
      setLocalPrimary(!next)
    }
  }
  const handleFallback = async () => {
    const next = !localFallback
    setLocalFallback(next)
    try {
      await onToggleCandidate(model.modelId, 'fallback', next)
    } catch {
      setLocalFallback(!next)
    }
  }

  return (
    <div
      className={`border rounded-lg bg-white ${
        model.isDeprecated ? 'border-red-200 bg-red-50/30' : 'border-gray-200'
      }`}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full px-3 py-2.5 flex items-center gap-3 text-left hover:bg-gray-50 transition-colors"
        aria-expanded={open}
      >
        <span
          className="text-[10px] font-bold px-2 py-0.5 rounded-sm shrink-0 text-white uppercase"
          style={{ backgroundColor: vendorColor(model.vendor) }}
        >
          {model.vendor}
        </span>
        <span className="text-xs text-gray-500 shrink-0 w-16 truncate">{model.family}</span>
        <span className="text-sm font-mono text-gray-800 truncate flex-1" title={model.modelId}>
          {model.modelId}
        </span>
        <span className="flex gap-1 shrink-0">
          {model.isNewlyAdded && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-sm font-bold bg-sky-100 text-sky-700">
              NEW
            </span>
          )}
          {model.isBeta && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-sm font-bold bg-amber-100 text-amber-700">
              BETA
            </span>
          )}
          {model.isDeprecated && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-sm font-bold bg-red-100 text-red-700">
              DEPRECATED
            </span>
          )}
          {model.primaryCandidate && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-sm font-bold bg-emerald-100 text-emerald-700">
              PRIMARY
            </span>
          )}
          {model.fallbackCandidate && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-sm font-bold bg-indigo-100 text-indigo-700">
              FALLBACK
            </span>
          )}
        </span>
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
              <span className="text-gray-500">task: </span>
              <span className="font-mono text-gray-800">{model.task}</span>
            </div>
            <div>
              <span className="text-gray-500">size: </span>
              <span className="font-mono text-gray-800">{model.sizeLabel ?? '—'}</span>
            </div>
            <div>
              <span className="text-gray-500">context: </span>
              <span className="font-mono text-gray-800">
                {model.contextWindow ? model.contextWindow.toLocaleString() : '—'}
              </span>
            </div>
            <div>
              <span className="text-gray-500">source: </span>
              <span className="font-mono text-gray-800">{model.source}</span>
            </div>
            <div>
              <span className="text-gray-500">first seen: </span>
              <span className="text-gray-800">{formatJstShort(model.firstSeenAt)}</span>
            </div>
            <div>
              <span className="text-gray-500">last synced: </span>
              <span className="text-gray-800">{formatJstShort(model.lastSyncedAt)}</span>
            </div>
          </div>

          {model.capabilities.length > 0 && (
            <div className="flex items-center flex-wrap gap-1.5 pt-1">
              <span className="text-gray-500">capabilities:</span>
              {model.capabilities.map((cap) => (
                <CapabilityBadge key={cap} cap={cap} />
              ))}
            </div>
          )}

          {model.description && (
            <div className="pt-1">
              <span className="text-gray-500">description: </span>
              <span className="text-gray-700">{model.description}</span>
            </div>
          )}

          {!model.isDeprecated && (
            <div className="flex gap-3 pt-2 border-t border-gray-200">
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={localPrimary}
                  onChange={handlePrimary}
                  disabled={busy}
                  className="cursor-pointer"
                />
                <span className="text-gray-700">primary candidate</span>
              </label>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={localFallback}
                  onChange={handleFallback}
                  disabled={busy}
                  className="cursor-pointer"
                />
                <span className="text-gray-700">fallback candidate</span>
              </label>
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

export default function AiModelsPage() {
  const [includeDeprecated, setIncludeDeprecated] = useState(false)
  const [vendorFilter, setVendorFilter] = useState('')
  const [taskFilter, setTaskFilter] = useState('')

  const [data, setData] = useState<{ models: AiModelEntry[]; stats: AiModelStats } | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyModelId, setBusyModelId] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [syncResult, setSyncResult] = useState<SyncResponse['data'] | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams()
      if (vendorFilter) params.set('vendor', vendorFilter)
      if (taskFilter) params.set('task', taskFilter)
      if (includeDeprecated) params.set('includeDeprecated', 'true')

      const res = await fetchApi<AiModelsResponse>(`/api/ai-models?${params.toString()}`)
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
  }, [includeDeprecated, vendorFilter, taskFilter])

  useEffect(() => {
    load()
  }, [load])

  const handleToggleCandidate = useCallback(
    async (modelId: string, kind: 'primary' | 'fallback', next: boolean) => {
      setBusyModelId(modelId)
      try {
        const res = await fetchApi<CandidateUpdateResponse>(
          `/api/ai-models/${encodeURIComponent(modelId)}/candidate`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ [kind]: next }),
          },
        )
        if (!res.success) {
          throw new Error(res.error ?? '更新失敗')
        }
        await load()
      } finally {
        setBusyModelId(null)
      }
    },
    [load],
  )

  const handleSyncNow = async () => {
    setSyncing(true)
    setSyncResult(null)
    setError(null)
    try {
      const res = await fetchApi<SyncResponse>('/api/ai-models/sync', { method: 'POST' })
      if (res.success && res.data) {
        setSyncResult(res.data)
        await load()
      } else {
        setError(res.error ?? 'sync failed')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSyncing(false)
    }
  }

  const vendorOptions = useMemo(() => {
    if (!data) return []
    return Object.keys(data.stats.byVendor).sort()
  }, [data])
  const taskOptions = useMemo(() => {
    if (!data) return []
    return Object.keys(data.stats.byTask).sort()
  }, [data])

  return (
    <div className="min-h-screen bg-gray-50">
      <Header
        title="AI Models カタログ"
        description="ai_models_catalog table。 戦略 #1 で daily sync された Cloudflare Workers AI model 一覧。 primary/fallback candidate は手動 toggle で run-time の env override 設計の判断材料。"
      />

      <main className="max-w-6xl mx-auto px-4 lg:px-6 py-6 space-y-4">
        {/* stats */}
        {data && (
          <section className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <StatCard label="total" value={data.stats.total} />
            <StatCard label="active" value={data.stats.active} accent="emerald" />
            <StatCard label="deprecated" value={data.stats.deprecated} accent="red" />
            <StatCard label="primary 候補" value={data.stats.primaryCandidates} accent="sky" />
            <StatCard label="fallback 候補" value={data.stats.fallbackCandidates} accent="indigo" />
          </section>
        )}

        {/* filter UI */}
        <section className="bg-white border border-gray-200 rounded-lg p-4 space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div>
              <label className="text-[11px] text-gray-500 block mb-1">vendor</label>
              <select
                value={vendorFilter}
                onChange={(e) => setVendorFilter(e.target.value)}
                className="w-full px-2 py-1.5 border border-gray-200 rounded-md text-sm bg-white"
              >
                <option value="">— 全部 —</option>
                {vendorOptions.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-[11px] text-gray-500 block mb-1">task</label>
              <select
                value={taskFilter}
                onChange={(e) => setTaskFilter(e.target.value)}
                className="w-full px-2 py-1.5 border border-gray-200 rounded-md text-sm bg-white"
              >
                <option value="">— 全部 —</option>
                {taskOptions.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex items-end">
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={includeDeprecated}
                  onChange={(e) => setIncludeDeprecated(e.target.checked)}
                  className="cursor-pointer"
                />
                <span className="text-gray-700">deprecated を含む</span>
              </label>
            </div>
          </div>

          <div className="flex items-center gap-2 pt-2 border-t border-gray-100">
            <button
              type="button"
              onClick={handleSyncNow}
              disabled={syncing}
              className="px-3 py-1.5 text-xs rounded-md border border-[#06C755] bg-[#06C755] text-white hover:bg-[#05a847] disabled:opacity-40"
            >
              {syncing ? 'sync 中…' : '今すぐ sync (= 手動 trigger)'}
            </button>
            {syncResult && (
              <span className="text-xs text-gray-600">
                {syncResult.skippedReason
                  ? `skipped: ${syncResult.skippedReason}`
                  : `fetched=${syncResult.fetched} inserted=${syncResult.inserted} updated=${syncResult.updated} deprecated=${syncResult.newlyDeprecated} errors=${syncResult.errors}`}
              </span>
            )}
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
          <section className="space-y-1.5">
            {data.models.length === 0 ? (
              <div className="bg-white border border-gray-200 rounded-lg p-8 text-sm text-gray-500 text-center">
                該当する model はありません
              </div>
            ) : (
              data.models.map((model) => (
                <ModelRow
                  key={model.id}
                  model={model}
                  busy={busyModelId === model.modelId}
                  onToggleCandidate={handleToggleCandidate}
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
// helper components
// ============================================================

interface StatCardProps {
  label: string
  value: number
  accent?: 'emerald' | 'red' | 'sky' | 'indigo'
}

function StatCard({ label, value, accent }: StatCardProps) {
  const colors: Record<string, string> = {
    emerald: 'text-emerald-700',
    red: 'text-red-700',
    sky: 'text-sky-700',
    indigo: 'text-indigo-700',
  }
  return (
    <div className="bg-white border border-gray-200 rounded-lg p-3">
      <p className="text-[11px] text-gray-500">{label}</p>
      <p className={`text-2xl font-bold ${accent ? colors[accent] : 'text-gray-800'}`}>{value}</p>
    </div>
  )
}
