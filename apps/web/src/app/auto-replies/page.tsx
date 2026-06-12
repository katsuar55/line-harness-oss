'use client'

/**
 * 自動応答 (auto_replies) 管理画面 — AIネイティブ A案 MVP
 *
 * キーワード自動応答ルールの一覧 / 手動作成 / 有効切替 / 削除。
 * AI Conductor (/conductor?tab=auto-reply) で自然言語から起草 → 保存する導線が本線で、
 * 本ページは保存済みルールの管理 + 細かい手動調整を担う。
 */

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { api, type AutoReply } from '@/lib/api'
import Header from '@/components/layout/header'

type MatchType = 'exact' | 'contains'

const matchTypeOptions: { value: MatchType; label: string }[] = [
  { value: 'contains', label: '部分一致' },
  { value: 'exact', label: '完全一致' },
]

const matchTypeLabelMap: Record<MatchType, string> = {
  exact: '完全一致',
  contains: '部分一致',
}

const matchTypeBadgeColor: Record<MatchType, string> = {
  exact: 'bg-purple-100 text-purple-700',
  contains: 'bg-blue-100 text-blue-700',
}

/** キーワードの最大長 (worker 側バリデーションと揃える) */
const KEYWORD_MAX = 40
/** 返信文の最大長 (worker 側バリデーションと揃える) */
const RESPONSE_MAX = 2000

interface CreateFormState {
  keyword: string
  matchType: MatchType
  responseContent: string
}

const initialForm: CreateFormState = {
  keyword: '',
  matchType: 'contains',
  responseContent: '',
}

