'use client'

import { useState, useEffect } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { api, fetchApi } from '@/lib/api'
import type { FriendWithTags, FriendStatus } from '@/lib/api'
import type { Tag, StaffMember, ApiResponse } from '@line-crm/shared'
import Header from '@/components/layout/header'
import TagBadge from '@/components/friends/tag-badge'

// ─── Types ───

interface ShopifyOrder {
  id: string
  shopifyOrderId: string
  orderNumber: string | null
  totalPrice: number
  currency: string
  financialStatus: string
  fulfillmentStatus: string | null
  lineItems: Array<{ title: string; quantity: number; price: string }> | null
  createdAt: string
}

interface ChatMessage {
  id: string
  direction: 'incoming' | 'outgoing'
  messageType: string
  content: string
  createdAt: string
}

type ApiResponse_<T> = { success: boolean; data?: T; error?: string }

// ─── Status Config ───

const STATUS_OPTIONS: { value: FriendStatus; label: string; color: string }[] = [
  { value: 'none', label: '未設定', color: 'bg-gray-100 text-gray-500' },
  { value: 'prospect', label: '見込み', color: 'bg-blue-100 text-blue-700' },
  { value: 'active', label: 'アクティブ', color: 'bg-green-100 text-green-700' },
  { value: 'vip', label: 'VIP', color: 'bg-purple-100 text-purple-700' },
  { value: 'dormant', label: '休眠', color: 'bg-yellow-100 text-yellow-700' },
  { value: 'churned', label: '離脱', color: 'bg-red-100 text-red-700' },
]

