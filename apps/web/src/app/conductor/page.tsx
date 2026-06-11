'use client'

/**
 * Phase 5γ-5: AI Conductor 統合 UI (chat-style)
 * Phase 5γ-6: chat 履歴形式 + URL query param + localStorage 永続化
 *
 * 4 種 conductor (scenario / rich-menu / form / message) を 1 ページにまとめた
 * Visual エディタ代替。 大方針 1 (AI ネイティブ設計) の「チャット + ボタン 両方併用」
 * を実現。
 *
 * 設計:
 * - tab 切替で 4 種を選択 (機能別「AI に作らせる」 ボタンは URL `?tab=...` で deep link)
 * - 入力欄は下部 (Claude Code 的)、 履歴は時系列で上に積まれる
 * - 各 turn 単位で「DB に保存」 可能 (workflow closure)
 * - 履歴は localStorage 永続化 (kind 別、 各 max 20 turns)
 *
 * 「履歴をクリア」 で現在 tab の履歴のみリセット (他 tab に影響なし)。
 */

import { useState, useCallback, useEffect, useRef, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import {
  api,
  type ConductorScenarioResult,
  type ConductorRichMenuResult,
  type ConductorFormResult,
  type ConductorMessageResult,
  type ConductorAutoReplyResult,
  type ConductorSegmentResult,
  type RichMenuArea,
} from '@/lib/api'
import Header from '@/components/layout/header'

// ============================================================
// 型
// ============================================================

type ConductorKind = 'scenario' | 'rich-menu' | 'form' | 'message' | 'auto-reply' | 'segment'

type ConductorResult =
  | { kind: 'scenario'; data: ConductorScenarioResult }
  | { kind: 'rich-menu'; data: ConductorRichMenuResult }
  | { kind: 'form'; data: ConductorFormResult }
  | { kind: 'message'; data: ConductorMessageResult }
  | { kind: 'auto-reply'; data: ConductorAutoReplyResult }
  | { kind: 'segment'; data: ConductorSegmentResult }

/**
 * auto-reply の保存前編集 draft。
 * AI が返した keyword / alternateKeywords (checkbox で採否) / matchType / responseContent を
 * オペレーターが調整してから保存する。
 */
interface AutoReplyDraft {
  keyword: string
  matchType: 'exact' | 'contains'
  responseContent: string
  alternates: Array<{ keyword: string; checked: boolean }>
}

function buildAutoReplyDraft(autoReply: ConductorAutoReplyResult['autoReply']): AutoReplyDraft {
  return {
    keyword: autoReply.keyword,
    matchType: autoReply.matchType,
    responseContent: autoReply.responseContent,
    alternates: (autoReply.alternateKeywords ?? []).map((k) => ({ keyword: k, checked: true })),
  }
}

interface ConductorError {
  message: string
  code?: string
}

interface ChatTurn {
  id: string
  kind: ConductorKind
  prompt: string
  timestamp: number
  status: 'loading' | 'success' | 'error'
  result?: ConductorResult
  error?: ConductorError
}

type SaveStatus =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'success'; id: string; viewPath: string }
  | { kind: 'error'; message: string }

const HISTORY_STORAGE_KEY = 'lh_conductor_history_v1'
const HISTORY_MAX_PER_KIND = 20
const VALID_KINDS: ConductorKind[] = ['scenario', 'rich-menu', 'form', 'message', 'auto-reply', 'segment']

// ============================================================
// Tab メタ情報
// ============================================================

