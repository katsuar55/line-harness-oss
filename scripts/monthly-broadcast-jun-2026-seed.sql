-- 月 1 通信 broadcast seed: 2026 年 6 月 (= 梅雨 / 体調管理) (Phase 2.1、 2026-05-24)
--
-- 設計:
--   - push 1 通/friend (= broadcast 自体、 200 friends で 200 通)
--   - 「詳しく見る ▶」 postback → reply 5 message 同時送信 (= push 0 通追加)
--   - postback handler: apps/worker/src/services/monthly-broadcast-postback.ts
--     (data='monthly_detail:6' → 当月詳細 reply)
--
-- 状態:
--   - status='draft' で seed (= 即配信されない、 admin で確認後 'scheduled' に変更)
--   - 実 send は admin /broadcasts page から手動 trigger or
--     scheduled_at='2026-06-01T10:00:00.000+09:00' に UPDATE + cron pickup
--
-- 適用方法 (= cwd: apps/worker):
--   npx wrangler d1 execute naturism-line-crm --remote --file ..\..\scripts\monthly-broadcast-jun-2026-seed.sql

INSERT OR REPLACE INTO broadcasts (
  id, title, message_type, message_content, target_type, status, channel, alt_text, created_at
) VALUES (
  'monthly-2026-06-naturism',
  '2026年6月 月次イベント (梅雨 / 体調管理)',
  'flex',
  '{
  "type": "bubble",
  "header": {
    "type": "box",
    "layout": "vertical",
    "backgroundColor": "#a5f3fc",
    "paddingAll": "14px",
    "contents": [
      {"type": "text", "text": "☔ 6月 naturism から", "size": "md", "weight": "bold", "color": "#0c4a6e", "align": "center"}
    ]
  },
  "body": {
    "type": "box",
    "layout": "vertical",
    "paddingAll": "16px",
    "spacing": "md",
    "contents": [
      {"type": "text", "text": "梅雨は気圧と湿度で体内リズムが乱れがち🌧️", "size": "sm", "weight": "bold", "color": "#1e293b", "wrap": true},
      {"type": "text", "text": "今月のヒントを 3 枚のカードにまとめました🌿", "size": "xs", "color": "#475569", "wrap": true},
      {"type": "separator", "margin": "md"},
      {"type": "text", "text": "✨ 含まれる内容", "size": "xs", "weight": "bold", "color": "#15803d", "margin": "sm"},
      {"type": "text", "text": "▸ 梅雨の食習慣 3 つの tip", "size": "xs", "color": "#334155", "wrap": true},
      {"type": "text", "text": "▸ 美容も気になる方へ — Pink のご紹介", "size": "xs", "color": "#334155", "wrap": true},
      {"type": "text", "text": "▸ 友だち紹介で 500 円 OFF (予告)", "size": "xs", "color": "#334155", "wrap": true}
    ]
  },
  "footer": {
    "type": "box",
    "layout": "vertical",
    "paddingAll": "14px",
    "spacing": "sm",
    "contents": [
      {"type": "button", "action": {"type": "postback", "label": "詳しく見る ▶", "data": "monthly_detail:6"}, "style": "primary", "color": "#06C755", "height": "sm"},
      {"type": "button", "action": {"type": "uri", "label": "公式ストアを見る", "uri": "https://naturism-diet.com/"}, "style": "secondary", "height": "sm"}
    ]
  }
}',
  'all',
  'draft',
  'line',
  '☔ 6月 naturism から - 梅雨の体調管理 (詳しく見る ▶)',
  strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')
);
