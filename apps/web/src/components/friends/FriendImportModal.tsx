'use client'

/**
 * Friends CSV Import Modal (LSTEP audit H1、 2026-05-22)
 *
 * 役割:
 *   - friends ページで「CSV インポート」 button から開く modal
 *   - CSV text を paste / file upload 受付
 *   - dryRun (= 検証のみ) と本実行を分離
 *   - 結果表示 (created / updated / skipped / errors)
 *
 * worker endpoint: POST /api/friends/import
 *   body: { csv: string, dryRun?: boolean }
 *   response: { success, data: { totalRows, created, updated, skipped, errors[], dryRun } }
 */

import { useState, useRef } from 'react'
import { fetchApi } from '@/lib/api'

interface ImportRowError {
  row: number
  lineUserId?: string
  field?: string
  message: string
}

interface ImportResult {
  totalRows: number
  created: number
  updated: number
  skipped: number
  errors: ImportRowError[]
  dryRun: boolean
}

interface ImportResponse {
  success: boolean
  data?: ImportResult
  error?: string
}

interface FriendImportModalProps {
  open: boolean
  onClose: () => void
  onSuccess?: () => void
}

const SAMPLE_CSV = `line_user_id,display_name,email,phone,memo
U0123456789abcdef0123456789abcdef,田中太郎,tanaka@example.com,090-1234-5678,LP 経由 2026-05
Uffffffffffffffffffffffffffffffff,佐藤花子,sato@example.com,,初回問合せ`

export default function FriendImportModal({ open, onClose, onSuccess }: FriendImportModalProps) {
  const [csv, setCsv] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<ImportResult | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  if (!open) return null

  function reset() {
    setCsv('')
    setError(null)
    setResult(null)
    setLoading(false)
  }

  function handleClose() {
    if (loading) return
    reset()
    onClose()
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    if (file.size > 1_048_576) {
      setError(`ファイルが大きすぎます (max 1 MB、 actual ${file.size} bytes)`)
      return
    }
    const text = await file.text()
    setCsv(text)
    setError(null)
  }

  async function submit(dryRun: boolean) {
    if (!csv.trim()) {
      setError('CSV が空です')
      return
    }
    setLoading(true)
    setError(null)
    setResult(null)
    try {
      const res = await fetchApi<ImportResponse>('/api/friends/import', {
        method: 'POST',
        body: JSON.stringify({ csv, dryRun }),
      })
      if (res.success && res.data) {
        setResult(res.data)
        if (!dryRun && !res.data.dryRun && res.data.created + res.data.updated > 0) {
          onSuccess?.()
        }
      } else {
        setError(res.error ?? 'インポートに失敗しました')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-lg shadow-xl max-w-3xl w-full max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between">
          <h2 className="text-lg font-semibold">友だち CSV インポート</h2>
          <button
            onClick={handleClose}
            disabled={loading}
            className="text-gray-400 hover:text-gray-600 disabled:opacity-40"
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          <div className="text-xs text-gray-600 space-y-1">
            <p>必須列: <code className="bg-gray-100 px-1 rounded">line_user_id</code></p>
            <p>
              optional 列:{' '}
              <code className="bg-gray-100 px-1 rounded">display_name</code>{' '}
              <code className="bg-gray-100 px-1 rounded">email</code>{' '}
              <code className="bg-gray-100 px-1 rounded">phone</code>{' '}
              <code className="bg-gray-100 px-1 rounded">memo</code>
            </p>
            <p>line_user_id 形式: <code className="bg-gray-100 px-1 rounded">U + hex 32 桁</code></p>
            <p>max 5,000 rows / 1 MB / dryRun で事前検証可</p>
          </div>

          <div className="flex items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv"
              onChange={handleFileChange}
              className="text-xs"
            />
            <button
              type="button"
              onClick={() => setCsv(SAMPLE_CSV)}
              className="text-xs text-blue-600 hover:text-blue-800 underline"
            >
              サンプルを挿入
            </button>
          </div>

          <textarea
            value={csv}
            onChange={(e) => setCsv(e.target.value)}
            disabled={loading}
            placeholder={SAMPLE_CSV}
            className="w-full h-48 p-3 text-xs font-mono border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-green-500"
            spellCheck={false}
          />

          {error && (
            <div className="p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700">
              {error}
            </div>
          )}

          {result && (
            <div
              className={`p-3 rounded border ${
                result.errors.length > 0
                  ? 'bg-amber-50 border-amber-200'
                  : 'bg-green-50 border-green-200'
              }`}
            >
              <p className="text-sm font-semibold">
                {result.dryRun ? 'Dry Run 結果' : 'インポート結果'}
              </p>
              <div className="mt-2 grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
                <div>
                  <span className="text-gray-500">total: </span>
                  <span className="font-mono">{result.totalRows}</span>
                </div>
                <div>
                  <span className="text-gray-500">created: </span>
                  <span className="font-mono text-green-700">{result.created}</span>
                </div>
                <div>
                  <span className="text-gray-500">updated: </span>
                  <span className="font-mono text-blue-700">{result.updated}</span>
                </div>
                <div>
                  <span className="text-gray-500">skipped: </span>
                  <span className="font-mono text-red-700">{result.skipped}</span>
                </div>
              </div>
              {result.errors.length > 0 && (
                <details className="mt-3">
                  <summary className="text-xs cursor-pointer text-amber-800 font-medium">
                    エラー {result.errors.length} 件 (クリックで展開)
                  </summary>
                  <div className="mt-2 max-h-40 overflow-y-auto bg-white border border-amber-200 rounded p-2 text-xs space-y-1">
                    {result.errors.slice(0, 50).map((e, i) => (
                      <div key={i} className="font-mono">
                        <span className="text-gray-400">row {e.row}</span>
                        {e.field && <span className="text-amber-700"> [{e.field}]</span>}
                        {e.lineUserId && (
                          <span className="text-gray-500">
                            {' '}({e.lineUserId.slice(0, 8)}…)
                          </span>
                        )}
                        : {e.message}
                      </div>
                    ))}
                    {result.errors.length > 50 && (
                      <div className="text-gray-400">… {result.errors.length - 50} 件省略</div>
                    )}
                  </div>
                </details>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-gray-200 flex items-center justify-end gap-2 bg-gray-50">
          <button
            type="button"
            onClick={handleClose}
            disabled={loading}
            className="px-4 py-2 text-sm border border-gray-300 rounded-md bg-white hover:bg-gray-100 disabled:opacity-40"
          >
            閉じる
          </button>
          <button
            type="button"
            onClick={() => submit(true)}
            disabled={loading || !csv.trim()}
            className="px-4 py-2 text-sm border border-blue-300 rounded-md bg-blue-50 text-blue-700 hover:bg-blue-100 disabled:opacity-40"
          >
            {loading ? '検証中…' : 'Dry Run 実行 (検証のみ)'}
          </button>
          <button
            type="button"
            onClick={() => submit(false)}
            disabled={loading || !csv.trim()}
            className="px-4 py-2 text-sm rounded-md bg-[#06C755] text-white hover:bg-[#05a847] disabled:opacity-40"
          >
            {loading ? 'インポート中…' : 'インポート実行'}
          </button>
        </div>
      </div>
    </div>
  )
}
