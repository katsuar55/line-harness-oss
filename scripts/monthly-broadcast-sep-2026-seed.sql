-- 月 1 通信 broadcast seed: 2026 年 9 月 (= 秋の入口 / 食欲の秋 / Blue vs Pink 使い分け / 再購入) (Phase 2.2 PR #74、 2026-05-26)
--
-- 設計:
--   - push 1 通/friend (= broadcast 自体、 6-8 月と同じ pattern、 200 friends で 200 通)
--   - 「詳しく見る ▶」 postback (data='monthly_detail:9') → reply 5 message 同時送信 (= push 0 通追加)
--   - postback handler: apps/worker/src/services/monthly-broadcast-postback.ts case 9
--     (= 本 PR で追加、 9 月 detail content 4 flex + 1 text)
--
-- 状態:
--   - status='draft' で seed (= 即配信されない、 admin で確認後 'scheduled' に変更)
--   - 実 send は admin /broadcasts page から手動 trigger or
--     scheduled_at='2026-09-01T10:00:00.000+09:00' に UPDATE + cron pickup
--
-- 適用方法 (= cwd: apps/worker):
--   npx wrangler d1 execute naturism-line-crm --remote --file ..\..\scripts\monthly-broadcast-sep-2026-seed.sql

INSERT OR REPLACE INTO broadcasts (
  id, title, message_type, message_content, target_type, status, channel, alt_text, created_at
) VALUES (
  'monthly-2026-09-naturism',
  '2026年9月 月次イベント (秋の入口 / 食欲の秋 / Blue vs Pink 使い分け)',
  'flex',
  '{
  "type": "bubble",
  "header": {
    "type": "box",
    "layout": "vertical",
    "backgroundColor": "#fed7aa",
    "paddingAll": "14px",
    "contents": [
      {"type": "text", "text": "🍂 9月 naturism から", "size": "md", "weight": "bold", "color": "#9a3412", "align": "center"}
    ]
  },
  "body": {
    "type": "box",
    "layout": "vertical",
    "paddingAll": "16px",
    "spacing": "md",
    "contents": [
      {"type": "text", "text": "少しずつ涼しくなり、 食欲の秋がやってきます🍠", "size": "sm", "weight": "bold", "color": "#1e293b", "wrap": true},
      {"type": "text", "text": "夏に乱れた食生活を整え、 旬の味覚を楽しむ準備の月。 naturism から秋の食習慣のヒントをお届けします🌿", "size": "xs", "color": "#475569", "wrap": true},
      {"type": "separator", "margin": "md"},
      {"type": "text", "text": "✨ 含まれる内容", "size": "xs", "weight": "bold", "color": "#9a3412", "margin": "sm"},
      {"type": "text", "text": "▸ 秋の食習慣 3 つの tip (= 旬の根菜 / ベジファースト / リセット習慣)", "size": "xs", "color": "#334155", "wrap": true},
      {"type": "text", "text": "▸ Blue と Pink の使い分け (= 二刀流で秋の食卓を楽しむ)", "size": "xs", "color": "#334155", "wrap": true},
      {"type": "text", "text": "▸ 続けることで実感する成分 (= 7 月初回購入者向け再購入 reminder)", "size": "xs", "color": "#334155", "wrap": true}
    ]
  },
  "footer": {
    "type": "box",
    "layout": "vertical",
    "paddingAll": "14px",
    "spacing": "sm",
    "contents": [
      {"type": "button", "action": {"type": "postback", "label": "詳しく見る ▶", "data": "monthly_detail:9"}, "style": "primary", "color": "#06C755", "height": "sm"},
      {"type": "button", "action": {"type": "uri", "label": "公式ストアを見る", "uri": "https://naturism-diet.com/"}, "style": "secondary", "height": "sm"}
    ]
  }
}',
  'all',
  'draft',
  'line',
  '🍂 9月 naturism から - 秋の入口 / 食欲の秋 / Blue vs Pink (詳しく見る ▶)',
  strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')
);
