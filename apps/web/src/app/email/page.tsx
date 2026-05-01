'use client'

import { useState, useEffect, useCallback } from 'react'
import { fetchApi } from '@/lib/api'
import type { ApiResponse } from '@line-crm/shared'

// ============================================================
// 型定義 — worker /api/admin/email/* レスポンスに対応 (Round 4 PR-7)
// ============================================================

interface KpiTotals {
  sent: number
  delivered: number
  opened: number
  clicked: number
  bounced: number
  complained: number
  unsubscribed: number
  fromDate: string
  toDate: string
}

interface KpiByCategory {
  category: 'transactional' | 'marketing'
  sent: number
  delivered: number
  opened: number
  clicked: number
}

interface KpiSubscribers {
  total: number
  active: number
  inactive: number
  transactionalOnly: number
}

interface KpiResponse {
  totals: KpiTotals
  byCategory: KpiByCategory[]
  subscribers: KpiSubscribers
}

interface SubscriberRow {
  id: string
  friend_id: string | null
  email: string
  is_active: number
  transactional_only: number
  unsubscribed_at: string | null
  bounce_count: number
  complaint_count: number
  consent_source: string | null
  consent_at: string
  created_at: string
  updated_at: string
}

interface TemplateRow {
  id: string
  name: string
  category: string
  subject: string
  html_content: string
  text_content: string
  preheader: string | null
  is_active: number
  created_at: string
  updated_at: string
}

interface MessageRow {
  id: string
  subscriberId: string
  email: string | null
  subject: string
  category: string
  sourceKind: string
  status: string
  openCount: number
  clickCount: number
  sentAt: string | null
  deliveredAt: string | null
  firstOpenedAt: string | null
  lastEventAt: string | null
  createdAt: string
}

type SubscriberStatus = 'all' | 'active' | 'inactive' | 'transactional'

interface NewSubscriberForm {
  email: string
  marketingOptIn: boolean
  consentSource: string
}

interface TemplateForm {
  id?: string
  name: string
  category: string
  subject: string
  preheader: string
  htmlContent: string
  textContent: string
  isActive: boolean
}

// ============================================================
// 日付ヘルパー
// ============================================================

function formatDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function defaultDateRange(): { from: string; to: string } {
  const today = new Date()
  const past = new Date()
  past.setDate(past.getDate() - 29)
  return { from: formatDate(past), to: formatDate(today) }
}

function formatJstDateTime(iso: string | null | undefined): string {
  if (!iso) return '-'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '-'
  return d.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })
}

function formatJstDate(iso: string | null | undefined): string {
  if (!iso) return '-'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '-'
  return d.toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo' })
}

function formatPercent(numerator: number, denominator: number): string {
  if (denominator <= 0) return '-'
  return `${((numerator / denominator) * 100).toFixed(1)}%`
}

const STATUS_LABEL: Record<SubscriberStatus, string> = {
  all: 'すべて',
  active: '配信中',
  inactive: '解除済み',
  transactional: 'トランザクションのみ',
}

const CATEGORY_LABEL: Record<string, string> = {
  marketing: 'マーケ',
  transactional: 'トランザクション',
  general: '汎用',
}

function statusBadgeClass(status: string): string {
  const s = status.toLowerCase()
  if (s === 'sent' || s === 'delivered') return 'badge badge-success badge-sm'
  if (s === 'opened' || s === 'clicked') return 'badge badge-info badge-sm'
  if (s === 'bounced' || s === 'complained' || s === 'failed')
    return 'badge badge-error badge-sm'
  if (s === 'queued' || s === 'pending') return 'badge badge-ghost badge-sm'
  return 'badge badge-ghost badge-sm'
}

// ============================================================
// Page
// ============================================================

