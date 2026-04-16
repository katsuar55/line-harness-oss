'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import type { Tag, StaffMember } from '@line-crm/shared'
import type { FriendWithTags, FriendStatus } from '@/lib/api'
import { api } from '@/lib/api'
import TagBadge from './tag-badge'

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
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${opt.color}`}>
      {opt.label}
    </span>
  )
}

interface FriendTableProps {
  friends: FriendWithTags[]
  allTags: Tag[]
  onRefresh: () => void
}

export default function FriendTable({ friends, allTags, onRefresh }: FriendTableProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [addingTagForFriend, setAddingTagForFriend] = useState<string | null>(null)
  const [selectedTagId, setSelectedTagId] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // Profile editing state
  const [editingProfile, setEditingProfile] = useState<string | null>(null)
  const [profileForm, setProfileForm] = useState({ phone: '', email: '', address: '', memo: '' })

  // Staff list for assignment
  const [staffList, setStaffList] = useState<StaffMember[]>([])
  const [staffLoaded, setStaffLoaded] = useState(false)

  useEffect(() => {
    if (!staffLoaded) {
      api.staff.list().then((res) => {
        if (res.success && res.data) setStaffList(res.data)
        setStaffLoaded(true)
      }).catch(() => setStaffLoaded(true))
    }
  }, [staffLoaded])

  const toggleExpand = (id: string) => {
    setExpandedId(expandedId === id ? null : id)
    setAddingTagForFriend(null)
    setSelectedTagId('')
    setEditingProfile(null)
    setError('')
  }

  const handleAddTag = async (friendId: string) => {
    if (!selectedTagId) return
    setLoading(true)
    setError('')
    try {
      await api.friends.addTag(friendId, selectedTagId)
      setAddingTagForFriend(null)
      setSelectedTagId('')
      onRefresh()
    } catch {
      setError('タグの追加に失敗しました')
    } finally {
      setLoading(false)
    }
  }

  const handleRemoveTag = async (friendId: string, tagId: string) => {
    setLoading(true)
    setError('')
    try {
      await api.friends.removeTag(friendId, tagId)
      onRefresh()
    } catch {
      setError('タグの削除に失敗しました')
    } finally {
      setLoading(false)
    }
  }

  const handleStatusChange = async (friendId: string, status: FriendStatus) => {
    setLoading(true)
    setError('')
    try {
      await api.friends.updateStatus(friendId, status)
      onRefresh()
    } catch {
      setError('ステータスの更新に失敗しました')
    } finally {
      setLoading(false)
    }
  }

  const startEditProfile = (friend: FriendWithTags) => {
    setEditingProfile(friend.id)
    setProfileForm({
      phone: friend.phone ?? '',
      email: friend.email ?? '',
      address: friend.address ?? '',
      memo: friend.memo ?? '',
    })
  }

  const handleSaveProfile = async (friendId: string) => {
    setLoading(true)
    setError('')
    try {
      await api.friends.updateProfile(friendId, profileForm)
      setEditingProfile(null)
      onRefresh()
    } catch {
      setError('プロフィールの保存に失敗しました')
    } finally {
      setLoading(false)
    }
  }

  const handleAssignStaff = async (friendId: string, staffId: string) => {
    setLoading(true)
    setError('')
    try {
      await api.friends.assignStaff(friendId, staffId || null)
      onRefresh()
    } catch {
      setError('担当者の割り当てに失敗しました')
    } finally {
      setLoading(false)
    }
  }

  const formatDate = (iso: string) => {
    return new Date(iso).toLocaleDateString('ja-JP', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
  }

  if (friends.length === 0) {
    return (
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-12 text-center">
        <p className="text-gray-500">友だちが見つかりません</p>
      </div>
    )
  }

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
      {error && (
        <div className="px-4 py-3 bg-red-50 border-b border-red-100 text-red-700 text-sm">
          {error}
        </div>
      )}
      <div className="overflow-x-auto">
      <table className="w-full min-w-[640px]">
        <thead>
          <tr className="bg-gray-50 border-b border-gray-200">
            <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
              アイコン / 表示名
            </th>
            <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
              ステータス
            </th>
            <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
              タグ / 流入
            </th>
            <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
              登録日
            </th>
            <th className="px-4 py-3" />
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {friends.map((friend) => {
            const isExpanded = expandedId === friend.id
            const isAddingTag = addingTagForFriend === friend.id
            const isEditingProfile = editingProfile === friend.id
            const availableTags = allTags.filter(
              (t) => !friend.tags.some((ft) => ft.id === t.id)
            )

            return (
              <>
                <tr
                  key={friend.id}
                  className="hover:bg-gray-50 cursor-pointer transition-colors"
                  onClick={() => toggleExpand(friend.id)}
                >
                  {/* Avatar + Name */}
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      {friend.pictureUrl ? (
                        <img
                          src={friend.pictureUrl}
                          alt={friend.displayName}
                          className="w-9 h-9 rounded-full object-cover bg-gray-100"
                        />
                      ) : (
                        <div className="w-9 h-9 rounded-full bg-gray-200 flex items-center justify-center text-gray-500 text-sm font-medium">
                          {friend.displayName?.charAt(0) ?? '?'}
                        </div>
                      )}
                      <div>
                        <p className="text-sm font-medium text-gray-900">{friend.displayName}</p>
                        {friend.statusMessage && (
                          <p className="text-xs text-gray-400 truncate max-w-[160px]">{friend.statusMessage}</p>
                        )}
                      </div>
                    </div>
                  </td>

                  {/* Status badges */}
                  <td className="px-4 py-3">
                    <div className="flex flex-col gap-1">
                      {friend.isFollowing ? (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700">
                          フォロー中
                        </span>
                      ) : (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-500">
                          ブロック/退会
                        </span>
                      )}
                      {getStatusBadge(friend.status)}
                    </div>
                  </td>

                  {/* Tags + Ref */}
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {(friend as unknown as { refCode?: string }).refCode && (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-700">
                          {(friend as unknown as { refCode: string }).refCode}
                        </span>
                      )}
                      {friend.tags.length > 0 ? (
                        friend.tags.map((tag) => <TagBadge key={tag.id} tag={tag} />)
                      ) : !((friend as unknown as { refCode?: string }).refCode) ? (
                        <span className="text-xs text-gray-400">なし</span>
                      ) : null}
                    </div>
                  </td>

                  {/* Registered date */}
                  <td className="px-4 py-3 text-sm text-gray-500">
                    {formatDate(friend.createdAt)}
                  </td>

                  {/* Expand indicator */}
                  <td className="px-4 py-3 text-right">
                    <svg
                      className={`w-4 h-4 text-gray-400 transition-transform inline-block ${isExpanded ? 'rotate-180' : ''}`}
                      fill="none" stroke="currentColor" viewBox="0 0 24 24"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </td>
                </tr>

                {/* Expanded detail row */}
                {isExpanded && (
                  <tr key={`${friend.id}-detail`} className="bg-gray-50">
                    <td colSpan={5} className="px-6 py-4">
                      <div className="space-y-4">
                        {/* LINE User ID */}
                        <div className="flex items-center justify-between">
                          <div>
                            <p className="text-xs font-semibold text-gray-500 mb-1">LINE ユーザーID</p>
                            <p className="text-xs text-gray-600 font-mono">{friend.lineUserId}</p>
                          </div>
                          <Link
                            href={`/friend-detail?id=${friend.id}`}
                            onClick={(e) => e.stopPropagation()}
                            className="px-3 py-1.5 text-xs font-medium rounded-md text-white transition-opacity hover:opacity-90"
                            style={{ backgroundColor: '#06C755' }}
                          >
                            詳細ページを開く →
                          </Link>
                        </div>

                        {/* CRM Status */}
                        <div onClick={(e) => e.stopPropagation()}>
                          <p className="text-xs font-semibold text-gray-500 mb-1">CRM ステータス</p>
                          <select
                            className="text-sm border border-gray-300 rounded-md px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-green-500 min-w-[140px]"
                            value={friend.status ?? 'none'}
                            onChange={(e) => handleStatusChange(friend.id, e.target.value as FriendStatus)}
                            disabled={loading}
                          >
                            {STATUS_OPTIONS.map((opt) => (
                              <option key={opt.value} value={opt.value}>{opt.label}</option>
                            ))}
                          </select>
                        </div>

                        {/* Staff Assignment */}
                        <div onClick={(e) => e.stopPropagation()}>
                          <p className="text-xs font-semibold text-gray-500 mb-1">担当者</p>
                          <select
                            className="text-sm border border-gray-300 rounded-md px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-green-500 min-w-[140px]"
                            value={friend.assignedStaffId ?? ''}
                            onChange={(e) => handleAssignStaff(friend.id, e.target.value)}
                            disabled={loading}
                          >
                            <option value="">未割り当て</option>
                            {staffList.map((s) => (
                              <option key={s.id} value={s.id}>{s.name}</option>
                            ))}
                          </select>
                        </div>

                        {/* Profile Section */}
                        <div onClick={(e) => e.stopPropagation()}>
                          <div className="flex items-center gap-2 mb-2">
                            <p className="text-xs font-semibold text-gray-500">プロフィール情報</p>
                            {!isEditingProfile && (
                              <button
                                onClick={() => startEditProfile(friend)}
                                className="text-xs font-medium text-green-600 hover:text-green-700 flex items-center gap-1 transition-colors"
                              >
                                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                                </svg>
                                編集
                              </button>
                            )}
                          </div>

                          {isEditingProfile ? (
                            <div className="space-y-2 max-w-md">
                              <div>
                                <label className="block text-xs text-gray-500 mb-0.5">電話番号</label>
                                <input
                                  type="tel"
                                  className="w-full text-sm border border-gray-300 rounded-md px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-green-500"
                                  value={profileForm.phone}
                                  onChange={(e) => setProfileForm({ ...profileForm, phone: e.target.value })}
                                  placeholder="090-1234-5678"
                                />
                              </div>
                              <div>
                                <label className="block text-xs text-gray-500 mb-0.5">メールアドレス</label>
                                <input
                                  type="email"
                                  className="w-full text-sm border border-gray-300 rounded-md px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-green-500"
                                  value={profileForm.email}
                                  onChange={(e) => setProfileForm({ ...profileForm, email: e.target.value })}
                                  placeholder="example@email.com"
                                />
                              </div>
                              <div>
                                <label className="block text-xs text-gray-500 mb-0.5">住所</label>
                                <input
                                  type="text"
                                  className="w-full text-sm border border-gray-300 rounded-md px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-green-500"
                                  value={profileForm.address}
                                  onChange={(e) => setProfileForm({ ...profileForm, address: e.target.value })}
                                  placeholder="東京都渋谷区..."
                                />
                              </div>
                              <div>
                                <label className="block text-xs text-gray-500 mb-0.5">メモ</label>
                                <textarea
                                  className="w-full text-sm border border-gray-300 rounded-md px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-green-500 resize-none"
                                  rows={2}
                                  value={profileForm.memo}
                                  onChange={(e) => setProfileForm({ ...profileForm, memo: e.target.value })}
                                  placeholder="自由メモ..."
                                />
                              </div>
                              <div className="flex gap-2 pt-1">
                                <button
                                  onClick={() => handleSaveProfile(friend.id)}
                                  disabled={loading}
                                  className="px-4 py-1.5 text-xs font-medium rounded-md text-white disabled:opacity-50 transition-opacity"
                                  style={{ backgroundColor: '#06C755' }}
                                >
                                  保存
                                </button>
                                <button
                                  onClick={() => setEditingProfile(null)}
                                  className="px-4 py-1.5 text-xs font-medium rounded-md text-gray-600 bg-gray-200 hover:bg-gray-300 transition-colors"
                                >
                                  キャンセル
                                </button>
                              </div>
                            </div>
                          ) : (
                            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                              <div>
                                <span className="text-xs text-gray-400">電話: </span>
                                <span className="text-gray-700">{friend.phone || '—'}</span>
                              </div>
                              <div>
                                <span className="text-xs text-gray-400">メール: </span>
                                <span className="text-gray-700">{friend.email || '—'}</span>
                              </div>
                              <div>
                                <span className="text-xs text-gray-400">住所: </span>
                                <span className="text-gray-700">{friend.address || '—'}</span>
                              </div>
                              <div>
                                <span className="text-xs text-gray-400">メモ: </span>
                                <span className="text-gray-700">{friend.memo || '—'}</span>
                              </div>
                            </div>
                          )}
                        </div>

                        {/* Tag management */}
                        <div>
                          <p className="text-xs font-semibold text-gray-500 mb-2">タグ管理</p>
                          <div className="flex flex-wrap gap-1.5 mb-2">
                            {friend.tags.map((tag) => (
                              <TagBadge
                                key={tag.id}
                                tag={tag}
                                onRemove={() => handleRemoveTag(friend.id, tag.id)}
                              />
                            ))}
                          </div>

                          {isAddingTag ? (
                            <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                              <select
                                className="text-sm border border-gray-300 rounded-md px-2 py-1 focus:outline-none focus:ring-2 focus:ring-green-500"
                                value={selectedTagId}
                                onChange={(e) => setSelectedTagId(e.target.value)}
                              >
                                <option value="">タグを選択...</option>
                                {availableTags.map((tag) => (
                                  <option key={tag.id} value={tag.id}>{tag.name}</option>
                                ))}
                              </select>
                              <button
                                onClick={() => handleAddTag(friend.id)}
                                disabled={!selectedTagId || loading}
                                className="px-3 py-1 text-xs font-medium rounded-md text-white disabled:opacity-50 transition-opacity"
                                style={{ backgroundColor: '#06C755' }}
                              >
                                追加
                              </button>
                              <button
                                onClick={() => { setAddingTagForFriend(null); setSelectedTagId('') }}
                                className="px-3 py-1 text-xs font-medium rounded-md text-gray-600 bg-gray-200 hover:bg-gray-300 transition-colors"
                              >
                                キャンセル
                              </button>
                            </div>
                          ) : (
                            availableTags.length > 0 && (
                              <button
                                onClick={(e) => { e.stopPropagation(); setAddingTagForFriend(friend.id) }}
                                className="text-xs font-medium text-green-600 hover:text-green-700 flex items-center gap-1 transition-colors"
                              >
                                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                                </svg>
                                タグを追加
                              </button>
                            )
                          )}
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
              </>
            )
          })}
        </tbody>
      </table>
      </div>
    </div>
  )
}
