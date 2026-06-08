'use client'

import { useState, useEffect, useCallback } from 'react'
import { api, type AbTest } from '@/lib/api'
import Header from '@/components/layout/header'
import CcPromptButton from '@/components/cc-prompt-button'

interface TagOption {
  id: string
  name: string
  color: string
}

interface CreateFormState {
  title: string
  variantAContent: string
  variantBContent: string
  targetType: 'all' | 'tag'
  targetTagId: string
  splitRatio: number
}

const initialForm: CreateFormState = {
  title: '',
  variantAContent: '',
  variantBContent: '',
  targetType: 'all',
  targetTagId: '',
  splitRatio: 50,
}

const statusLabel: Record<AbTest['status'], string> = {
  draft: '下書き',
  scheduled: '予約済み',
  sending: '送信中',
  test_sent: 'テスト送信済み',
  winner_sent: '勝者送信済み',
}

const statusColor: Record<AbTest['status'], string> = {
  draft: 'bg-gray-100 text-gray-600',
  scheduled: 'bg-blue-100 text-blue-700',
  sending: 'bg-yellow-100 text-yellow-700',
  test_sent: 'bg-purple-100 text-purple-700',
  winner_sent: 'bg-green-100 text-green-700',
}

const ccPrompts = [
  {
    title: 'A/Bテスト案の提案',
    prompt: `naturism (インナーケアサプリ) の LINE 配信 A/Bテスト案を作成してください。
1. 検証したい仮説 (件名/CTA/絵文字有無 等) を複数
2. バリアントA/Bの具体文面 (薬機法配慮・効能効果の断定なし)
3. 評価指標 (クリック率) と判定の目安
案を提示してください。`,
  },
]

function ctr(success: number, total: number): string {
  if (!total || total <= 0) return '—'
  return `${((success / total) * 100).toFixed(1)}%`
}