export default function EmailPage() {
  const initialRange = defaultDateRange()
  const [from, setFrom] = useState<string>(initialRange.from)
  const [to, setTo] = useState<string>(initialRange.to)

  const [kpi, setKpi] = useState<KpiResponse | null>(null)
  const [kpiLoading, setKpiLoading] = useState(false)
  const [kpiError, setKpiError] = useState<string | null>(null)

  const [subscriberStatus, setSubscriberStatus] =
    useState<SubscriberStatus>('all')
  const [subscribers, setSubscribers] = useState<SubscriberRow[] | null>(null)
  const [subsLoading, setSubsLoading] = useState(false)
  const [subsError, setSubsError] = useState<string | null>(null)

  const [templates, setTemplates] = useState<TemplateRow[] | null>(null)
  const [tplLoading, setTplLoading] = useState(false)
  const [tplError, setTplError] = useState<string | null>(null)

  const [messages, setMessages] = useState<MessageRow[] | null>(null)
  const [msgLoading, setMsgLoading] = useState(false)
  const [msgError, setMsgError] = useState<string | null>(null)

  // Modals
  const [newSubscriber, setNewSubscriber] =
    useState<NewSubscriberForm | null>(null)
  const [savingSub, setSavingSub] = useState(false)
  const [saveSubError, setSaveSubError] = useState<string | null>(null)

  const [editingTemplate, setEditingTemplate] = useState<TemplateForm | null>(
    null,
  )
  const [savingTpl, setSavingTpl] = useState(false)
  const [saveTplError, setSaveTplError] = useState<string | null>(null)

  // ----------------------------------------------------------
  // Loaders
  // ----------------------------------------------------------

  const loadKpi = useCallback(async () => {
    setKpiLoading(true)
    setKpiError(null)
    try {
      const params = new URLSearchParams({ from, to })
      const json = await fetchApi<ApiResponse<KpiResponse>>(
        `/api/admin/email/kpi?${params.toString()}`,
      )
      if (json.success) {
        setKpi(json.data)
      } else {
        setKpiError(json.error || 'KPI の取得に失敗しました')
      }
    } catch (err) {
      setKpiError(err instanceof Error ? err.message : 'KPI の取得に失敗しました')
    } finally {
      setKpiLoading(false)
    }
  }, [from, to])

  const loadSubscribers = useCallback(async () => {
    setSubsLoading(true)
    setSubsError(null)
    try {
      const params = new URLSearchParams({
        status: subscriberStatus,
        limit: '200',
      })
      const json = await fetchApi<
        ApiResponse<{ subscribers: SubscriberRow[] }>
      >(`/api/admin/email/subscribers?${params.toString()}`)
      if (json.success) {
        setSubscribers(json.data.subscribers || [])
      } else {
        setSubsError(json.error || '購読者の取得に失敗しました')
      }
    } catch (err) {
      setSubsError(
        err instanceof Error ? err.message : '購読者の取得に失敗しました',
      )
    } finally {
      setSubsLoading(false)
    }
  }, [subscriberStatus])

  const loadTemplates = useCallback(async () => {
    setTplLoading(true)
    setTplError(null)
    try {
      const json = await fetchApi<ApiResponse<{ templates: TemplateRow[] }>>(
        '/api/admin/email/templates',
      )
      if (json.success) {
        setTemplates(json.data.templates || [])
      } else {
        setTplError(json.error || 'テンプレートの取得に失敗しました')
      }
    } catch (err) {
      setTplError(
        err instanceof Error
          ? err.message
          : 'テンプレートの取得に失敗しました',
      )
    } finally {
      setTplLoading(false)
    }
  }, [])

  const loadMessages = useCallback(async () => {
    setMsgLoading(true)
    setMsgError(null)
    try {
      const params = new URLSearchParams({ limit: '50' })
      const json = await fetchApi<ApiResponse<{ messages: MessageRow[] }>>(
        `/api/admin/email/messages?${params.toString()}`,
      )
      if (json.success) {
        setMessages(json.data.messages || [])
      } else {
        setMsgError(json.error || '送信履歴の取得に失敗しました')
      }
    } catch (err) {
      setMsgError(
        err instanceof Error ? err.message : '送信履歴の取得に失敗しました',
      )
    } finally {
      setMsgLoading(false)
    }
  }, [])

  useEffect(() => {
    loadKpi()
  }, [loadKpi])

  useEffect(() => {
    loadSubscribers()
  }, [loadSubscribers])

  useEffect(() => {
    loadTemplates()
  }, [loadTemplates])

  useEffect(() => {
    loadMessages()
  }, [loadMessages])

  // ----------------------------------------------------------
  // Subscriber actions
  // ----------------------------------------------------------

  const saveSubscriber = useCallback(async () => {
    if (!newSubscriber) return
    setSavingSub(true)
    setSaveSubError(null)
    try {
      const json = await fetchApi<ApiResponse<unknown>>(
        '/api/admin/email/subscribers',
        {
          method: 'POST',
          body: JSON.stringify({
            email: newSubscriber.email,
            marketingOptIn: newSubscriber.marketingOptIn,
            consentSource: newSubscriber.consentSource || undefined,
          }),
        },
      )
      if (json.success) {
        setNewSubscriber(null)
        await loadSubscribers()
      } else {
        setSaveSubError(json.error || '保存に失敗しました')
      }
    } catch (err) {
      setSaveSubError(err instanceof Error ? err.message : '保存に失敗しました')
    } finally {
      setSavingSub(false)
    }
  }, [newSubscriber, loadSubscribers])

  const toggleSubscriberActive = useCallback(
    async (id: string, isActive: boolean) => {
      try {
        const json = await fetchApi<ApiResponse<unknown>>(
          `/api/admin/email/subscribers/${encodeURIComponent(id)}`,
          {
            method: 'PATCH',
            body: JSON.stringify({ isActive }),
          },
        )
        if (json.success) {
          await loadSubscribers()
        } else {
          alert(json.error || '更新に失敗しました')
        }
      } catch (err) {
        alert(err instanceof Error ? err.message : '更新に失敗しました')
      }
    },
    [loadSubscribers],
  )

  // ----------------------------------------------------------
  // Template actions
  // ----------------------------------------------------------

  const saveTemplate = useCallback(async () => {
    if (!editingTemplate) return
    setSavingTpl(true)
    setSaveTplError(null)
    try {
      const json = await fetchApi<ApiResponse<unknown>>(
        '/api/admin/email/templates',
        {
          method: 'PUT',
          body: JSON.stringify({
            id: editingTemplate.id,
            name: editingTemplate.name,
            category: editingTemplate.category || undefined,
            subject: editingTemplate.subject,
            htmlContent: editingTemplate.htmlContent,
            textContent: editingTemplate.textContent,
            preheader: editingTemplate.preheader || undefined,
            isActive: editingTemplate.isActive,
          }),
        },
      )
      if (json.success) {
        setEditingTemplate(null)
        await loadTemplates()
      } else {
        setSaveTplError(json.error || '保存に失敗しました')
      }
    } catch (err) {
      setSaveTplError(err instanceof Error ? err.message : '保存に失敗しました')
    } finally {
      setSavingTpl(false)
    }
  }, [editingTemplate, loadTemplates])

  const deleteTemplate = useCallback(
    async (id: string, name: string) => {
      if (!confirm(`テンプレート「${name}」を削除しますか?`)) return
      try {
        const json = await fetchApi<ApiResponse<unknown>>(
          `/api/admin/email/templates/${encodeURIComponent(id)}`,
          { method: 'DELETE' },
        )
        if (json.success) {
          await loadTemplates()
        } else {
          alert(json.error || '削除に失敗しました')
        }
      } catch (err) {
        alert(err instanceof Error ? err.message : '削除に失敗しました')
      }
    },
    [loadTemplates],
  )

  // ----------------------------------------------------------
  // Render
  // ----------------------------------------------------------

  return (
    <div className="container mx-auto p-4 max-w-7xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">📧 メール配信</h1>
        <p className="text-sm text-gray-500 mt-1">
          Round 4: メール購読者 / テンプレート / 送信 KPI の運用画面
        </p>
      </div>

      {/* Date range */}
      <div className="card bg-base-100 shadow-sm">
        <div className="card-body p-4">
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className="label py-1">
                <span className="label-text text-xs">開始日</span>
              </label>
              <input
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                className="input input-bordered input-sm"
              />
            </div>
            <div>
              <label className="label py-1">
                <span className="label-text text-xs">終了日</span>
              </label>
              <input
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                className="input input-bordered input-sm"
              />
            </div>
            <button
              onClick={loadKpi}
              disabled={kpiLoading}
              className="btn btn-primary btn-sm"
            >
              {kpiLoading ? '読み込み中...' : '更新'}
            </button>
          </div>
        </div>
      </div>

      {/* KPI section */}
      <section>
        <h2 className="text-lg font-semibold mb-3">KPI (期間内)</h2>
        {kpiError && (
          <div className="alert alert-error text-sm mb-3">
            <span>{kpiError}</span>
          </div>
        )}
        {kpi && (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <KpiCard
                label="送信"
                value={kpi.totals.sent}
                accent="emerald"
              />
              <KpiCard
                label="配信完了"
                value={kpi.totals.delivered}
                accent="green"
                caption={formatPercent(
                  kpi.totals.delivered,
                  kpi.totals.sent,
                )}
              />
              <KpiCard
                label="開封"
                value={kpi.totals.opened}
                accent="blue"
                caption={formatPercent(
                  kpi.totals.opened,
                  kpi.totals.delivered,
                )}
              />
              <KpiCard
                label="クリック"
                value={kpi.totals.clicked}
                accent="purple"
                caption={formatPercent(
                  kpi.totals.clicked,
                  kpi.totals.opened,
                )}
              />
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-3">
              <KpiCard
                label="バウンス"
                value={kpi.totals.bounced}
                accent="red"
                caption={formatPercent(
                  kpi.totals.bounced,
                  kpi.totals.sent,
                )}
              />
              <KpiCard
                label="苦情"
                value={kpi.totals.complained}
                accent="red"
                caption={formatPercent(
                  kpi.totals.complained,
                  kpi.totals.sent,
                )}
              />
              <KpiCard
                label="解除"
                value={kpi.totals.unsubscribed}
                accent="amber"
                caption={formatPercent(
                  kpi.totals.unsubscribed,
                  kpi.totals.delivered,
                )}
              />
              <KpiCard
                label="期間内 登録"
                value={kpi.subscribers.total}
                accent="indigo"
                caption={`配信中 ${kpi.subscribers.active} / 解除 ${kpi.subscribers.inactive}`}
              />
            </div>
          </>
        )}
      </section>

      {/* Category breakdown */}
      {kpi && kpi.byCategory.length > 0 && (
        <section>
          <h2 className="text-lg font-semibold mb-3">カテゴリ別 (期間内)</h2>
          <div className="card bg-base-100 shadow-sm overflow-x-auto">
            <table className="table table-sm">
              <thead>
                <tr>
                  <th>カテゴリ</th>
                  <th className="text-right">送信</th>
                  <th className="text-right">配信完了</th>
                  <th className="text-right">開封</th>
                  <th className="text-right">クリック</th>
                </tr>
              </thead>
              <tbody>
                {kpi.byCategory.map((row) => (
                  <tr key={row.category}>
                    <td>{CATEGORY_LABEL[row.category] ?? row.category}</td>
                    <td className="text-right">{row.sent}</td>
                    <td className="text-right">{row.delivered}</td>
                    <td className="text-right">{row.opened}</td>
                    <td className="text-right">{row.clicked}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Subscribers panel */}
      <section>
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <h2 className="text-lg font-semibold">購読者</h2>
          <div className="flex items-center gap-2">
            <select
              value={subscriberStatus}
              onChange={(e) =>
                setSubscriberStatus(e.target.value as SubscriberStatus)
              }
              className="select select-bordered select-sm"
              aria-label="購読者ステータス"
            >
              {(
                ['all', 'active', 'inactive', 'transactional'] as SubscriberStatus[]
              ).map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </select>
            <button
              onClick={() =>
                setNewSubscriber({
                  email: '',
                  marketingOptIn: true,
                  consentSource: 'manual',
                })
              }
              className="btn btn-primary btn-sm"
            >
              + 手動追加
            </button>
          </div>
        </div>
        {subsError && (
          <div className="alert alert-error text-sm mb-3">
            <span>{subsError}</span>
          </div>
        )}
        <div className="card bg-base-100 shadow-sm overflow-x-auto">
          <table className="table table-sm">
            <thead>
              <tr>
                <th>メール</th>
                <th>友だち</th>
                <th>状態</th>
                <th>同意元</th>
                <th>同意日</th>
                <th className="text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {subsLoading ? (
                <tr>
                  <td colSpan={6} className="text-center py-4">
                    読み込み中...
                  </td>
                </tr>
              ) : subscribers && subscribers.length > 0 ? (
                subscribers.map((s) => (
                  <tr key={s.id}>
                    <td className="max-w-xs truncate">{s.email}</td>
                    <td className="font-mono text-xs">
                      {s.friend_id ? s.friend_id.slice(0, 8) : '-'}
                    </td>
                    <td>
                      {s.is_active === 1 ? (
                        s.transactional_only === 1 ? (
                          <span className="badge badge-info badge-sm">
                            トランザクション
                          </span>
                        ) : (
                          <span className="badge badge-success badge-sm">
                            配信中
                          </span>
                        )
                      ) : (
                        <span className="badge badge-ghost badge-sm">
                          解除済み
                        </span>
                      )}
                    </td>
                    <td className="text-xs">{s.consent_source || '-'}</td>
                    <td className="text-xs">{formatJstDate(s.consent_at)}</td>
                    <td className="text-right">
                      {s.is_active === 1 ? (
                        <button
                          onClick={() => toggleSubscriberActive(s.id, false)}
                          className="btn btn-ghost btn-xs text-error"
                        >
                          解除
                        </button>
                      ) : (
                        <button
                          onClick={() => toggleSubscriberActive(s.id, true)}
                          className="btn btn-ghost btn-xs"
                        >
                          再有効化
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={6} className="text-center py-4 text-gray-400">
                    購読者がいません
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Templates panel */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold">テンプレート</h2>
          <button
            onClick={() =>
              setEditingTemplate({
                name: '',
                category: 'marketing',
                subject: '',
                preheader: '',
                htmlContent: '',
                textContent: '',
                isActive: true,
              })
            }
            className="btn btn-primary btn-sm"
          >
            + テンプレート追加
          </button>
        </div>
        {tplError && (
          <div className="alert alert-error text-sm mb-3">
            <span>{tplError}</span>
          </div>
        )}
        <div className="card bg-base-100 shadow-sm overflow-x-auto">
          <table className="table table-sm">
            <thead>
              <tr>
                <th>名前</th>
                <th>件名</th>
                <th>カテゴリ</th>
                <th>状態</th>
                <th>更新日</th>
                <th className="text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {tplLoading ? (
                <tr>
                  <td colSpan={6} className="text-center py-4">
                    読み込み中...
                  </td>
                </tr>
              ) : templates && templates.length > 0 ? (
                templates.map((t) => (
                  <tr key={t.id}>
                    <td className="max-w-xs truncate">{t.name}</td>
                    <td className="max-w-xs truncate">{t.subject}</td>
                    <td>{CATEGORY_LABEL[t.category] ?? t.category}</td>
                    <td>
                      {t.is_active === 1 ? (
                        <span className="badge badge-success badge-sm">
                          有効
                        </span>
                      ) : (
                        <span className="badge badge-ghost badge-sm">
                          無効
                        </span>
                      )}
                    </td>
                    <td className="text-xs">{formatJstDate(t.updated_at)}</td>
                    <td className="text-right space-x-1">
                      <button
                        onClick={() =>
                          setEditingTemplate({
                            id: t.id,
                            name: t.name,
                            category: t.category,
                            subject: t.subject,
                            preheader: t.preheader || '',
                            htmlContent: t.html_content,
                            textContent: t.text_content,
                            isActive: t.is_active === 1,
                          })
                        }
                        className="btn btn-ghost btn-xs"
                      >
                        編集
                      </button>
                      <button
                        onClick={() => deleteTemplate(t.id, t.name)}
                        className="btn btn-ghost btn-xs text-error"
                      >
                        削除
                      </button>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={6} className="text-center py-4 text-gray-400">
                    テンプレートがありません
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Messages history panel */}
      <section>
        <h2 className="text-lg font-semibold mb-3">送信履歴 (最大 50 件)</h2>
        {msgError && (
          <div className="alert alert-error text-sm mb-3">
            <span>{msgError}</span>
          </div>
        )}
        <div className="card bg-base-100 shadow-sm overflow-x-auto">
          <table className="table table-sm">
            <thead>
              <tr>
                <th>送信先</th>
                <th>件名</th>
                <th>カテゴリ</th>
                <th>状態</th>
                <th className="text-right">開封</th>
                <th className="text-right">クリック</th>
                <th>送信日時</th>
              </tr>
            </thead>
            <tbody>
              {msgLoading ? (
                <tr>
                  <td colSpan={7} className="text-center py-4">
                    読み込み中...
                  </td>
                </tr>
              ) : messages && messages.length > 0 ? (
                messages.map((m) => (
                  <tr key={m.id}>
                    <td className="max-w-xs truncate">{m.email || '-'}</td>
                    <td className="max-w-xs truncate">{m.subject}</td>
                    <td>{CATEGORY_LABEL[m.category] ?? m.category}</td>
                    <td>
                      <span className={statusBadgeClass(m.status)}>
                        {m.status}
                      </span>
                    </td>
                    <td className="text-right">{m.openCount}</td>
                    <td className="text-right">{m.clickCount}</td>
                    <td className="text-xs">{formatJstDateTime(m.createdAt)}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={7} className="text-center py-4 text-gray-400">
                    送信履歴がありません
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* New subscriber modal */}
      {newSubscriber && (
        <div className="modal modal-open">
          <div className="modal-box">
            <h3 className="font-bold text-lg mb-4">購読者を手動追加</h3>
            {saveSubError && (
              <div className="alert alert-error text-sm mb-3">
                <span>{saveSubError}</span>
              </div>
            )}
            <div className="space-y-3">
              <div>
                <label className="label py-1">
                  <span className="label-text text-xs">メールアドレス *</span>
                </label>
                <input
                  type="email"
                  value={newSubscriber.email}
                  onChange={(e) =>
                    setNewSubscriber({
                      ...newSubscriber,
                      email: e.target.value,
                    })
                  }
                  placeholder="user@example.com"
                  className="input input-bordered w-full"
                />
              </div>
              <div>
                <label className="label py-1">
                  <span className="label-text text-xs">同意元 (任意)</span>
                </label>
                <input
                  type="text"
                  value={newSubscriber.consentSource}
                  onChange={(e) =>
                    setNewSubscriber({
                      ...newSubscriber,
                      consentSource: e.target.value,
                    })
                  }
                  placeholder="manual / form / shopify など"
                  className="input input-bordered w-full"
                />
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={newSubscriber.marketingOptIn}
                  onChange={(e) =>
                    setNewSubscriber({
                      ...newSubscriber,
                      marketingOptIn: e.target.checked,
                    })
                  }
                  className="checkbox checkbox-sm"
                />
                マーケティングメールを受け取る
              </label>
            </div>
            <div className="modal-action">
              <button
                onClick={() => setNewSubscriber(null)}
                className="btn btn-ghost"
              >
                キャンセル
              </button>
              <button
                onClick={saveSubscriber}
                disabled={savingSub || !newSubscriber.email.trim()}
                className="btn btn-primary"
              >
                {savingSub ? '保存中...' : '保存'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Template edit modal */}
      {editingTemplate && (
        <div className="modal modal-open">
          <div className="modal-box max-w-3xl">
            <h3 className="font-bold text-lg mb-4">
              {editingTemplate.id ? 'テンプレート編集' : 'テンプレート追加'}
            </h3>
            {saveTplError && (
              <div className="alert alert-error text-sm mb-3">
                <span>{saveTplError}</span>
              </div>
            )}
            <div className="space-y-3">
              <div className="flex gap-3 flex-wrap">
                <div className="flex-1 min-w-[200px]">
                  <label className="label py-1">
                    <span className="label-text text-xs">名前 *</span>
                  </label>
                  <input
                    type="text"
                    value={editingTemplate.name}
                    onChange={(e) =>
                      setEditingTemplate({
                        ...editingTemplate,
                        name: e.target.value,
                      })
                    }
                    className="input input-bordered w-full"
                  />
                </div>
                <div className="flex-1 min-w-[160px]">
                  <label className="label py-1">
                    <span className="label-text text-xs">カテゴリ</span>
                  </label>
                  <select
                    value={editingTemplate.category}
                    onChange={(e) =>
                      setEditingTemplate({
                        ...editingTemplate,
                        category: e.target.value,
                      })
                    }
                    className="select select-bordered w-full"
                  >
                    <option value="marketing">マーケ</option>
                    <option value="transactional">トランザクション</option>
                    <option value="general">汎用</option>
                  </select>
                </div>
                <div className="min-w-[120px]">
                  <label className="label py-1">
                    <span className="label-text text-xs">状態</span>
                  </label>
                  <select
                    value={editingTemplate.isActive ? 'on' : 'off'}
                    onChange={(e) =>
                      setEditingTemplate({
                        ...editingTemplate,
                        isActive: e.target.value === 'on',
                      })
                    }
                    className="select select-bordered w-full"
                  >
                    <option value="on">有効</option>
                    <option value="off">無効</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="label py-1">
                  <span className="label-text text-xs">件名 *</span>
                </label>
                <input
                  type="text"
                  value={editingTemplate.subject}
                  onChange={(e) =>
                    setEditingTemplate({
                      ...editingTemplate,
                      subject: e.target.value,
                    })
                  }
                  className="input input-bordered w-full"
                />
              </div>
              <div>
                <label className="label py-1">
                  <span className="label-text text-xs">プリヘッダー (任意)</span>
                </label>
                <input
                  type="text"
                  value={editingTemplate.preheader}
                  onChange={(e) =>
                    setEditingTemplate({
                      ...editingTemplate,
                      preheader: e.target.value,
                    })
                  }
                  placeholder="メール一覧で件名の隣に表示される短い説明"
                  className="input input-bordered w-full"
                />
              </div>
              <div>
                <label className="label py-1">
                  <span className="label-text text-xs">HTML 本文 *</span>
                </label>
                <textarea
                  value={editingTemplate.htmlContent}
                  onChange={(e) =>
                    setEditingTemplate({
                      ...editingTemplate,
                      htmlContent: e.target.value,
                    })
                  }
                  rows={8}
                  className="textarea textarea-bordered w-full font-mono text-xs"
                />
                <p className="text-[10px] text-gray-400 mt-1">
                  プレビューはセキュリティ上、画面に直接描画しません。最初の 500
                  文字のみ確認できます。
                </p>
              </div>
              <div>
                <label className="label py-1">
                  <span className="label-text text-xs">プレーンテキスト *</span>
                </label>
                <textarea
                  value={editingTemplate.textContent}
                  onChange={(e) =>
                    setEditingTemplate({
                      ...editingTemplate,
                      textContent: e.target.value,
                    })
                  }
                  rows={4}
                  className="textarea textarea-bordered w-full font-mono text-xs"
                />
              </div>
              {editingTemplate.htmlContent && (
                <details className="text-xs">
                  <summary className="cursor-pointer text-gray-500">
                    HTML プレビュー (先頭 500 文字)
                  </summary>
                  <pre className="mt-2 p-2 bg-base-200 rounded text-[10px] whitespace-pre-wrap break-all">
                    {editingTemplate.htmlContent.slice(0, 500)}
                  </pre>
                </details>
              )}
            </div>
            <div className="modal-action">
              <button
                onClick={() => setEditingTemplate(null)}
                className="btn btn-ghost"
              >
                キャンセル
              </button>
              <button
                onClick={saveTemplate}
                disabled={
                  savingTpl ||
                  !editingTemplate.name.trim() ||
                  !editingTemplate.subject.trim() ||
                  !editingTemplate.htmlContent.trim() ||
                  !editingTemplate.textContent.trim()
                }
                className="btn btn-primary"
              >
                {savingTpl ? '保存中...' : '保存'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ============================================================
// KPI card
// ============================================================

interface KpiCardProps {
  label: string
  value: number
  accent: 'emerald' | 'green' | 'blue' | 'purple' | 'red' | 'amber' | 'indigo'
  caption?: string
}

function KpiCard({ label, value, accent, caption }: KpiCardProps) {
  const accentClass: Record<KpiCardProps['accent'], string> = {
    emerald: 'border-l-4 border-emerald-500',
    green: 'border-l-4 border-green-500',
    blue: 'border-l-4 border-blue-500',
    purple: 'border-l-4 border-purple-500',
    red: 'border-l-4 border-red-500',
    amber: 'border-l-4 border-amber-500',
    indigo: 'border-l-4 border-indigo-500',
  }
  return (
    <div className={`card bg-base-100 shadow-sm ${accentClass[accent]}`}>
      <div className="card-body p-4">
        <div className="text-xs text-gray-500">{label}</div>
        <div className="text-2xl font-bold">{value.toLocaleString()}</div>
        {caption && (
          <div className="text-[10px] text-gray-400">{caption}</div>
        )}
      </div>
    </div>
  )
}
