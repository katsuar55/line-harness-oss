-- 月 1 通信 broadcast seed: 2027 年 1 月 (= 新年リセット / 七草粥 / Pink / 21 日習慣化) (Phase 2.2 PR #76、 2026-05-26)
-- 適用方法 (= cwd: apps/worker):
--   npx wrangler d1 execute naturism-line-crm --remote --file ..\..\scripts\monthly-broadcast-jan-2027-seed.sql

INSERT OR REPLACE INTO broadcasts (
  id, title, message_type, message_content, target_type, status, channel, alt_text, created_at
) VALUES (
  'monthly-2027-01-naturism',
  '2027年1月 月次イベント (新年リセット / 七草粥 / Pink / 21 日習慣化)',
  'flex',
  '{
  "type": "bubble",
  "header": {
    "type": "box",
    "layout": "vertical",
    "backgroundColor": "#e0f2fe",
    "paddingAll": "14px",
    "contents": [
      {"type": "text", "text": "🎍 1月 naturism から", "size": "md", "weight": "bold", "color": "#075985", "align": "center"}
    ]
  },
  "body": {
    "type": "box",
    "layout": "vertical",
    "paddingAll": "16px",
    "spacing": "md",
    "contents": [
      {"type": "text", "text": "新年あけましておめでとうございます🌸", "size": "sm", "weight": "bold", "color": "#1e293b", "wrap": true},
      {"type": "text", "text": "1 月は「新しい習慣をスタートしやすい」 時期。 年末年始で食べ過ぎた方も多いはず、 naturism から新年リセットのヒントをお届けします🌿", "size": "xs", "color": "#475569", "wrap": true},
      {"type": "separator", "margin": "md"},
      {"type": "text", "text": "✨ 含まれる内容", "size": "xs", "weight": "bold", "color": "#075985", "margin": "sm"},
      {"type": "text", "text": "▸ 新年リセット 3 つの tip (= 七草粥 / 水分補給 / 習慣化)", "size": "xs", "color": "#334155", "wrap": true},
      {"type": "text", "text": "▸ Pink 強化 (= 新年は美容もケア)", "size": "xs", "color": "#334155", "wrap": true},
      {"type": "text", "text": "▸ 1 月の習慣化チャレンジ (= 21 日の法則で定着)", "size": "xs", "color": "#334155", "wrap": true}
    ]
  },
  "footer": {
    "type": "box",
    "layout": "vertical",
    "paddingAll": "14px",
    "spacing": "sm",
    "contents": [
      {"type": "button", "action": {"type": "postback", "label": "詳しく見る ▶", "data": "monthly_detail:1"}, "style": "primary", "color": "#06C755", "height": "sm"},
      {"type": "button", "action": {"type": "uri", "label": "公式ストアを見る", "uri": "https://naturism-diet.com/"}, "style": "secondary", "height": "sm"}
    ]
  }
}',
  'all',
  'draft',
  'line',
  '🎍 1月 naturism から - 新年リセット / 七草粥 / Pink (詳しく見る ▶)',
  strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')
);