export default function AbTestsPage() {
  const [tests, setTests] = useState<AbTest[]>([])
  const [tags, setTags] = useState<TagOption[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [form, setForm] = useState<CreateFormState>({ ...initialForm })
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState('')
  const [busyId, setBusyId] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [testsRes, tagsRes] = await Promise.all([api.abTests.list(), api.tags.list()])
      if (testsRes.success) setTests(testsRes.data)
      else setError(testsRes.error)
      if (tagsRes.success) setTags(tagsRes.data as unknown as TagOption[])
    } catch {
      setError('A/Bテストの読み込みに失敗しました。もう一度お試しください。')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const handleCreate = async () => {
    if (!form.title.trim()) { setFormError('タイトルを入力してください'); return }
    if (!form.variantAContent.trim() || !form.variantBContent.trim()) {
      setFormError('バリアントA・Bの両方のメッセージを入力してください'); return
    }
    if (form.targetType === 'tag' && !form.targetTagId) {
      setFormError('タグ配信の場合はタグを選択してください'); return
    }
    if (form.splitRatio < 1 || form.splitRatio > 99) {
      setFormError('テスト配信比率は1〜99で指定してください'); return
    }
    setSaving(true)
    setFormError('')
    try {
      const res = await api.abTests.create({
        title: form.title.trim(),
        variantA: { messageType: 'text', messageContent: form.variantAContent },
        variantB: { messageType: 'text', messageContent: form.variantBContent },
        targetType: form.targetType,
        targetTagId: form.targetType === 'tag' ? form.targetTagId : null,
        splitRatio: form.splitRatio,
      })
      if (res.success) {
        setShowCreate(false)
        setForm({ ...initialForm })
        load()
      } else setFormError(res.error)
    } catch {
      setFormError('作成に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  const handleSend = async (t: AbTest) => {
    if (!confirm(`「${t.title}」のテスト配信を今すぐ送信します。よろしいですか？`)) return
    setBusyId(t.id)
    try {
      const res = await api.abTests.send(t.id)
      if (!res.success) setError(res.error)
      load()
    } catch { setError('送信に失敗しました') } finally { setBusyId('') }
  }

  const handleStats = async (t: AbTest) => {
    setBusyId(t.id)
    try {
      await api.abTests.stats(t.id)
      load()
    } catch { setError('集計の更新に失敗しました') } finally { setBusyId('') }
  }

  const handleSendWinner = async (t: AbTest) => {
    const winner = window.prompt('勝者のバリアントを入力してください（A または B）', t.winner ?? 'A')
    if (winner !== 'A' && winner !== 'B') {
      if (winner !== null) setError('A または B を入力してください')
      return
    }
    if (!confirm(`バリアント${winner}を残りのユーザーに配信します。よろしいですか？`)) return
    setBusyId(t.id)
    try {
      const res = await api.abTests.sendWinner(t.id, winner)
      if (!res.success) setError(res.error)
      load()
    } catch { setError('勝者配信に失敗しました') } finally { setBusyId('') }
  }

  const handleDelete = async (t: AbTest) => {
    if (!confirm(`「${t.title}」を削除してもよいですか？`)) return
    setBusyId(t.id)
    try {
      await api.abTests.delete(t.id)
      load()
    } catch { setError('削除に失敗しました') } finally { setBusyId('') }
  }

  return (
    <div>
      <Header
        title="A/Bテスト配信"
        action={
          <button
            onClick={() => setShowCreate(true)}
            className="px-4 py-2 min-h-[44px] text-sm font-medium text-white rounded-lg transition-opacity hover:opacity-90"
            style={{ backgroundColor: '#06C755' }}
          >
            + 新規テスト
          </button>
        }
      />

      <p className="mb-4 text-sm text-gray-500">
        2つの文面案を一部のユーザーに送り分け、クリック率の高い方を残りのユーザーに配信します。
      </p>

      {error && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>
      )}

      {showCreate && (
        <div className="mb-6 bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <h2 className="text-sm font-semibold text-gray-800 mb-4">新規 A/Bテスト</h2>
          <div className="space-y-4 max-w-2xl">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">タイトル <span className="text-red-500">*</span></label>
              <input
                type="text"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                placeholder="例: 新商品告知の件名テスト"
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
              />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">バリアントA <span className="text-red-500">*</span></label>
                <textarea
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 resize-y"
                  rows={4}
                  placeholder="A案のメッセージ"
                  value={form.variantAContent}
                  onChange={(e) => setForm({ ...form, variantAContent: e.target.value })}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">バリアントB <span className="text-red-500">*</span></label>
                <textarea
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 resize-y"
                  rows={4}
                  placeholder="B案のメッセージ"
                  value={form.variantBContent}
                  onChange={(e) => setForm({ ...form, variantBContent: e.target.value })}
                />
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">配信対象</label>
                <select
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 bg-white"
                  value={form.targetType}
                  onChange={(e) => setForm({ ...form, targetType: e.target.value as 'all' | 'tag' })}
                >
                  <option value="all">全員</option>
                  <option value="tag">タグで絞り込み</option>
                </select>
              </div>
              {form.targetType === 'tag' && (
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">タグ</label>
                  <select
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 bg-white"
                    value={form.targetTagId}
                    onChange={(e) => setForm({ ...form, targetTagId: e.target.value })}
                  >
                    <option value="">タグを選択...</option>
                    {tags.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                </div>
              )}
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">テスト配信比率 (A/B 各)</label>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={1}
                    max={99}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                    value={form.splitRatio}
                    onChange={(e) => setForm({ ...form, splitRatio: parseInt(e.target.value, 10) || 0 })}
                  />
                  <span className="text-sm text-gray-500">%</span>
                </div>
              </div>
            </div>
            <p className="text-[11px] text-gray-400">
              対象の {form.splitRatio}% ずつに A・B を送り、残り {Math.max(0, 100 - form.splitRatio * 2)}% に勝者を配信します。{'{{name}}'} で表示名に置換。薬機法に配慮してください。
            </p>

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
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {[...Array(2)].map((_, i) => (
            <div key={i} className="bg-white rounded-lg border border-gray-200 p-5 animate-pulse space-y-3">
              <div className="h-4 bg-gray-200 rounded w-3/4" />
              <div className="h-3 bg-gray-100 rounded w-full" />
              <div className="h-3 bg-gray-100 rounded w-1/2" />
            </div>
          ))}
        </div>
      ) : tests.length === 0 && !showCreate ? (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-12 text-center">
          <p className="text-gray-500">A/Bテストがありません。「新規テスト」から作成してください。</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {tests.map((t) => (
            <div key={t.id} className="bg-white rounded-lg shadow-sm border border-gray-200 p-5 hover:shadow-md transition-shadow">
              <div className="flex items-start justify-between mb-2 gap-2">
                <h3 className="text-sm font-semibold text-gray-900 leading-tight">{t.title}</h3>
                <span className={`inline-flex shrink-0 items-center px-2 py-0.5 rounded-full text-xs font-medium ${statusColor[t.status]}`}>
                  {statusLabel[t.status]}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-2 my-3">
                <div className="rounded-lg border border-gray-100 p-2">
                  <p className="text-[11px] text-gray-400 mb-0.5">バリアントA</p>
                  <p className="text-xs text-gray-700 line-clamp-2 whitespace-pre-wrap mb-1">{t.variantA.messageContent}</p>
                  <p className="text-xs font-semibold text-gray-900">CTR {ctr(t.variantASuccess, t.variantATotal)} <span className="font-normal text-gray-400">({t.variantASuccess}/{t.variantATotal})</span></p>
                </div>
                <div className="rounded-lg border border-gray-100 p-2">
                  <p className="text-[11px] text-gray-400 mb-0.5">バリアントB</p>
                  <p className="text-xs text-gray-700 line-clamp-2 whitespace-pre-wrap mb-1">{t.variantB.messageContent}</p>
                  <p className="text-xs font-semibold text-gray-900">CTR {ctr(t.variantBSuccess, t.variantBTotal)} <span className="font-normal text-gray-400">({t.variantBSuccess}/{t.variantBTotal})</span></p>
                </div>
              </div>

              {t.winner && (
                <p className="text-xs text-green-700 mb-2">勝者: バリアント{t.winner}（{t.winnerSuccess ?? 0}/{t.winnerTotal ?? 0}）</p>
              )}

              <div className="flex flex-wrap items-center justify-end gap-2 pt-2 border-t border-gray-100">
                {(t.status === 'draft' || t.status === 'scheduled') && (
                  <button
                    onClick={() => handleSend(t)}
                    disabled={busyId === t.id}
                    className="px-3 py-1 min-h-[44px] text-xs font-medium text-white rounded-md disabled:opacity-50"
                    style={{ backgroundColor: '#06C755' }}
                  >
                    {busyId === t.id ? '処理中...' : 'テスト送信'}
                  </button>
                )}
                {t.status === 'test_sent' && (
                  <>
                    <button
                      onClick={() => handleStats(t)}
                      disabled={busyId === t.id}
                      className="px-3 py-1 min-h-[44px] text-xs font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-md disabled:opacity-50"
                    >
                      集計更新
                    </button>
                    <button
                      onClick={() => handleSendWinner(t)}
                      disabled={busyId === t.id}
                      className="px-3 py-1 min-h-[44px] text-xs font-medium text-white rounded-md disabled:opacity-50"
                      style={{ backgroundColor: '#06C755' }}
                    >
                      勝者を配信
                    </button>
                  </>
                )}
                {(t.status === 'sending' || t.status === 'winner_sent') && (
                  <button
                    onClick={() => handleStats(t)}
                    disabled={busyId === t.id}
                    className="px-3 py-1 min-h-[44px] text-xs font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-md disabled:opacity-50"
                  >
                    集計更新
                  </button>
                )}
                <button
                  onClick={() => handleDelete(t)}
                  disabled={busyId === t.id}
                  className="px-3 py-1 min-h-[44px] text-xs font-medium text-red-500 hover:text-red-700 bg-red-50 hover:bg-red-100 rounded-md disabled:opacity-50"
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
