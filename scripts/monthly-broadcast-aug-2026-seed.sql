-- 月 1 通信 broadcast seed: 2026 年 8 月 (= お盆 / 夏バテ / Pink 強化) (Phase 2.2 PR #74、 2026-05-26)
--
-- 設計:
--   - push 1 通/friend (= broadcast 自体、 6/7 月と同じ pattern、 200 friends で 200 通)
--   - 「詳しく見る ▶」 postback (data='monthly_detail:8') → reply 5 message 同時送信 (= push 0 通追加)
--   - postback handler: apps/worker/src/services/monthly-broadcast-postback.ts case 8
--     (= 本 PR で追加、 8 月 detail content 4 flex + 1 text)
--
-- 状態:
--   - status='draft' で seed (= 即配信されない、 admin で確認後 'scheduled' に変更)
--   - 実 send は admin /broadcasts page から手動 trigger or
--     scheduled_at='2026-08-01T10:00:00.000+09:00' に UPDATE + cron pickup
--
-- 適用方法 (= cwd: apps/worker):
--   npx wrangler d1 execute naturism-line-crm --remote --file ..\..\scripts\monthly-broadcast-aug-2026-seed.sql

INSERT OR REPLACE INTO broadcasts (
  id, title, message_type, message_content, target_type, status, channel, alt_text, created_at
) VALUES (
  'monthly-2026-08-naturism',
  '2026年8月 月次イベント (お盆 / 夏バテ / Pink 強化)',
  'flex',
  '{
  "type": "bubble",
  "header": {
    "type": "box",
    "layout": "vertical",
    "backgroundColor": "#fed7aa",
    "paddingAll": "14px",
    "contents": [
      {"type": "text", "text": "🍉 8月 naturism から", "size": "md", "weight": "bold", "color": "#9a3412", "align": "center"}
    ]
  },
  "body": {
    "type": "box",
    "layout": "vertical",
    "paddingAll": "16px",
    "spacing": "md",
    "contents": [
      {"type": "text", "text": "夏の盛り、 お盆休みや帰省で食生活が乱れがち🥵", "size": "sm", "weight": "bold", "color": "#1e293b", "wrap": true},
      {"type": "text", "text": "残暑と紫外線で疲労 + 肌コンディションも気になる季節、 naturism から夏疲れリカバリのヒントをお届けします🌿", "size": "xs", "color": "#475569", "wrap": true},
      {"type": "separator", "margin": "md"},
      {"type": "text", "text": "✨ 含まれる内容", "size": "xs", "weight": "bold", "color": "#9a3412", "margin": "sm"},
      {"type": "text", "text": "▸ 夏バテ対策 3 つの tip (= 朝食 / 冷たいもの少量 / 食後 30 分休息)", "size": "xs", "color": "#334155", "wrap": true},
      {"type": "text", "text": "▸ Pink 強化 — 夏疲れ + 美容ケアに酵素配合", "size": "xs", "color": "#334155", "wrap": true},
      {"type": "text", "text": "▸ お盆休み発送案内 + 紹介 500 円 OFF 継続", "size": "xs", "color": "#334155", "wrap": true}
    ]
  },
  "footer": {
    "type": "box",
    "layout": "vertical",
    "paddingAll": "14px",
    "spacing": "sm",
    "contents": [
      {"type": "button", "action": {"type": "postback", "label": "詳しく見る ▶", "data": "monthly_detail:8"}, "style": "primary", "color": "#06C755", "height": "sm"},
      {"type": "button", "action": {"type": "uri", "label": "公式ストアを見る", "uri": "https://naturism-diet.com/"}, "style": "secondary", "height": "sm"}
    ]
  }
}',
  'all',
  'draft',
  'line',
  '🍉 8月 naturism から - お盆 / 夏バテ / Pink 強化 (詳しく見る ▶)',
  strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')
);
