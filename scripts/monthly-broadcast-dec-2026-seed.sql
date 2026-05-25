-- 月 1 通信 broadcast seed: 2026 年 12 月 (= 年末年始 / クリスマス / 大晦日 / 帰省土産) (Phase 2.2 PR #76、 2026-05-26)
-- 適用方法 (= cwd: apps/worker):
--   npx wrangler d1 execute naturism-line-crm --remote --file ..\..\scripts\monthly-broadcast-dec-2026-seed.sql

INSERT OR REPLACE INTO broadcasts (
  id, title, message_type, message_content, target_type, status, channel, alt_text, created_at
) VALUES (
  'monthly-2026-12-naturism',
  '2026年12月 月次イベント (年末年始 / クリスマス / 帰省土産)',
  'flex',
  '{
  "type": "bubble",
  "header": {
    "type": "box",
    "layout": "vertical",
    "backgroundColor": "#fee2e2",
    "paddingAll": "14px",
    "contents": [
      {"type": "text", "text": "🎄 12月 naturism から", "size": "md", "weight": "bold", "color": "#991b1b", "align": "center"}
    ]
  },
  "body": {
    "type": "box",
    "layout": "vertical",
    "paddingAll": "16px",
    "spacing": "md",
    "contents": [
      {"type": "text", "text": "1 年で最も食事イベントが多い月🍗", "size": "sm", "weight": "bold", "color": "#1e293b", "wrap": true},
      {"type": "text", "text": "クリスマス / 忘年会 / 大晦日 / おせち準備 — 暴飲暴食しがちな時期、 naturism から年末対策のヒントをお届けします🌿", "size": "xs", "color": "#475569", "wrap": true},
      {"type": "separator", "margin": "md"},
      {"type": "text", "text": "✨ 含まれる内容", "size": "xs", "weight": "bold", "color": "#991b1b", "margin": "sm"},
      {"type": "text", "text": "▸ 年末年始 3 つの食事 tip (= 主役を楽しむ / ベジ先 / 連続イベントの naturism)", "size": "xs", "color": "#334155", "wrap": true},
      {"type": "text", "text": "▸ 帰省土産にも naturism (= 親世代へのプレゼント hint)", "size": "xs", "color": "#334155", "wrap": true},
      {"type": "text", "text": "▸ 年末年始 発送スケジュール (= 12/27 最終受付・1/4 再開)", "size": "xs", "color": "#334155", "wrap": true}
    ]
  },
  "footer": {
    "type": "box",
    "layout": "vertical",
    "paddingAll": "14px",
    "spacing": "sm",
    "contents": [
      {"type": "button", "action": {"type": "postback", "label": "詳しく見る ▶", "data": "monthly_detail:12"}, "style": "primary", "color": "#06C755", "height": "sm"},
      {"type": "button", "action": {"type": "uri", "label": "公式ストアを見る", "uri": "https://naturism-diet.com/"}, "style": "secondary", "height": "sm"}
    ]
  }
}',
  'all',
  'draft',
  'line',
  '🎄 12月 naturism から - 年末年始 / クリスマス / 帰省土産 (詳しく見る ▶)',
  strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')
);
