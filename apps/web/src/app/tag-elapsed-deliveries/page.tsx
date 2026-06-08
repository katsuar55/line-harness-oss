'use client'

import { useState, useEffect, useCallback } from 'react'
import { api } from '@/lib/api'
import Header from '@/components/layout/header'
import CcPromptButton from '@/components/cc-prompt-button'

interface TagOption {
  id: string
  name: string
  color: string
}

interface Rule {
  id: string
  name: string
  trigger_tag_id: string
  tag_name: string | null
  elapsed_days: number
  message_type: string
  message_content: string
  send_hour: number
  is_active: number
  sent_count: number
  created_at: string
  updated_at: string
}

interface CreateFormState {
  name: string
  triggerTagId: string
  elapsedDays: number
  sendHour: number
  messageContent: string
}

const initialForm: CreateFormState = {
  name: '',
  triggerTagId: '',
  elapsedDays: 3,
  sendHour: 10,
  messageContent: '',
}

const ccPrompts = [
  {
    title: '販促配信シナリオ提案',
    prompt: `naturism (インナーケアサプリ) の「タグ付与からN日後」の販促配信を設計してください。
1. 「初回購入」タグから3日後・7日後・30日後のフォロー文面案
2. リピート促進に効くトリガータグと経過日数の組み合わせ
3. 薬機法に配慮した訴求 (効能効果の断定なし)
案を複数提示してください。`,
  },
]

