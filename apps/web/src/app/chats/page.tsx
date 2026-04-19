'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { api, fetchApi, type Operator } from '@/lib/api'
import { useAccount } from '@/contexts/account-context'
import CcPromptButton from '@/components/cc-prompt-button'
import FlexPreviewComponent from '@/components/flex-preview'

interface Chat {
  id: string
  friendId: string
  friendName: string
  friendPictureUrl: string | null
  operatorId: string | null
  status: 'unread' | 'in_progress' | 'resolved'
  notes: string | null
  lastMessageAt: string | null
  createdAt: string
  updatedAt: string
}

interface ChatMessage {
  id: string
  direction: 'incoming' | 'outgoing'
  messageType: string
  content: string
  createdAt: string
}

interface ChatDetail extends Chat {
  friendName: string
  friendPictureUrl: string | null
  messages?: ChatMessage[]
}

type StatusFilter = 'all' | 'unread' | 'in_progress' | 'resolved'

const statusConfig: Record<Chat['status'], { label: string; className: string }> = {
  unread: { label: '未読', className: 'bg-red-100 text-red-700' },
  in_progress: { label: '対応中', className: 'bg-yellow-100 text-yellow-700' },
  resolved: { label: '解決済', className: 'bg-green-100 text-green-700' },
}

const statusFilters: { key: StatusFilter; label: string }[] = [
  { key: 'all', label: '全て' },
  { key: 'unread', label: '未読' },
  { key: 'in_progress', label: '対応中' },
  { key: 'resolved', label: '解決済' },
]

const SHOW_LOADING_PREF_KEY = 'lh_chat_show_loading_indicator'
const LOADING_SECONDS_PREF_KEY = 'lh_chat_loading_seconds'
const LOADING_REFRESH_INTERVAL_MS = 4000

