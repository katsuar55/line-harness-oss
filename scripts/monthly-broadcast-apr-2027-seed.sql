-- 月 1 通信 broadcast seed: 2027 年 4 月 (= 新生活 / 入学 / 入社 / 歓迎会) (Phase 2.2 PR #78、 2026-05-26)
-- 適用方法 (= cwd: apps/worker):
--   npx wrangler d1 execute naturism-line-crm --remote --file ..\..\scripts\monthly-broadcast-apr-2027-seed.sql

INSERT OR REPLACE INTO broadcasts (
  id, title, message_type, message_content, target_type, status, channel, alt_text, created_at
) VALUES (
  'monthly-2027-04-naturism',
  '2027年4月 月次イベント (新生活 / 入学 / 入社 / 歓迎会 / Blue)',
  'flex',
  '{
  "type": "bubble",
  "header": {"type": "box", "layout": "vertical", "backgroundColor": "#dcfce7", "paddingAll": "14px",
    "contents": [{"type": "text", "text": "🌱 4月 naturism から", "size": "md", "weight": "bold", "color": "#15803d", "align": "center"}]},
  "body": {"type": "box", "layout": "vertical", "paddingAll": "16px", "spacing": "md",
    "contents": [
      {"type": "text", "text": "新生活 / 入学 / 入社 / 歓迎会シーズン本格スタート🌱", "size": "sm", "weight": "bold", "color": "#1e293b", "wrap": true},
      {"type": "text", "text": "環境変化で生活リズムが乱れがちな時期、 naturism から新生活の食習慣をお届けします🌿", "size": "xs", "color": "#475569", "wrap": true},
      {"type": "separator", "margin": "md"},
      {"type": "text", "text": "✨ 含まれる内容", "size": "xs", "weight": "bold", "color": "#15803d", "margin": "sm"},
      {"type": "text", "text": "▸ 新生活食習慣 3 つの tip (= 朝食ルーティン / 外食頻度 / 翌日整え)", "size": "xs", "color": "#334155", "wrap": true},
      {"type": "text", "text": "▸ Blue 強化 (= 歓迎会連続 + 居酒屋メニュー対策)", "size": "xs", "color": "#334155", "wrap": true},
      {"type": "text", "text": "▸ 環境変化の体調管理 (= 7h 睡眠 / 1.5L 水分 / 無理しない勇気)", "size": "xs", "color": "#334155", "wrap": true}
    ]},
  "footer": {"type": "box", "layout": "vertical", "paddingAll": "14px", "spacing": "sm",
    "contents": [
      {"type": "button", "action": {"type": "postback", "label": "詳しく見る ▶", "data": "monthly_detail:4"}, "style": "primary", "color": "#06C755", "height": "sm"},
      {"type": "button", "action": {"type": "uri", "label": "公式ストアを見る", "uri": "https://naturism-diet.com/"}, "style": "secondary", "height": "sm"}
    ]}
}',
  'all',
  'draft',
  'line',
  '🌱 4月 naturism から - 新生活 / 歓迎会 / Blue (詳しく見る ▶)',
  strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')
);
