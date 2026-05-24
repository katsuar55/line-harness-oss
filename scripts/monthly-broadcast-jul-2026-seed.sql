-- 月 1 通信 broadcast seed: 2026 年 7 月 (= 夏本番 / BBQ・焼肉 / Blue 強化) (Phase 2.2、 2026-05-24)
--
-- 設計:
--   - push 1 通/friend (= broadcast 自体、 6 月と同じ pattern、 200 friends で 200 通)
--   - 「詳しく見る ▶」 postback (data='monthly_detail:7') → reply 5 message 同時送信 (= push 0 通追加)
--   - postback handler: apps/worker/src/services/monthly-broadcast-postback.ts case 7
--     (= Phase 2.2 PR で追加、 7 月 detail content 5 flex)
--
-- 状態:
--   - status='draft' で seed (= 即配信されない、 admin で確認後 'scheduled' に変更)
--   - 実 send は admin /broadcasts page から手動 trigger or
--     scheduled_at='2026-07-01T10:00:00.000+09:00' に UPDATE + cron pickup
--
-- 適用方法 (= cwd: apps/worker):
--   npx wrangler d1 execute naturism-line-crm --remote --file ..\..\scripts\monthly-broadcast-jul-2026-seed.sql

INSERT OR REPLACE INTO broadcasts (
  id, title, message_type, message_content, target_type, status, channel, alt_text, created_at
) VALUES (
  'monthly-2026-07-naturism',
  '2026年7月 月次イベント (夏本番 / BBQ・焼肉 / Blue 強化)',
  'flex',
  '{
  "type": "bubble",
  "header": {
    "type": "box",
    "layout": "vertical",
    "backgroundColor": "#fef3c7",
    "paddingAll": "14px",
    "contents": [
      {"type": "text", "text": "🌻 7月 naturism から", "size": "md", "weight": "bold", "color": "#92400e", "align": "center"}
    ]
  },
  "body": {
    "type": "box",
    "layout": "vertical",
    "paddingAll": "16px",
    "spacing": "md",
    "contents": [
      {"type": "text", "text": "夏本番、 ビアガーデン・BBQ・焼肉・かき氷の季節☀", "size": "sm", "weight": "bold", "color": "#1e293b", "wrap": true},
      {"type": "text", "text": "脂っこい食事・甘いものが増えるこの時期、 naturism から夏の食習慣のヒントをお届けします🌿", "size": "xs", "color": "#475569", "wrap": true},
      {"type": "separator", "margin": "md"},
      {"type": "text", "text": "✨ 含まれる内容", "size": "xs", "weight": "bold", "color": "#92400e", "margin": "sm"},
      {"type": "text", "text": "▸ 夏の食習慣 3 つの tip (= 食前に水 / 冷たいものは少量 / Blue 6 粒)", "size": "xs", "color": "#334155", "wrap": true},
      {"type": "text", "text": "▸ Blue 強化 — BBQ・焼肉 に安心の 8 成分", "size": "xs", "color": "#334155", "wrap": true},
      {"type": "text", "text": "▸ 夏のキャンペーン (= 友だち紹介 ¥500 OFF 予告)", "size": "xs", "color": "#334155", "wrap": true}
    ]
  },
  "footer": {
    "type": "box",
    "layout": "vertical",
    "paddingAll": "14px",
    "spacing": "sm",
    "contents": [
      {"type": "button", "action": {"type": "postback", "label": "詳しく見る ▶", "data": "monthly_detail:7"}, "style": "primary", "color": "#06C755", "height": "sm"},
      {"type": "button", "action": {"type": "uri", "label": "公式ストアを見る", "uri": "https://naturism-diet.com/"}, "style": "secondary", "height": "sm"}
    ]
  }
}',
  'all',
  'draft',
  'line',
  '🌻 7月 naturism から - 夏本番・BBQ 対策 (詳しく見る ▶)',
  strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')
);
