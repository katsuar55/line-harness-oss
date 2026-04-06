'use client'

import { useState, useEffect, useCallback } from 'react'
import { api } from '@/lib/api'
import Header from '@/components/layout/header'

interface DailyTip {
  id: string
  tip_date: string
  category: string
  title: string
  content: string
  image_url: string | null
  source: string
  created_at: string
}

interface FormState {
  tipDate: string
  category: string
  title: string
  content: string
  imageUrl: string
}

const CATEGORIES = [
  { value: 'health', label: '健康' },
  { value: 'nutrition', label: '栄養' },
  { value: 'exercise', label: '運動' },
  { value: 'sleep', label: '睡眠' },
  { value: 'beauty', label: '美容' },
  { value: 'lifestyle', label: 'ライフスタイル' },
  { value: 'product', label: '商品紹介' },
]

const defaultForm: FormState = {
  tipDate: new Date().toISOString().slice(0, 10),
  category: 'health',
  title: '',
  content: '',
  imageUrl: '',
}

export default function TipsPage() {
  const [tips, setTips] = useState<DailyTip[]>([])
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<FormState>(defaultForm)
  const [submitting, setSubmitting] = useState(false)
  const LIMIT = 20

  const loadTips = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await api.tips.list({ limit: LIMIT, offset })
      if (res.success && res.data) {
        setTips(res.data.tips as DailyTip[])
        setTotal(res.data.total)
      }
    } catch (err) {
      setError('Tips の読み込みに失敗しました')
    } finally {
      setLoading(false)
    }
  }, [offset])

  useEffect(() => {
    loadTips()
  }, [loadTips])

  function openCreate() {
    setForm(defaultForm)
    setEditingId(null)
    setShowForm(true)
  }

  function openEdit(tip: DailyTip) {
    setForm({
      tipDate: tip.tip_date,
      category: tip.category,
      title: tip.title,
      content: tip.content,
      imageUrl: tip.image_url || '',
    })
    setEditingId(tip.id)
    setShowForm(true)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.title.trim() || !form.content.trim()) {
      setError('タイトルと本文は必須です')
      return
    }

    setSubmitting(true)
    setError('')
    try {
      if (editingId) {
        await api.tips.update(editingId, {
          category: form.category,
          title: form.title,
          content: form.content,
          imageUrl: form.imageUrl || undefined,
        })
      } else {
        await api.tips.create({
          tipDate: form.tipDate,
          category: form.category,
          title: form.title,
          content: form.content,
          imageUrl: form.imageUrl || undefined,
        })
      }
      setShowForm(false)
      setEditingId(null)
      await loadTips()
    } catch (err) {
      setError(editingId ? '更新に失敗しました' : '作成に失敗しました')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('このTipを削除しますか？')) return
    try {
      await api.tips.delete(id)
      await loadTips()
    } catch {
      setError('削除に失敗しました')
    }
  }

  const categoryLabel = (value: string) =>
    CATEGORIES.find((c) => c.value === value)?.label || value

  const totalPages = Math.ceil(total / LIMIT)
  const currentPage = Math.floor(offset / LIMIT) + 1

  return (
    <div className="min-h-screen bg-gray-50">
      <Header />
      <main className="max-w-5xl mx-auto px-4 py-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">日替わり Tips 管理</h1>
            <p className="text-sm text-gray-500 mt-1">
              合計 {total} 件のTip
            </p>
          </div>
          <button
            onClick={openCreate}
            className="bg-green-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-green-700 transition-colors"
          >
            + 新規作成
          </button>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg mb-4 text-sm">
            {error}
            <button onClick={() => setError('')} className="float-right text-red-500 font-bold">&times;</button>
          </div>
        )}

        {/* Create/Edit Modal */}
        {showForm && (
          <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4">
            <div className="bg-white rounded-xl max-w-lg w-full p-6 max-h-[90vh] overflow-y-auto">
              <h2 className="text-lg font-bold mb-4">
                {editingId ? 'Tip を編集' : '新しい Tip を作成'}
              </h2>
              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">日付</label>
                  <input
                    type="date"
                    value={form.tipDate}
                    onChange={(e) => setForm({ ...form, tipDate: e.target.value })}
                    disabled={!!editingId}
                    className="w-full border rounded-lg px-3 py-2 text-sm disabled:bg-gray-100"
                    required
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">カテゴリ</label>
                  <select
                    value={form.category}
                    onChange={(e) => setForm({ ...form, category: e.target.value })}
                    className="w-full border rounded-lg px-3 py-2 text-sm"
                  >
                    {CATEGORIES.map((cat) => (
                      <option key={cat.value} value={cat.value}>{cat.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">タイトル</label>
                  <input
                    type="text"
                    value={form.title}
                    onChange={(e) => setForm({ ...form, title: e.target.value })}
                    maxLength={200}
                    className="w-full border rounded-lg px-3 py-2 text-sm"
                    placeholder="例: 水分補給のコツ"
                    required
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">本文</label>
                  <textarea
                    value={form.content}
                    onChange={(e) => setForm({ ...form, content: e.target.value })}
                    maxLength={2000}
                    rows={4}
                    className="w-full border rounded-lg px-3 py-2 text-sm"
                    placeholder="Tipの内容を入力..."
                    required
                  />
                  <p className="text-xs text-gray-400 mt-1">{form.content.length} / 2000</p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">画像URL（任意）</label>
                  <input
                    type="url"
                    value={form.imageUrl}
                    onChange={(e) => setForm({ ...form, imageUrl: e.target.value })}
                    className="w-full border rounded-lg px-3 py-2 text-sm"
                    placeholder="https://..."
                  />
                </div>
                <div className="flex gap-3 pt-2">
                  <button
                    type="submit"
                    disabled={submitting}
                    className="flex-1 bg-green-600 text-white py-2 rounded-lg text-sm font-medium hover:bg-green-700 disabled:opacity-50"
                  >
                    {submitting ? '保存中...' : editingId ? '更新' : '作成'}
                  </button>
                  <button
                    type="button"
                    onClick={() => { setShowForm(false); setEditingId(null) }}
                    className="flex-1 border border-gray-300 py-2 rounded-lg text-sm font-medium text-gray-600 hover:bg-gray-50"
                  >
                    キャンセル
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* Tips List */}
        {loading ? (
          <div className="text-center py-12 text-gray-400">読み込み中...</div>
        ) : tips.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-gray-400 mb-3">Tip がまだありません</p>
            <button
              onClick={openCreate}
              className="text-green-600 font-medium text-sm hover:underline"
            >
              最初のTipを作成する
            </button>
          </div>
        ) : (
          <>
            <div className="bg-white rounded-xl shadow-sm overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b">
                  <tr>
                    <th className="text-left px-4 py-3 font-medium text-gray-600">日付</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-600">カテゴリ</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-600">タイトル</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-600 hidden md:table-cell">本文</th>
                    <th className="text-right px-4 py-3 font-medium text-gray-600">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {tips.map((tip) => (
                    <tr key={tip.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3 text-gray-700 whitespace-nowrap">{tip.tip_date}</td>
                      <td className="px-4 py-3">
                        <span className="inline-block bg-green-50 text-green-700 text-xs px-2 py-0.5 rounded-full">
                          {categoryLabel(tip.category)}
                        </span>
                      </td>
                      <td className="px-4 py-3 font-medium text-gray-800 max-w-[200px] truncate">
                        {tip.title}
                      </td>
                      <td className="px-4 py-3 text-gray-500 max-w-[300px] truncate hidden md:table-cell">
                        {tip.content}
                      </td>
                      <td className="px-4 py-3 text-right whitespace-nowrap">
                        <button
                          onClick={() => openEdit(tip)}
                          className="text-blue-600 hover:underline text-xs mr-3"
                        >
                          編集
                        </button>
                        <button
                          onClick={() => handleDelete(tip.id)}
                          className="text-red-500 hover:underline text-xs"
                        >
                          削除
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="flex items-center justify-between mt-4 text-sm text-gray-500">
                <p>{currentPage} / {totalPages} ページ</p>
                <div className="flex gap-2">
                  <button
                    onClick={() => setOffset(Math.max(0, offset - LIMIT))}
                    disabled={offset === 0}
                    className="px-3 py-1 border rounded-lg disabled:opacity-30 hover:bg-gray-50"
                  >
                    前へ
                  </button>
                  <button
                    onClick={() => setOffset(offset + LIMIT)}
                    disabled={offset + LIMIT >= total}
                    className="px-3 py-1 border rounded-lg disabled:opacity-30 hover:bg-gray-50"
                  >
                    次へ
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  )
}