const TABS: Array<{
  kind: ConductorKind
  label: string
  description: string
  placeholder: string
  examplePrompts: string[]
}> = [
  {
    kind: 'scenario',
    label: 'シナリオ',
    description: '友だち追加 / タグ付与をトリガーに、 ステップ配信のシナリオ JSON を AI 生成',
    placeholder:
      '例: 新規友だち追加から 3 ステップ welcome シナリオ。 1 ステップ目は挨拶、 2 ステップ目は 1 日後に商品紹介、 3 ステップ目は 3 日後に LIFF フォーム誘導',
    examplePrompts: [
      '新規友だち welcome 3 ステップ (挨拶 → 1 日後商品紹介 → 3 日後フォーム誘導)',
      'タグ「興味あり」付与後、 2 日おきに 5 ステップで商品情報を配信',
      '手動 broadcast 起点で 1 ステップ、 リサーチ用フォームへの案内',
    ],
  },
  {
    kind: 'rich-menu',
    label: 'リッチメニュー',
    description: 'LINE 公式リッチメニュー (RichMenuObject) JSON を AI 生成',
    placeholder:
      '例: LARGE (2500x1686) の 2x3 レイアウト、 6 ボタン。 左上: ショップ、 中央上: カート、 右上: 会員証、 左下: クーポン、 中央下: 履歴、 右下: お問い合わせ',
    examplePrompts: [
      'LARGE 6 ボタン: ショップ・カート・会員証・クーポン・履歴・お問い合わせ',
      'SMALL 3 ボタン: 商品一覧・キャンペーン・FAQ',
      'LARGE 4 ボタン: 商品ページ・予約・お問い合わせ・公式 LINE 友だち紹介',
    ],
  },
  {
    kind: 'form',
    label: 'フォーム',
    description: 'LIFF アンケート / 申込書フォーム JSON を AI 生成 (送信先は /api/forms)',
    placeholder:
      '例: 商品アンケート 3 質問 (メールアドレス必須、 年齢層 select、 ご感想 textarea)',
    examplePrompts: [
      '商品アンケート 3 質問 (メール必須 + 年齢層 select + 感想 textarea)',
      'お問い合わせフォーム (お名前 + メール + 件名 + 本文 + 連絡希望時間 radio)',
      '誕生月収集フォーム (お名前 + 誕生月 select)',
    ],
  },
  {
    kind: 'message',
    label: 'メッセージ',
    description: 'テンプレート (text/image/flex/carousel) JSON を AI 生成 (送信先は /api/templates)',
    placeholder:
      '例: 新商品の紹介 carousel メッセージ、 3 bubble (商品 A・B・C)、 各 bubble に「詳しく見る」 ボタン',
    examplePrompts: [
      'text: welcome メッセージ ({{name}} さん向け、 絵文字 1 つ)',
      'flex: 商品 1 件の カード ({{brand_name}} 商品紹介、 詳細ボタン付き)',
      'carousel: 3 商品の一覧 (各 bubble に画像 + 詳細ボタン)',
    ],
  },
  {
    kind: 'auto-reply',
    label: '自動応答',
    description: 'キーワード自動応答ルールを AI 起草 (保存先は /api/auto-replies、 採用キーワードごとに 1 行)',
    placeholder:
      '例: 営業時間を聞かれたら平日10時〜18時と案内して',
    examplePrompts: [
      '営業時間を聞かれたら平日10時〜18時と案内して',
      '解約方法を聞かれたらマイページの手順を案内して',
      '送料を聞かれたら全国一律550円、 5,000円以上のご注文で無料と案内して',
    ],
  },
  {
    kind: 'segment',
    label: 'セグメント',
    description: '配信対象のセグメント条件 JSON を AI 生成 (該当人数のドライラン確認可、 保存対象なし)',
    placeholder:
      '例: 注文2回以上でフォロー中の人',
    examplePrompts: [
      '注文2回以上でフォロー中の人',
      'VIPタグの人だけ',
      '累計購入額1万円以上でフォロー中の人',
    ],
  },
]

const KIND_LABEL: Record<ConductorKind, string> = {
  scenario: 'シナリオ',
  'rich-menu': 'リッチメニュー',
  form: 'フォーム',
  message: 'テンプレート',
  'auto-reply': '自動応答',
  segment: 'セグメント',
}

// segment rule type → 日本語チップラベル
const SEGMENT_RULE_LABEL: Record<string, string> = {
  tag_exists: 'タグあり',
  tag_not_exists: 'タグなし',
  group_exists: 'グループ所属',
  group_not_exists: 'グループ非所属',
  metadata_equals: '属性一致',
  metadata_not_equals: '属性不一致',
  ref_code: '流入経路',
  is_following: 'フォロー中',
  friend_status: 'ステータス',
  assigned_staff: '担当者',
  shopify_tag_exists: 'Shopifyタグあり',
  shopify_tag_not_exists: 'Shopifyタグなし',
  shopify_total_spent_gte: '累計購入額≥',
  shopify_orders_count_gte: '注文回数≥',
}

function formatSegmentRuleValue(value: unknown): string {
  // metadata 系は { key, value } object — key=value 形式で表示
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>
    if ('key' in obj && 'value' in obj) {
      return `${String(obj.key)}=${String(obj.value)}`
    }
    return JSON.stringify(value)
  }
  return String(value)
}

// ============================================================
// 履歴 (localStorage) 操作
// ============================================================

function loadHistory(): ChatTurn[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = localStorage.getItem(HISTORY_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return (parsed as ChatTurn[]).filter(
      (t) => t && typeof t === 'object' && VALID_KINDS.includes(t.kind),
    )
  } catch {
    return []
  }
}

function saveHistory(history: ChatTurn[]): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history))
  } catch {
    // QuotaExceededError 等は黙って無視 (履歴は best-effort)
  }
}

function trimHistory(history: ChatTurn[]): ChatTurn[] {
  // kind 別に max N 件まで保持。 新しい (timestamp 降順) を残す。
  const byKind = new Map<ConductorKind, ChatTurn[]>()
  for (const turn of history) {
    const arr = byKind.get(turn.kind) ?? []
    arr.push(turn)
    byKind.set(turn.kind, arr)
  }
  const result: ChatTurn[] = []
  for (const [, turns] of byKind) {
    const sorted = [...turns].sort((a, b) => b.timestamp - a.timestamp)
    result.push(...sorted.slice(0, HISTORY_MAX_PER_KIND))
  }
  // 全体を timestamp 昇順 (古い → 新しい) で返す
  return result.sort((a, b) => a.timestamp - b.timestamp)
}

// ============================================================
// 保存ロジック (5γ-5c)
// ============================================================

