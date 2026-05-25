-- 月 1 通信 broadcast seed: 2027 年 3 月 (= 春先 / 花粉 / 卒業 / 送別会 / 新生活ギフト) (Phase 2.2 PR #77、 2026-05-26)
-- 適用方法 (= cwd: apps/worker):
--   npx wrangler d1 execute naturism-line-crm --remote --file ..\..\scripts\monthly-broadcast-mar-2027-seed.sql

INSERT OR REPLACE INTO broadcasts (
  id, title, message_type, message_content, target_type, status, channel, alt_text, created_at
) VALUES (
  'monthly-2027-03-naturism',
  '2027年3月 月次イベント (春先 / 卒業 / Pink / 新生活ギフト)',
  'flex',
  '{
  "type": "bubble",
  "header": {
    "type": "box",
    "layout": "vertical",
    "backgroundColor": "#fce7f3",
    "paddingAll": "14px",
    "contents": [
      {"type": "text", "text": "🌸 3月 naturism から", "size": "md", "weight": "bold", "color": "#9d174d", "align": "center"}
    ]
  },
  "body": {
    "type": "box",
    "layout": "vertical",
    "paddingAll": "16px",
    "spacing": "md",
    "contents": [
      {"type": "text", "text": "卒業 / 送別会 / 新生活準備で食事会が増える時期🌸", "size": "sm", "weight": "bold", "color": "#1e293b", "wrap": true},
      {"type": "text", "text": "花粉症の影響や春の体調変化が気になる方も多いはず、 naturism から春先のヒントをお届けします🌿", "size": "xs", "color": "#475569", "wrap": true},
      {"type": "separator", "margin": "md"},
      {"type": "text", "text": "✨ 含まれる内容", "size": "xs", "weight": "bold", "color": "#9d174d", "margin": "sm"},
      {"type": "text", "text": "▸ 春先の食習慣 3 つ (= 春野菜 / 送別会 / 新生活前の見直し)", "size": "xs", "color": "#334155", "wrap": true},
      {"type": "text", "text": "▸ Pink 強化 (= 春の体調変化 + 美容ケア)", "size": "xs", "color": "#334155", "wrap": true},
      {"type": "text", "text": "▸ 卒業 / 新生活ギフト hint (= 社会人 / 新生活組へ)", "size": "xs", "color": "#334155", "wrap": true}
    ]
  },
  "footer": {
    "type": "box",
    "layout": "vertical",
    "paddingAll": "14px",
    "spacing": "sm",
    "contents": [
      {"type": "button", "action": {"type": "postback", "label": "詳しく見る ▶", "data": "monthly_detail:3"}, "style": "primary", "color": "#06C755", "height": "sm"},
      {"type": "button", "action": {"type": "uri", "label": "公式ストアを見る", "uri": "https://naturism-diet.com/"}, "style": "secondary", "height": "sm"}
    ]
  }
}',
  'all',
  'draft',
  'line',
  '🌸 3月 naturism から - 春先 / 卒業 / Pink / 新生活ギフト (詳しく見る ▶)',
  strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')
);
