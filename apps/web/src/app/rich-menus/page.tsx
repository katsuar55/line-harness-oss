'use client'

import { useState, useEffect, useRef } from 'react'
import { api } from '@/lib/api'
import type { RichMenu, RichMenuArea } from '@/lib/api'
import Header from '@/components/layout/header'

// ─── Templates ───

const TEMPLATES: { label: string; cols: number; rows: number; areas: RichMenuArea[] }[] = [
  {
    label: '2×3 (6エリア)',
    cols: 3, rows: 2,
    areas: Array.from({ length: 6 }, (_, i) => ({
      bounds: { x: (i % 3) * 833, y: Math.floor(i / 3) * 843, width: 833, height: 843 },
      action: { type: 'message', text: `メニュー${i + 1}` },
    })),
  },
  {
    label: '1×3 (3エリア)',
    cols: 3, rows: 1,
    areas: Array.from({ length: 3 }, (_, i) => ({
      bounds: { x: i * 833, y: 0, width: 833, height: 843 },
      action: { type: 'message', text: `メニュー${i + 1}` },
    })),
  },
  {
    label: '2×2 (4エリア)',
    cols: 2, rows: 2,
    areas: Array.from({ length: 4 }, (_, i) => ({
      bounds: { x: (i % 2) * 1250, y: Math.floor(i / 2) * 843, width: 1250, height: 843 },
      action: { type: 'message', text: `メニュー${i + 1}` },
    })),
  },
  {
    label: '1×2 (2エリア)',
    cols: 2, rows: 1,
    areas: Array.from({ length: 2 }, (_, i) => ({
      bounds: { x: i * 1250, y: 0, width: 1250, height: 843 },
      action: { type: 'message', text: `メニュー${i + 1}` },
    })),
  },
]

const ACTION_TYPES = [
  { value: 'message', label: 'テキスト送信' },
  { value: 'uri', label: 'URL を開く' },
  { value: 'postback', label: 'ポストバック' },
]

// ─── Main Page ───

export default function RichMenuPage() {
  const [menus, setMenus] = useState<RichMenu[]>([])
  const [defaultMenuId, setDefaultMenuId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [showCreate, setShowCreate] = useState(false)

  const loadMenus = async () => {
    setLoading(true)
    setError('')
    try {
      const [listRes, statusRes] = await Promise.all([
        api.richMenus.list(),
        api.richMenus.status(),
      ])
      if (listRes.success && listRes.data) setMenus(listRes.data)
      if (statusRes.success && statusRes.data) setDefaultMenuId(statusRes.data.defaultRichMenuId)
    } catch {
      setError('リッチメニューの取得に失敗しました')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadMenus() }, [])

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`「${name}」を削除しますか？`)) return
    try {
      await api.richMenus.delete(id)
      flash('削除しました')
      loadMenus()
    } catch {
      setError('削除に失敗しました')
    }
  }

  const handleSetDefault = async (id: string) => {
    try {
      await api.richMenus.setDefault(id)
      flash('デフォルトメニューに設定しました')
      loadMenus()
    } catch {
      setError('デフォルト設定に失敗しました')
    }
  }

  const flash = (msg: string) => {
    setSuccess(msg)
    setTimeout(() => setSuccess(''), 3000)
  }

  return (
    <div>
      <Header title="リッチメニュー管理" description="LINE リッチメニューの作成・編集・デフォルト設定" />

      {error && <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-700 rounded-lg text-sm">{error}</div>}
      {success && <div className="mb-4 p-3 bg-green-50 border border-green-200 text-green-700 rounded-lg text-sm">{success}</div>}

      {/* Create button */}
      <div className="mb-6 flex justify-between items-center">
        <p className="text-sm text-gray-500">
          {loading ? '読込中...' : `${menus.length} 件のリッチメニュー`}
          {defaultMenuId && <span className="ml-2 text-green-600">（デフォルト設定済み）</span>}
        </p>
        <button
          onClick={() => setShowCreate(!showCreate)}
          className="px-4 py-2 text-sm font-medium text-white rounded-lg transition-opacity hover:opacity-90"
          style={{ backgroundColor: '#06C755' }}
        >
          {showCreate ? 'キャンセル' : '＋ 新規作成'}
        </button>
      </div>

      {/* Create form */}
      {showCreate && (
        <CreateRichMenuForm
          onCreated={() => { setShowCreate(false); loadMenus(); flash('リッチメニューを作成しました') }}
          onError={setError}
        />
      )}

      {/* Menu list */}
      {!loading && menus.length === 0 && (
        <div className="bg-white rounded-lg border border-gray-200 p-12 text-center text-gray-500">
          リッチメニューがありません。「新規作成」から作成してください。
        </div>
      )}

      <div className="space-y-4">
        {menus.map((menu) => (
          <RichMenuCard
            key={menu.richMenuId}
            menu={menu}
            isDefault={menu.richMenuId === defaultMenuId}
            onSetDefault={() => handleSetDefault(menu.richMenuId)}
            onDelete={() => handleDelete(menu.richMenuId, menu.name)}
            onImageUploaded={() => { loadMenus(); flash('画像をアップロードしました') }}
            onError={setError}
          />
        ))}
      </div>
    </div>
  )
}

