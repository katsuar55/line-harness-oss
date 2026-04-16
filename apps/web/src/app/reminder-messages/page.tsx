'use client';

import { useState, useEffect, useCallback } from 'react';
import { fetchApi } from '@/lib/api';
import type { ApiResponse } from '@line-crm/shared';

interface ReminderMessage {
  id: string;
  time_slot: string;
  message: string;
  category: string;
  weight: number;
  is_active: number;
  created_at: string;
}

interface Stats {
  total: number;
  active: number;
  byTimeSlot: Array<{ time_slot: string; count: number; active_count: number }>;
}

interface ListResponse {
  messages: ReminderMessage[];
  total: number;
}

const TIME_SLOT_LABELS: Record<string, string> = {
  morning: '🌅 朝',
  noon: '☀️ 昼',
  evening: '🌙 夜',
  any: '🔄 共通',
};

const CATEGORIES = ['general', 'motivation', 'health_tip', 'beauty', 'lifestyle', 'care', 'seasonal'];

export default function ReminderMessagesPage() {
  const [messages, setMessages] = useState<ReminderMessage[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [filterSlot, setFilterSlot] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [showBulkModal, setShowBulkModal] = useState(false);
  const [editMsg, setEditMsg] = useState<ReminderMessage | null>(null);
  const [form, setForm] = useState({ timeSlot: 'any', message: '', category: 'general' });
  const [bulkText, setBulkText] = useState('');
  const [bulkSlot, setBulkSlot] = useState('any');
  const limit = 50;

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
      if (filterSlot) params.set('time_slot', filterSlot);
      const json = await fetchApi<ApiResponse<ListResponse>>(`/api/reminder-messages?${params}`);
      if (json.success && json.data) {
        setMessages(json.data.messages);
        setTotal(json.data.total);
      }
    } catch (err) {
      console.error('reminder-messages load failed:', err);
    }
  }, [offset, filterSlot]);

  const loadStats = useCallback(async () => {
    try {
      const json = await fetchApi<ApiResponse<Stats>>('/api/reminder-messages/stats');
      if (json.success && json.data) setStats(json.data);
    } catch (err) {
      console.error('reminder-messages stats failed:', err);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadStats(); }, [loadStats]);

  async function handleSave() {
    try {
      if (editMsg) {
        await fetchApi(`/api/reminder-messages/${editMsg.id}`, {
          method: 'PUT',
          body: JSON.stringify(form),
        });
      } else {
        await fetchApi('/api/reminder-messages', {
          method: 'POST',
          body: JSON.stringify(form),
        });
      }
      setShowModal(false);
      setEditMsg(null);
      setForm({ timeSlot: 'any', message: '', category: 'general' });
      load();
      loadStats();
    } catch (err) {
      console.error('reminder-messages save failed:', err);
    }
  }

  async function handleBulkImport() {
    const lines = bulkText.split('\n').filter((l) => l.trim());
    if (lines.length === 0) return;
    try {
      await fetchApi('/api/reminder-messages/bulk', {
        method: 'POST',
        body: JSON.stringify({
          messages: lines.map((line) => ({ timeSlot: bulkSlot, message: line.trim(), category: 'general' })),
        }),
      });
      setShowBulkModal(false);
      setBulkText('');
      load();
      loadStats();
    } catch (err) {
      console.error('reminder-messages bulk import failed:', err);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('削除しますか？')) return;
    try {
      await fetchApi(`/api/reminder-messages/${id}`, { method: 'DELETE' });
      load();
      loadStats();
    } catch (err) {
      console.error('reminder-messages delete failed:', err);
    }
  }

  async function toggleActive(msg: ReminderMessage) {
    try {
      await fetchApi(`/api/reminder-messages/${msg.id}`, {
        method: 'PUT',
        body: JSON.stringify({ isActive: !msg.is_active }),
      });
      load();
      loadStats();
    } catch (err) {
      console.error('reminder-messages toggle failed:', err);
    }
  }

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">リマインドメッセージ</h1>
          <p className="text-sm text-gray-500">毎日届くメッセージを管理（最大1000種）</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => { setShowBulkModal(true); }}
            className="px-4 py-2 text-sm font-medium text-green-700 bg-green-50 border border-green-200 rounded-lg hover:bg-green-100"
          >
            一括登録
          </button>
          <button
            onClick={() => { setEditMsg(null); setForm({ timeSlot: 'any', message: '', category: 'general' }); setShowModal(true); }}
            className="px-4 py-2 text-sm font-medium text-white bg-green-600 rounded-lg hover:bg-green-700"
          >
            ＋ 新規作成
          </button>
        </div>
      </div>

      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
          <div className="bg-white rounded-lg border p-3 text-center">
            <p className="text-2xl font-bold text-gray-800">{stats.total}</p>
            <p className="text-xs text-gray-500">合計</p>
          </div>
          <div className="bg-white rounded-lg border p-3 text-center">
            <p className="text-2xl font-bold text-green-600">{stats.active}</p>
            <p className="text-xs text-gray-500">有効</p>
          </div>
          {stats.byTimeSlot.map((s) => (
            <div key={s.time_slot} className="bg-white rounded-lg border p-3 text-center">
              <p className="text-2xl font-bold text-gray-700">{s.count}</p>
              <p className="text-xs text-gray-500">{TIME_SLOT_LABELS[s.time_slot] || s.time_slot}</p>
            </div>
          ))}
        </div>
      )}

      {/* Filter */}
      <div className="flex gap-2 mb-4">
        {['', 'morning', 'noon', 'evening', 'any'].map((slot) => (
          <button
            key={slot}
            onClick={() => { setFilterSlot(slot); setOffset(0); }}
            className={`px-3 py-1.5 rounded-full text-xs font-medium ${filterSlot === slot ? 'bg-green-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
          >
            {slot === '' ? '全て' : TIME_SLOT_LABELS[slot] || slot}
          </button>
        ))}
      </div>

      {/* Table */}
      <div className="bg-white rounded-lg border overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-500 text-xs">
            <tr>
              <th className="text-left p-3">時間帯</th>
              <th className="text-left p-3">メッセージ</th>
              <th className="text-left p-3">カテゴリ</th>
              <th className="text-center p-3">有効</th>
              <th className="text-right p-3">操作</th>
            </tr>
          </thead>
          <tbody>
            {messages.map((msg) => (
              <tr key={msg.id} className="border-t hover:bg-gray-50">
                <td className="p-3 whitespace-nowrap">{TIME_SLOT_LABELS[msg.time_slot] || msg.time_slot}</td>
                <td className="p-3 max-w-md truncate">{msg.message}</td>
                <td className="p-3 whitespace-nowrap text-xs text-gray-500">{msg.category}</td>
                <td className="p-3 text-center">
                  <button onClick={() => toggleActive(msg)} className={`w-8 h-5 rounded-full ${msg.is_active ? 'bg-green-500' : 'bg-gray-300'}`} />
                </td>
                <td className="p-3 text-right">
                  <button onClick={() => { setEditMsg(msg); setForm({ timeSlot: msg.time_slot, message: msg.message, category: msg.category }); setShowModal(true); }} className="text-blue-600 text-xs mr-2">編集</button>
                  <button onClick={() => handleDelete(msg.id)} className="text-red-500 text-xs">削除</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between mt-4 text-sm text-gray-500">
        <span>{total}件中 {offset + 1}〜{Math.min(offset + limit, total)}件</span>
        <div className="flex gap-2">
          <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))} className="px-3 py-1 rounded border disabled:opacity-30">前へ</button>
          <button disabled={offset + limit >= total} onClick={() => setOffset(offset + limit)} className="px-3 py-1 rounded border disabled:opacity-30">次へ</button>
        </div>
      </div>

      {/* Create/Edit Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setShowModal(false)}>
          <div className="bg-white rounded-xl p-6 w-full max-w-md mx-4" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-bold mb-4">{editMsg ? 'メッセージ編集' : '新規メッセージ'}</h2>
            <div className="space-y-4">
              <div>
                <label className="text-xs text-gray-500 block mb-1">時間帯</label>
                <select value={form.timeSlot} onChange={(e) => setForm({ ...form, timeSlot: e.target.value })} className="w-full p-2 border rounded-lg text-sm">
                  <option value="morning">🌅 朝</option>
                  <option value="noon">☀️ 昼</option>
                  <option value="evening">🌙 夜</option>
                  <option value="any">🔄 共通</option>
                </select>
              </div>
              <div>
                <label className="text-xs text-gray-500 block mb-1">メッセージ（200文字以内）</label>
                <textarea value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} maxLength={200} rows={3} className="w-full p-2 border rounded-lg text-sm" placeholder="おはようございます！今日も忘れずに..." />
                <p className="text-xs text-gray-400 text-right">{form.message.length}/200</p>
              </div>
              <div>
                <label className="text-xs text-gray-500 block mb-1">カテゴリ</label>
                <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} className="w-full p-2 border rounded-lg text-sm">
                  {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            </div>
            <div className="flex gap-2 mt-6">
              <button onClick={() => setShowModal(false)} className="flex-1 py-2 rounded-lg border text-sm">キャンセル</button>
              <button onClick={handleSave} disabled={!form.message.trim()} className="flex-1 py-2 rounded-lg bg-green-600 text-white text-sm font-bold disabled:opacity-50">保存</button>
            </div>
          </div>
        </div>
      )}

      {/* Bulk Import Modal */}
      {showBulkModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setShowBulkModal(false)}>
          <div className="bg-white rounded-xl p-6 w-full max-w-lg mx-4" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-bold mb-4">一括登録</h2>
            <p className="text-xs text-gray-500 mb-3">1行1メッセージで入力（最大100件/回）</p>
            <div className="space-y-4">
              <div>
                <label className="text-xs text-gray-500 block mb-1">時間帯（全件共通）</label>
                <select value={bulkSlot} onChange={(e) => setBulkSlot(e.target.value)} className="w-full p-2 border rounded-lg text-sm">
                  <option value="morning">🌅 朝</option>
                  <option value="noon">☀️ 昼</option>
                  <option value="evening">🌙 夜</option>
                  <option value="any">🔄 共通</option>
                </select>
              </div>
              <textarea value={bulkText} onChange={(e) => setBulkText(e.target.value)} rows={10} className="w-full p-2 border rounded-lg text-sm font-mono" placeholder="おはようございます！朝の1粒で今日も元気に。&#10;新しい一日の始まりです。naturismと一緒に。&#10;..." />
              <p className="text-xs text-gray-400">{bulkText.split('\n').filter((l) => l.trim()).length}件</p>
            </div>
            <div className="flex gap-2 mt-6">
              <button onClick={() => setShowBulkModal(false)} className="flex-1 py-2 rounded-lg border text-sm">キャンセル</button>
              <button onClick={handleBulkImport} className="flex-1 py-2 rounded-lg bg-green-600 text-white text-sm font-bold">登録</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
