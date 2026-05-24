-- naturism-welcome-v1 scenario v2 rebrush (Phase 1 ULTRATHINK MVP、 2026-05-24)
--
-- 背景:
--   LP launch 前リハーサル (2026-05-23) で「クーポンが 24h 後しか届かない」 問題発覚 + user 指示
--   で「公式 LINE = 最安窓口 + 習慣化 channel」 grand design に拡張。
--   Phase 1 MVP = welcome 3 step を content + timing 全面 rebrush + postback chain で誕生月/年代取得。
--
-- 変更 summary (= 全 3 step、 step 数は維持):
--   - step 0 (delay 0、 immediate reply 維持): ようこそ + クーポン即時開示 + 「次へ ▶ (誕生日教えて)」 postback button
--   - step 1 (delay 30→15 min): 3 商品比較 (既存) + 「AI に相談」 button (= 既存) + 「公式ストア」 button
--   - step 2 (text → flex 格上げ、 delay 1440 min 維持): クーポン残日数 reminder + AI 質問促し
--
-- demographics 取得は webhook postback chain で別 path:
--   step 0 「次へ ▶」 tap → postback `welcome_intro_step`
--     → flex「お誕生日教えて 🎂」 push
--   → postback `welcome_birthday:N` (N=1-12)
--     → friend.birth_month=N UPDATE + flex「年代教えて ✨」 push
--   → postback `welcome_age_group:X` (X='10s'..'70+')
--     → friend.age_group=X UPDATE + reply「ありがとう」 text
--
-- 適用方法 (= cwd: apps/worker):
--   npx wrangler d1 execute naturism-line-crm --remote --file ..\..\scripts\welcome-scenario-v2-2026-05-24.sql
--
-- backup (= 旧 content を comment で末尾保存、 revert 時に手動 UPDATE 可)

-- ============================================================
-- step 0: ようこそ + 500円 OFF クーポン即時開示 + 「次へ」 button
-- ============================================================
UPDATE scenario_steps SET
  message_type = 'flex',
  delay_minutes = 0,
  message_content = '{
  "type": "bubble",
  "header": {
    "type": "box",
    "layout": "vertical",
    "backgroundColor": "#06C755",
    "paddingAll": "16px",
    "contents": [
      {"type": "text", "text": "🌿 naturism へようこそ！", "size": "lg", "weight": "bold", "color": "#ffffff", "align": "center"}
    ]
  },
  "body": {
    "type": "box",
    "layout": "vertical",
    "paddingAll": "18px",
    "spacing": "md",
    "contents": [
      {"type": "text", "text": "友だち追加ありがとうございます😊", "size": "sm", "weight": "bold", "color": "#1e293b", "wrap": true},
      {"type": "text", "text": "「食べたら、 飲んでおく」 が naturism のコンセプト。 天然由来のインナーケアサプリです🌿", "size": "xs", "color": "#475569", "wrap": true},
      {{#if_coupon}}
      {"type": "separator", "margin": "md"},
      {
        "type": "box",
        "layout": "vertical",
        "backgroundColor": "#fef3c7",
        "cornerRadius": "8px",
        "paddingAll": "12px",
        "spacing": "sm",
        "contents": [
          {"type": "text", "text": "🎁 友だち限定 500 円 OFF クーポン", "size": "sm", "weight": "bold", "color": "#92400e", "align": "center", "wrap": true},
          {"type": "text", "text": "{{line_friend_coupon_code}}", "size": "xl", "weight": "bold", "color": "#06C755", "align": "center", "margin": "sm"},
          {"type": "text", "text": "naturism-diet.com で 3 日間 ご利用可", "size": "xxs", "color": "#78350f", "align": "center", "wrap": true}
        ]
      },
      {{/if_coupon}}
      {"type": "separator", "margin": "md"},
      {"type": "text", "text": "✨ 何でも AI に聞いてください", "size": "sm", "weight": "bold", "color": "#15803d"},
      {"type": "text", "text": "『違い』 『おすすめ』 『飲み方』 と話しかけると即お答えします", "size": "xs", "color": "#334155", "wrap": true}
    ]
  },
  "footer": {
    "type": "box",
    "layout": "vertical",
    "paddingAll": "14px",
    "spacing": "sm",
    "contents": [
      {"type": "button", "action": {"type": "postback", "label": "次へ ▶ (誕生日教えて)", "data": "welcome_intro_step"}, "style": "primary", "color": "#06C755", "height": "sm"},
      {"type": "button", "action": {"type": "uri", "label": "公式ストアを見る", "uri": "https://naturism-diet.com/"}, "style": "secondary", "height": "sm"}
    ]
  }
}',
  updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')
WHERE scenario_id = 'naturism-welcome-v1' AND step_order = 0;

-- ============================================================
-- step 1: 3 商品比較 (delay 30 → 15 min)
-- ============================================================
UPDATE scenario_steps SET
  message_type = 'flex',
  delay_minutes = 15,
  message_content = '{
  "type": "bubble",
  "header": {
    "type": "box",
    "layout": "vertical",
    "backgroundColor": "#f0fdf4",
    "paddingAll": "14px",
    "contents": [
      {"type": "text", "text": "🌿 あなたにぴったりの naturism は？", "size": "sm", "weight": "bold", "color": "#15803d", "align": "center"}
    ]
  },
  "body": {
    "type": "box",
    "layout": "vertical",
    "paddingAll": "16px",
    "spacing": "lg",
    "contents": [
      {
        "type": "box", "layout": "vertical", "spacing": "sm",
        "contents": [
          {"type": "text", "text": "💙 Blue — まずはここから", "size": "sm", "weight": "bold", "color": "#1e293b"},
          {"type": "text", "text": "脂っこい食事が好きな方に。 8 成分配合、 1日¥64〜", "size": "xs", "color": "#475569", "wrap": true}
        ]
      },
      {"type": "separator"},
      {
        "type": "box", "layout": "vertical", "spacing": "sm",
        "contents": [
          {"type": "text", "text": "💗 Pink — 酵素で美容もケア", "size": "sm", "weight": "bold", "color": "#1e293b"},
          {"type": "text", "text": "Blue ＋活きた酵素配合。 美容も気になる方に。 1日¥75〜", "size": "xs", "color": "#475569", "wrap": true}
        ]
      },
      {"type": "separator"},
      {
        "type": "box", "layout": "vertical", "spacing": "sm",
        "contents": [
          {"type": "text", "text": "🩶 Premium — 本気の体型管理に", "size": "sm", "weight": "bold", "color": "#1e293b"},
          {"type": "text", "text": "全 16 成分の最高峰。 機能性表示食品。 1日¥149〜", "size": "xs", "color": "#475569", "wrap": true}
        ]
      }
    ]
  },
  "footer": {
    "type": "box",
    "layout": "vertical",
    "paddingAll": "14px",
    "spacing": "sm",
    "contents": [
      {"type": "button", "action": {"type": "message", "label": "AI に相談 (おすすめ)", "text": "おすすめ"}, "style": "primary", "color": "#06C755", "height": "sm"},
      {"type": "button", "action": {"type": "uri", "label": "公式ストアを見る", "uri": "https://naturism-diet.com/"}, "style": "secondary", "height": "sm"}
    ]
  }
}',
  updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')