async function saveResult(
  result: ConductorResult,
  autoReplyDraft?: AutoReplyDraft | null,
): Promise<{ id: string; viewPath: string }> {
  switch (result.kind) {
    case 'auto-reply': {
      // operator が編集した draft を優先 (未編集なら AI 出力そのまま)
      const draft = autoReplyDraft ?? buildAutoReplyDraft(result.data.autoReply)
      const keywords = [
        draft.keyword.trim(),
        ...draft.alternates.filter((a) => a.checked).map((a) => a.keyword.trim()),
      ].filter((k) => k.length > 0)
      const unique = Array.from(new Set(keywords))
      if (unique.length === 0) {
        throw new Error('キーワードを 1 つ以上入力してください')
      }
      const responseContent = draft.responseContent.trim()
      if (responseContent.length === 0) {
        throw new Error('返信文を入力してください')
      }
      // 採用キーワードごとに 1 行 (auto_replies は 1 行 = 1 keyword)
      const ids: string[] = []
      for (const keyword of unique) {
        const resp = await api.autoReplies.create({
          keyword,
          matchType: draft.matchType,
          responseContent,
        })
        if (!resp.success) {
          throw new Error(
            ids.length > 0
              ? `${ids.length} 件保存後、 キーワード「${keyword}」の保存に失敗: ${resp.error}`
              : (resp.error ?? '自動応答の保存に失敗しました'),
          )
        }
        ids.push(resp.data.id)
      }
      return { id: ids[0], viewPath: '/auto-replies' }
    }

    case 'segment': {
      // MVP では永続化対象なし — UI 側で SaveSection を出さないため到達しない (防御的 throw)
      throw new Error('セグメントは保存対象がありません。「条件JSONをコピー」を利用してください')
    }

    case 'message': {
      const { template, messageContent, messageType } = result.data
      const resp = await api.templates.create({
        name: template.name,
        category: template.category ?? 'general',
        messageType,
        messageContent,
      })
      if (!resp.success) {
        throw new Error(resp.error ?? 'テンプレート保存に失敗しました')
      }
      return { id: resp.data.id, viewPath: '/templates' }
    }

    case 'form': {
      const { form } = result.data
      const resp = await api.forms.create({
        name: form.name,
        description: form.description,
        fields: form.fields,
        onSubmitTagId: form.onSubmitTagId,
        onSubmitScenarioId: form.onSubmitScenarioId,
        saveToMetadata: form.saveToMetadata,
      })
      if (!resp.success) {
        throw new Error(resp.error ?? 'フォーム保存に失敗しました')
      }
      return { id: resp.data.id, viewPath: '/form-submissions' }
    }

    case 'scenario': {
      const { scenario, steps } = result.data
      const scenarioResp = await api.scenarios.create({
        name: scenario.name,
        description: scenario.description,
        triggerType: scenario.triggerType,
        triggerTagId: scenario.triggerTagId,
        isActive: scenario.isActive,
      })
      if (!scenarioResp.success) {
        throw new Error(scenarioResp.error ?? 'シナリオ保存に失敗しました')
      }
      const scenarioId = scenarioResp.data.id
      for (const step of steps) {
        const stepResp = await api.scenarios.addStep(scenarioId, {
          stepOrder: step.stepOrder,
          delayMinutes: step.delayMinutes,
          messageType: step.messageType,
          messageContent: step.messageContent,
          channel: step.channel,
          conditionType: step.conditionType,
          conditionValue: step.conditionValue,
        })
        if (!stepResp.success) {
          throw new Error(
            `シナリオは作成されましたがステップ ${step.stepOrder} の保存に失敗: ${stepResp.error ?? 'unknown'}`,
          )
        }
      }
      return { id: scenarioId, viewPath: '/scenarios' }
    }

    case 'rich-menu': {
      const { richMenu } = result.data
      const resp = await api.richMenus.create({
        size: richMenu.size,
        selected: richMenu.selected,
        name: richMenu.name,
        chatBarText: richMenu.chatBarText,
        areas: richMenu.areas as unknown as RichMenuArea[],
      })
      if (!resp.success) {
        throw new Error(resp.error ?? 'リッチメニュー作成に失敗しました')
      }
      return { id: resp.data.richMenuId, viewPath: '/rich-menus' }
    }
  }
}

// ============================================================
// メイン (Suspense でラップ — useSearchParams のため)
// ============================================================

export default function ConductorPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-gray-500">読み込み中...</div>}>
      <ConductorPageInner />
    </Suspense>
  )
}

