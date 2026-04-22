'use client'

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { api, fetchApi } from '@/lib/api'
import type { RichMenu, RichMenuArea, RichMenuAction } from '@/lib/api'
import type { ApiResponse } from '@line-crm/shared'
import Header from '@/components/layout/header'

// ─── Layout templates (percentages for scalable rendering) ─────────────────

interface LayoutCell { x: number; y: number; w: number; h: number }
interface Layout {
  id: string
  label: string
  cells: LayoutCell[]
  sizeMode: 'large' | 'small' | 'both'
}

const LAYOUTS: Layout[] = [
  { id: 'L-1',   label: '1枠',           sizeMode: 'both',  cells: [{ x: 0, y: 0, w: 100, h: 100 }] },
  { id: 'L-2h',  label: '横2枠',         sizeMode: 'both',  cells: [
    { x: 0,  y: 0, w: 50, h: 100 }, { x: 50, y: 0, w: 50, h: 100 },
  ]},
  { id: 'L-2v',  label: '縦2枠',         sizeMode: 'large', cells: [
    { x: 0, y: 0,  w: 100, h: 50 }, { x: 0, y: 50, w: 100, h: 50 },
  ]},
  { id: 'L-3h',  label: '横3枠',         sizeMode: 'both',  cells: [
    { x: 0,     y: 0, w: 33.33, h: 100 },
    { x: 33.33, y: 0, w: 33.34, h: 100 },
    { x: 66.67, y: 0, w: 33.33, h: 100 },
  ]},
  { id: 'L-2x2', label: '2×2 (4枠)',     sizeMode: 'large', cells: [
    { x: 0, y: 0,  w: 50, h: 50 }, { x: 50, y: 0,  w: 50, h: 50 },
    { x: 0, y: 50, w: 50, h: 50 }, { x: 50, y: 50, w: 50, h: 50 },
  ]},
  { id: 'L-2x3', label: '2×3 (6枠)',     sizeMode: 'large', cells: [
    { x: 0,     y: 0,  w: 33.33, h: 50 },
    { x: 33.33, y: 0,  w: 33.34, h: 50 },
    { x: 66.67, y: 0,  w: 33.33, h: 50 },
    { x: 0,     y: 50, w: 33.33, h: 50 },
    { x: 33.33, y: 50, w: 33.34, h: 50 },
    { x: 66.67, y: 50, w: 33.33, h: 50 },
  ]},
  { id: 'L-naturism8', label: 'naturism風 8枠', sizeMode: 'large', cells: [
    // 上段
    { x: 0,     y: 0,  w: 33.33, h: 50 },
    { x: 33.33, y: 0,  w: 33.34, h: 50 },
    { x: 66.67, y: 0,  w: 33.33, h: 25 },
    { x: 66.67, y: 25, w: 33.33, h: 25 },
    // 下段
    { x: 0,     y: 50, w: 33.33, h: 50 },
    { x: 33.33, y: 50, w: 33.34, h: 50 },
    { x: 66.67, y: 50, w: 33.33, h: 25 },
    { x: 66.67, y: 75, w: 33.33, h: 25 },
  ]},
]

// ─── Action type (UI) ─────────────────

type ActionKind = 'link' | 'text' | 'tel' | 'mail' | 'scenario' | 'postback' | 'menuswitch'

const ACTION_KIND_LABELS: Record<ActionKind, { label: string; icon: string }> = {
  link:       { label: 'リンク',       icon: '🔗' },
  text:       { label: 'テキスト送信', icon: '💬' },
  tel:        { label: '電話',         icon: '📞' },
  mail:       { label: 'メール',       icon: '✉️' },
  scenario:   { label: 'シナリオ',     icon: '🔄' },
  postback:   { label: 'ポストバック', icon: '📮' },
  menuswitch: { label: '別メニュー移動', icon: '🔀' },
}

interface EditableArea {
  bounds: { x: number; y: number; width: number; height: number }
  kind: ActionKind
  label: string
  uri?: string
  text?: string
  tel?: string
  email?: string
  scenarioId?: string
  postbackData?: string
  menuswitchAlias?: string
}

// ─── Main Page ─────────────────

