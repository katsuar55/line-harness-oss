-- 月 1 通信 broadcast seed: 2026 年 10 月 (= 紅葉 / 行楽 / Blue 旅のお供) (Phase 2.2 PR #75、 2026-05-26)
-- 適用方法 (= cwd: apps/worker):
--   npx wrangler d1 execute naturism-line-crm --remote --file ..\..\scripts\monthly-broadcast-oct-2026-seed.sql

INSERT OR REPLACE INTO broadcasts (
  id, title, message_type, message_content, target_type, status, channel, alt_text, created_at
) VALUES (
  'monthly-2026-10-naturism',
  '2026年10月 月次イベント (紅葉 / 行楽 / Blue 旅のお供)',
  'flex',
  '{
  "type": "bubble",
  "header": {
    "type": "box",
    "layout": "vertical",
    "backgroundColor": "#fef3c7",
    "paddingAll": "14px",
    "contents": [
      {"type": "text", "text": "🍁 10月 naturism から", "size": "md", "weight": "bold", "color": "#854d0e", "align": "center"}
    ]
  },
  "body": {
    "type": "box",
    "layout": "vertical",
    "paddingAll": "16px",
    "spacing": "md",
    "contents": [
      {"type": "text", "text": "紅葉シーズン到来、 行楽 + スポーツの秋を満喫する時期🍂", "size": "sm", "weight": "bold", "color": "#1e293b", "wrap": true},
      {"type": "text", "text": "旅先・外食の機会が増えるので、 食事を楽しみつつ食習慣も整えたい月。 naturism から旅先での工夫をお届けします🌿", "size": "xs", "color": "#475569", "wrap": true},
      {"type": "separator", "margin": "md"},
      {"type": "text", "text": "✨ 含まれる内容", "size": "xs", "weight": "bold", "color": "#854d0e", "margin": "sm"},
      {"type": "text", "text": "▸ 行楽シーズンの食習慣 3 つ (= シェア / 食後散策 / 旅カバンに naturism)", "size": "xs", "color": "#334155", "wrap": true},
      {"type": "text", "text": "▸ Blue を旅のお供に (= 個包装で外食時の安心感)", "size": "xs", "color": "#334155", "wrap": true},
      {"type": "text", "text": "▸ 忘年会シーズン まで 2 ヶ月 (= 今月から習慣準備)", "size": "xs", "color": "#334155", "wrap": true}
    ]
  },
  "footer": {
    "type": "box",
    "layout": "vertical",
    "paddingAll": "14px",
    "spacing": "sm",
    "contents": [
      {"type": "button", "action": {"type": "postback", "label": "詳しく見る ▶", "data": "monthly_detail:10"}, "style": "primary", "color": "#06C755", "height": "sm"},
      {"type": "button", "action": {"type": "uri", "label": "公式ストアを見る", "uri": "https://naturism-diet.com/"}, "style": "secondary", "height": "sm"}
    ]
  }
}',
  'all',
  'draft',
  'line',
  '🍁 10月 naturism から - 紅葉 / 行楽 / Blue 旅のお供 (詳しく見る ▶)',
  strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')
);
