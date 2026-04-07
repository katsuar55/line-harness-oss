'use client'

import { useState, useEffect, useCallback } from 'react'
import { fetchApi } from '@/lib/api'
import Header from '@/components/layout/header'

interface Ambassador {
  id: string
  friend_id: string
  display_name: string | null
  picture_url: string | null
  status: string
  tier: string
  enrolled_at: string | null
  total_surveys_completed: number
  total_product_tests: number
  feedback_score: number | null
  preferences: { survey_ok?: boolean; product_test_ok?: boolean; sns_share_ok?: boolean }
  note: string | null
  created_at: string
}

interface Stats {
  total: number
  active: number
  avgSurveys: number
  avgFeedbackScore: number | null
}

const TIER_COLORS: Record<string, string> = {
  bronze: 'bg-amber-100 text-amber-800',
  silver: 'bg-gray-100 text-gray-700',
  gold: 'bg-yellow-100 text-yellow-800',
  platinum: 'bg-purple-100 text-purple-800',
}

const STATUS_COLORS: Record<string, string> = {
  active: 'bg-green-100 text-green-700',
  inactive: 'bg-gray-100 text-gray-500',
  suspended: 'bg-red-100 text-red-700',
}

export default function AmbassadorsPage() {
  const [ambassadors, setAmbassadors] = useState<Ambassador[]>([])
  const [stats, setStats] = useState<Stats | null>(null)
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [statusFilter, setStatusFilter] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState({ status: '', tier: '', note: '' })
  const LIMIT = 20

  const loadData = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const query = new URLSearchParams({ limit: String(LIMIT), offset: String(offset) })
      if (statusFilter) query.set('status', statusFilter)

      const [listRes, statsRes] = await Promise.all([
        fetchApi<{ success: boolean; data: { ambassadors: Ambassador[]; total: number } }>('/api/ambassadors?' + query),
        fetchApi<{ success: boolean; data: Stats }>('/api/ambassadors/stats'),
      ])

      if (listRes.success && listRes.data) {
        setAmbassadors(listRes.data.ambassadors)
        setTotal(listRes.data.total)
      }
      if (statsRes.success && statsRes.data) {
        setStats(statsRes.data)
      }
    } catch {
      setError('データの読み込みに失敗しました')
    } finally {
      setLoading(false)
    }
  }, [offset, statusFilter])

  useEffect(() => { loadData() }, [loadData])

  function openEdit(a: Ambassador) {
    setEditingId(a.id)
    setEditForm({ status: a.status, tier: a.tier, note: a.note || '' })
  }

  async function handleUpdate() {
    if (!editingId) return
    try {
      await fetchApi(`/api/ambassadors/${editingId}`, {
        method: 'PUT',
        body: JSON.stringify(editForm),
      })
      setEditingId(null)
      await loadData()
    } catch {
      setError('更新に失敗しました')
    }
  }

  const totalPages = Math.ceil(total / LIMIT)
  const currentPage = Math.floor(offset / LIMIT) + 1

  return (
    <div className="min-h-screen bg-gray-50">
      <Header />
      <main className="max-w-6xl mx-auto px-4 py-6">
        <h1 className="text-2xl font-bold text-gray-900 mb-6">アンバサダー管理</h1>

        {/* Stats Cards */}
        {stats && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
            <div className="bg-white rounded-xl p-4 shadow-sm">
              <p className="text-xs text-gray-500">合計</p>
              <p className="text-2xl font-bold text-gray-800">{stats.total}</p>
            </div>
            <div className="bg-white rounded-xl p-4 shadow-sm">
              <p className="text-xs text-gray-500">アクティブ</p>
              <p className="text-2xl font-bold text-green-600">{stats.active}</p>
            </div>
            <div className="bg-white rounded-xl p-4 shadow-sm">
              <p className="text-xs text-gray-500">平均アンケート</p>
              <p className="text-2xl font-bold text-gray-800">{stats.avgSurveys}</p>
            </div>
            <div className="bg-white rounded-xl p-4 shadow-sm">
              <p className="text-xs text-gray-500">平均フィードバック</p>
              <p className="text-2xl font-bold text-gray-800">{stats.avgFeedbackScore ?? '-'}</p>
            </div>
          </div>
        )}

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg mb-4 text-sm">
            {error}
            <button onClick={() => setError('')} className="float-right text-red-500 font-bold">&times;</button>
          </div>
        )}

        {/* Filters */}
        <div className="flex gap-2 mb-4">
          {['', 'active', 'inactive', 'suspended'].map((s) => (
            <button
              key={s}
              onClick={() => { setStatusFilter(s); setOffset(0) }}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                statusFilter === s ? 'bg-green-600 text-white' : 'bg-white border text-gray-600 hover:bg-gray-50'
              }`}
            >
              {s === '' ? '全て' : s}
            </button>
          ))}
        </div>

        {/* Edit Modal */}
        {editingId && (
          <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4">
            <div className="bg-white rounded-xl max-w-md w-full p-6">
              <h2 className="text-lg font-bold mb-4">アンバサダー編集</h2>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">ステータス</label>
                  <select
                    value={editForm.status}
                    onChange={(e) => setEditForm({ ...editForm, status: e.target.value })}
                    className="w-full border rounded-lg px-3 py-2 text-sm"
                  >
                    <option value="active">active</option>
                    <option value="inactive">inactive</option>
                    <option value="suspended">suspended</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">ティア</label>
                  <select
                    value={editForm.tier}
                    onChange={(e) => setEditForm({ ...editForm, tier: e.target.value })}
                    className="w-full border rounded-lg px-3 py-2 text-sm"
                  >
                    <option value="bronze">Bronze</option>
                    <option value="silver">Silver</option>
                    <option value="gold">Gold</option>
                    <option value="platinum">Platinum</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">メモ</label>
                  <textarea
                    value={editForm.note}
                    onChange={(e) => setEditForm({ ...editForm, note: e.target.value })}
                    maxLength={500}
                    rows={3}
                    className="w-full border rounded-lg px-3 py-2 text-sm"
                  />
                </div>
                <div className="flex gap-3">
                  <button onClick={handleUpdate} className="flex-1 bg-green-600 text-white py-2 rounded-lg text-sm font-medium">更新</button>
                  <button onClick={() => setEditingId(null)} className="flex-1 border py-2 rounded-lg text-sm text-gray-600">キャンセル</button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Table */}
        {loading ? (
          <div className="text-center py-12 text-gray-400">読み込み中...</div>
        ) : ambassadors.length === 0 ? (
          <div className="text-center py-12 text-gray-400">アンバサダーはまだいません</div>
        ) : (
          <>
            <div className="bg-white rounded-xl shadow-sm overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b">
                  <tr>
                    <th className="text-left px-4 py-3 font-medium text-gray-600">ユーザー</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-600">ステータス</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-600">ティア</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-600 hidden md:table-cell">アンケート</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-600 hidden md:table-cell">登録日</th>
                    <th className="text-right px-4 py-3 font-medium text-gray-600">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {ambassadors.map((a) => (
                    <tr key={a.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          {a.picture_url ? (
                            <img src={a.picture_url} className="w-8 h-8 rounded-full" alt="" />
                          ) : (
                            <div className="w-8 h-8 rounded-full bg-gray-200 flex items-center justify-center text-xs text-gray-500">?</div>
                          )}
                          <span className="font-medium text-gray-800">{a.display_name || '(名前なし)'}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_COLORS[a.status] || 'bg-gray-100'}`}>
                          {a.status}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`text-xs px-2 py-0.5 rounded-full ${TIER_COLORS[a.tier] || 'bg-gray-100'}`}>
                          {a.tier}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-gray-600 hidden md:table-cell">{a.total_surveys_completed}</td>
                      <td className="px-4 py-3 text-gray-500 hidden md:table-cell">{a.enrolled_at?.slice(0, 10) || '-'}</td>
                      <td className="px-4 py-3 text-right">
                        <button onClick={() => openEdit(a)} className="text-blue-600 hover:underline text-xs">編集</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {totalPages > 1 && (
              <div className="flex items-center justify-between mt-4 text-sm text-gray-500">
                <p>{currentPage} / {totalPages} ページ</p>
                <div className="flex gap-2">
                  <button onClick={() => setOffset(Math.max(0, offset - LIMIT))} disabled={offset === 0} className="px-3 py-1 border rounded-lg disabled:opacity-30">前へ</button>
                  <button onClick={() => setOffset(offset + LIMIT)} disabled={offset + LIMIT >= total} className="px-3 py-1 border rounded-lg disabled:opacity-30">次へ</button>
                </div>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  )
}