function ConductorPageInner() {
  const searchParams = useSearchParams()

  // URL `?tab=scenario` 等で初期 tab を deep link 指定可能
  const tabParam = searchParams.get('tab')
  const initialKind: ConductorKind =
    tabParam && VALID_KINDS.includes(tabParam as ConductorKind)
      ? (tabParam as ConductorKind)
      : 'scenario'

  const [activeKind, setActiveKind] = useState<ConductorKind>(initialKind)
  const [prompt, setPrompt] = useState('')
  const [loading, setLoading] = useState(false)
  const [history, setHistory] = useState<ChatTurn[]>([])
  const [inputError, setInputError] = useState<string | null>(null)
  const historyEndRef = useRef<HTMLDivElement>(null)

  // 初回マウントで履歴をロード
  useEffect(() => {
    setHistory(loadHistory())
  }, [])

  // 履歴変更時に localStorage 同期
  useEffect(() => {
    saveHistory(history)
  }, [history])

  // 新 turn 追加時、 末尾に scroll
  useEffect(() => {
    historyEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [history.length])

  const activeTab = TABS.find((t) => t.kind === activeKind)!

  // 現在 tab の履歴 (chronological)
  const filteredHistory = history.filter((t) => t.kind === activeKind)

  const handleGenerate = useCallback(async () => {
    const trimmed = prompt.trim()
    if (trimmed.length < 5) {
      setInputError('プロンプトは 5 文字以上で入力してください')
      return
    }
    if (trimmed.length > 4000) {
      setInputError('プロンプトは 4000 文字以内で入力してください')
      return
    }
    setInputError(null)

    const turnId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
    const newTurn: ChatTurn = {
      id: turnId,
      kind: activeKind,
      prompt: trimmed,
      timestamp: Date.now(),
      status: 'loading',
    }
    setHistory((prev) => trimHistory([...prev, newTurn]))
    setPrompt('')
    setLoading(true)

    try {
      let resp
      let result: ConductorResult | undefined
      switch (activeKind) {
        case 'scenario':
          resp = await api.conductor.scenario(trimmed)
          if (resp.success) result = { kind: 'scenario', data: resp.data }
          break
        case 'rich-menu':
          resp = await api.conductor.richMenu(trimmed)
          if (resp.success) result = { kind: 'rich-menu', data: resp.data }
          break
        case 'form':
          resp = await api.conductor.form(trimmed)
          if (resp.success) result = { kind: 'form', data: resp.data }
          break
        case 'message':
          resp = await api.conductor.message(trimmed)
          if (resp.success) result = { kind: 'message', data: resp.data }
          break
        case 'auto-reply':
          resp = await api.conductor.autoReply(trimmed)
          if (resp.success) result = { kind: 'auto-reply', data: resp.data }
          break
        case 'segment':
          resp = await api.conductor.segment(trimmed)
          if (resp.success) result = { kind: 'segment', data: resp.data }
          break
      }

      // resp は discriminated union — success 分岐は result が埋まる前に消化、
      // error 分岐は resp.success === false を確定してから error を取得。
      const errorMessage =
        resp && !resp.success ? resp.error : 'Unknown error'
      setHistory((prev) =>
        prev.map((t) =>
          t.id === turnId
            ? result
              ? { ...t, status: 'success' as const, result }
              : { ...t, status: 'error' as const, error: { message: errorMessage } }
            : t,
        ),
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const codeMatch = message.match(/code:\s*"?([a-z_]+)"?/i)
      setHistory((prev) =>
        prev.map((t) =>
          t.id === turnId
            ? {
                ...t,
                status: 'error' as const,
                error: { message, code: codeMatch?.[1] },
              }
            : t,
        ),
      )
    } finally {
      setLoading(false)
    }
  }, [activeKind, prompt])

  const handleTabChange = (kind: ConductorKind) => {
    setActiveKind(kind)
    setInputError(null)
  }

  const handleExampleClick = (example: string) => {
    setPrompt(example)
    setInputError(null)
  }

  const handleClearHistory = () => {
    if (!confirm(`${KIND_LABEL[activeKind]} の履歴をクリアしますか?`)) return
    setHistory((prev) => prev.filter((t) => t.kind !== activeKind))
  }

  const handleReusePrompt = (text: string) => {
    setPrompt(text)
    setInputError(null)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Ctrl/Cmd + Enter で送信
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault()
      if (!loading) handleGenerate()
    }
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <Header title="AI Conductor" />

      <div className="max-w-6xl mx-auto px-4 py-4 space-y-4">
        {/* Tabs */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
          <div className="flex border-b border-gray-200">
            {TABS.map((tab) => (
              <button
                key={tab.kind}
                onClick={() => handleTabChange(tab.kind)}
                className={`flex-1 px-4 py-3 text-sm font-medium transition-colors ${
                  activeKind === tab.kind
                    ? 'bg-blue-50 text-blue-700 border-b-2 border-blue-500'
                    : 'text-gray-600 hover:bg-gray-50'
                }`}
              >
                {tab.label}
                {history.filter((t) => t.kind === tab.kind).length > 0 && (
                  <span className="ml-2 text-xs px-1.5 py-0.5 bg-gray-200 text-gray-700 rounded-full">
                    {history.filter((t) => t.kind === tab.kind).length}
                  </span>
                )}
              </button>
            ))}
          </div>

          <div className="px-4 py-2 bg-gray-50 border-b border-gray-200 flex items-center justify-between text-xs">
            <div className="text-gray-600">{activeTab.description}</div>
            {filteredHistory.length > 0 && (
              <button
                onClick={handleClearHistory}
                className="text-gray-500 hover:text-red-600 hover:underline"
              >
                履歴をクリア ({filteredHistory.length})
              </button>
            )}
          </div>
        </div>

        {/* History (chat) */}
        <div className="space-y-3">
          {filteredHistory.length === 0 ? (
            <EmptyState
              activeTab={activeTab}
              onExampleClick={handleExampleClick}
            />
          ) : (
            filteredHistory.map((turn) => <ChatTurnView key={turn.id} turn={turn} onReuse={handleReusePrompt} />)
          )}
          <div ref={historyEndRef} />
        </div>

        {/* Input box (sticky bottom) */}
        <div className="sticky bottom-0 bg-gray-50 pt-3 pb-1 -mx-4 px-4 border-t border-gray-200">
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-3 space-y-2">
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={activeTab.placeholder}
              rows={3}
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono resize-y"
              disabled={loading}
            />
            {inputError && (
              <div className="text-xs text-red-600">{inputError}</div>
            )}
            <div className="flex items-center justify-between">
              <div className="text-xs text-gray-400">
                {prompt.length} / 4000 文字 ・ Ctrl+Enter で送信
              </div>
              <button
                onClick={handleGenerate}
                disabled={loading || prompt.trim().length < 5}
                className="px-5 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed text-white text-sm font-medium rounded-md transition-colors"
              >
                {loading ? 'AI 生成中…' : `${activeTab.label}を生成`}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ============================================================
// 空状態 (履歴なし時の hero)
// ============================================================

function EmptyState({
  activeTab,
  onExampleClick,
}: {
  activeTab: (typeof TABS)[number]
  onExampleClick: (s: string) => void
}) {
  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 text-center">
      <div className="text-4xl mb-3">💬</div>
      <h2 className="text-base font-semibold text-gray-900 mb-2">
        {activeTab.label} を自然言語で作成
      </h2>
      <p className="text-sm text-gray-600 mb-4">
        プロンプトを入力すると AI が構造化 JSON を生成し、 そのまま DB に保存できます。
      </p>
      <div className="space-y-2 max-w-xl mx-auto">
        <div className="text-xs font-medium text-gray-500 uppercase tracking-wide text-left">
          プロンプト例 (クリックで挿入)
        </div>
        {activeTab.examplePrompts.map((example, i) => (
          <button
            key={i}
            onClick={() => onExampleClick(example)}
            className="block w-full text-left text-xs px-3 py-2 bg-gray-50 hover:bg-blue-50 border border-gray-200 rounded text-gray-700"
          >
            {example}
          </button>
        ))}
      </div>
    </div>
  )
}

// ============================================================
// Chat turn (1 ターン = user prompt + AI response)
// ============================================================

function ChatTurnView({
  turn,
  onReuse,
}: {
  turn: ChatTurn
  onReuse: (prompt: string) => void
}) {
  return (
    <div className="space-y-2">
      {/* User prompt (right-aligned) */}
      <div className="flex justify-end">
        <div className="max-w-2xl bg-blue-600 text-white rounded-lg px-3 py-2 text-sm whitespace-pre-wrap break-words">
          {turn.prompt}
        </div>
      </div>

      {/* AI response (left-aligned) */}
      <div className="flex justify-start">
        <div className="w-full max-w-4xl bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
          {turn.status === 'loading' && (
            <div className="p-4 text-sm text-gray-500 flex items-center space-x-2">
              <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
              <span>AI 生成中…</span>
            </div>
          )}

          {turn.status === 'error' && turn.error && (
            <div className="p-4 space-y-2">
              <div className="flex items-start space-x-2">
                <svg className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.072 16.5c-.77.833.192 2.5 1.732 2.5z" />
                </svg>
                <div className="flex-1">
                  <div className="text-sm font-medium text-red-900">エラー</div>
                  <div className="text-sm text-red-700 mt-1 break-words">{turn.error.message}</div>
                  {turn.error.code && (
                    <div className="text-xs text-red-600 mt-1 font-mono">code: {turn.error.code}</div>
                  )}
                  {turn.error.code === 'api_key_missing' && (
                    <div className="text-xs text-red-700 mt-2 p-2 bg-red-100 rounded">
                      ANTHROPIC_API_KEY 未設定の可能性。 Workers AI フォールバックには Cloudflare AI binding 確認を。
                    </div>
                  )}
                </div>
              </div>
              <button
                onClick={() => onReuse(turn.prompt)}
                className="text-xs text-blue-600 hover:underline"
              >
                同じプロンプトをリトライ
              </button>
            </div>
          )}

          {turn.status === 'success' && turn.result && (
            <ResultView result={turn.result} onReuse={() => onReuse(turn.prompt)} />
          )}
        </div>
      </div>
    </div>
  )
}

// ============================================================
// Result view (1 turn の AI 成功 response)
// ============================================================

function ResultView({
  result,
  onReuse,
}: {
  result: ConductorResult
  onReuse: () => void
}) {
  const [showRaw, setShowRaw] = useState(false)
  const [saveStatus, setSaveStatus] = useState<SaveStatus>({ kind: 'idle' })
  // auto-reply のみ: 保存前にオペレーターが調整できる draft (他 kind では null のまま)
  const [autoReplyDraft, setAutoReplyDraft] = useState<AutoReplyDraft | null>(() =>
    result.kind === 'auto-reply' ? buildAutoReplyDraft(result.data.autoReply) : null,
  )

  const warnings = result.data.warnings
  const provider = result.data.provider
  const model = result.data.model

  const handleSave = useCallback(async () => {
    setSaveStatus({ kind: 'saving' })
    try {
      const { id, viewPath } = await saveResult(result, autoReplyDraft)
      setSaveStatus({ kind: 'success', id, viewPath })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setSaveStatus({ kind: 'error', message })
    }
  }, [result, autoReplyDraft])

  return (
    <div>
      <div className="px-4 py-2 border-b border-gray-200 bg-gray-50 flex items-center justify-between text-xs">
        <div className="flex items-center space-x-2">
          <span className="text-green-700 font-medium">✓ 生成成功</span>
          <span className="text-gray-500">・</span>
          <span className="font-mono text-gray-600">{provider}</span>
          <span className="text-gray-400 font-mono">{model}</span>
        </div>
        <div className="flex items-center space-x-3">
          <button
            onClick={onReuse}
            className="text-blue-600 hover:underline"
            title="このプロンプトを入力欄に挿入してリトライ"
          >
            ↻ 再生成
          </button>
          <button
            onClick={() => setShowRaw(!showRaw)}
            className="text-blue-600 hover:underline"
          >
            {showRaw ? '整形' : '生 JSON'}
          </button>
        </div>
      </div>

      <div className="p-4 space-y-4">
        {warnings.length > 0 && (
          <div className="bg-yellow-50 border border-yellow-200 rounded p-3">
            <div className="text-xs font-medium text-yellow-900 mb-1">⚠️ 警告</div>
            {warnings.map((w, i) => (
              <div key={i} className="text-xs text-yellow-800 break-words">
                {w}
              </div>
            ))}
          </div>
        )}

        {showRaw ? (
          <pre className="text-xs bg-gray-900 text-gray-100 p-4 rounded overflow-x-auto font-mono">
            {JSON.stringify(result.data, null, 2)}
          </pre>
        ) : (
          <FormattedResult
            result={result}
            autoReplyDraft={autoReplyDraft}
            onAutoReplyDraftChange={setAutoReplyDraft}
          />
        )}

        {result.kind === 'segment' ? (
          <div className="border-t border-gray-200 pt-3 text-xs text-gray-500">
            セグメントは MVP では DB 保存対象がありません。 「条件JSONをコピー」 で条件を取得し、 配信設定に貼り付けてください。
          </div>
        ) : (
          <SaveSection result={result} saveStatus={saveStatus} onSave={handleSave} onReset={() => setSaveStatus({ kind: 'idle' })} />
        )}
      </div>
    </div>
  )
}

// ============================================================
// Save section
// ============================================================

function SaveSection({
  result,
  saveStatus,
  onSave,
  onReset,
}: {
  result: ConductorResult
  saveStatus: SaveStatus
  onSave: () => void
  onReset: () => void
}) {
  const label = KIND_LABEL[result.kind]

  return (
    <div className="border-t border-gray-200 pt-3 space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div className="text-xs text-gray-600">
          プレビュー OK なら DB に直接保存 (確認しないと適用されません)
        </div>
        <button
          onClick={onSave}
          disabled={saveStatus.kind === 'saving' || saveStatus.kind === 'success'}
          className="px-4 py-2 bg-green-600 hover:bg-green-700 disabled:bg-gray-300 disabled:cursor-not-allowed text-white text-sm font-medium rounded-md transition-colors whitespace-nowrap"
        >
          {saveStatus.kind === 'saving'
            ? '保存中…'
            : saveStatus.kind === 'success'
              ? '✓ 保存済み'
              : `${label} を DB に保存`}
        </button>
      </div>

      {saveStatus.kind === 'success' && (
        <div className="bg-green-50 border border-green-200 rounded p-3 text-sm">
          <div className="font-medium text-green-900">✓ 保存しました</div>
          <div className="text-xs text-green-700 mt-1">
            ID:{' '}
            <code className="font-mono px-1.5 py-0.5 bg-green-100 rounded">
              {saveStatus.id}
            </code>
          </div>
          <a
            href={saveStatus.viewPath}
            className="inline-block mt-2 text-xs text-green-700 hover:text-green-900 underline"
          >
            {label}管理画面を開く →
          </a>
          {result.kind === 'rich-menu' && (
            <div className="text-xs text-yellow-700 mt-2 p-2 bg-yellow-50 border border-yellow-200 rounded">
              ⚠️ LINE 側でメニューを表示するには、 リッチメニュー管理画面で画像をアップロード + 「デフォルトに設定」 が必要です。
            </div>
          )}
        </div>
      )}

      {saveStatus.kind === 'error' && (
        <div className="bg-red-50 border border-red-200 rounded p-3 text-sm">
          <div className="font-medium text-red-900">✗ 保存失敗</div>
          <div className="text-xs text-red-700 mt-1 break-words">
            {saveStatus.message}
          </div>
          <button
            onClick={onReset}
            className="text-xs text-red-700 hover:text-red-900 underline mt-2"
          >
            リトライ
          </button>
        </div>
      )}
    </div>
  )
}

// ============================================================
// Formatted preview (kind-specific)
// ============================================================

function FormattedResult({
  result,
  autoReplyDraft,
  onAutoReplyDraftChange,
}: {
  result: ConductorResult
  autoReplyDraft: AutoReplyDraft | null
  onAutoReplyDraftChange: (draft: AutoReplyDraft) => void
}) {
  switch (result.kind) {
    case 'scenario':
      return <ScenarioPreview data={result.data} />
    case 'rich-menu':
      return <RichMenuPreview data={result.data} />
    case 'form':
      return <FormPreview data={result.data} />
    case 'message':
      return <MessagePreview data={result.data} />
    case 'auto-reply':
      return autoReplyDraft ? (
        <AutoReplyPreview draft={autoReplyDraft} onDraftChange={onAutoReplyDraftChange} />
      ) : null
    case 'segment':
      return <SegmentPreview data={result.data} />
  }
}

function ScenarioPreview({ data }: { data: ConductorScenarioResult }) {
  return (
    <div className="space-y-3">
      <div>
        <div className="text-xs font-medium text-gray-500 mb-1">シナリオ情報</div>
        <div className="bg-gray-50 rounded p-3 space-y-1 text-sm">
          <div>
            <span className="font-medium">名前:</span> {data.scenario.name}
          </div>
          {data.scenario.description && (
            <div>
              <span className="font-medium">説明:</span> {data.scenario.description}
            </div>
          )}
          <div>
            <span className="font-medium">トリガー:</span>{' '}
            <code className="text-xs px-1.5 py-0.5 bg-blue-100 text-blue-800 rounded">
              {data.scenario.triggerType}
            </code>
          </div>
        </div>
      </div>
      <div>
        <div className="text-xs font-medium text-gray-500 mb-1">
          ステップ ({data.steps.length} 件)
        </div>
        <div className="space-y-2">
          {data.steps.map((step, i) => (
            <div key={i} className="bg-gray-50 rounded p-3 text-sm">
              <div className="flex items-center justify-between mb-1">
                <span className="font-medium">Step {step.stepOrder}</span>
                <span className="text-xs text-gray-500">
                  +{step.delayMinutes} 分 ・ {step.messageType} ・ {step.channel}
                </span>
              </div>
              <div className="text-xs text-gray-700 whitespace-pre-wrap font-mono bg-white p-2 rounded border border-gray-200">
                {step.messageContent}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function RichMenuPreview({ data }: { data: ConductorRichMenuResult }) {
  const { richMenu } = data
  return (
    <div className="space-y-3">
      <div>
        <div className="text-xs font-medium text-gray-500 mb-1">リッチメニュー情報</div>
        <div className="bg-gray-50 rounded p-3 space-y-1 text-sm">
          <div>
            <span className="font-medium">名前:</span> {richMenu.name}
          </div>
          <div>
            <span className="font-medium">チャットバー:</span> {richMenu.chatBarText}
          </div>
          <div>
            <span className="font-medium">サイズ:</span>{' '}
            <code className="text-xs">
              {richMenu.size.width} x {richMenu.size.height}
            </code>
            {richMenu.size.height === 1686 && (
              <span className="text-xs text-gray-500 ml-2">(LARGE)</span>
            )}
            {richMenu.size.height === 843 && (
              <span className="text-xs text-gray-500 ml-2">(SMALL)</span>
            )}
          </div>
        </div>
      </div>
      <div>
        <div className="text-xs font-medium text-gray-500 mb-1">
          エリア ({richMenu.areas.length} 件)
        </div>
        <div className="space-y-2">
          {richMenu.areas.map((area, i) => (
            <div key={i} className="bg-gray-50 rounded p-3 text-sm">
              <div className="flex items-center justify-between mb-1">
                <span className="font-medium">エリア {i + 1}</span>
                <span className="text-xs text-gray-500 font-mono">
                  ({area.bounds.x}, {area.bounds.y}) {area.bounds.width}×{area.bounds.height}
                </span>
              </div>
              <pre className="text-xs bg-white p-2 rounded border border-gray-200 overflow-x-auto">
                {JSON.stringify(area.action, null, 2)}
              </pre>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function FormPreview({ data }: { data: ConductorFormResult }) {
  const { form } = data
  return (
    <div className="space-y-3">
      <div>
        <div className="text-xs font-medium text-gray-500 mb-1">フォーム情報</div>
        <div className="bg-gray-50 rounded p-3 space-y-1 text-sm">
          <div>
            <span className="font-medium">名前:</span> {form.name}
          </div>
          {form.description && (
            <div>
              <span className="font-medium">説明:</span> {form.description}
            </div>
          )}
          <div className="flex gap-4">
            <div>
              <span className="font-medium">送信内容保存:</span>{' '}
              {form.saveToMetadata ? '✓' : '×'}
            </div>
            <div>
              <span className="font-medium">公開:</span> {form.isActive ? '✓' : '×'}
            </div>
          </div>
        </div>
      </div>
      <div>
        <div className="text-xs font-medium text-gray-500 mb-1">
          フィールド ({form.fields.length} 件)
        </div>
        <div className="space-y-2">
          {form.fields.map((field, i) => (
            <div key={i} className="bg-gray-50 rounded p-3 text-sm">
              <div className="flex items-center justify-between">
                <div>
                  <span className="font-medium">{field.label}</span>
                  {field.required && <span className="text-red-500 ml-1">*</span>}
                </div>
                <code className="text-xs px-2 py-0.5 bg-blue-100 text-blue-800 rounded">
                  {field.type}
                </code>
              </div>
              <div className="text-xs text-gray-500 mt-1 font-mono">
                name: {field.name}
                {field.placeholder && ` ・ placeholder: "${field.placeholder}"`}
              </div>
              {field.options && field.options.length > 0 && (
                <div className="text-xs mt-2 space-y-0.5">
                  {field.options.map((opt, j) => (
                    <div key={j} className="pl-2 text-gray-700">
                      • {opt.label} <span className="text-gray-400">({opt.value})</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function MessagePreview({ data }: { data: ConductorMessageResult }) {
  const { template, messageContent, altText } = data
  return (
    <div className="space-y-3">
      <div>
        <div className="text-xs font-medium text-gray-500 mb-1">メッセージ情報</div>
        <div className="bg-gray-50 rounded p-3 space-y-1 text-sm">
          <div>
            <span className="font-medium">名前:</span> {template.name}
          </div>
          {template.category && (
            <div>
              <span className="font-medium">カテゴリ:</span> {template.category}
            </div>
          )}
          <div>
            <span className="font-medium">タイプ:</span>{' '}
            <code className="text-xs px-2 py-0.5 bg-purple-100 text-purple-800 rounded">
              {template.messageType}
            </code>
          </div>
          {altText && (
            <div>
              <span className="font-medium">代替テキスト:</span> {altText}
            </div>
          )}
        </div>
      </div>
      <div>
        <div className="text-xs font-medium text-gray-500 mb-1">
          コンテンツ (messageContent)
        </div>
        {template.messageType === 'text' ? (
          <div className="bg-green-50 border border-green-200 rounded p-3 text-sm whitespace-pre-wrap">
            {messageContent}
          </div>
        ) : (
          <pre className="text-xs bg-gray-900 text-gray-100 p-3 rounded overflow-x-auto font-mono">
            {(() => {
              try {
                return JSON.stringify(JSON.parse(messageContent), null, 2)
              } catch {
                return messageContent
              }
            })()}
          </pre>
        )}
      </div>
    </div>
  )
}

function AutoReplyPreview({
  draft,
  onDraftChange,
}: {
  draft: AutoReplyDraft
  onDraftChange: (draft: AutoReplyDraft) => void
}) {
  const checkedCount =
    (draft.keyword.trim().length > 0 ? 1 : 0) +
    draft.alternates.filter((a) => a.checked).length

  const toggleAlternate = (index: number) => {
    onDraftChange({
      ...draft,
      alternates: draft.alternates.map((a, i) =>
        i === index ? { ...a, checked: !a.checked } : a,
      ),
    })
  }

  return (
    <div className="space-y-3">
      <div>
        <div className="text-xs font-medium text-gray-500 mb-1">キーワード (編集可)</div>
        <input
          type="text"
          value={draft.keyword}
          onChange={(e) => onDraftChange({ ...draft, keyword: e.target.value })}
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          placeholder="例: 営業時間"
        />
      </div>

      {draft.alternates.length > 0 && (
        <div>
          <div className="text-xs font-medium text-gray-500 mb-1">
            類義キーワード候補 (チェックした分だけ同じ返信文で個別ルール化)
          </div>
          <div className="bg-gray-50 rounded p-3 space-y-1.5">
            {draft.alternates.map((alt, i) => (
              <label key={i} className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={alt.checked}
                  onChange={() => toggleAlternate(i)}
                  className="w-4 h-4 rounded border-gray-300"
                />
                <span>{alt.keyword}</span>
              </label>
            ))}
          </div>
        </div>
      )}

      <div>
        <div className="text-xs font-medium text-gray-500 mb-1">マッチ方式</div>
        <select
          value={draft.matchType}
          onChange={(e) =>
            onDraftChange({ ...draft, matchType: e.target.value as 'exact' | 'contains' })
          }
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
        >
          <option value="exact">完全一致 (exact)</option>
          <option value="contains">部分一致 (contains)</option>
        </select>
      </div>

      <div>
        <div className="text-xs font-medium text-gray-500 mb-1">返信文 (編集可)</div>
        <textarea
          value={draft.responseContent}
          onChange={(e) => onDraftChange({ ...draft, responseContent: e.target.value })}
          rows={4}
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y"
          placeholder="返信メッセージ本文"
        />
      </div>

      <div className="text-xs text-gray-500">
        保存時に {checkedCount} 件の自動応答ルールを作成します (1 キーワード = 1 ルール)
      </div>
    </div>
  )
}

type SegmentCountState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'done'; count: number }
  | { kind: 'error'; message: string }

function SegmentPreview({ data }: { data: ConductorSegmentResult }) {
  const [countState, setCountState] = useState<SegmentCountState>({ kind: 'idle' })
  const [copied, setCopied] = useState(false)

  const handleCount = async () => {
    setCountState({ kind: 'loading' })
    try {
      const resp = await api.segments.count(data.condition)
      if (resp.success) {
        setCountState({ kind: 'done', count: resp.data.count })
      } else {
        setCountState({ kind: 'error', message: resp.error })
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setCountState({ kind: 'error', message })
    }
  }

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(data.condition))
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // clipboard 不可環境 (非 https 等) では黙って無視
    }
  }

  return (
    <div className="space-y-3">
      <div>
        <div className="text-xs font-medium text-gray-500 mb-1">条件 (AI 解釈)</div>
        <div className="bg-gray-50 rounded p-3 text-sm text-gray-800">{data.humanReadable}</div>
      </div>

      <div>
        <div className="text-xs font-medium text-gray-500 mb-1">
          ルール ({data.condition.rules.length} 件 ・{' '}
          {data.condition.operator === 'AND' ? 'すべて満たす' : 'いずれか満たす'})
        </div>
        <div className="flex flex-wrap gap-2">
          {data.condition.rules.map((rule, i) => (
            <span
              key={i}
              className="inline-flex items-center gap-1 px-2.5 py-1 bg-blue-50 border border-blue-200 text-blue-800 rounded-full text-xs"
            >
              <span className="font-medium">{SEGMENT_RULE_LABEL[rule.type] ?? rule.type}</span>
              <span className="text-blue-600">{formatSegmentRuleValue(rule.value)}</span>
            </span>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <button
          onClick={handleCount}
          disabled={countState.kind === 'loading'}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed text-white text-sm font-medium rounded-md transition-colors"
        >
          {countState.kind === 'loading' ? '集計中…' : '該当人数を確認'}
        </button>
        <button
          onClick={handleCopy}
          className="px-4 py-2 bg-white hover:bg-gray-50 border border-gray-300 text-gray-700 text-sm font-medium rounded-md transition-colors"
        >
          {copied ? '✓ コピーしました' : '条件JSONをコピー'}
        </button>
        {countState.kind === 'done' && (
          <span className="text-sm font-semibold text-green-700">
            該当 {countState.count} 人
          </span>
        )}
        {countState.kind === 'error' && (
          <span className="text-xs text-red-600 break-words">{countState.message}</span>
        )}
      </div>
    </div>
  )
}
