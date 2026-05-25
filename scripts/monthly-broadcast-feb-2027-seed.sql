-- 月 1 通信 broadcast seed: 2027 年 2 月 (= バレンタイン / チョコ / Blue) (Phase 2.2 PR #77、 2026-05-26)
-- 適用方法 (= cwd: apps/worker):
--   npx wrangler d1 execute naturism-line-crm --remote --file ..\..\scripts\monthly-broadcast-feb-2027-seed.sql

INSERT OR REPLACE INTO broadcasts (
  id, title, message_type, message_content, target_type, status, channel, alt_text, created_at
) VALUES (
  'monthly-2027-02-naturism',
  '2027年2月 月次イベント (バレンタイン / チョコ / Blue)',
  'flex',
  '{
  "type": "bubble",
  "header": {
    "type": "box",
    "layout": "vertical",
    "backgroundColor": "#fce7f3",
    "paddingAll": "14px",
    "contents": [
      {"type": "text", "text": "🍫 2月 naturism から", "size": "md", "weight": "bold", "color": "#9d174d", "align": "center"}
    ]
  },
  "body": {
    "type": "box",
    "layout": "vertical",
    "paddingAll": "16px",
    "spacing": "md",
    "contents": [
      {"type": "text", "text": "バレンタインでチョコレートが家に増える時期🍫", "size": "sm", "weight": "bold", "color": "#1e293b", "wrap": true},
      {"type": "text", "text": "寒さで運動量が減りがちな季節、 naturism から甘いもの対策のヒントをお届けします🌿", "size": "xs", "color": "#475569", "wrap": true},
      {"type": "separator", "margin": "md"},
      {"type": "text", "text": "✨ 含まれる内容", "size": "xs", "weight": "bold", "color": "#9d174d", "margin": "sm"},
      {"type": "text", "text": "▸ チョコ消費 3 つの工夫 (= 高カカオ / 温かい飲み物 / Blue で対策)", "size": "xs", "color": "#334155", "wrap": true},
      {"type": "text", "text": "▸ Blue 強化 (= 砂糖+脂質ダブル対策)", "size": "xs", "color": "#334155", "wrap": true},
      {"type": "text", "text": "▸ 寒い日の室内軽運動 5 分習慣", "size": "xs", "color": "#334155", "wrap": true}
    ]
  },
  "footer": {
    "type": "box",
    "layout": "vertical",
    "paddingAll": "14px",
    "spacing": "sm",
    "contents": [
      {"type": "button", "action": {"type": "postback", "label": "詳しく見る ▶", "data": "monthly_detail:2"}, "style": "primary", "color": "#06C755", "height": "sm"},
      {"type": "button", "action": {"type": "uri", "label": "公式ストアを見る", "uri": "https://naturism-diet.com/"}, "style": "secondary", "height": "sm"}
    ]
  }
}',
  'all',
  'draft',
  'line',
  '🍫 2月 naturism から - バレンタイン / チョコ / Blue (詳しく見る ▶)',
  strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')
);