export default function AutoRepliesPage() {
  const [autoReplies, setAutoReplies] = useState<AutoReply[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [form, setForm] = useState<CreateFormState>({ ...initialForm })
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState('')
  // 作成 response の server 警告 (薬機 redact 等) — フォームは閉じるためページレベルで表示
  const [createWarnings, setCreateWarnings] = useState<string[]>([])

  const loadAutoReplies = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await api.autoReplies.list()
      if (res.success) {
        setAutoReplies(res.data)
      } else {
        setError(res.error)
      }
    } catch {
      setError('自動応答の読み込みに失敗しました。もう一度お試しください。')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadAutoReplies()
  }, [loadAutoReplies])

  const handleCreate = async () => {
    if (!form.keyword.trim()) {
      setFormError('キーワードを入力してください')
      return
    }
    if (!form.responseContent.trim()) {
      setFormError('返信文を入力してください')
      return
    }

    setSaving(true)
    setFormError('')
    try {
      const res = await api.autoReplies.create({
        keyword: form.keyword.trim(),
        matchType: form.matchType,
        responseContent: form.responseContent.trim(),
      })
      if (res.success) {
        setShowCreate(false)
        setForm({ ...initialForm })
        setCreateWarnings(res.warnings ?? [])
        loadAutoReplies()
      } else {
        setFormError(res.error)
      }
    } catch {
      setFormError('作成に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  const handleToggleActive = async (id: string, current: boolean) => {
    try {
      await api.autoReplies.update(id, { isActive: !current })
      loadAutoReplies()
    } catch {
      setError('ステータスの変更に失敗しました')
    }
  }

  const handleDelete = async (id: string) => {
    if (!confirm('この自動応答を削除してもよいですか？')) return
    try {
      await api.autoReplies.delete(id)
      loadAutoReplies()
    } catch {
      setError('削除に失敗しました')
    }
  }

  return (
    <div>
      <Header
        title="自動応答"
        action={
          <div className="flex items-center gap-2">
            <Link
              href="/conductor?tab=auto-reply"
              className="px-4 py-2 min-h-[44px] inline-flex items-center text-sm font-medium text-green-700 bg-green-50 hover:bg-green-100 border border-green-200 rounded-lg transition-colors"
            >
              ✨ AI Conductorで作成
            </Link>
            <button
              onClick={() => setShowCreate(true)}
              className="px-4 py-2 min-h-[44px] text-sm font-medium text-white rounded-lg transition-opacity hover:opacity-90"
              style={{ backgroundColor: '#06C755' }}
            >
              + 新規ルール
            </button>
          </div>
        }
      />

      {/* 運用上の注記 */}
      <p className="mb-4 text-xs text-gray-500">
        キーワード一致しないメッセージは AI自動応答 (3層) が引き続き対応します。薬機法に配慮し効能効果の断定は避けてください。現在は全LINEアカウント共通ルールとして保存されます。
      </p>

      {/* Error */}
      {error && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
          {error}
        </div>
      )}

      {/* 作成時の server 警告 (薬機 redact 等) */}
      {createWarnings.length > 0 && (
        <div className="mb-4 p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1">
              <p className="text-xs font-medium text-yellow-900">⚠️ サーバー警告</p>
              {createWarnings.map((w, i) => (
                <p key={i} className="text-xs text-yellow-800 break-words">{w}</p>
              ))}
            </div>
            <button
              onClick={() => setCreateWarnings([])}
              className="text-xs text-yellow-700 hover:text-yellow-900 underline flex-shrink-0"
            >
              閉じる
            </button>
          </div>
        </div>
      )}

      {/* Create form */}
      {showCreate && (
        <div className="mb-6 bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <h2 className="text-sm font-semibold text-gray-800 mb-4">新規自動応答を作成</h2>
          <div className="space-y-4 max-w-lg">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">キーワード <span className="text-red-500">*</span></label>
              <input
                type="text"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                placeholder="例: 営業時間"
                value={form.keyword}
                maxLength={KEYWORD_MAX}
                onChange={(e) => setForm({ ...form, keyword: e.target.value })}
              />
              <p className="text-xs text-gray-400 mt-0.5 text-right">{form.keyword.length} / {KEYWORD_MAX}</p>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">マッチ方式</label>
              <select
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 bg-white"
                value={form.matchType}
                onChange={(e) => setForm({ ...form, matchType: e.target.value as MatchType })}
              >
                {matchTypeOptions.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">返信文 <span className="text-red-500">*</span></label>
              <textarea
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 resize-y"
                rows={4}
                placeholder="例: お問い合わせありがとうございます。サポート対応は平日10時〜18時です。"
                value={form.responseContent}
                maxLength={RESPONSE_MAX}
                onChange={(e) => setForm({ ...form, responseContent: e.target.value })}
              />
              <p className="text-xs text-gray-400 mt-0.5 text-right">{form.responseContent.length} / {RESPONSE_MAX}</p>
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

      {/* Loading skeleton */}
      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="bg-white rounded-lg border border-gray-200 p-5 animate-pulse space-y-3">
              <div className="h-4 bg-gray-200 rounded w-3/4" />
              <div className="h-3 bg-gray-100 rounded w-full" />
              <div className="flex gap-4">
                <div className="h-3 bg-gray-100 rounded w-24" />
                <div className="h-3 bg-gray-100 rounded w-16" />
              </div>
            </div>
          ))}
        </div>
      ) : autoReplies.length === 0 && !showCreate ? (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-12 text-center">
          <p className="text-gray-500">自動応答がありません。「AI Conductorで作成」または「新規ルール」から作成してください。</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {autoReplies.map((reply) => {
            const isActive = reply.is_active === 1
            return (
              <div
                key={reply.id}
                className="bg-white rounded-lg shadow-sm border border-gray-200 p-5 hover:shadow-md transition-shadow"
              >
                {/* Header row */}
                <div className="flex items-start justify-between mb-2">
                  <h3 className="text-sm font-semibold text-gray-900 leading-tight break-words">{reply.keyword}</h3>
                  <button
                    onClick={() => handleToggleActive(reply.id, isActive)}
                    className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                      isActive ? 'bg-green-500' : 'bg-gray-300'
                    }`}
                    title={isActive ? '有効 - クリックで無効化' : '無効 - クリックで有効化'}
                  >
                    <span
                      className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                        isActive ? 'translate-x-4' : 'translate-x-0'
                      }`}
                    />
                  </button>
                </div>

                {/* Response content */}
                <p className="text-xs text-gray-500 mb-3 line-clamp-2 whitespace-pre-wrap">{reply.response_content}</p>

                {/* Badges */}
                <div className="flex items-center gap-2 mb-3">
                  <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${matchTypeBadgeColor[reply.match_type]}`}>
                    {matchTypeLabelMap[reply.match_type]}
                  </span>
                  <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                    isActive ? 'bg-green-50 text-green-700' : 'bg-gray-100 text-gray-500'
                  }`}>
                    {isActive ? '有効' : '無効'}
                  </span>
                </div>

                {/* Actions */}
                <div className="flex items-center justify-end gap-2 pt-2 border-t border-gray-100">
                  <button
                    onClick={() => handleDelete(reply.id)}
                    className="px-3 py-1 min-h-[44px] text-xs font-medium text-red-500 hover:text-red-700 bg-red-50 hover:bg-red-100 rounded-md transition-colors"
                  >
                    削除
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
