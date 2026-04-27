'use client'

import { useState, useEffect, useCallback } from 'react'
import { fetchApi } from '@/lib/api'
import { useAccount } from '@/contexts/account-context'
import type { ApiResponse } from '@line-crm/shared'

interface Stats {
  total: number
  registered: number
  unregistered: number
}

interface QuickReplyAction {
  type: 'postback'
  label: string
  data: string
  displayText?: string
}

interface QuickReplyItem {
  type: 'action'
  action: QuickReplyAction
}

interface PreviewMessage {
  type: 'text'
  text: string
  quickReply?: { items: QuickReplyItem[] }
}

interface DryRunResult {
  dryRun: true
  targetCount: number
}

interface SendResult {
  dryRun: false
  targetCount: number
  sent: number
  errors: number
}

type SendResponse = DryRunResult | SendResult

const MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]

export default function BirthdayCollectionPage() {
  const { selectedAccountId } = useAccount()
  const [stats, setStats] = useState<Stats | null>(null)
  const [statsLoading, setStatsLoading] = useState(false)
  const [statsError, setStatsError] = useState<string | null>(null)

  const [customText, setCustomText] = useState('')
  const [preview, setPreview] = useState<PreviewMessage | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)

  const [sending, setSending] = useState(false)
  const [lastResult, setLastResult] = useState<SendResponse | null>(null)
  const [sendError, setSendError] = useState<string | null>(null)

  const [confirmOpen, setConfirmOpen] = useState(false)
  const [confirmInput, setConfirmInput] = useState('')

  const buildAccountQuery = useCallback(
    (): string => (selectedAccountId ? `?lineAccountId=${selectedAccountId}` : ''),
    [selectedAccountId],
  )

  const buildAccountBody = useCallback((): Record<string, string> => {
    return selectedAccountId ? { lineAccountId: selectedAccountId } : {}
  }, [selectedAccountId])

  const loadStats = useCallback(async () => {
    setStatsLoading(true)
    setStatsError(null)
    try {
      const json = await fetchApi<ApiResponse<Stats>>(
        `/api/birthday-collection/stats${buildAccountQuery()}`,
      )
      if (json.success) {
        setStats(json.data)
      } else {
        setStatsError(json.error || '統計の取得に失敗しました')
      }
    } catch (err) {
      setStatsError(err instanceof Error ? err.message : '統計の取得に失敗しました')
    } finally {
      setStatsLoading(false)
    }
  }, [buildAccountQuery])

  const loadPreview = useCallback(async () => {
    setPreviewLoading(true)
    try {
      const body = customText.trim() ? { customText: customText.trim() } : {}
      const json = await fetchApi<ApiResponse<PreviewMessage>>(
        '/api/birthday-collection/preview',
        { method: 'POST', body: JSON.stringify(body) },
      )
      if (json.success) {
        setPreview(json.data)
      }
    } catch {
      // Preview failure is non-fatal — keep the previous preview
    } finally {
      setPreviewLoading(false)
    }
  }, [customText])

  useEffect(() => {
    loadStats()
  }, [loadStats])

  useEffect(() => {
    loadPreview()
  }, [loadPreview])

  async function executeSend(dryRun: boolean) {
    setSending(true)
    setSendError(null)
    setLastResult(null)
    try {
      const body = {
        ...buildAccountBody(),
        ...(customText.trim() ? { customText: customText.trim() } : {}),
        dryRun,
      }
      const json = await fetchApi<ApiResponse<SendResponse>>(
        '/api/birthday-collection/send',
        { method: 'POST', body: JSON.stringify(body) },
      )
      if (json.success) {
        setLastResult(json.data)
        if (!dryRun) loadStats()
      } else {
        setSendError(json.error || '送信に失敗しました')
      }
    } catch (err) {
      setSendError(err instanceof Error ? err.message : '送信に失敗しました')
    } finally {
      setSending(false)
    }
  }

  function openConfirm() {
    setConfirmInput('')
    setConfirmOpen(true)
  }

  function handleConfirmSend() {
    if (confirmInput !== '本送信') return
    setConfirmOpen(false)
    executeSend(false)
  }

  const progress = stats && stats.total > 0
    ? Math.round((stats.registered / stats.total) * 100)
    : 0

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-800">誕生月収集</h1>
        <p className="text-sm text-gray-500 mt-1">
          DMM チャットブースト解約 (2026-06〜07月) 前に、未登録の友だちから誕生月を再収集します。
          Quick Reply で 1〜12 月のボタンから選択してもらい、<code className="text-xs bg-gray-100 px-1 rounded">friends.metadata.birth_month</code> に保存されます。
        </p>
      </div>

      {/* Stats */}
      <div className="bg-white rounded-xl border p-5 mb-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-bold text-gray-700">登録状況</h2>
          <button
            onClick={loadStats}
            disabled={statsLoading}
            className="text-xs px-3 py-1.5 rounded-lg border text-gray-600 hover:bg-gray-50 disabled:opacity-50"
          >
            {statsLoading ? '更新中…' : '更新'}
          </button>
        </div>

        {statsError && (
          <div className="mb-3 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-3">
            {statsError}
          </div>
        )}

        <div className="grid grid-cols-3 gap-3 mb-4">
          <div className="bg-gray-50 rounded-lg p-3 text-center">
            <p className="text-2xl font-bold text-gray-800">{stats?.total ?? '—'}</p>
            <p className="text-xs text-gray-500 mt-1">合計フォロワー</p>
          </div>
          <div className="bg-green-50 rounded-lg p-3 text-center">
            <p className="text-2xl font-bold text-green-700">{stats?.registered ?? '—'}</p>
            <p className="text-xs text-gray-500 mt-1">誕生月 登録済</p>
          </div>
          <div className="bg-orange-50 rounded-lg p-3 text-center">
            <p className="text-2xl font-bold text-orange-600">{stats?.unregistered ?? '—'}</p>
            <p className="text-xs text-gray-500 mt-1">未登録 (送信対象)</p>
          </div>
        </div>

        {stats && stats.total > 0 && (
          <div>
            <div className="flex items-center justify-between text-xs text-gray-500 mb-1">
              <span>登録率</span>
              <span>{progress}%</span>
            </div>
            <div className="w-full bg-gray-100 rounded-full h-2 overflow-hidden">
              <div
                className="bg-green-500 h-2 rounded-full transition-all"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>
        )}
      </div>

      {/* Message editor + preview */}
      <div className="grid md:grid-cols-2 gap-6 mb-6">
        <div className="bg-white rounded-xl border p-5">
          <h2 className="text-sm font-bold text-gray-700 mb-3">メッセージ本文</h2>
          <p className="text-xs text-gray-500 mb-2">
            空欄の場合はデフォルト文言が使われます。Quick Reply (1〜12月) は自動で付与されます。
          </p>
          <textarea
            value={customText}
            onChange={(e) => setCustomText(e.target.value)}
            rows={10}
            maxLength={500}
            placeholder="（空欄でデフォルト文言を使用）"
            className="w-full p-3 border rounded-lg text-sm font-mono"
          />
          <p className="text-xs text-gray-400 text-right mt-1">{customText.length}/500</p>
        </div>

        <div className="bg-white rounded-xl border p-5">
          <h2 className="text-sm font-bold text-gray-700 mb-3">プレビュー</h2>
          {previewLoading && !preview ? (
            <p className="text-xs text-gray-400">読み込み中…</p>
          ) : preview ? (
            <div>
              <div className="bg-[#06C755]/10 rounded-2xl p-4 text-sm whitespace-pre-wrap text-gray-800 mb-3 border border-[#06C755]/20">
                {preview.text}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {MONTHS.map((m) => (
                  <span
                    key={m}
                    className="px-3 py-1.5 rounded-full bg-white border border-gray-300 text-xs text-gray-700"
                  >
                    {m}月
                  </span>
                ))}
              </div>
            </div>
          ) : (
            <p className="text-xs text-gray-400">プレビューを生成できませんでした</p>
          )}
        </div>
      </div>

      {/* Send actions */}
      <div className="bg-white rounded-xl border p-5">
        <h2 className="text-sm font-bold text-gray-700 mb-3">送信</h2>

        <div className="flex flex-wrap gap-3 mb-4">
          <button
            onClick={() => executeSend(true)}
            disabled={sending}
            className="px-4 py-2 text-sm font-medium text-blue-700 bg-blue-50 border border-blue-200 rounded-lg hover:bg-blue-100 disabled:opacity-50"
          >
            {sending ? '実行中…' : 'テスト実行 (DryRun)'}
          </button>
          <button
            onClick={openConfirm}
            disabled={sending || !stats || stats.unregistered === 0}
            className="px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 disabled:opacity-50"
          >
            本送信 ({stats?.unregistered ?? 0}人)
          </button>
        </div>

        {sendError && (
          <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-3 mb-3">
            {sendError}
          </div>
        )}

        {lastResult && (
          <div className={`text-sm rounded-lg p-3 border ${
            lastResult.dryRun
              ? 'bg-blue-50 border-blue-200 text-blue-800'
              : 'bg-green-50 border-green-200 text-green-800'
          }`}>
            {lastResult.dryRun ? (
              <>
                <p className="font-bold mb-1">DryRun 完了</p>
                <p>送信対象: <strong>{lastResult.targetCount}</strong> 人 (実送信なし)</p>
              </>
            ) : (
              <>
                <p className="font-bold mb-1">本送信 完了</p>
                <p>対象 {lastResult.targetCount} / 送信成功 <strong>{lastResult.sent}</strong> / エラー {lastResult.errors}</p>
              </>
            )}
          </div>
        )}

        <p className="text-xs text-gray-500 mt-3">
          「テスト実行」では送信対象人数のみを確認できます (LINE には送信されません)。
          「本送信」は確認モーダルで「本送信」と入力すると実行されます。
        </p>
      </div>

      {/* Confirm modal */}
      {confirmOpen && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
          onClick={() => setConfirmOpen(false)}
        >
          <div
            className="bg-white rounded-xl p-6 w-full max-w-md mx-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-bold text-gray-800 mb-2">本送信の確認</h2>
            <p className="text-sm text-gray-600 mb-4">
              <strong className="text-red-600">{stats?.unregistered ?? 0} 人</strong> の友だちにブロードキャストします。
              この操作は取り消せません。
            </p>
            <p className="text-xs text-gray-500 mb-2">
              実行するには下のボックスに <code className="bg-gray-100 px-1 rounded">本送信</code> と入力してください。
            </p>
            <input
              type="text"
              value={confirmInput}
              onChange={(e) => setConfirmInput(e.target.value)}
              placeholder="本送信"
              className="w-full p-2 border rounded-lg text-sm mb-4"
              autoFocus
            />
            <div className="flex gap-2">
              <button
                onClick={() => setConfirmOpen(false)}
                className="flex-1 py-2 rounded-lg border text-sm"
              >
                キャンセル
              </button>
              <button
                onClick={handleConfirmSend}
                disabled={confirmInput !== '本送信'}
                className="flex-1 py-2 rounded-lg bg-red-600 text-white text-sm font-bold disabled:opacity-30"
              >
                送信実行
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