WHERE scenario_id = 'naturism-welcome-v1' AND step_order = 1;

-- ============================================================
-- step 2: クーポン残日数 reminder (text → flex 格上げ、 delay 1440 min 維持)
-- ============================================================
UPDATE scenario_steps SET
  message_type = 'flex',
  delay_minutes = 1440,
  message_content = '{
  "type": "bubble",
  "header": {
    "type": "box",
    "layout": "vertical",
    "backgroundColor": "#fef3c7",
    "paddingAll": "14px",
    "contents": [
      {"type": "text", "text": "🎁 クーポン、 残り 2 日です", "size": "sm", "weight": "bold", "color": "#92400e", "align": "center"}
    ]
  },
  "body": {
    "type": "box",
    "layout": "vertical",
    "paddingAll": "16px",
    "spacing": "md",
    "contents": [
      {"type": "text", "text": "{{name}} さん、 もう試されましたか？", "size": "sm", "color": "#1e293b", "wrap": true},
      {{#if_coupon}}
      {"type": "separator"},
      {"type": "text", "text": "{{line_friend_coupon_code}}", "size": "lg", "weight": "bold", "color": "#06C755", "align": "center"},
      {"type": "text", "text": "Blue 7日分 ¥696 → 500円 OFF で 実質 ¥196", "size": "xs", "color": "#475569", "align": "center", "wrap": true},
      {{/if_coupon}}
      {"type": "separator"},
      {"type": "text", "text": "✨ 何か質問あれば 『違い』 『成分』 『飲み方』 と話しかけてください", "size": "xs", "color": "#334155", "wrap": true}
    ]
  },
  "footer": {
    "type": "box",
    "layout": "vertical",
    "paddingAll": "14px",
    "spacing": "sm",
    "contents": [
      {"type": "button", "action": {"type": "uri", "label": "公式ストアで使う", "uri": "https://naturism-diet.com/"}, "style": "primary", "color": "#06C755", "height": "sm"},
      {"type": "button", "action": {"type": "message", "label": "AI に聞く", "text": "飲み方"}, "style": "secondary", "height": "sm"}
    ]
  }
}',
  updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')
WHERE scenario_id = 'naturism-welcome-v1' AND step_order = 2;

-- ============================================================
-- backup (= 旧 content を comment で参照可、 revert 時は手動 UPDATE)
-- 旧 step 0: bubble header「🌿 naturism へようこそ！」 + body「友だち追加ありがとうございます😊」 + 「food: ▸ 商品の質問にAIが即回答 / ▸ 飲み方・成分・価格をすぐ確認 / ▸ お得な情報をお届け」 + footer「3 種類の違いを教えて」/「公式ストアを見る」
-- 旧 step 1: delay=30、 bubble header「🌿 あなたにぴったりのnaturismは？」 + body「Blue/Pink/Premium 3 比較」 + footer「おすすめを教えて」
-- 旧 step 2: text、 delay=1440、 「{{name}}さん、 naturismに興味を持って...」 + 商品案内 + 購入経路 + {{#if_coupon}}クーポン{{/if_coupon}}
