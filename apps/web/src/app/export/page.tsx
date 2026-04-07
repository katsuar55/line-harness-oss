'use client'

import { useState } from 'react'
import Header from '@/components/layout/header'

interface ExportType {
  id: string
  label: string
  description: string
  path: string
  icon: string
}

const EXPORT_TYPES: ExportType[] = [
  { id: 'friends', label: '友だち一覧', description: '全友だち + タグ情報', path: '/api/export/friends', icon: '👥' },
  { id: 'orders', label: '購入履歴', description: 'Shopify注文データ', path: '/api/export/orders', icon: '🛒' },
  { id: 'coupons', label: 'クーポン利用', description: '発行・使用状況', path: '/api/export/coupons', icon: '🎟️' },
  { id: 'intake', label: '服用記録', description: '服用ログ + streak', path: '/api/export/intake', icon: '💊' },
  { id: 'health', label: '体調記録', description: '体重・体調・睡眠', path: '/api/export/health', icon: '🏥' },
  { id: 'referrals', label: '紹介実績', description: '紹介者 → 被紹介者', path: '/api/export/referrals', icon: '🤝' },
  { id: 'ambassadors', label: 'アンバサダー', description: 'ステータス・実績', path: '/api/export/ambassadors', icon: '⭐' },
  { id: 'ranks', label: 'ランク別', description: '累計購入額・ランク', path: '/api/export/ranks', icon: '🏆' },
]

export default function ExportPage() {
  const [downloading, setDownloading] = useState<string | null>(null)
  const [error, setError] = useState('')

  async function handleDownload(exp: ExportType) {
    setDownloading(exp.id)
    setError('')
    try {
      const apiUrl = process.env.NEXT_PUBLIC_API_URL
      const apiKey = typeof window !== 'undefined' ? localStorage.getItem('lh_api_key') || '' : ''

      const res = await fetch(`${apiUrl}${exp.path}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      })

      if (!res.ok) throw new Error(`HTTP ${res.status}`)

      const blob = await res.blob()
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url

      // Extract filename from Content-Disposition header
      const disposition = res.headers.get('Content-Disposition')
      const filenameMatch = disposition?.match(/filename="(.+)"/)
      a.download = filenameMatch ? filenameMatch[1] : `${exp.id}.csv`

      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      window.URL.revokeObjectURL(url)
    } catch {
      setError(`${exp.label}のダウンロードに失敗しました`)
    } finally {
      setDownloading(null)
    }
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <Header />
      <main className="max-w-4xl mx-auto px-4 py-6">
        <h1 className="text-2xl font-bold text-gray-900 mb-2">CSV エクスポート</h1>
        <p className="text-sm text-gray-500 mb-6">各データをCSVファイルとしてダウンロードできます（最大10,000件）</p>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg mb-4 text-sm">
            {error}
            <button onClick={() => setError('')} className="float-right text-red-500 font-bold">&times;</button>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {EXPORT_TYPES.map((exp) => (
            <div key={exp.id} className="bg-white rounded-xl p-5 shadow-sm flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className="text-2xl">{exp.icon}</span>
                <div>
                  <p className="font-medium text-gray-800">{exp.label}</p>
                  <p className="text-xs text-gray-500">{exp.description}</p>
                </div>
              </div>
              <button
                onClick={() => handleDownload(exp)}
                disabled={downloading === exp.id}
                className="bg-green-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-green-700 disabled:opacity-50 transition-colors whitespace-nowrap"
              >
                {downloading === exp.id ? 'DL中...' : 'ダウンロード'}
              </button>
            </div>
          ))}
        </div>
      </main>
    </div>
  )
}