// ─── Menu Card ───

function RichMenuCard({
  menu, isDefault, onSetDefault, onDelete, onImageUploaded, onError,
}: {
  menu: RichMenu
  isDefault: boolean
  onSetDefault: () => void
  onDelete: () => void
  onImageUploaded: () => void
  onError: (msg: string) => void
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)

  const handleUploadImage = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    try {
      await api.richMenus.uploadImage(menu.richMenuId, file)
      onImageUploaded()
    } catch {
      onError('画像のアップロードに失敗しました')
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const cols = Math.round(2500 / (menu.areas[0]?.bounds.width || 833))
  const rows = Math.round((menu.size.height) / (menu.areas[0]?.bounds.height || 843))

  return (
    <div className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden">
      <div className="px-5 py-4 flex items-center justify-between border-b border-gray-100">
        <div className="flex items-center gap-3">
          <h3 className="font-semibold text-gray-900">{menu.name}</h3>
          {isDefault && (
            <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-green-100 text-green-700">
              デフォルト
            </span>
          )}
          <span className="text-xs text-gray-400">
            {menu.size.width}×{menu.size.height} / {menu.areas.length}エリア
          </span>
        </div>
        <div className="flex items-center gap-2">
          {!isDefault && (
            <button
              onClick={onSetDefault}
              className="px-3 py-1.5 text-xs font-medium rounded-md bg-blue-50 text-blue-700 hover:bg-blue-100 transition-colors"
            >
              デフォルトに設定
            </button>
          )}
          <button
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
            className="px-3 py-1.5 text-xs font-medium rounded-md bg-gray-100 text-gray-700 hover:bg-gray-200 transition-colors disabled:opacity-50"
          >
            {uploading ? 'アップロード中...' : '画像アップロード'}
          </button>
          <input ref={fileRef} type="file" accept="image/png,image/jpeg" className="hidden" onChange={handleUploadImage} />
          <button
            onClick={onDelete}
            className="px-3 py-1.5 text-xs font-medium rounded-md bg-red-50 text-red-600 hover:bg-red-100 transition-colors"
          >
            削除
          </button>
        </div>
      </div>

      {/* Area grid preview */}
      <div className="px-5 py-4">
        <p className="text-xs font-semibold text-gray-500 mb-2">メニューバーテキスト: 「{menu.chatBarText}」</p>
        <div
          className="border border-gray-200 rounded-lg overflow-hidden"
          style={{
            display: 'grid',
            gridTemplateColumns: `repeat(${cols}, 1fr)`,
            gridTemplateRows: `repeat(${rows}, 1fr)`,
            aspectRatio: `${menu.size.width / menu.size.height}`,
            maxWidth: '500px',
          }}
        >
          {menu.areas.map((area, idx) => (
            <div
              key={idx}
              className="border border-gray-100 bg-gray-50 flex flex-col items-center justify-center p-2 text-center"
            >
              <span className="text-xs font-bold text-gray-400 mb-1">{idx + 1}</span>
              <span className="text-xs text-gray-600">
                {area.action.type === 'uri' ? '🔗 URL' :
                 area.action.type === 'postback' ? '📮 Postback' :
                 '💬 テキスト'}
              </span>
              <span className="text-xs text-gray-500 truncate max-w-full mt-0.5">
                {area.action.uri || area.action.text || area.action.data || '—'}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ─── Create Form ───

function CreateRichMenuForm({
  onCreated, onError,
}: {
  onCreated: () => void
  onError: (msg: string) => void
}) {
  const [name, setName] = useState('')
  const [chatBarText, setChatBarText] = useState('メニューを開く')
  const [selectedTemplate, setSelectedTemplate] = useState(0)
  const [useLargeSize, setUseLargeSize] = useState(true)
  const [areas, setAreas] = useState<RichMenuArea[]>(TEMPLATES[0].areas)
  const [saving, setSaving] = useState(false)

  const template = TEMPLATES[selectedTemplate]

  const handleTemplateChange = (idx: number) => {
    setSelectedTemplate(idx)
    setAreas(TEMPLATES[idx].areas.map(a => ({ ...a })))
  }

  const updateAreaAction = (idx: number, field: string, value: string) => {
    setAreas(prev => prev.map((a, i) => {
      if (i !== idx) return a
      const newAction = { ...a.action, [field]: value }
      // Clear irrelevant fields when type changes
      if (field === 'type') {
        if (value === 'uri') { delete newAction.text; delete newAction.data; newAction.uri = '' }
        else if (value === 'postback') { delete newAction.uri; delete newAction.text; newAction.data = '' }
        else { delete newAction.uri; delete newAction.data; newAction.text = '' }
      }
      return { ...a, action: newAction }
    }))
  }

  const handleCreate = async () => {
    if (!name.trim()) { onError('メニュー名を入力してください'); return }
    setSaving(true)
    try {
      const height = useLargeSize ? 1686 : 843
      const scaledAreas = areas.map(a => ({
        bounds: {
          ...a.bounds,
          y: useLargeSize ? a.bounds.y : Math.round(a.bounds.y / 2),
          height: useLargeSize ? a.bounds.height : Math.round(a.bounds.height / 2),
        },
        action: a.action,
      }))
      await api.richMenus.create({
        size: { width: 2500, height },
        selected: false,
        name: name.trim(),
        chatBarText: chatBarText.trim() || 'メニュー',
        areas: scaledAreas,
      })
      onCreated()
    } catch {
      onError('リッチメニューの作成に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mb-6 bg-white rounded-lg border border-gray-200 shadow-sm p-5 space-y-5">
      <h3 className="font-semibold text-gray-900">新規リッチメニュー作成</h3>

      {/* Basic settings */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">メニュー名</label>
          <input
            type="text"
            className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
            placeholder="メインリッチメニュー"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">メニューバーテキスト</label>
          <input
            type="text"
            className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
            placeholder="メニューを開く"
            value={chatBarText}
            onChange={(e) => setChatBarText(e.target.value)}
          />
        </div>
      </div>

      {/* Size */}
      <div>
        <label className="block text-xs font-medium text-gray-500 mb-2">サイズ</label>
        <div className="flex gap-3">
          <button
            onClick={() => setUseLargeSize(true)}
            className={`px-4 py-2 text-sm rounded-md border transition-colors ${
              useLargeSize ? 'border-green-500 bg-green-50 text-green-700 font-medium' : 'border-gray-300 text-gray-600 hover:bg-gray-50'
            }`}
          >
            大 2500×1686
          </button>
          <button
            onClick={() => setUseLargeSize(false)}
            className={`px-4 py-2 text-sm rounded-md border transition-colors ${
              !useLargeSize ? 'border-green-500 bg-green-50 text-green-700 font-medium' : 'border-gray-300 text-gray-600 hover:bg-gray-50'
            }`}
          >
            小 2500×843
          </button>
        </div>
      </div>

      {/* Template selector */}
      <div>
        <label className="block text-xs font-medium text-gray-500 mb-2">テンプレート</label>
        <div className="flex gap-3">
          {TEMPLATES.map((t, idx) => (
            <button
              key={idx}
              onClick={() => handleTemplateChange(idx)}
              className={`flex flex-col items-center gap-1 px-3 py-2 rounded-md border transition-colors ${
                selectedTemplate === idx
                  ? 'border-green-500 bg-green-50 text-green-700'
                  : 'border-gray-300 text-gray-600 hover:bg-gray-50'
              }`}
            >
              {/* Mini grid preview */}
              <div className="grid gap-0.5" style={{ gridTemplateColumns: `repeat(${t.cols}, 1fr)`, width: '40px' }}>
                {Array.from({ length: t.cols * t.rows }).map((_, i) => (
                  <div key={i} className="aspect-square bg-gray-300 rounded-sm" style={{ minHeight: '8px' }} />
                ))}
              </div>
              <span className="text-xs">{t.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Area configuration */}
      <div>
        <label className="block text-xs font-medium text-gray-500 mb-2">エリア設定（{areas.length} エリア）</label>

        {/* Visual preview */}
        <div
          className="border border-gray-200 rounded-lg overflow-hidden mb-4"
          style={{
            display: 'grid',
            gridTemplateColumns: `repeat(${template.cols}, 1fr)`,
            gridTemplateRows: `repeat(${template.rows}, 1fr)`,
            aspectRatio: `${2500 / (useLargeSize ? 1686 : 843)}`,
            maxWidth: '400px',
          }}
        >
          {areas.map((_, idx) => (
            <div
              key={idx}
              className="border border-dashed border-gray-300 bg-green-50/30 flex items-center justify-center text-lg font-bold text-green-600/50"
            >
              {idx + 1}
            </div>
          ))}
        </div>

        <div className="space-y-3">
          {areas.map((area, idx) => (
            <div key={idx} className="flex items-center gap-3 p-3 bg-gray-50 rounded-md">
              <span className="text-sm font-bold text-gray-400 w-6 text-center">{idx + 1}</span>
              <select
                className="text-sm border border-gray-300 rounded-md px-2 py-1.5 focus:ring-2 focus:ring-green-500"
                value={area.action.type}
                onChange={(e) => updateAreaAction(idx, 'type', e.target.value)}
              >
                {ACTION_TYPES.map(at => (
                  <option key={at.value} value={at.value}>{at.label}</option>
                ))}
              </select>
              {area.action.type === 'uri' && (
                <input
                  type="url"
                  className="flex-1 text-sm border border-gray-300 rounded-md px-3 py-1.5 focus:ring-2 focus:ring-green-500"
                  placeholder="https://example.com"
                  value={area.action.uri || ''}
                  onChange={(e) => updateAreaAction(idx, 'uri', e.target.value)}
                />
              )}
              {area.action.type === 'message' && (
                <input
                  type="text"
                  className="flex-1 text-sm border border-gray-300 rounded-md px-3 py-1.5 focus:ring-2 focus:ring-green-500"
                  placeholder="送信テキスト"
                  value={area.action.text || ''}
                  onChange={(e) => updateAreaAction(idx, 'text', e.target.value)}
                />
              )}
              {area.action.type === 'postback' && (
                <input
                  type="text"
                  className="flex-1 text-sm border border-gray-300 rounded-md px-3 py-1.5 focus:ring-2 focus:ring-green-500"
                  placeholder="action=buy&item=123"
                  value={area.action.data || ''}
                  onChange={(e) => updateAreaAction(idx, 'data', e.target.value)}
                />
              )}
              <input
                type="text"
                className="w-24 text-sm border border-gray-300 rounded-md px-2 py-1.5 focus:ring-2 focus:ring-green-500"
                placeholder="ラベル"
                value={area.action.label || ''}
                onChange={(e) => updateAreaAction(idx, 'label', e.target.value)}
              />
            </div>
          ))}
        </div>
      </div>

      <div className="flex gap-3 pt-2">
        <button
          onClick={handleCreate}
          disabled={!name.trim() || saving}
          className="px-6 py-2.5 text-sm font-medium text-white rounded-lg disabled:opacity-50 transition-opacity"
          style={{ backgroundColor: '#06C755' }}
        >
          {saving ? '作成中...' : '作成'}
        </button>
      </div>
    </div>
  )
}
