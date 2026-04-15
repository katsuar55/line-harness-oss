'use client'

/**
 * QuickReplyEditor — structured form for LINE quick reply buttons.
 *
 * Stored format (consumed by apps/worker/src/services/step-delivery.ts):
 * {
 *   "text": "本文テキスト",
 *   "items": [
 *     { "label": "ボタン名", "text": "返信文" },         // message action
 *     { "label": "ボタン名", "data": "postback_data" }  // postback action
 *   ]
 * }
 *
 * LINE limits: max 13 items, label ≤ 20 chars, text ≤ 300 chars, data ≤ 300 chars.
 */
import { useEffect, useState } from 'react'

export interface QuickReplyItemDraft {
  label: string
  actionType: 'message' | 'postback'
  value: string // text (message) or data (postback)
}

export interface QuickReplyDraft {
  text: string
  items: QuickReplyItemDraft[]
}

interface QuickReplyEditorProps {
  /** Stringified JSON; empty string allowed */
  value: string
  onChange: (jsonString: string) => void
}

const MAX_ITEMS = 13
const LABEL_MAX = 20
const VALUE_MAX = 300
const TEXT_MAX = 1000

function parseValue(raw: string): QuickReplyDraft {
  if (!raw.trim()) return { text: '', items: [] }
  try {
    const obj = JSON.parse(raw)
    const items = Array.isArray(obj?.items)
      ? obj.items.map((it: { label?: unknown; text?: unknown; data?: unknown }) => {
          const label = typeof it?.label === 'string' ? it.label : ''
          if (typeof it?.data === 'string') {
            return { label, actionType: 'postback' as const, value: it.data }
          }
          const text = typeof it?.text === 'string' ? it.text : ''
          return { label, actionType: 'message' as const, value: text }
        })
      : []
    return {
      text: typeof obj?.text === 'string' ? obj.text : '',
      items,
    }
  } catch {
    return { text: '', items: [] }
  }
}

function serializeDraft(draft: QuickReplyDraft): string {
  return JSON.stringify({
    text: draft.text,
    items: draft.items.map((it) =>
      it.actionType === 'postback' ? { label: it.label, data: it.value } : { label: it.label, text: it.value },
    ),
  })
}

export default function QuickReplyEditor({ value, onChange }: QuickReplyEditorProps) {
  const [draft, setDraft] = useState<QuickReplyDraft>(() => parseValue(value))

  // Re-sync when external value changes (e.g. switching steps)
  useEffect(() => {
    setDraft(parseValue(value))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])

  const update = (next: QuickReplyDraft) => {
    setDraft(next)
    onChange(serializeDraft(next))
  }

  const addItem = () => {
    if (draft.items.length >= MAX_ITEMS) return
    update({
      ...draft,
      items: [...draft.items, { label: '', actionType: 'message', value: '' }],
    })
  }

  const removeItem = (idx: number) => {
    update({ ...draft, items: draft.items.filter((_, i) => i !== idx) })
  }

  const moveItem = (idx: number, dir: -1 | 1) => {
    const next = [...draft.items]
    const target = idx + dir
    if (target < 0 || target >= next.length) return
    ;[next[idx], next[target]] = [next[target], next[idx]]
    update({ ...draft, items: next })
  }

  const updateItem = (idx: number, patch: Partial<QuickReplyItemDraft>) => {
    const next = draft.items.map((it, i) => (i === idx ? { ...it, ...patch } : it))
    update({ ...draft, items: next })
  }

  return (
    <div className="space-y-3">
      {/* Body text */}
      <div>
        <label className="block text-xs font-medium text-gray-600 mb-1">
          本文テキスト <span className="text-gray-400">(クイックリプライの上に表示)</span>
        </label>
        <textarea
          value={draft.text}
          onChange={(e) => update({ ...draft, text: e.target.value.slice(0, TEXT_MAX) })}
          rows={2}
          placeholder="例: ご質問はこちらからどうぞ"
          className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 resize-y"
        />
        <div className="text-[10px] text-gray-400 text-right">{draft.text.length}/{TEXT_MAX}</div>
      </div>

      {/* Items */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="block text-xs font-medium text-gray-600">
            クイックリプライボタン ({draft.items.length}/{MAX_ITEMS})
          </label>
          <button
            type="button"
            onClick={addItem}
            disabled={draft.items.length >= MAX_ITEMS}
            className="px-3 py-1 text-xs font-medium text-white rounded-md disabled:opacity-50"
            style={{ backgroundColor: '#06C755' }}
          >
            + ボタン追加
          </button>
        </div>

        {draft.items.length === 0 && (
          <div className="text-xs text-gray-400 text-center py-4 border border-dashed border-gray-200 rounded-md">
            ボタンがまだありません
          </div>
        )}

        <ul className="space-y-2">
          {draft.items.map((item, idx) => (
            <li key={idx} className="border border-gray-200 rounded-md p-3 bg-gray-50/40">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] font-medium text-gray-500">ボタン {idx + 1}</span>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => moveItem(idx, -1)}
                    disabled={idx === 0}
                    className="px-2 text-xs text-gray-500 hover:text-gray-800 disabled:opacity-30"
                    aria-label="上に移動"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    onClick={() => moveItem(idx, 1)}
                    disabled={idx === draft.items.length - 1}
                    className="px-2 text-xs text-gray-500 hover:text-gray-800 disabled:opacity-30"
                    aria-label="下に移動"
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    onClick={() => removeItem(idx)}
                    className="px-2 text-xs text-red-500 hover:text-red-700"
                    aria-label="削除"
                  >
                    ✕
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div>
                  <label className="block text-[10px] text-gray-500 mb-1">ラベル ({item.label.length}/{LABEL_MAX})</label>
                  <input
                    type="text"
                    value={item.label}
                    onChange={(e) => updateItem(idx, { label: e.target.value.slice(0, LABEL_MAX) })}
                    placeholder="例: はい"
                    className="w-full border border-gray-300 rounded-md px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-green-500"
                  />
                </div>
                <div>
                  <label className="block text-[10px] text-gray-500 mb-1">アクション種別</label>
                  <select
                    value={item.actionType}
                    onChange={(e) =>
                      updateItem(idx, { actionType: e.target.value as 'message' | 'postback' })
                    }
                    className="w-full border border-gray-300 rounded-md px-2 py-1.5 text-sm bg-white focus:outline-none focus:ring-1 focus:ring-green-500"
                  >
                    <option value="message">メッセージ送信</option>
                    <option value="postback">ポストバック</option>
                  </select>
                </div>
              </div>

              <div className="mt-2">
                <label className="block text-[10px] text-gray-500 mb-1">
                  {item.actionType === 'message' ? '送信される返信テキスト' : 'ポストバックデータ (例: action=yes)'}
                  <span className="ml-1">({item.value.length}/{VALUE_MAX})</span>
                </label>
                <input
                  type="text"
                  value={item.value}
                  onChange={(e) => updateItem(idx, { value: e.target.value.slice(0, VALUE_MAX) })}
                  placeholder={item.actionType === 'message' ? '例: はい、お願いします' : 'action=confirm_yes'}
                  className="w-full border border-gray-300 rounded-md px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-green-500 font-mono"
                />
              </div>
            </li>
          ))}
        </ul>
      </div>

      {/* Validation hints */}
      {draft.items.some((it) => !it.label.trim() || !it.value.trim()) && draft.items.length > 0 && (
        <p className="text-xs text-amber-600">
          ⚠ ラベルまたは値が空欄のボタンがあります。LINEに送信される際にエラーになる場合があります。
        </p>
      )}
    </div>
  )
}