function getStatusBadge(status: FriendStatus | undefined) {
  const opt = STATUS_OPTIONS.find((o) => o.value === (status ?? 'none')) ?? STATUS_OPTIONS[0]
  return <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium ${opt.color}`}>{opt.label}</span>
}

// ─── Helpers ───

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit' })
}

function formatDatetime(iso: string): string {
  return new Date(iso).toLocaleString('ja-JP', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  })
}

function formatCurrency(amount: number, currency: string): string {
  return new Intl.NumberFormat('ja-JP', { style: 'currency', currency: currency || 'JPY' }).format(amount)
}

// ─── Page ───

type ActiveTab = 'overview' | 'orders' | 'messages'

export default function FriendDetailPage() {
  const searchParams = useSearchParams()
  const id = searchParams.get('id') ?? ''

  const [friend, setFriend] = useState<FriendWithTags | null>(null)
  const [orders, setOrders] = useState<ShopifyOrder[]>([])
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [allTags, setAllTags] = useState<Tag[]>([])
  const [staffList, setStaffList] = useState<StaffMember[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [activeTab, setActiveTab] = useState<ActiveTab>('overview')

  // Profile editing
  const [editing, setEditing] = useState(false)
  const [profileForm, setProfileForm] = useState({ phone: '', email: '', address: '', memo: '' })
  const [saving, setSaving] = useState(false)

  const loadFriend = async () => {
    try {
      const res = await api.friends.get(id)
      if (res.success && res.data) {
        setFriend(res.data)
        setProfileForm({
          phone: res.data.phone ?? '',
          email: res.data.email ?? '',
          address: res.data.address ?? '',
          memo: res.data.memo ?? '',
        })
      }
    } catch {
      setError('友だち情報の取得に失敗しました')
    }
  }

  useEffect(() => {
    const load = async () => {
      setLoading(true)
      await Promise.all([
        loadFriend(),
        api.tags.list().then(r => { if (r.success && r.data) setAllTags(r.data) }).catch(() => {}),
        api.staff.list().then(r => { if (r.success && r.data) setStaffList(r.data) }).catch(() => {}),
        fetchApi<ApiResponse_<ShopifyOrder[]>>(`/api/integrations/shopify/orders?friendId=${id}&limit=50`)
          .then(r => { if (r.success && r.data) setOrders(r.data) }).catch(() => {}),
        fetchApi<ApiResponse_<{ results: ChatMessage[] }>>(`/api/friends/${id}/messages`)
          .then(r => { if (r.success && r.data) setMessages(r.data.results ?? []) }).catch(() => {}),
      ])
      setLoading(false)
    }
    load()
  }, [id])

  const flash = (msg: string) => { setSuccess(msg); setTimeout(() => setSuccess(''), 3000) }

  const handleStatusChange = async (status: FriendStatus) => {
    try {
      await api.friends.updateStatus(id, status)
      flash('ステータスを更新しました')
      loadFriend()
    } catch { setError('ステータスの更新に失敗しました') }
  }

  const handleAssignStaff = async (staffId: string) => {
    try {
      await api.friends.assignStaff(id, staffId || null)
      flash('担当者を更新しました')
      loadFriend()
    } catch { setError('担当者の割り当てに失敗しました') }
  }

  const handleSaveProfile = async () => {
    setSaving(true)
    try {
      await api.friends.updateProfile(id, profileForm)
      setEditing(false)
      flash('プロフィールを保存しました')
      loadFriend()
    } catch { setError('プロフィールの保存に失敗しました') }
    finally { setSaving(false) }
  }

  const handleAddTag = async (tagId: string) => {
    try {
      await api.friends.addTag(id, tagId)
      flash('タグを追加しました')
      loadFriend()
    } catch { setError('タグの追加に失敗しました') }
  }

  const handleRemoveTag = async (tagId: string) => {
    try {
      await api.friends.removeTag(id, tagId)
      loadFriend()
    } catch { setError('タグの削除に失敗しました') }
  }

  if (loading) {
    return (
      <div>
        <Header title="友だち詳細" />
        <div className="animate-pulse space-y-4">
          <div className="h-32 bg-gray-200 rounded-lg" />
          <div className="h-64 bg-gray-200 rounded-lg" />
        </div>
      </div>
    )
  }

  if (!friend) {
    return (
      <div>
        <Header title="友だち詳細" />
        <div className="bg-white rounded-lg border p-12 text-center text-gray-500">
          友だちが見つかりません
          <div className="mt-4"><Link href="/friends" className="text-green-600 hover:underline">← 一覧に戻る</Link></div>
        </div>
      </div>
    )
  }

  const availableTags = allTags.filter(t => !friend.tags.some(ft => ft.id === t.id))
  const totalSpent = orders.reduce((s, o) => s + (o.totalPrice || 0), 0)

  const TABS: { key: ActiveTab; label: string; count?: number }[] = [
    { key: 'overview', label: '概要' },
    { key: 'orders', label: '購入履歴', count: orders.length },
    { key: 'messages', label: 'メッセージ', count: messages.length },
  ]

  return (
    <div>
      <Header title="友だち詳細" />

      {error && <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-700 rounded-lg text-sm">{error}</div>}
      {success && <div className="mb-4 p-3 bg-green-50 border border-green-200 text-green-700 rounded-lg text-sm">{success}</div>}

      {/* Back link */}
      <div className="mb-4">
        <Link href="/friends" className="text-sm text-gray-500 hover:text-green-600 transition-colors">← 友だち一覧に戻る</Link>
      </div>

      {/* Profile header card */}
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-5 mb-6">
        <div className="flex items-start gap-4">
          {friend.pictureUrl ? (
            <img src={friend.pictureUrl} alt={friend.displayName} className="w-16 h-16 rounded-full object-cover bg-gray-100" />
          ) : (
            <div className="w-16 h-16 rounded-full bg-gray-200 flex items-center justify-center text-gray-500 text-2xl font-medium">
              {friend.displayName?.charAt(0) ?? '?'}
            </div>
          )}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3 flex-wrap">
              <h2 className="text-xl font-bold text-gray-900">{friend.displayName}</h2>
              {friend.isFollowing ? (
                <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700">フォロー中</span>
              ) : (
                <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-500">ブロック/退会</span>
              )}
              {getStatusBadge(friend.status)}
            </div>
            {friend.statusMessage && <p className="text-sm text-gray-400 mt-1">{friend.statusMessage}</p>}
            <p className="text-xs text-gray-400 font-mono mt-1">{friend.lineUserId}</p>
            <p className="text-xs text-gray-400 mt-1">登録日: {formatDate(friend.createdAt)}</p>
          </div>

          {/* KPI cards */}
          <div className="flex gap-3 shrink-0">
            <div className="text-center px-4 py-2 bg-blue-50 rounded-lg">
              <p className="text-2xl font-bold text-blue-700">{orders.length}</p>
              <p className="text-xs text-blue-600">購入回数</p>
            </div>
            <div className="text-center px-4 py-2 bg-green-50 rounded-lg">
              <p className="text-2xl font-bold text-green-700">{formatCurrency(totalSpent, 'JPY')}</p>
              <p className="text-xs text-green-600">累計購入額</p>
            </div>
            <div className="text-center px-4 py-2 bg-purple-50 rounded-lg">
              <p className="text-2xl font-bold text-purple-700">{messages.length}</p>
              <p className="text-xs text-purple-600">メッセージ</p>
            </div>
          </div>
        </div>

        {/* Quick actions row */}
        <div className="flex items-center gap-4 mt-4 pt-4 border-t border-gray-100">
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">ステータス:</span>
            <select
              className="text-sm border border-gray-300 rounded-md px-2 py-1 focus:ring-2 focus:ring-green-500"
              value={friend.status ?? 'none'}
              onChange={(e) => handleStatusChange(e.target.value as FriendStatus)}
            >
              {STATUS_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">担当者:</span>
            <select
              className="text-sm border border-gray-300 rounded-md px-2 py-1 focus:ring-2 focus:ring-green-500"
              value={friend.assignedStaffId ?? ''}
              onChange={(e) => handleAssignStaff(e.target.value)}
            >
              <option value="">未割り当て</option>
              {staffList.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="border-b border-gray-200 mb-6">
        <nav className="flex gap-6">
          {TABS.map(tab => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`pb-3 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab.key
                  ? 'border-green-500 text-green-700'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              {tab.label}
              {tab.count !== undefined && (
                <span className="ml-1.5 px-1.5 py-0.5 text-xs rounded-full bg-gray-100 text-gray-500">{tab.count}</span>
              )}
            </button>
          ))}
        </nav>
      </div>

      {/* Tab content */}
      {activeTab === 'overview' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Profile info */}
          <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-5">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-semibold text-gray-900">プロフィール情報</h3>
              <button
                onClick={() => setEditing(!editing)}
                className="text-xs font-medium text-green-600 hover:text-green-700"
              >
                {editing ? 'キャンセル' : '編集'}
              </button>
            </div>
            {editing ? (
              <div className="space-y-3">
                {(['phone', 'email', 'address', 'memo'] as const).map(field => (
                  <div key={field}>
                    <label className="block text-xs text-gray-500 mb-1">
                      {{ phone: '電話番号', email: 'メールアドレス', address: '住所', memo: 'メモ' }[field]}
                    </label>
                    {field === 'memo' ? (
                      <textarea
                        className="w-full text-sm border border-gray-300 rounded-md px-3 py-1.5 focus:ring-2 focus:ring-green-500 resize-none"
                        rows={3}
                        value={profileForm[field]}
                        onChange={(e) => setProfileForm({ ...profileForm, [field]: e.target.value })}
                      />
                    ) : (
                      <input
                        type={field === 'email' ? 'email' : 'text'}
                        className="w-full text-sm border border-gray-300 rounded-md px-3 py-1.5 focus:ring-2 focus:ring-green-500"
                        value={profileForm[field]}
                        onChange={(e) => setProfileForm({ ...profileForm, [field]: e.target.value })}
                      />
                    )}
                  </div>
                ))}
                <button
                  onClick={handleSaveProfile}
                  disabled={saving}
                  className="px-4 py-1.5 text-xs font-medium text-white rounded-md disabled:opacity-50"
                  style={{ backgroundColor: '#06C755' }}
                >
                  {saving ? '保存中...' : '保存'}
                </button>
              </div>
            ) : (
              <dl className="space-y-2 text-sm">
                {[
                  { label: '電話番号', value: friend.phone },
                  { label: 'メールアドレス', value: friend.email },
                  { label: '住所', value: friend.address },
                  { label: 'メモ', value: friend.memo },
                ].map(item => (
                  <div key={item.label} className="flex">
                    <dt className="w-28 text-gray-400 shrink-0">{item.label}</dt>
                    <dd className="text-gray-700">{item.value || '—'}</dd>
                  </div>
                ))}
              </dl>
            )}
          </div>

          {/* Tags */}
          <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-5">
            <h3 className="font-semibold text-gray-900 mb-4">タグ</h3>
            <div className="flex flex-wrap gap-1.5 mb-3">
              {friend.tags.length > 0 ? (
                friend.tags.map(tag => (
                  <TagBadge key={tag.id} tag={tag} onRemove={() => handleRemoveTag(tag.id)} />
                ))
              ) : (
                <span className="text-sm text-gray-400">タグなし</span>
              )}
            </div>
            {availableTags.length > 0 && (
              <select
                className="text-sm border border-gray-300 rounded-md px-2 py-1.5 focus:ring-2 focus:ring-green-500"
                value=""
                onChange={(e) => { if (e.target.value) handleAddTag(e.target.value) }}
              >
                <option value="">＋ タグを追加...</option>
                {availableTags.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            )}
          </div>

          {/* Recent orders summary */}
          <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-5">
            <h3 className="font-semibold text-gray-900 mb-4">直近の購入</h3>
            {orders.length === 0 ? (
              <p className="text-sm text-gray-400">購入履歴はありません</p>
            ) : (
              <div className="space-y-2">
                {orders.slice(0, 5).map(order => (
                  <div key={order.id} className="flex items-center justify-between py-2 border-b border-gray-50 last:border-0">
                    <div>
                      <p className="text-sm font-medium text-gray-700">#{order.orderNumber || order.shopifyOrderId}</p>
                      <p className="text-xs text-gray-400">{formatDate(order.createdAt)}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-semibold text-gray-900">{formatCurrency(order.totalPrice, order.currency)}</p>
                      <p className="text-xs text-gray-400">
                        {order.fulfillmentStatus === 'fulfilled' ? '✅ 配送済' :
                         order.fulfillmentStatus === 'partial' ? '📦 一部配送' : '⏳ 未配送'}
                      </p>
                    </div>
                  </div>
                ))}
                {orders.length > 5 && (
                  <button onClick={() => setActiveTab('orders')} className="text-xs text-green-600 hover:underline">
                    全{orders.length}件を表示 →
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Recent messages summary */}
          <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-5">
            <h3 className="font-semibold text-gray-900 mb-4">直近のメッセージ</h3>
            {messages.length === 0 ? (
              <p className="text-sm text-gray-400">メッセージ履歴はありません</p>
            ) : (
              <div className="space-y-2">
                {messages.slice(-5).reverse().map(msg => (
                  <div key={msg.id} className="flex gap-2 py-2 border-b border-gray-50 last:border-0">
                    <span className={`text-xs px-1.5 py-0.5 rounded ${
                      msg.direction === 'incoming' ? 'bg-blue-100 text-blue-600' : 'bg-gray-100 text-gray-500'
                    }`}>
                      {msg.direction === 'incoming' ? '受信' : '送信'}
                    </span>
                    <p className="text-sm text-gray-700 truncate flex-1">{msg.content}</p>
                    <span className="text-xs text-gray-400 shrink-0">{formatDatetime(msg.createdAt)}</span>
                  </div>
                ))}
                {messages.length > 5 && (
                  <button onClick={() => setActiveTab('messages')} className="text-xs text-green-600 hover:underline">
                    全{messages.length}件を表示 →
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {activeTab === 'orders' && (
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden">
          {orders.length === 0 ? (
            <div className="p-12 text-center text-gray-500">購入履歴はありません</div>
          ) : (
            <table className="w-full">
              <thead>
                <tr className="bg-gray-50 border-b">
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">注文番号</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">商品</th>
                  <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500">金額</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">ステータス</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">日時</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {orders.map(order => (
                  <tr key={order.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 text-sm font-medium text-gray-900">#{order.orderNumber || '—'}</td>
                    <td className="px-4 py-3 text-sm text-gray-600">
                      {order.lineItems
                        ? order.lineItems.map(li => `${li.title} ×${li.quantity}`).join(', ')
                        : '—'}
                    </td>
                    <td className="px-4 py-3 text-sm text-right font-semibold text-gray-900">
                      {formatCurrency(order.totalPrice, order.currency)}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                        order.financialStatus === 'paid' ? 'bg-green-100 text-green-700' :
                        order.financialStatus === 'refunded' ? 'bg-red-100 text-red-700' :
                        'bg-yellow-100 text-yellow-700'
                      }`}>
                        {order.financialStatus === 'paid' ? '支払済' :
                         order.financialStatus === 'refunded' ? '返金済' :
                         order.financialStatus || '—'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-500">{formatDatetime(order.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {activeTab === 'messages' && (
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-5">
          {messages.length === 0 ? (
            <div className="text-center text-gray-500 py-12">メッセージ履歴はありません</div>
          ) : (
            <div className="space-y-3 max-h-[600px] overflow-y-auto">
              {messages.map(msg => (
                <div
                  key={msg.id}
                  className={`flex ${msg.direction === 'outgoing' ? 'justify-end' : 'justify-start'}`}
                >
                  <div className={`max-w-[70%] rounded-2xl px-4 py-2.5 ${
                    msg.direction === 'outgoing'
                      ? 'bg-green-500 text-white rounded-br-md'
                      : 'bg-gray-100 text-gray-800 rounded-bl-md'
                  }`}>
                    <p className="text-sm whitespace-pre-wrap break-words">{msg.content}</p>
                    <p className={`text-xs mt-1 ${msg.direction === 'outgoing' ? 'text-green-200' : 'text-gray-400'}`}>
                      {formatDatetime(msg.createdAt)}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
