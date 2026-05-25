-- 月 1 通信 broadcast seed: 2026 年 11 月 (= 忘年会シーズン突入 / Blue 強化 / 季節変わり目) (Phase 2.2 PR #75、 2026-05-26)
-- 適用方法 (= cwd: apps/worker):
--   npx wrangler d1 execute naturism-line-crm --remote --file ..\..\scripts\monthly-broadcast-nov-2026-seed.sql

INSERT OR REPLACE INTO broadcasts (
  id, title, message_type, message_content, target_type, status, channel, alt_text, created_at
) VALUES (
  'monthly-2026-11-naturism',
  '2026年11月 月次イベント (忘年会シーズン / Blue 強化 / 季節変わり目)',
  'flex',
  '{
  "type": "bubble",
  "header": {
    "type": "box",
    "layout": "vertical",
    "backgroundColor": "#fed7aa",
    "paddingAll": "14px",
    "contents": [
      {"type": "text", "text": "🍻 11月 naturism から", "size": "md", "weight": "bold", "color": "#9a3412", "align": "center"}
    ]
  },
  "body": {
    "type": "box",
    "layout": "vertical",
    "paddingAll": "16px",
    "spacing": "md",
    "contents": [
      {"type": "text", "text": "忘年会シーズンが本格スタート🍻", "size": "sm", "weight": "bold", "color": "#1e293b", "wrap": true},
      {"type": "text", "text": "季節の変わり目で体調管理も大事な時期、 naturism から飲み会対策のヒントをお届けします🌿", "size": "xs", "color": "#475569", "wrap": true},
      {"type": "separator", "margin": "md"},
      {"type": "text", "text": "✨ 含まれる内容", "size": "xs", "weight": "bold", "color": "#9a3412", "margin": "sm"},
      {"type": "text", "text": "▸ 忘年会シーズン 3 つの対策 (= 飲む前水 / ベジ・タンパク先 / 食べたら飲む)", "size": "xs", "color": "#334155", "wrap": true},
      {"type": "text", "text": "▸ Blue 強化推奨 (= 30 日分でほぼ毎晩カバー可)", "size": "xs", "color": "#334155", "wrap": true},
      {"type": "text", "text": "▸ 季節変わり目の体調整え (= 翌朝ケア / 水分補給 1.5L)", "size": "xs", "color": "#334155", "wrap": true}
    ]
  },
  "footer": {
    "type": "box",
    "layout": "vertical",
    "paddingAll": "14px",
    "spacing": "sm",
    "contents": [
      {"type": "button", "action": {"type": "postback", "label": "詳しく見る ▶", "data": "monthly_detail:11"}, "style": "primary", "color": "#06C755", "height": "sm"},
      {"type": "button", "action": {"type": "uri", "label": "公式ストアを見る", "uri": "https://naturism-diet.com/"}, "style": "secondary", "height": "sm"}
    ]
  }
}',
  'all',
  'draft',
  'line',
  '🍻 11月 naturism から - 忘年会シーズン突入・Blue 強化 (詳しく見る ▶)',
  strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')
);