export default function RichMenusPage() {
  const [menus, setMenus] = useState<RichMenu[]>([])
  const [defaultMenuId, setDefaultMenuId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [editorMode, setEditorMode] = useState<'list' | 'new'>('list')
  const [flash, setFlash] = useState<{ kind: 'ok' | 'err'; msg: string } | null>(null)

  const loadMenus = useCallback(async () => {
    setLoading(true)
    try {
      const [listRes, statusRes] = await Promise.all([
        api.richMenus.list(),
        api.richMenus.status(),
      ])
      if (listRes.success && listRes.data) setMenus(listRes.data)
      if (statusRes.success && statusRes.data) setDefaultMenuId(statusRes.data.defaultRichMenuId)
    } catch (err) {
      console.error('richMenus.load', err)
      showFlash('err', 'リッチメニューの取得に失敗しました')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadMenus() }, [loadMenus])

  function showFlash(kind: 'ok' | 'err', msg: string) {
    setFlash({ kind, msg })
    setTimeout(() => setFlash(null), 3500)
  }

  async function handleDelete(id: string, name: string) {
    if (!confirm(`「${name}」を削除しますか？`)) return
    try {
      await api.richMenus.delete(id)
      showFlash('ok', '削除しました')
      loadMenus()
    } catch (err) {
      console.error('richMenus.delete', err)
      showFlash('err', '削除に失敗しました')
    }
  }

  async function handleSetDefault(id: string) {
    try {
      await api.richMenus.setDefault(id)
      showFlash('ok', 'デフォルトに設定しました')
      loadMenus()
    } catch (err) {
      console.error('richMenus.setDefault', err)
      showFlash('err', 'デフォルト設定に失敗しました')
    }
  }

  return (
    <div>
      <Header title="リッチメニュー" description="LINE リッチメニューの作成・編集・デフォルト設定" />

      {flash && (
        <div className={`mb-4 p-3 rounded-lg text-sm ${
          flash.kind === 'ok' ? 'bg-green-50 border border-green-200 text-green-700'
                              : 'bg-red-50 border border-red-200 text-red-700'
        }`}>{flash.msg}</div>
      )}

      {editorMode === 'new' ? (
        <RichMenuEditor
          onSaved={() => { setEditorMode('list'); loadMenus(); showFlash('ok', 'リッチメニューを作成しました') }}
          onCancel={() => setEditorMode('list')}
          onError={(msg) => showFlash('err', msg)}
        />
      ) : (
        <>
          <div className="mb-6 flex justify-between items-center">
            <p className="text-sm text-gray-500">
              {loading ? '読込中...' : `${menus.length} 件のリッチメニュー`}
              {defaultMenuId && <span className="ml-2 text-green-600 text-xs">（デフォルト設定中）</span>}
            </p>
            <button
              onClick={() => setEditorMode('new')}
              className="px-4 py-2 text-sm font-medium text-white rounded-lg hover:opacity-90"
              style={{ backgroundColor: '#06C755' }}
            >＋ 新規作成</button>
          </div>

          {!loading && menus.length === 0 && (
            <div className="bg-white rounded-lg border border-gray-200 p-12 text-center text-gray-500">
              リッチメニューがありません。「＋ 新規作成」から作成してください。
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
                onImageUploaded={(info) => {
                  loadMenus()
                  showFlash('ok', info?.replaced
                    ? '画像を更新しました（LINE仕様により内部的にメニューを再作成しました）'
                    : '画像をアップロードしました')
                }}
                onError={(msg) => showFlash('err', msg)}
              />
            ))}
          </div>
        </>
      )}
    </div>
  )
}

// ─── List card ─────────────────

function RichMenuCard({
  menu, isDefault, onSetDefault, onDelete, onImageUploaded, onError,
}: {
  menu: RichMenu
  isDefault: boolean
  onSetDefault: () => void
  onDelete: () => void
  // info.replaced=true means LINE forced a menu recreate (id changed)
  onImageUploaded: (info?: { replaced?: boolean }) => void
  onError: (msg: string) => void
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  // Cache-bust key — bumping this after upload forces re-fetch of the image.
  const [imageVersion, setImageVersion] = useState<number>(() => Date.now())

  // Fetch the LINE-hosted rich menu image as a blob URL for preview.
  useEffect(() => {
    let cancelled = false
    let createdUrl: string | null = null
    api.richMenus.fetchImageBlobUrl(menu.richMenuId, imageVersion).then((url) => {
      if (cancelled) {
        if (url) URL.revokeObjectURL(url)
        return
      }
      if (url) {
        createdUrl = url
        setImageUrl(url)
      } else {
        setImageUrl(null)
      }
    })
    return () => {
      cancelled = true
      if (createdUrl) URL.revokeObjectURL(createdUrl)
    }
  }, [menu.richMenuId, imageVersion])

  async function handleUploadImage(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return

    // ── Pre-flight validation against LINE's rich menu image requirements ──
    // (LINE: PNG/JPEG, ≤1MB, 800-2500px wide, 250-1686px tall, width/height ≥ 1.45)
    const MAX_BYTES = 1024 * 1024
    if (file.size > MAX_BYTES) {
      onError(`画像サイズが大きすぎます (${(file.size / 1024 / 1024).toFixed(2)}MB)。LINE の制限は 1MB までです。`)
      if (fileRef.current) fileRef.current.value = ''
      return
    }
    const fileType = (file.type || '').toLowerCase()
    if (!fileType.includes('png') && !fileType.includes('jpeg') && !fileType.includes('jpg')) {
      onError('PNG または JPEG 画像のみ対応しています')
      if (fileRef.current) fileRef.current.value = ''
      return
    }

    // Verify dimensions match the rich menu size (otherwise LINE returns 400)
    const dimsOk = await new Promise<boolean>((resolve) => {
      const img = new Image()
      img.onload = () => {
        const ok = img.width === menu.size.width && img.height === menu.size.height
        if (!ok) {
          onError(
            `画像サイズが ${img.width}×${img.height} です。このリッチメニューは ${menu.size.width}×${menu.size.height} の画像が必要です。`
          )
        }
        URL.revokeObjectURL(img.src)
        resolve(ok)
      }
      img.onerror = () => {
        onError('画像を読み込めませんでした。ファイルが破損していないか確認してください。')
        URL.revokeObjectURL(img.src)
        resolve(false)
      }
      img.src = URL.createObjectURL(file)
    })
    if (!dimsOk) {
      if (fileRef.current) fileRef.current.value = ''
      return
    }

    setUploading(true)
    try {
      const res = await api.richMenus.uploadImage(menu.richMenuId, file)
      // If the worker had to recreate the menu (LINE doesn't allow re-uploading
      // images), the rich menu ID changes. The list refresh in onImageUploaded()
      // picks up the new menu and remounts the card.
      const replaced = res.success && res.data?.replaced === true
      setImageVersion(Date.now())
      onImageUploaded({ replaced })
    } catch (err) {
      console.error('richMenus.uploadImage', err)
      const msg = err instanceof Error ? err.message : String(err)
      onError(`画像のアップロードに失敗しました: ${msg}`)
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  return (
    <div className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden">
      <div className="px-5 py-4 flex items-center justify-between border-b border-gray-100 flex-wrap gap-2">
        <div className="flex items-center gap-3 min-w-0">
          <h3 className="font-semibold text-gray-900 truncate">{menu.name}</h3>
          {isDefault && <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-green-100 text-green-700">デフォルト</span>}
          <span className="text-xs text-gray-400 shrink-0">
            {menu.size.width}×{menu.size.height} / {menu.areas.length}枠
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {!isDefault && (
            <button onClick={onSetDefault} className="px-3 py-1.5 text-xs font-medium rounded-md bg-blue-50 text-blue-700 hover:bg-blue-100">
              デフォルトに設定
            </button>
          )}
          <button
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
            className="px-3 py-1.5 text-xs font-medium rounded-md bg-gray-100 text-gray-700 hover:bg-gray-200 disabled:opacity-50"
            title={`要件: ${menu.size.width}×${menu.size.height}px / PNG または JPEG / 1MB以下`}
          >
            {uploading ? 'アップロード中...' : '画像変更'}
          </button>
          <input ref={fileRef} type="file" accept="image/png,image/jpeg" className="hidden" onChange={handleUploadImage} />
          <button onClick={onDelete} className="px-3 py-1.5 text-xs font-medium rounded-md bg-red-50 text-red-600 hover:bg-red-100">削除</button>
        </div>
      </div>

      <div className="px-5 py-4">
        <p className="text-xs font-semibold text-gray-500 mb-2">メニューバー: 「{menu.chatBarText}」</p>
        <AreaPreview
          width={menu.size.width}
          height={menu.size.height}
          areas={menu.areas}
          maxW={500}
          imageUrl={imageUrl}
        />
        {!imageUrl && (
          <p className="text-[11px] text-gray-400 mt-2">
            ※ 画像が未設定、または LINE から取得できません。「画像変更」からアップロードしてください。
          </p>
        )}
      </div>
    </div>
  )
}

function AreaPreview({ width, height, areas, maxW, imageUrl }: {
  width: number
  height: number
  areas: RichMenuArea[]
  maxW: number
  imageUrl?: string | null
}) {
  return (
    <div
      className="relative border border-gray-200 rounded-lg overflow-hidden bg-gray-50"
      style={{
        width: '100%',
        maxWidth: `${maxW}px`,
        aspectRatio: `${width} / ${height}`,
        backgroundImage: imageUrl ? `url("${imageUrl}")` : undefined,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
      }}
    >
      {areas.map((area, idx) => {
        const left = (area.bounds.x / width) * 100
        const top = (area.bounds.y / height) * 100
        const w = (area.bounds.width / width) * 100
        const h = (area.bounds.height / height) * 100
        return (
          <div
            key={idx}
            className="absolute border border-white/60 bg-emerald-500/15 flex flex-col items-center justify-center p-1 text-center"
            style={{ left: `${left}%`, top: `${top}%`, width: `${w}%`, height: `${h}%` }}
          >
            <span className="text-[10px] font-bold text-emerald-700">{idx + 1}</span>
            <span className="text-[9px] text-gray-600 truncate max-w-full">{area.action.label || '—'}</span>
          </div>
        )
      })}
    </div>
  )
}

// ─── Editor ─────────────────

interface ScenarioOption { id: string; name: string }

function RichMenuEditor({
  onSaved, onCancel, onError,
}: {
  onSaved: () => void
  onCancel: () => void
  onError: (msg: string) => void
}) {
  const [name, setName] = useState('')
  const [chatBarText, setChatBarText] = useState('メニュー')
  const [sizeLarge, setSizeLarge] = useState(true)
  const [layoutId, setLayoutId] = useState<string>('L-naturism8')
  const [areas, setAreas] = useState<EditableArea[]>([])
  const [selectedIdx, setSelectedIdx] = useState<number>(0)
  const [saving, setSaving] = useState(false)
  const [scenarios, setScenarios] = useState<ScenarioOption[]>([])
  const [existingMenus, setExistingMenus] = useState<RichMenu[]>([])
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string | null>(null)
  const [pendingImage, setPendingImage] = useState<File | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const canvasWidth = 2500
  const canvasHeight = sizeLarge ? 1686 : 843

  // Load scenarios and existing menus (for menuswitch dropdown)
  useEffect(() => {
    (async () => {
      try {
        const sRes = await api.scenarios.list()
        if (sRes.success && sRes.data) {
          setScenarios(sRes.data.map((s) => ({ id: s.id, name: s.name })))
        }
      } catch (err) { console.error('scenarios.list', err) }
      try {
        const mRes = await api.richMenus.list()
        if (mRes.success && mRes.data) setExistingMenus(mRes.data)
      } catch (err) { console.error('richMenus.list', err) }
    })()
  }, [])

  // Filter layouts by size
  const availableLayouts = useMemo(
    () => LAYOUTS.filter((l) => l.sizeMode === 'both' || l.sizeMode === (sizeLarge ? 'large' : 'small')),
    [sizeLarge],
  )

  // Build areas from layout template whenever layout or size changes
  const applyLayout = useCallback((newLayoutId: string, newSizeLarge: boolean) => {
    const layout = LAYOUTS.find((l) => l.id === newLayoutId) ?? LAYOUTS[0]
    const w = 2500
    const h = newSizeLarge ? 1686 : 843
    const next: EditableArea[] = layout.cells.map((c, i) => ({
      bounds: {
        x: Math.round((c.x / 100) * w),
        y: Math.round((c.y / 100) * h),
        width: Math.round((c.w / 100) * w),
        height: Math.round((c.h / 100) * h),
      },
      kind: 'text',
      label: `メニュー${i + 1}`,
      text: `メニュー${i + 1}`,
    }))
    setAreas(next)
    setSelectedIdx(0)
  }, [])

  // Re-apply when layout/size changes
  useEffect(() => {
    // If currently selected layout isn't valid for size, fall back
    const valid = availableLayouts.some((l) => l.id === layoutId)
    const nextLayout = valid ? layoutId : availableLayouts[0].id
    if (nextLayout !== layoutId) setLayoutId(nextLayout)
    applyLayout(nextLayout, sizeLarge)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutId, sizeLarge])

  // Image preview
  function handleImagePick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setPendingImage(file)
    const url = URL.createObjectURL(file)
    setImagePreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev)
      return url
    })
    if (fileRef.current) fileRef.current.value = ''
  }

  useEffect(() => () => { if (imagePreviewUrl) URL.revokeObjectURL(imagePreviewUrl) }, [imagePreviewUrl])

  function updateSelected<K extends keyof EditableArea>(key: K, value: EditableArea[K]) {
    setAreas((prev) => prev.map((a, i) => (i === selectedIdx ? { ...a, [key]: value } : a)))
  }

  function updateSelectedBounds(key: 'x' | 'y' | 'width' | 'height', value: number) {
    setAreas((prev) => prev.map((a, i) => (i === selectedIdx ? { ...a, bounds: { ...a.bounds, [key]: value } } : a)))
  }

  function areaToApi(area: EditableArea): RichMenuArea {
    const action = toApiAction(area)
    return { bounds: area.bounds, action }
  }

  function validate(): string | null {
    if (!name.trim()) return 'メニュー名を入力してください'
    if (!chatBarText.trim()) return 'メニューバーテキストを入力してください'
    for (let i = 0; i < areas.length; i++) {
      const a = areas[i]
      if (a.kind === 'link'     && !a.uri?.trim())        return `エリア${i + 1}: URLを入力してください`
      if (a.kind === 'text'     && !a.text?.trim())       return `エリア${i + 1}: 送信テキストを入力してください`
      if (a.kind === 'tel'      && !a.tel?.trim())        return `エリア${i + 1}: 電話番号を入力してください`
      if (a.kind === 'mail'     && !a.email?.trim())      return `エリア${i + 1}: メールアドレスを入力してください`
      if (a.kind === 'scenario' && !a.scenarioId)         return `エリア${i + 1}: シナリオを選択してください`
      if (a.kind === 'postback' && !a.postbackData?.trim()) return `エリア${i + 1}: ポストバックデータを入力してください`
      if (a.kind === 'menuswitch' && !a.menuswitchAlias?.trim()) return `エリア${i + 1}: 移動先メニューを選択してください`
    }
    return null
  }

  async function handleSave() {
    const err = validate()
    if (err) { onError(err); return }
    setSaving(true)
    try {
      const payload = {
        size: { width: canvasWidth, height: canvasHeight },
        selected: false,
        name: name.trim(),
        chatBarText: chatBarText.trim(),
        areas: areas.map(areaToApi),
      }
      const createRes = await fetchApi<ApiResponse<{ richMenuId: string }>>('/api/rich-menus', {
        method: 'POST',
        body: JSON.stringify(payload),
      })
      if (!createRes.success) {
        throw new Error('error' in createRes ? createRes.error : 'create failed')
      }
      if (!createRes.data?.richMenuId) {
        throw new Error('richMenuId missing in response')
      }
      // Upload image if provided
      if (pendingImage) {
        try {
          await api.richMenus.uploadImage(createRes.data.richMenuId, pendingImage)
        } catch (imgErr) {
          console.error('richMenus.uploadImage', imgErr)
          onError('メニュー作成はできましたが、画像アップロードに失敗しました。一覧から再度アップロードしてください。')
        }
      }
      onSaved()
    } catch (err) {
      console.error('richMenus.create', err)
      onError('リッチメニューの作成に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  const selected = areas[selectedIdx]

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
      {/* Top header */}
      <div className="px-6 py-4 border-b border-gray-100 flex items-center gap-3">
        <button onClick={onCancel} className="p-1.5 rounded hover:bg-gray-100" aria-label="戻る">
          <svg className="w-5 h-5 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <div>
          <p className="text-xs text-gray-400">リッチメニュー</p>
          <h2 className="text-lg font-bold text-gray-900">新規作成</h2>
        </div>
      </div>

      <div className="p-6 space-y-6">
        {/* 共通設定 */}
        <section>
          <h3 className="text-base font-bold text-gray-900 mb-3">共通設定</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">タイトル</label>
              <input
                type="text"
                className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                placeholder="メインリッチメニュー"
                maxLength={50}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <p className="text-xs text-gray-400 text-right mt-1">{name.length}/50</p>
            </div>
            <div>
              <label className="flex items-center gap-1 text-xs font-medium text-gray-500 mb-1">
                メニューバーテキスト
                <span className="text-[10px] text-gray-400" title="LINEのチャット下部に表示されるテキスト">?</span>
              </label>
              <input
                type="text"
                className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                placeholder="メニューを開く"
                maxLength={14}
                value={chatBarText}
                onChange={(e) => setChatBarText(e.target.value)}
              />
              <p className="text-xs text-gray-400 text-right mt-1">{chatBarText.length}/14</p>
            </div>
          </div>
        </section>

        {/* テンプレート */}
        <section>
          <h3 className="text-base font-bold text-gray-900 mb-3">テンプレート</h3>

          {/* サイズ */}
          <div className="mb-4">
            <label className="block text-xs font-medium text-gray-500 mb-2">サイズ</label>
            <div className="flex gap-2">
              <button
                onClick={() => setSizeLarge(true)}
                className={`flex items-center gap-2 px-4 py-2 text-sm rounded-md border ${
                  sizeLarge ? 'border-green-500 bg-green-50 text-green-700 font-medium' : 'border-gray-300 text-gray-600 hover:bg-gray-50'
                }`}
              >
                <span className={`w-3 h-3 rounded-full ${sizeLarge ? 'bg-green-500' : 'border border-gray-400'}`} />
                大 2500×1686
              </button>
              <button
                onClick={() => setSizeLarge(false)}
                className={`flex items-center gap-2 px-4 py-2 text-sm rounded-md border ${
                  !sizeLarge ? 'border-green-500 bg-green-50 text-green-700 font-medium' : 'border-gray-300 text-gray-600 hover:bg-gray-50'
                }`}
              >
                <span className={`w-3 h-3 rounded-full ${!sizeLarge ? 'bg-green-500' : 'border border-gray-400'}`} />
                小 2500×843
              </button>
            </div>
          </div>

          {/* Layout selector */}
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-2">レイアウト</label>
            <div className="flex flex-wrap gap-3">
              {availableLayouts.map((l) => (
                <button
                  key={l.id}
                  onClick={() => setLayoutId(l.id)}
                  className={`flex flex-col items-center gap-1.5 p-2.5 rounded-lg border transition-colors ${
                    layoutId === l.id
                      ? 'border-green-500 bg-green-50 text-green-700'
                      : 'border-gray-300 text-gray-600 hover:bg-gray-50'
                  }`}
                >
                  <MiniLayout layout={l} size={sizeLarge ? 'large' : 'small'} />
                  <span className="text-xs">{l.label}</span>
                </button>
              ))}
            </div>
          </div>
        </section>

        {/* Canvas + Right panel */}
        <section className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_320px] gap-6">
          {/* Canvas */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-base font-bold text-gray-900">プレビュー・エリア選択</h3>
              <button
                onClick={() => fileRef.current?.click()}
                className="px-3 py-1.5 text-xs font-medium rounded-md bg-gray-100 text-gray-700 hover:bg-gray-200"
              >
                {imagePreviewUrl ? '画像を再設定' : '画像を設定'}
              </button>
              <input ref={fileRef} type="file" accept="image/png,image/jpeg" className="hidden" onChange={handleImagePick} />
            </div>
            <p className="text-xs text-gray-400 mb-2">エリアをクリックするとアクションを編集できます</p>

            <AreaCanvas
              width={canvasWidth}
              height={canvasHeight}
              areas={areas}
              selectedIdx={selectedIdx}
              onSelect={setSelectedIdx}
              imageUrl={imagePreviewUrl}
            />

            <p className="text-xs text-gray-400 mt-2">
              {pendingImage ? `📎 ${pendingImage.name}` : '画像を設定しない場合は緑のプレースホルダのまま作成されます'}
            </p>
          </div>

          {/* Right panel */}
          <div>
            <h3 className="text-base font-bold text-gray-900 mb-3">
              <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-green-500 text-white text-xs font-bold mr-2">
                {selectedIdx + 1}
              </span>
              エリア設定
            </h3>

            {selected && (
              <div className="bg-gray-50 rounded-lg p-4 space-y-4">
                {/* Coordinates */}
                <div>
                  <p className="text-xs font-medium text-gray-500 mb-2">座標・サイズ (px)</p>
                  <div className="grid grid-cols-2 gap-2">
                    <LabeledNumber label="X座標" value={selected.bounds.x} onChange={(v) => updateSelectedBounds('x', v)} max={canvasWidth} />
                    <LabeledNumber label="Y座標" value={selected.bounds.y} onChange={(v) => updateSelectedBounds('y', v)} max={canvasHeight} />
                    <LabeledNumber label="幅(px)" value={selected.bounds.width} onChange={(v) => updateSelectedBounds('width', v)} max={canvasWidth} />
                    <LabeledNumber label="高さ(px)" value={selected.bounds.height} onChange={(v) => updateSelectedBounds('height', v)} max={canvasHeight} />
                  </div>
                </div>

                {/* Action type picker */}
                <div>
                  <p className="text-xs font-medium text-gray-500 mb-2">アクション設定</p>
                  <div className="grid grid-cols-2 gap-1.5">
                    {(Object.keys(ACTION_KIND_LABELS) as ActionKind[]).map((k) => (
                      <button
                        key={k}
                        onClick={() => updateSelected('kind', k)}
                        className={`flex items-center gap-1.5 px-2 py-1.5 rounded-md text-xs border transition-colors ${
                          selected.kind === k
                            ? 'border-green-500 bg-white text-green-700 font-medium'
                            : 'border-gray-200 bg-white/60 text-gray-600 hover:bg-white'
                        }`}
                      >
                        <span>{ACTION_KIND_LABELS[k].icon}</span>
                        <span className="truncate">{ACTION_KIND_LABELS[k].label}</span>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Action target based on kind */}
                <ActionInputs
                  area={selected}
                  scenarios={scenarios}
                  existingMenus={existingMenus}
                  onChange={(patch) => setAreas((prev) => prev.map((a, i) => i === selectedIdx ? { ...a, ...patch } : a))}
                />

                {/* Label */}
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">ラベル（任意・アクセシビリティ用）</label>
                  <input
                    type="text"
                    className="w-full border border-gray-300 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                    placeholder="例: ホームページ"
                    maxLength={20}
                    value={selected.label}
                    onChange={(e) => updateSelected('label', e.target.value)}
                  />
                </div>
              </div>
            )}
          </div>
        </section>

        {/* Footer actions */}
        <div className="flex items-center justify-center gap-3 pt-2">
          <button
            onClick={onCancel}
            className="px-8 py-2.5 text-sm font-medium rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50"
          >キャンセル</button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-10 py-2.5 text-sm font-bold text-white rounded-lg hover:opacity-90 disabled:opacity-50"
            style={{ backgroundColor: '#2563EB' }}
          >{saving ? '保存中...' : '保存'}</button>
        </div>
      </div>
    </div>
  )
}

// ─── Canvas (visual area editor) ─────────────────

function AreaCanvas({
  width, height, areas, selectedIdx, onSelect, imageUrl,
}: {
  width: number
  height: number
  areas: EditableArea[]
  selectedIdx: number
  onSelect: (idx: number) => void
  imageUrl: string | null
}) {
  return (
    <div
      className="relative border-2 border-gray-200 rounded-lg overflow-hidden"
      style={{
        width: '100%',
        aspectRatio: `${width} / ${height}`,
        background: imageUrl
          ? `url(${imageUrl}) center/cover no-repeat`
          : 'linear-gradient(135deg,#06C755,#04a844)',
      }}
    >
      {areas.map((area, idx) => {
        const left = (area.bounds.x / width) * 100
        const top = (area.bounds.y / height) * 100
        const w = (area.bounds.width / width) * 100
        const h = (area.bounds.height / height) * 100
        const isSel = idx === selectedIdx
        return (
          <button
            key={idx}
            onClick={() => onSelect(idx)}
            className={`absolute flex flex-col items-center justify-center transition-all ${
              isSel
                ? 'ring-2 ring-blue-500 ring-offset-0 z-10'
                : 'hover:bg-white/10'
            }`}
            style={{
              left: `${left}%`, top: `${top}%`, width: `${w}%`, height: `${h}%`,
              border: isSel ? '2px solid rgb(59,130,246)' : '1.5px dashed rgba(255,255,255,0.85)',
              background: isSel ? 'rgba(59,130,246,0.15)' : 'rgba(255,255,255,0.08)',
            }}
          >
            <span
              className={`inline-flex items-center justify-center rounded-full text-xs font-bold shadow ${
                isSel ? 'bg-blue-500 text-white' : 'bg-white/90 text-gray-700'
              }`}
              style={{ width: 26, height: 26 }}
            >
              {idx + 1}
            </span>
            {area.label && (
              <span className={`mt-1 px-1.5 py-0.5 rounded text-[10px] font-medium max-w-[90%] truncate ${
                isSel ? 'bg-blue-50 text-blue-700' : 'bg-white/85 text-gray-700'
              }`}>{area.label}</span>
            )}
          </button>
        )
      })}
    </div>
  )
}

// ─── Helpers ─────────────────

function LabeledNumber({ label, value, onChange, max }: { label: string; value: number; onChange: (v: number) => void; max: number }) {
  return (
    <label className="block">
      <span className="block text-[11px] text-gray-500 mb-0.5">{label}</span>
      <input
        type="number"
        min={0}
        max={max}
        value={value}
        onChange={(e) => {
          const n = parseInt(e.target.value || '0', 10)
          onChange(Number.isFinite(n) ? Math.max(0, Math.min(max, n)) : 0)
        }}
        className="w-full border border-gray-300 rounded-md px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
      />
    </label>
  )
}

function MiniLayout({ layout, size }: { layout: Layout; size: 'large' | 'small' }) {
  const aspect = size === 'large' ? 2500 / 1686 : 2500 / 843
  return (
    <div
      className="relative border border-gray-300 bg-white rounded-sm"
      style={{ width: '48px', aspectRatio: aspect.toString() }}
    >
      {layout.cells.map((c, i) => (
        <div
          key={i}
          className="absolute bg-gray-300 border border-white"
          style={{ left: `${c.x}%`, top: `${c.y}%`, width: `${c.w}%`, height: `${c.h}%` }}
        />
      ))}
    </div>
  )
}

function toApiAction(area: EditableArea): RichMenuAction {
  const label = area.label?.trim() || undefined
  switch (area.kind) {
    case 'link':
      return { type: 'uri', uri: area.uri?.trim() ?? '', label }
    case 'text':
      return { type: 'message', text: area.text?.trim() ?? '', label }
    case 'tel':
      return { type: 'uri', uri: `tel:${(area.tel ?? '').replace(/[^0-9+]/g, '')}`, label }
    case 'mail':
      return { type: 'uri', uri: `mailto:${area.email?.trim() ?? ''}`, label }
    case 'scenario':
      return { type: 'postback', data: `scenario:${area.scenarioId ?? ''}`, displayText: label, label }
    case 'postback':
      return { type: 'postback', data: area.postbackData?.trim() ?? '', label }
    case 'menuswitch':
      return { type: 'richmenuswitch', richMenuAliasId: area.menuswitchAlias?.trim() ?? '', data: `switch:${area.menuswitchAlias ?? ''}`, label }
  }
}

// ─── Action input panel ─────────────────

function ActionInputs({
  area, scenarios, existingMenus, onChange,
}: {
  area: EditableArea
  scenarios: ScenarioOption[]
  existingMenus: RichMenu[]
  onChange: (patch: Partial<EditableArea>) => void
}) {
  if (area.kind === 'link') {
    return (
      <div>
        <label className="block text-xs font-medium text-gray-500 mb-1">URL</label>
        <input
          type="url"
          placeholder="https://example.com"
          className="w-full border border-gray-300 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
          value={area.uri ?? ''}
          onChange={(e) => onChange({ uri: e.target.value })}
        />
      </div>
    )
  }
  if (area.kind === 'text') {
    return (
      <div>
        <label className="block text-xs font-medium text-gray-500 mb-1">送信テキスト</label>
        <input
          type="text"
          placeholder="お問い合わせ"
          maxLength={300}
          className="w-full border border-gray-300 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
          value={area.text ?? ''}
          onChange={(e) => onChange({ text: e.target.value })}
        />
        <p className="text-[10px] text-gray-400 mt-1">タップ時にユーザーが送信する文言</p>
      </div>
    )
  }
  if (area.kind === 'tel') {
    return (
      <div>
        <label className="block text-xs font-medium text-gray-500 mb-1">電話番号</label>
        <input
          type="tel"
          placeholder="0312345678"
          className="w-full border border-gray-300 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
          value={area.tel ?? ''}
          onChange={(e) => onChange({ tel: e.target.value })}
        />
      </div>
    )
  }
  if (area.kind === 'mail') {
    return (
      <div>
        <label className="block text-xs font-medium text-gray-500 mb-1">メールアドレス</label>
        <input
          type="email"
          placeholder="info@example.com"
          className="w-full border border-gray-300 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
          value={area.email ?? ''}
          onChange={(e) => onChange({ email: e.target.value })}
        />
      </div>
    )
  }
  if (area.kind === 'scenario') {
    return (
      <div>
        <label className="block text-xs font-medium text-gray-500 mb-1">シナリオ</label>
        <select
          className="w-full border border-gray-300 rounded-md px-2 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-green-500"
          value={area.scenarioId ?? ''}
          onChange={(e) => onChange({ scenarioId: e.target.value })}
        >
          <option value="">-- シナリオを選択 --</option>
          {scenarios.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <p className="text-[10px] text-gray-400 mt-1">
          選択したシナリオを起動するオートメーションを「オートメーション」画面で設定してください
        </p>
      </div>
    )
  }
  if (area.kind === 'postback') {
    return (
      <div>
        <label className="block text-xs font-medium text-gray-500 mb-1">データ</label>
        <input
          type="text"
          placeholder="action=buy&item=123"
          className="w-full border border-gray-300 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
          value={area.postbackData ?? ''}
          onChange={(e) => onChange({ postbackData: e.target.value })}
        />
        <p className="text-[10px] text-gray-400 mt-1">Webhook で受信するポストバックデータ（上級者向け）</p>
      </div>
    )
  }
  if (area.kind === 'menuswitch') {
    return (
      <div>
        <label className="block text-xs font-medium text-gray-500 mb-1">移動先メニュー（エイリアスID）</label>
        <input
          type="text"
          placeholder="menu-2"
          className="w-full border border-gray-300 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
          value={area.menuswitchAlias ?? ''}
          onChange={(e) => onChange({ menuswitchAlias: e.target.value })}
        />
        <p className="text-[10px] text-gray-400 mt-1">
          LINE Messaging API でエイリアス設定が別途必要です。既存メニュー: {existingMenus.length}件
        </p>
      </div>
    )
  }
  return null
}
