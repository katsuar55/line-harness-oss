'use client'

/**
 * Phase 5γ-5b: AI Conductor 統合 UI
 *
 * 4 種 conductor (scenario / rich-menu / form / message) を 1 ページにまとめた
 * Visual エディタ代替。 自然言語プロンプト → AI 生成 → JSON プレビュー。
 *
 * 大方針 1 (AI ネイティブ設計) の本丸 UI。 シナリオ / リッチメニュー / フォーム /
 * メッセージ作成 GUI を AI Conductor で代替する。
 *
 * 設計:
 * - tab 切替で 4 種を選択 (Claude Code 的シンプル UI)
 * - prompt textarea + Generate ボタン
 * - 結果は preview area に JSON で表示 + warnings + provider/model
 * - エラー時は HTTP status + code を表示 (400/502/503/504/500)
 */

import { useState, useCallback } from 'react'
import {
  api,
  type ConductorScenarioResult,
  type ConductorRichMenuResult,
  type ConductorFormResult,
  type ConductorMessageResult,
} from '@/lib/api'
import Header from '@/components/layout/header'

type ConductorKind = 'scenario' | 'rich-menu' | 'form' | 'message'

type ConductorResult =
  | { kind: 'scenario'; data: ConductorScenarioResult }
  | { kind: 'rich-menu'; data: ConductorRichMenuResult }
  | { kind: 'form'; data: ConductorFormResult }
  | { kind: 'message'; data: ConductorMessageResult }

interface ConductorError {
  message: string
  code?: string
  status?: number
}

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
]

// ============================================================
// メイン
// ============================================================

export default function ConductorPage() {
  const [activeKind, setActiveKind] = useState<ConductorKind>('scenario')
  const [prompt, setPrompt] = useState('')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<ConductorResult | null>(null)
  const [error, setError] = useState<ConductorError | null>(null)

  const activeTab = TABS.find((t) => t.kind === activeKind)!

  const handleGenerate = useCallback(async () => {
    const trimmed = prompt.trim()
    if (trimmed.length < 5) {
      setError({ message: 'プロンプトは 5 文字以上で入力してください', code: 'prompt_too_short' })
      return
    }
    if (trimmed.length > 4000) {
      setError({ message: 'プロンプトは 4000 文字以内で入力してください', code: 'prompt_too_long' })
      return
    }

    setLoading(true)
    setError(null)
    setResult(null)

    try {
      let resp
      switch (activeKind) {
        case 'scenario':
          resp = await api.conductor.scenario(trimmed)
          if (resp.success && resp.data) {
            setResult({ kind: 'scenario', data: resp.data })
          }
          break
        case 'rich-menu':
          resp = await api.conductor.richMenu(trimmed)
          if (resp.success && resp.data) {
            setResult({ kind: 'rich-menu', data: resp.data })
          }
          break
        case 'form':
          resp = await api.conductor.form(trimmed)
          if (resp.success && resp.data) {
            setResult({ kind: 'form', data: resp.data })
          }
          break
        case 'message':
          resp = await api.conductor.message(trimmed)
          if (resp.success && resp.data) {
            setResult({ kind: 'message', data: resp.data })
          }
          break
      }
      if (resp && !resp.success) {
        setError({
          message: resp.error ?? 'Unknown error',
        })
      }
    } catch (err) {
      // fetchApi throws on non-2xx response
      const message = err instanceof Error ? err.message : String(err)
      // try to extract code from message (fetchApi format: "API X: ...")
      const codeMatch = message.match(/code:\s*"?([a-z_]+)"?/i)
      setError({
        message,
        code: codeMatch?.[1],
      })
    } finally {
      setLoading(false)
    }
  }, [activeKind, prompt])

  const handleTabChange = (kind: ConductorKind) => {
    setActiveKind(kind)
    setResult(null)
    setError(null)
  }

  const handleExampleClick = (example: string) => {
    setPrompt(example)
    setError(null)
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <Header title="AI Conductor" />

      <div className="max-w-6xl mx-auto px-4 py-6 space-y-6">
        {/* Intro */}
        <div className="bg-white rounded-lg shadow-sm p-4 border border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900">
            自然言語から JSON を生成
          </h2>
          <p className="text-sm text-gray-600 mt-1">
            AI (Claude / Workers AI) がプロンプトから シナリオ / リッチメニュー / フォーム /
            メッセージテンプレートの構造化 JSON を生成します。 プレビュー確認後、
            既存の管理画面 (シナリオ / リッチメニュー / フォーム / テンプレート) で保存してください。
          </p>
        </div>

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
              </button>
            ))}
          </div>

          <div className="p-6 space-y-4">
            {/* Active tab description */}
            <p className="text-sm text-gray-600">{activeTab.description}</p>

            {/* Example prompts */}
            <div className="space-y-2">
              <div className="text-xs font-medium text-gray-500 uppercase tracking-wide">
                プロンプト例 (クリックで挿入)
              </div>
              <div className="flex flex-wrap gap-2">
                {activeTab.examplePrompts.map((example, i) => (
                  <button
                    key={i}
                    onClick={() => handleExampleClick(example)}
                    className="text-xs text-left px-3 py-1.5 bg-gray-100 hover:bg-gray-200 rounded-md text-gray-700"
                  >
                    {example.length > 50 ? example.slice(0, 50) + '…' : example}
                  </button>
                ))}
              </div>
            </div>

            {/* Prompt textarea */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                プロンプト (5〜4000 文字)
              </label>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder={activeTab.placeholder}
                rows={6}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm font-mono"
                disabled={loading}
              />
              <div className="text-xs text-gray-500 mt-1 text-right">
                {prompt.length} / 4000 文字
              </div>
            </div>

            {/* Generate button */}
            <div className="flex justify-end">
              <button
                onClick={handleGenerate}
                disabled={loading || prompt.trim().length < 5}
                className="px-6 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed text-white text-sm font-medium rounded-md transition-colors"
              >
                {loading ? 'AI 生成中…' : `${activeTab.label}を生成`}
              </button>
            </div>
          </div>
        </div>

        {/* Error display */}
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4">
            <div className="flex items-start space-x-3">
              <svg
                className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.072 16.5c-.77.833.192 2.5 1.732 2.5z"
                />
              </svg>
              <div className="flex-1">
                <div className="text-sm font-medium text-red-900">エラー</div>
                <div className="text-sm text-red-700 mt-1 break-words">
                  {error.message}
                </div>
                {error.code && (
                  <div className="text-xs text-red-600 mt-1 font-mono">
                    code: {error.code}
                  </div>
                )}
                {error.code === 'api_key_missing' && (
                  <div className="text-xs text-red-700 mt-2 p-2 bg-red-100 rounded">
                    ANTHROPIC_API_KEY が設定されていない可能性があります。
                    Workers AI へのフォールバックを有効化するには Cloudflare AI binding を確認してください。
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Result display */}
        {result && <ResultDisplay result={result} />}
      </div>
    </div>
  )
}