export default function TagElapsedDeliveriesPage() {
  const [rules, setRules] = useState<Rule[]>([])
  const [tags, setTags] = useState<TagOption[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [form, setForm] = useState<CreateFormState>({ ...initialForm })
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [rulesRes, tagsRes] = await Promise.all([
        api.tagElapsedDeliveries.list(),
        api.tags.list(),
      ])
      if (rulesRes.success) setRules(rulesRes.data)
      else setError(rulesRes.error)
      if (tagsRes.success) setTags(tagsRes.data as unknown as TagOption[])
    } catch {
      setError('販促配信ルールの読み込みに失敗しました。もう一度お試しください。')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const handleCreate = async () => {
    if (!form.name.trim()) {
      setFormError('ルール名を入力してください')
      return
    }
    if (!form.triggerTagId) {
      setFormError('トリガーとなるタグを選択してください')
      return
    }
    if (!form.messageContent.trim()) {
      setFormError('配信メッセージを入力してください')
      return
    }
    if (!Number.isFinite(form.elapsedDays) || form.elapsedDays < 1) {
      setFormError('経過日数は1以上で指定してください')
      return
    }
    setSaving(true)
    setFormError('')
    try {
      const res = await api.tagElapsedDeliveries.create({
        name: form.name.trim(),
        triggerTagId: form.triggerTagId,
        elapsedDays: form.elapsedDays,
        messageContent: form.messageContent,
        sendHour: form.sendHour,
      })
      if (res.success) {
        setShowCreate(false)
        setForm({ ...initialForm })
        load()
      } else {
        setFormError(res.error)
      }
    } catch {
      setFormError('作成に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  const handleToggleActive = async (id: string, current: number) => {
    try {
      await api.tagElapsedDeliveries.update(id, { isActive: !current })
      load()
    } catch {
      setError('ステータスの変更に失敗しました')
    }
  }

  const handleDelete = async (id: string) => {
    if (!confirm('この販促配信ルールを削除してもよいですか？')) return
    try {
      await api.tagElapsedDeliveries.delete(id)
      load()
    } catch {
      setError('削除に失敗しました')
    }
  }

  return (
    <div>
      <Header
        title="販促配信"
        action={
          <button
            onClick={() => setShowCreate(true)}
            className="px-4 py-2 min-h-[44px] text-sm font-medium text-white rounded-lg transition-opacity hover:opacity-90"
            style={{ backgroundColor: '#06C755' }}
          >
            + 新規ルール
          </button>
        }
      />

      <p className="mb-4 text-sm text-gray-500">
        タグが付与されてから指定日数が経過した友だちに、指定時刻に自動でメッセージを配信します（例: 「初回購入」タグの3日後にフォロー）。
      </p>

      {error && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>
      )}

      {showCreate && (
        <div className="mb-6 bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <h2 className="text-sm font-semibold text-gray-800 mb-4">新規 販促配信ルール</h2>
          {tags.length === 0 && (
            <p className="mb-3 text-xs text-amber-600">
              タグが未登録です。先に友だち管理でタグを作成してください。
            </p>
          )}
          <div className="space-y-4 max-w-lg">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">
                ルール名 <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                placeholder="例: 初回購入3日後フォロー"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">
                トリガータグ <span className="text-red-500">*</span>
              </label>
              <select
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 bg-white"
                value={form.triggerTagId}
                onChange={(e) => setForm({ ...form, triggerTagId: e.target.value })}
              >
                <option value="">タグを選択...</option>
                {tags.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </div>
            <div className="flex gap-3">
              <div className="flex-1">
                <label className="block text-xs font-medium text-gray-600 mb-1">経過日数</label>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={1}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                    value={form.elapsedDays}
                    onChange={(e) => setForm({ ...form, elapsedDays: parseInt(e.target.value, 10) || 0 })}
                  />
                  <span className="text-sm text-gray-500 whitespace-nowrap">日後</span>
                </div>
              </div>
              <div className="flex-1">
                <label className="block text-xs font-medium text-gray-600 mb-1">配信時刻</label>
                <div className="flex items-center gap-2">
                  <select
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 bg-white"
                    value={form.sendHour}
                    onChange={(e) => setForm({ ...form, sendHour: parseInt(e.target.value, 10) || 0 })}
                  >
                    {Array.from({ length: 24 }, (_, h) => (
                      <option key={h} value={h}>{h}時</option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">
                配信メッセージ <span className="text-red-500">*</span>
              </label>
              <textarea
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 resize-y"
                rows={4}
                placeholder="例: ご購入から3日が経ちました。お身体の調子はいかがですか？"
                value={form.messageContent}
                onChange={(e) => setForm({ ...form, messageContent: e.target.value })}
              />
              <p className="mt-1 text-[11px] text-gray-400">
                {'{{name}}'} で友だちの表示名に置換されます。薬機法に配慮し効能効果の断定は避けてください。
              </p>
            </div>

            {formError && <p className="text-xs text-red-600">{formError}</p>}

            <div className="flex gap-2">
              <button
                onClick={handleCreate}
                disabled={saving}
                className="px-4 py-2 min-h-[44px] text-sm font-medium text-white rounded-lg disabled:opacity-50 transition-opacity"
                style={{ backgroundColor: '#06C755' }}
              >
                {saving ? '作成中...' : '作成'}
              </button>
              <button
                onClick={() => { setShowCreate(false); setFormError('') }}
                className="px-4 py-2 min-h-[44px] text-sm font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
              >
                キャンセル
              </button>
            </div>
          </div>
        </div>
      )}

      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="bg-white rounded-lg border border-gray-200 p-5 animate-pulse space-y-3">
              <div className="h-4 bg-gray-200 rounded w-3/4" />
              <div className="h-3 bg-gray-100 rounded w-full" />
              <div className="h-3 bg-gray-100 rounded w-24" />
            </div>
          ))}
        </div>
      ) : rules.length === 0 && !showCreate ? (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-12 text-center">
          <p className="text-gray-500">販促配信ルールがありません。「新規ルール」から作成してください。</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {rules.map((rule) => (
            <div key={rule.id} className="bg-white rounded-lg shadow-sm border border-gray-200 p-5 hover:shadow-md transition-shadow">
              <div className="flex items-start justify-between mb-2">
                <h3 className="text-sm font-semibold text-gray-900 leading-tight">{rule.name}</h3>
                <button
                  onClick={() => handleToggleActive(rule.id, rule.is_active)}
                  className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                    rule.is_active ? 'bg-green-500' : 'bg-gray-300'
                  }`}
                  title={rule.is_active ? '有効 - クリックで無効化' : '無効 - クリックで有効化'}
                >
                  <span
                    className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                      rule.is_active ? 'translate-x-4' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>

              <div className="flex flex-wrap items-center gap-2 mb-3">
                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-700">
                  🏷 {rule.tag_name ?? '(削除済みタグ)'}
                </span>
                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-indigo-100 text-indigo-700">
                  {rule.elapsed_days}日後 / {rule.send_hour}時
                </span>
                <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                  rule.is_active ? 'bg-green-50 text-green-700' : 'bg-gray-100 text-gray-500'
                }`}>
                  {rule.is_active ? '有効' : '無効'}
                </span>
              </div>

              <p className="text-xs text-gray-600 mb-3 line-clamp-3 whitespace-pre-wrap">{rule.message_content}</p>

              <div className="flex items-center justify-between gap-2 pt-2 border-t border-gray-100">
                <span className="text-xs text-gray-400">配信実績: {rule.sent_count}件</span>
                <button
                  onClick={() => handleDelete(rule.id)}
                  className="px-3 py-1 min-h-[44px] text-xs font-medium text-red-500 hover:text-red-700 bg-red-50 hover:bg-red-100 rounded-md transition-colors"
                >
                  削除
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      <CcPromptButton prompts={ccPrompts} />
    </div>
  )
}