function formatDatetime(iso: string | null): string {
  if (!iso) return '-'
  return new Date(iso).toLocaleString('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

const ccPrompts = [
  {
    title: 'チャット対応テンプレート',
    prompt: `チャット対応で使えるテンプレートメッセージを作成してください。
1. よくある質問への回答テンプレート（挨拶、FAQ、サポート）
2. クレーム対応用の丁寧な返信テンプレート
3. フォローアップメッセージのテンプレート
手順を示してください。`,
  },
  {
    title: '未対応チャット確認',
    prompt: `未対応のチャットを確認し、対応優先度を整理してください。
1. 未読・対応中のチャット数を集計
2. 最終メッセージからの経過時間で優先度を判定
3. 長時間未対応のチャットへの対応アクションを提案
結果をレポートしてください。`,
  },
]

interface FriendItem {
  id: string
  displayName: string
  pictureUrl: string | null
  isFollowing: boolean
}

interface MessageLog {
  id: string
  direction: 'incoming' | 'outgoing'
  messageType: string
  content: string
  createdAt: string
}

interface TemplateItem { id: string; name: string; messageContent: string; messageType: string }

function DirectMessagePanel({ friendId, friend, onBack, onSent }: {
  friendId: string
  friend: FriendItem | null
  onBack: () => void
  onSent: () => void
}) {
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)
  const [messages, setMessages] = useState<MessageLog[]>([])
  const [loadingMessages, setLoadingMessages] = useState(true)
  const [showTemplates, setShowTemplates] = useState(false)
  const [templates, setTemplates] = useState<TemplateItem[]>([])
  const [templatesLoaded, setTemplatesLoaded] = useState(false)

  useEffect(() => {
    const loadMessages = async () => {
      setLoadingMessages(true)
      try {
        const res = await fetchApi<{ success: boolean; data: MessageLog[] }>(
          `/api/friends/${friendId}/messages`
        )
        if (res.success) setMessages(res.data)
      } catch { /* silent */ }
      setLoadingMessages(false)
    }
    loadMessages()
  }, [friendId])

  const handleSend = async () => {
    if (!message.trim() || sending) return
    setSending(true)
    try {
      await fetchApi(`/api/friends/${friendId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: message, messageType: 'text' }),
      })
      setMessages((prev) => [...prev, {
        id: crypto.randomUUID(),
        direction: 'outgoing',
        messageType: 'text',
        content: message,
        createdAt: new Date().toISOString(),
      }])
      setMessage('')
    } catch { /* silent */ }
    setSending(false)
  }

  function renderContent(msg: MessageLog) {
    if (msg.messageType === 'text') return msg.content
    if (msg.messageType === 'flex') {
      try {
        const parsed = JSON.parse(msg.content)
        // Extract ALL text from flex (up to 200 chars)
        const texts: string[] = []
        const collectText = (obj: Record<string, unknown>) => {
          if (texts.join(' ').length > 200) return
          if (obj.type === 'text' && typeof obj.text === 'string') {
            const t = (obj.text as string).trim()
            if (t && !t.startsWith('{{')) texts.push(t)
          }
          for (const key of ['header', 'body', 'footer']) {
            if (obj[key]) collectText(obj[key] as Record<string, unknown>)
          }
          if (Array.isArray(obj.contents)) {
            for (const c of obj.contents) collectText(c as Record<string, unknown>)
          }
        }
        collectText(parsed)
        return texts.slice(0, 4).join('\n') || '[Flex Message]'
      } catch { return '[Flex Message]' }
    }
    return `[${msg.messageType}]`
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-4 border-b border-gray-200 flex items-center gap-3">
        <button onClick={onBack} className="lg:hidden text-gray-400 hover:text-gray-600">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        {friend?.pictureUrl ? (
          <img src={friend.pictureUrl} alt="" className="w-8 h-8 rounded-full" />
        ) : (
          <div className="w-8 h-8 rounded-full bg-gray-200 flex items-center justify-center">
            <span className="text-gray-500 text-xs">{(friend?.displayName || '?').charAt(0)}</span>
          </div>
        )}
        <div>
          <p className="text-sm font-bold text-gray-900">{friend?.displayName || '不明'}</p>
          <p className="text-xs text-gray-400">メッセージ履歴</p>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {loadingMessages ? (
          <p className="text-center text-gray-400 text-sm">読み込み中...</p>
        ) : messages.length === 0 ? (
          <p className="text-center text-gray-400 text-sm">メッセージ履歴がありません</p>
        ) : (
          messages.map((msg) => (
            <div key={msg.id} className={`flex ${msg.direction === 'outgoing' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[75%] rounded-2xl px-4 py-2 ${
                msg.direction === 'outgoing'
                  ? 'bg-green-500 text-white'
                  : 'bg-gray-100 text-gray-900'
              }`}>
                <p className="text-sm whitespace-pre-wrap break-words">{renderContent(msg)}</p>
                <p className={`text-xs mt-1 ${msg.direction === 'outgoing' ? 'text-green-200' : 'text-gray-400'}`}>
                  {new Date(msg.createdAt).toLocaleString('ja-JP', { hour: '2-digit', minute: '2-digit' })}
                </p>
              </div>
            </div>
          ))
        )}
      </div>
      {/* Template picker */}
      {showTemplates && (
        <div className="px-4 py-2 border-t border-gray-100 bg-gray-50 max-h-[200px] overflow-y-auto">
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs font-semibold text-gray-500">定型文を挿入</p>
            <button onClick={() => setShowTemplates(false)} className="text-xs text-gray-400 hover:text-gray-600">✕</button>
          </div>
          {templates.length === 0 ? (
            <p className="text-xs text-gray-400 py-2">テンプレートがありません</p>
          ) : (
            <div className="space-y-1">
              {templates.filter(t => t.messageType === 'text').map(t => (
                <button
                  key={t.id}
                  onClick={() => { setMessage(t.messageContent); setShowTemplates(false) }}
                  className="w-full text-left px-3 py-2 text-sm rounded-md hover:bg-white transition-colors border border-transparent hover:border-gray-200"
                >
                  <span className="font-medium text-gray-700">{t.name}</span>
                  <p className="text-xs text-gray-400 truncate mt-0.5">{t.messageContent}</p>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      <div className="px-4 py-3 border-t border-gray-200">
        <div className="flex gap-2">
          <button
            onClick={() => {
              if (!templatesLoaded) {
                fetchApi<{ success: boolean; data: TemplateItem[] }>('/api/templates')
                  .then(r => { if (r.success && r.data) setTemplates(r.data) })
                  .catch(() => {})
                  .finally(() => setTemplatesLoaded(true))
              }
              setShowTemplates(!showTemplates)
            }}
            className="px-2 py-2 rounded-lg border border-gray-300 text-gray-500 hover:bg-gray-50 transition-colors"
            title="定型文"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6z" />
            </svg>
          </button>
          <input
            type="text"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleSend()}
            placeholder="メッセージを入力..."
            className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
          />
          <button
            onClick={handleSend}
            disabled={!message.trim() || sending}
            className="px-4 py-2 rounded-lg text-white text-sm font-medium disabled:opacity-50"
            style={{ backgroundColor: '#06C755' }}
          >
            {sending ? '...' : '送信'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default function ChatsPage() {
  const { selectedAccountId } = useAccount()
  const [chats, setChats] = useState<Chat[]>([])
  const [allFriends, setAllFriends] = useState<FriendItem[]>([])
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null)
  const [selectedFriendId, setSelectedFriendId] = useState<string | null>(null)
  const [chatDetail, setChatDetail] = useState<ChatDetail | null>(null)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [operators, setOperators] = useState<Operator[]>([])
  const [operatorFilter, setOperatorFilter] = useState<string>('all') // 'all' | 'unassigned' | operator.id
  const [loading, setLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [error, setError] = useState('')
  const [messageContent, setMessageContent] = useState('')
  const [sending, setSending] = useState(false)
  const [notes, setNotes] = useState('')
  const [savingNotes, setSavingNotes] = useState(false)
  const [showLoadingIndicator, setShowLoadingIndicator] = useState(false)
  const [loadingSeconds, setLoadingSeconds] = useState(5)
  const lastLoadingTriggerAtRef = useRef<Record<string, number>>({})
  const [isMessageInputFocused, setIsMessageInputFocused] = useState(false)
  const messagesContainerRef = useRef<HTMLDivElement | null>(null)

  // Resizable split: user can drag divider between left (list) and right (detail).
  // Persisted in localStorage. Only applies on lg+ (desktop); mobile remains stacked.
  const LEFT_WIDTH_KEY = 'lh_chat_left_width'
  const MIN_LEFT = 260
  const MAX_LEFT = 720
  const DEFAULT_LEFT = 384
  const [leftWidth, setLeftWidth] = useState<number>(DEFAULT_LEFT)
  const splitContainerRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    try {
      const raw = localStorage.getItem(LEFT_WIDTH_KEY)
      if (raw) {
        const n = Number.parseInt(raw, 10)
        if (Number.isFinite(n)) setLeftWidth(Math.max(MIN_LEFT, Math.min(MAX_LEFT, n)))
      }
    } catch { /* ignore */ }
  }, [])
  useEffect(() => {
    try { localStorage.setItem(LEFT_WIDTH_KEY, String(leftWidth)) } catch { /* ignore */ }
  }, [leftWidth])

  const handleDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const container = splitContainerRef.current
    if (!container) return
    const containerRect = container.getBoundingClientRect()
    const startX = e.clientX
    const startWidth = leftWidth
    // Cap max width to half of container so right panel always has breathing room.
    const containerMax = Math.min(MAX_LEFT, Math.floor(containerRect.width * 0.7))
    const onMove = (ev: MouseEvent) => {
      const delta = ev.clientX - startX
      const next = Math.max(MIN_LEFT, Math.min(containerMax, startWidth + delta))
      setLeftWidth(next)
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }, [leftWidth])

  // Auto-mark chat as "in_progress" the first time an operator opens it.
  // Matches PC LINE UX: viewing clears the unread badge. Only triggers once per
  // chatId per session (tracked in a ref) so manually marking "未読に戻す" works.
  const autoMarkedRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    try {
      const rawEnabled = localStorage.getItem(SHOW_LOADING_PREF_KEY)
      const rawSeconds = localStorage.getItem(LOADING_SECONDS_PREF_KEY)
      if (rawEnabled !== null) setShowLoadingIndicator(rawEnabled === '1')
      if (rawSeconds) {
        const n = Number.parseInt(rawSeconds, 10)
        if (Number.isFinite(n) && n >= 5 && n <= 60) setLoadingSeconds(n)
      }
    } catch {
      // localStorage unavailable
    }
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem(SHOW_LOADING_PREF_KEY, showLoadingIndicator ? '1' : '0')
      localStorage.setItem(LOADING_SECONDS_PREF_KEY, String(loadingSeconds))
    } catch {
      // localStorage unavailable
    }
  }, [showLoadingIndicator, loadingSeconds])

  const loadChats = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const params: { status?: string; operatorId?: string; accountId?: string } = {}
      if (statusFilter !== 'all') params.status = statusFilter
      if (selectedAccountId) params.accountId = selectedAccountId
      if (operatorFilter !== 'all' && operatorFilter !== 'unassigned') {
        params.operatorId = operatorFilter
      }
      const [chatRes, friendRes, opRes] = await Promise.allSettled([
        api.chats.list(params),
        api.friends.list({ accountId: selectedAccountId || undefined, limit: '800' }),
        api.operators.list(),
      ])
      if (chatRes.status === 'fulfilled' && chatRes.value.success) {
        let rows = chatRes.value.data as unknown as Chat[]
        if (operatorFilter === 'unassigned') {
          rows = rows.filter((c) => !c.operatorId)
        }
        setChats(rows)
      }
      if (friendRes.status === 'fulfilled' && friendRes.value.success) {
        setAllFriends((friendRes.value.data as unknown as { items: FriendItem[] }).items)
      }
      if (opRes.status === 'fulfilled' && opRes.value.success) {
        setOperators((opRes.value.data as Operator[]).filter((o) => o.isActive !== false))
      }
    } catch {
      setError('チャットの読み込みに失敗しました。もう一度お試しください。')
    } finally {
      setLoading(false)
    }
  }, [statusFilter, operatorFilter, selectedAccountId])

  // silent=true -> don't toggle detailLoading (keeps the DOM mounted so scroll
  // position and notes field aren't disrupted during background polling).
  const loadChatDetail = useCallback(async (chatId: string, silent = false) => {
    if (!silent) setDetailLoading(true)
    try {
      const res = await api.chats.get(chatId)
      if (res.success) {
        const detail = res.data as unknown as ChatDetail
        setChatDetail(detail)
        // Only overwrite notes on initial load; silent refresh keeps user's in-progress typing.
        if (!silent) setNotes(detail.notes || '')
      }
    } catch {
      if (!silent) setError('チャット詳細の読み込みに失敗しました。')
    } finally {
      if (!silent) setDetailLoading(false)
    }
  }, [])

  useEffect(() => {
    loadChats()
  }, [loadChats])

  // Auto-refresh chat list every 15s + on tab visibility/focus,
  // so new LINE messages appear without a manual reload.
  useEffect(() => {
    const interval = setInterval(() => { loadChats() }, 15000)
    const onVisibility = () => { if (document.visibilityState === 'visible') loadChats() }
    const onFocus = () => loadChats()
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('focus', onFocus)
    return () => {
      clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('focus', onFocus)
    }
  }, [loadChats])

  // Auto-refresh detail of currently-selected chat every 10s (silent — no loading
  // state flicker, preserves scroll + notes input). Also silent-refresh on tab focus.
  useEffect(() => {
    if (!selectedChatId) return
    const refresh = () => loadChatDetail(selectedChatId, true)
    const interval = setInterval(refresh, 10000)
    const onVisibility = () => { if (document.visibilityState === 'visible') refresh() }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [selectedChatId, loadChatDetail])

  // Auto-clear unread badge when operator opens a chat: transition unread -> in_progress.
  // Fires only once per chatId per session, so operator can manually set "未読に戻す" afterwards.
  useEffect(() => {
    if (!selectedChatId || !chatDetail) return
    if (chatDetail.status !== 'unread') return
    if (autoMarkedRef.current.has(selectedChatId)) return
    autoMarkedRef.current.add(selectedChatId)
    api.chats.update(selectedChatId, { status: 'in_progress' })
      .then(() => {
        // Refresh list so status badge updates, and detail so local state matches.
        loadChats()
        loadChatDetail(selectedChatId, true)
      })
      .catch((err) => {
        console.error('auto-mark-as-in-progress failed', err)
        // Allow a later retry if it failed
        autoMarkedRef.current.delete(selectedChatId)
      })
  }, [selectedChatId, chatDetail, loadChats, loadChatDetail])

  useEffect(() => {
    if (selectedChatId) {
      loadChatDetail(selectedChatId)
    } else {
      setChatDetail(null)
    }
  }, [selectedChatId, loadChatDetail])

  // Scroll-to-bottom strategy:
  //   - When chat id changes (new chat opened): force scroll to bottom.
  //   - When new messages arrive: only scroll if user was already near the bottom
  //     (so we don't yank them away from old messages they were reading).
  const prevChatIdRef = useRef<string | null>(null)
  const prevMessageCountRef = useRef(0)
  useEffect(() => {
    const el = messagesContainerRef.current
    if (!el || !chatDetail?.messages) return
    const currentId = chatDetail.id
    const currentCount = chatDetail.messages.length
    const isNewChat = prevChatIdRef.current !== currentId
    const hasNewMessages = !isNewChat && currentCount > prevMessageCountRef.current
    // Consider "near bottom" as within 120px — user scroll is preserved otherwise.
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    const wasNearBottom = distanceFromBottom < 120

    if (isNewChat || (hasNewMessages && wasNearBottom)) {
      const id = requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight
      })
      prevChatIdRef.current = currentId
      prevMessageCountRef.current = currentCount
      return () => cancelAnimationFrame(id)
    }
    prevChatIdRef.current = currentId
    prevMessageCountRef.current = currentCount
  }, [chatDetail?.id, chatDetail?.messages?.length])

  const handleSelectChat = (chatId: string) => {
    setSelectedChatId(chatId)
    setMessageContent('')
  }

  const triggerLoadingAnimation = useCallback(async (chatId: string) => {
    if (!showLoadingIndicator) return

    const now = Date.now()
    const last = lastLoadingTriggerAtRef.current[chatId] ?? 0
    if (now - last < LOADING_REFRESH_INTERVAL_MS) return
    lastLoadingTriggerAtRef.current[chatId] = now

    try {
      await fetchApi<{ success: boolean }>(`/api/chats/${chatId}/loading`, {
        method: 'POST',
        body: JSON.stringify({ loadingSeconds }),
      })
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'unknown'
      setError(`ローディング表示の開始に失敗しました: ${detail}`)
    }
  }, [showLoadingIndicator, loadingSeconds])

  const handleSendMessage = async () => {
    if (!selectedChatId || !messageContent.trim()) return
    setSending(true)
    try {
      await api.chats.send(selectedChatId, {
        content: messageContent.trim(),
      })
      setMessageContent('')
      loadChatDetail(selectedChatId)
      loadChats()
    } catch {
      setError('メッセージの送信に失敗しました。')
    } finally {
      setSending(false)
    }
  }

  const handleStatusUpdate = async (newStatus: Chat['status']) => {
    if (!selectedChatId) return
    try {
      await api.chats.update(selectedChatId, { status: newStatus })
      loadChatDetail(selectedChatId)
      loadChats()
    } catch {
      setError('ステータスの更新に失敗しました。')
    }
  }

  const handleOperatorAssign = async (operatorId: string) => {
    if (!selectedChatId) return
    try {
      await api.chats.update(selectedChatId, { operatorId: operatorId || null })
      loadChatDetail(selectedChatId)
      loadChats()
    } catch {
      setError('担当者の更新に失敗しました。')
    }
  }

  const handleSaveNotes = async () => {
    if (!selectedChatId) return
    setSavingNotes(true)
    try {
      await api.chats.update(selectedChatId, { notes })
      loadChatDetail(selectedChatId)
    } catch {
      setError('メモの保存に失敗しました。')
    } finally {
      setSavingNotes(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSendMessage()
    }
  }

  return (
    <div className="-mt-4 lg:-mt-6">
      {/* Compact title: smaller than shared Header, pinned to top for max vertical space */}
      <div className="flex items-center justify-between mb-1.5">
        <h1 className="text-base lg:text-lg font-bold text-gray-900">オペレーターチャット</h1>
      </div>

      {/* Error */}
      {error && (
        <div className="mb-2 p-2 bg-red-50 border border-red-200 rounded-md text-red-700 text-xs">
          {error}
        </div>
      )}

      <div
        ref={splitContainerRef}
        className="flex h-[calc(100vh-88px)] lg:h-[calc(100vh-88px)]"
      >
        {/* Left Panel: Chat List — width is user-resizable on lg+ via divider */}
        <div
          className={`w-full lg:w-[var(--lh-left-w)] lg:flex-shrink-0 bg-white rounded-lg shadow-sm border border-gray-200 flex-col overflow-hidden ${selectedChatId ? 'hidden lg:flex' : 'flex'}`}
          style={{ ['--lh-left-w' as string]: `${leftWidth}px` } as React.CSSProperties}
        >
          {/* Status Filter Tabs */}
          <div className="flex border-b border-gray-200">
            {statusFilters.map((filter) => (
              <button
                key={filter.key}
                onClick={() => { setStatusFilter(filter.key); setSelectedChatId(null) }}
                className={`flex-1 px-3 py-2.5 min-h-[44px] text-xs font-medium transition-colors ${
                  statusFilter === filter.key
                    ? 'text-white'
                    : 'text-gray-600 hover:bg-gray-50'
                }`}
                style={statusFilter === filter.key ? { backgroundColor: '#06C755' } : undefined}
              >
                {filter.label}
              </button>
            ))}
          </div>

          {/* Operator Filter */}
          <div className="px-3 py-2 border-b border-gray-200 bg-gray-50">
            <label className="block text-[10px] text-gray-500 mb-1">担当者フィルター</label>
            <select
              value={operatorFilter}
              onChange={(e) => { setOperatorFilter(e.target.value); setSelectedChatId(null) }}
              className="w-full text-xs border border-gray-300 rounded-md px-2 py-1.5 bg-white focus:outline-none focus:ring-1 focus:ring-green-500"
            >
              <option value="all">すべて</option>
              <option value="unassigned">未対応キュー（未アサイン）</option>
              {operators.map((op) => (
                <option key={op.id} value={op.id}>{op.name}</option>
              ))}
            </select>
          </div>

          {/* Chat List */}
          <div className="flex-1 overflow-y-auto">
            {loading ? (
              <div>
                {[...Array(5)].map((_, i) => (
                  <div key={i} className="px-4 py-3 border-b border-gray-100 animate-pulse">
                    <div className="flex items-center gap-3">
                      <div className="flex-1 space-y-2">
                        <div className="h-3 bg-gray-200 rounded w-32" />
                        <div className="h-2 bg-gray-100 rounded w-20" />
                      </div>
                      <div className="h-5 bg-gray-100 rounded-full w-12" />
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <>
                {chats.map((chat) => {
                  const statusInfo = statusConfig[chat.status]
                  const isSelected = selectedChatId === chat.id
                  return (
                    <button
                      key={chat.id}
                      onClick={() => { setSelectedFriendId(null); handleSelectChat(chat.id); }}
                      className={`w-full text-left px-4 py-3 border-b border-gray-100 transition-colors ${
                        isSelected && !selectedFriendId ? 'bg-green-50' : 'hover:bg-gray-50'
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        {chat.friendPictureUrl ? (
                          <img src={chat.friendPictureUrl} alt="" className="w-10 h-10 rounded-full flex-shrink-0" />
                        ) : (
                          <div className="w-10 h-10 rounded-full bg-gray-200 flex items-center justify-center flex-shrink-0">
                            <span className="text-gray-500 text-sm">{chat.friendName.charAt(0)}</span>
                          </div>
                        )}
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-gray-900 truncate">{chat.friendName}</p>
                          <p className="text-xs text-gray-400 mt-0.5">{formatDatetime(chat.lastMessageAt)}</p>
                        </div>
                        <span className={`ml-2 inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium flex-shrink-0 ${statusInfo.className}`}>
                          {statusInfo.label}
                        </span>
                      </div>
                    </button>
                  )
                })}
              </>
            )}
          </div>
        </div>

        {/* Resizable divider — desktop only. Drag to resize left/right panels. */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="幅を調整（ドラッグ）"
          onMouseDown={handleDividerMouseDown}
          onDoubleClick={() => setLeftWidth(DEFAULT_LEFT)}
          title="ドラッグで幅調整 / ダブルクリックでリセット"
          className="hidden lg:flex items-center justify-center mx-1 w-2 cursor-col-resize group select-none"
        >
          <div className="w-0.5 h-16 rounded bg-gray-300 group-hover:bg-green-500 transition-colors" />
        </div>

        {/* Right Panel: Chat Detail */}
        <div className={`flex-1 min-w-0 bg-white rounded-lg shadow-sm border border-gray-200 flex-col overflow-hidden ${selectedChatId || selectedFriendId ? 'flex' : 'hidden lg:flex'}`}>
          {selectedFriendId && !selectedChatId ? (
            /* Direct message to friend without existing chat */
            <DirectMessagePanel
              friendId={selectedFriendId}
              friend={allFriends.find((f) => f.id === selectedFriendId) || null}
              onBack={() => setSelectedFriendId(null)}
              onSent={() => { setSelectedFriendId(null); loadChats(); }}
            />
          ) : !selectedChatId ? (
            <div className="flex-1 flex items-center justify-center">
              <p className="text-gray-400 text-sm">チャットを選択してください</p>
            </div>
          ) : detailLoading ? (
            <div className="flex-1 flex items-center justify-center">
              <p className="text-gray-400 text-sm">読み込み中...</p>
            </div>
          ) : chatDetail ? (
            <>
              {/* Chat Header */}
              <div className="px-4 py-4 border-b border-gray-200 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <button
                    onClick={() => setSelectedChatId(null)}
                    className="lg:hidden flex-shrink-0 p-1 -ml-1 text-gray-500 hover:text-gray-700"
                    aria-label="戻る"
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                    </svg>
                  </button>
                  {chatDetail.friendPictureUrl && (
                    <img src={chatDetail.friendPictureUrl} alt="" className="w-8 h-8 rounded-full flex-shrink-0" />
                  )}
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">
                      {chatDetail.friendName}
                    </p>
                    <span
                      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium mt-1 ${statusConfig[chatDetail.status].className}`}
                    >
                      {statusConfig[chatDetail.status].label}
                    </span>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    value={chatDetail.operatorId ?? ''}
                    onChange={(e) => handleOperatorAssign(e.target.value)}
                    className="text-xs border border-gray-300 rounded-md px-2 py-1 bg-white focus:outline-none focus:ring-1 focus:ring-green-500"
                    title="担当者"
                  >
                    <option value="">担当者未割当</option>
                    {operators.map((op) => (
                      <option key={op.id} value={op.id}>{op.name}</option>
                    ))}
                  </select>
                  {chatDetail.status !== 'unread' && (
                    <button
                      onClick={() => handleStatusUpdate('unread')}
                      className="px-3 py-1 min-h-[44px] lg:min-h-0 text-xs font-medium text-red-600 bg-red-50 hover:bg-red-100 rounded-md transition-colors"
                    >
                      未読に戻す
                    </button>
                  )}
                  {chatDetail.status !== 'in_progress' && (
                    <button
                      onClick={() => handleStatusUpdate('in_progress')}
                      className="px-3 py-1 min-h-[44px] lg:min-h-0 text-xs font-medium text-yellow-700 bg-yellow-50 hover:bg-yellow-100 rounded-md transition-colors"
                    >
                      対応中にする
                    </button>
                  )}
                  {chatDetail.status !== 'resolved' && (
                    <button
                      onClick={() => handleStatusUpdate('resolved')}
                      className="px-3 py-1 min-h-[44px] lg:min-h-0 text-xs font-medium text-green-700 bg-green-50 hover:bg-green-100 rounded-md transition-colors"
                    >
                      解決済にする
                    </button>
                  )}
                </div>
              </div>

              {/* Messages — LINE-style chat bubbles */}
              <div ref={messagesContainerRef} className="flex-1 overflow-y-auto p-4 space-y-2" style={{ backgroundColor: '#7494C0' }}>
                {(!chatDetail.messages || chatDetail.messages.length === 0) ? (
                  <div className="text-center py-8">
                    <p className="text-white/60 text-sm">メッセージはまだありません。</p>
                  </div>
                ) : (
                  (chatDetail.messages ?? []).map((msg) => {
                    const isOutgoing = msg.direction === 'outgoing'

                    // メッセージ表示の分岐
                    let bubbleContent: React.ReactNode
                    if (msg.messageType === 'flex') {
                      bubbleContent = (
                        <div className="max-w-[300px]">
                          <FlexPreviewComponent content={msg.content} maxWidth={280} />
                        </div>
                      )
                    } else if (msg.messageType === 'image') {
                      try {
                        const parsed = JSON.parse(msg.content)
                        bubbleContent = (
                          <img src={parsed.originalContentUrl || parsed.previewImageUrl} alt="" className="max-w-[200px] rounded" />
                        )
                      } catch {
                        bubbleContent = <span>🖼️ [画像]</span>
                      }
                    } else {
                      bubbleContent = <span>{msg.content}</span>
                    }

                    return (
                      <div
                        key={msg.id}
                        className={`flex items-end gap-2 ${isOutgoing ? 'justify-end' : 'justify-start'}`}
                      >
                        {/* 相手のアイコン（incoming のみ） */}
                        {!isOutgoing && (
                          chatDetail.friendPictureUrl ? (
                            <img src={chatDetail.friendPictureUrl} alt="" className="w-8 h-8 rounded-full flex-shrink-0 mb-1" />
                          ) : (
                            <div className="w-8 h-8 rounded-full bg-gray-300 flex-shrink-0 mb-1" />
                          )
                        )}

                        <div className={`flex flex-col ${isOutgoing ? 'items-end' : 'items-start'}`}>
                          {/* メッセージバブル */}
                          <div
                            className={`max-w-[min(85%,640px)] px-3 py-2 text-sm break-words whitespace-pre-wrap ${
                              isOutgoing
                                ? 'rounded-tl-2xl rounded-tr-md rounded-bl-2xl rounded-br-2xl text-white'
                                : 'rounded-tl-md rounded-tr-2xl rounded-bl-2xl rounded-br-2xl bg-white text-gray-900'
                            }`}
                            style={isOutgoing ? { backgroundColor: '#06C755' } : undefined}
                          >
                            {bubbleContent}
                          </div>
                          {/* 時刻 */}
                          <span className="text-xs text-white/50 mt-0.5 px-1">
                            {new Date(msg.createdAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}
                          </span>
                        </div>
                      </div>
                    )
                  })
                )}
              </div>

              {/* Compact bottom: notes (collapsible) + send form */}
              <div className="border-t border-gray-200 bg-white">
                {/* Notes — compact, click to edit */}
                <details className="border-b border-gray-100 px-4">
                  <summary className="py-1.5 text-xs text-gray-500 cursor-pointer hover:text-gray-700 select-none list-none flex items-center gap-1">
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                    メモ{notes ? `: ${notes.slice(0, 40)}${notes.length > 40 ? '...' : ''}` : ''}
                  </summary>
                  <div className="py-2 flex items-center gap-2">
                    <input
                      type="text"
                      value={notes}
                      onChange={(e) => setNotes(e.target.value)}
                      placeholder="この友だちに関するメモ..."
                      className="flex-1 text-xs border border-gray-300 rounded-md px-2 py-1 bg-white focus:outline-none focus:ring-1 focus:ring-green-500"
                    />
                    <button
                      onClick={handleSaveNotes}
                      disabled={savingNotes}
                      className="px-2 py-1 text-xs font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-md transition-colors disabled:opacity-50"
                    >
                      {savingNotes ? '...' : '保存'}
                    </button>
                  </div>
                </details>

              {/* Send Message Form — single compact row */}
              <div className="px-4 py-2">
                <div className="flex items-center gap-2 mb-1.5 text-[11px] text-gray-500">
                  <label className="inline-flex items-center gap-1 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={showLoadingIndicator}
                      onChange={(e) => setShowLoadingIndicator(e.target.checked)}
                      className="h-3 w-3 rounded border-gray-300 text-green-600 focus:ring-green-500"
                    />
                    入力中ローディング
                  </label>
                  <select
                    value={loadingSeconds}
                    onChange={(e) => setLoadingSeconds(Number.parseInt(e.target.value, 10))}
                    disabled={!showLoadingIndicator}
                    className="text-[11px] border border-gray-300 rounded-md px-1 py-0.5 bg-white disabled:bg-gray-100 disabled:text-gray-400"
                  >
                    {[5, 10, 15, 20, 30, 45, 60].map((sec) => (
                      <option key={sec} value={sec}>{sec}秒</option>
                    ))}
                  </select>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={messageContent}
                    onChange={(e) => {
                      const value = e.target.value
                      setMessageContent(value)
                      if (selectedChatId && isMessageInputFocused && value.trim()) {
                        void triggerLoadingAnimation(selectedChatId)
                      }
                    }}
                    onFocus={() => {
                      setIsMessageInputFocused(true)
                      if (selectedChatId) {
                        void triggerLoadingAnimation(selectedChatId)
                      }
                    }}
                    onBlur={() => setIsMessageInputFocused(false)}
                    onKeyDown={handleKeyDown}
                    placeholder="メッセージを入力..."
                    className="flex-1 text-sm border border-gray-300 rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-green-500"
                  />
                  <button
                    onClick={handleSendMessage}
                    disabled={sending || !messageContent.trim()}
                    className="px-4 py-2 text-sm font-medium text-white rounded-lg transition-opacity hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
                    style={{ backgroundColor: '#06C755' }}
                  >
                    {sending ? '送信中...' : '送信'}
                  </button>
                </div>
              </div>
              </div>
            </>
          ) : null}
        </div>
      </div>
      <CcPromptButton prompts={ccPrompts} />
    </div>
  )
}