// ============================================================
// Result display
// ============================================================

function ResultDisplay({ result }: { result: ConductorResult }) {
  const [showRaw, setShowRaw] = useState(false)

  // common metadata
  const warnings = result.data.warnings
  const provider = result.data.provider
  const model = result.data.model

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
        <div className="flex items-center space-x-3">
          <span className="text-sm font-semibold text-gray-900">生成結果</span>
          <span className="text-xs px-2 py-0.5 bg-green-100 text-green-800 rounded-full">
            ✓ 成功
          </span>
        </div>
        <button
          onClick={() => setShowRaw(!showRaw)}
          className="text-xs text-blue-600 hover:text-blue-700 hover:underline"
        >
          {showRaw ? '整形表示に戻す' : '生 JSON を表示'}
        </button>
      </div>

      <div className="p-4 space-y-4">
        {/* Provider / model */}
        <div className="flex items-center space-x-2 text-xs text-gray-500">
          <span>provider:</span>
          <span className="font-mono px-2 py-0.5 bg-gray-100 rounded">{provider}</span>
          <span>model:</span>
          <span className="font-mono px-2 py-0.5 bg-gray-100 rounded">{model}</span>
        </div>

        {/* Warnings */}
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

        {/* Content */}
        {showRaw ? (
          <pre className="text-xs bg-gray-900 text-gray-100 p-4 rounded overflow-x-auto font-mono">
            {JSON.stringify(result.data, null, 2)}
          </pre>
        ) : (
          <FormattedResult result={result} />
        )}
      </div>
    </div>
  )
}

function FormattedResult({ result }: { result: ConductorResult }) {
  switch (result.kind) {
    case 'scenario':
      return <ScenarioPreview data={result.data} />
    case 'rich-menu':
      return <RichMenuPreview data={result.data} />
    case 'form':
      return <FormPreview data={result.data} />
    case 'message':
      return <MessagePreview data={result.data} />
  }
}

// ============================================================
// Per-kind preview components
// ============================================================

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
