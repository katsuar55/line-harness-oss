-- naturism ウェルカムシナリオ: 友だち追加時の自動配信
-- Step 0: 即座にreplyMessage（無料）
-- Step 1: 30分後にpushMessage（商品紹介）
-- Step 2: 翌日にpushMessage（おすすめ提案）

-- シナリオ本体
INSERT INTO scenarios (id, name, description, trigger_type, is_active) VALUES
('naturism-welcome-v1', 'naturism ウェルカムシナリオ', '友だち追加時に3ステップで商品を紹介', 'friend_add', 1);

-- Step 0: 即座に送信（replyMessage = 無料）
INSERT INTO scenario_steps (id, scenario_id, step_order, delay_minutes, message_type, message_content) VALUES
('nw-step-0', 'naturism-welcome-v1', 0, 0, 'flex', '{
  "type": "bubble",
  "header": {
    "type": "box",
    "layout": "vertical",
    "backgroundColor": "#06C755",
    "paddingAll": "16px",
    "contents": [
      {
        "type": "text",
        "text": "🌿 naturism へようこそ！",
        "size": "lg",
        "weight": "bold",
        "color": "#ffffff",
        "align": "center"
      }
    ]
  },
  "body": {
    "type": "box",
    "layout": "vertical",
    "paddingAll": "20px",
    "spacing": "md",
    "contents": [
      {
        "type": "text",
        "text": "友だち追加ありがとうございます😊",
        "size": "md",
        "weight": "bold",
        "color": "#1e293b",
        "wrap": true
      },
      {
        "type": "text",
        "text": "naturismは「食べたら、飲んでおく」がコンセプトの天然由来インナーケアサプリです🌿",
        "size": "sm",
        "color": "#475569",
        "wrap": true
      },
      {
        "type": "separator"
      },
      {
        "type": "text",
        "text": "✨ こんなことができます",
        "size": "sm",
        "weight": "bold",
        "color": "#15803d"
      },
      {
        "type": "box",
        "layout": "vertical",
        "spacing": "sm",
        "contents": [
          {
            "type": "text",
            "text": "▸ 商品の質問にAIが即回答",
            "size": "sm",
            "color": "#334155",
            "wrap": true
          },
          {
            "type": "text",
            "text": "▸ 飲み方・成分・価格をすぐ確認",
            "size": "sm",
            "color": "#334155",
            "wrap": true
          },
          {
            "type": "text",
            "text": "▸ お得な情報をお届け",
            "size": "sm",
            "color": "#334155",
            "wrap": true
          }
        ]
      },
      {
        "type": "text",
        "text": "何でもお気軽にメッセージしてくださいね！",
        "size": "sm",
        "color": "#475569",
        "wrap": true,
        "margin": "md"
      }
    ]
  },
  "footer": {
    "type": "box",
    "layout": "vertical",
    "paddingAll": "16px",
    "spacing": "sm",
    "contents": [
      {
        "type": "button",
        "action": {
          "type": "message",
          "label": "3種類の違いを教えて",
          "text": "違い"
        },
        "style": "primary",
        "color": "#06C755",
        "height": "sm"
      },
      {
        "type": "button",
        "action": {
          "type": "uri",
          "label": "公式ストアを見る",
          "uri": "https://naturism-diet.com/"
        },
        "style": "secondary",
        "height": "sm"
      }
    ]
  }
}');

-- Step 1: 30分後に送信（商品比較カード）
INSERT INTO scenario_steps (id, scenario_id, step_order, delay_minutes, message_type, message_content) VALUES
('nw-step-1', 'naturism-welcome-v1', 1, 30, 'flex', '{
  "type": "bubble",
  "header": {
    "type": "box",
    "layout": "vertical",
    "backgroundColor": "#f0fdf4",
    "paddingAll": "14px",
    "contents": [
      {
        "type": "text",
        "text": "🌿 あなたにぴったりのnaturismは？",
        "size": "sm",
        "weight": "bold",
        "color": "#15803d",
        "align": "center"
      }
    ]
  },
  "body": {
    "type": "box",
    "layout": "vertical",
    "paddingAll": "16px",
    "spacing": "lg",
    "contents": [
      {
        "type": "box",
        "layout": "vertical",
        "spacing": "sm",
        "contents": [
          {"type": "text", "text": "💙 Blue — まずはここから", "size": "sm", "weight": "bold", "color": "#1e293b"},
          {"type": "text", "text": "脂っこい食事が好きな方に。8成分配合、1日¥64〜", "size": "xs", "color": "#475569", "wrap": true}
        ]
      },
      {"type": "separator"},
      {
        "type": "box",
        "layout": "vertical",
        "spacing": "sm",
        "contents": [
          {"type": "text", "text": "💗 Pink — 酵素で美容もケア", "size": "sm", "weight": "bold", "color": "#1e293b"},
          {"type": "text", "text": "Blue＋活きた酵素配合。美容も気になる方に。1日¥75〜", "size": "xs", "color": "#475569", "wrap": true}
        ]
      },
      {"type": "separator"},
      {
        "type": "box",
        "layout": "vertical",
        "spacing": "sm",
        "contents": [
          {"type": "text", "text": "🩶 Premium — 本気の体型管理に", "size": "sm", "weight": "bold", "color": "#1e293b"},
          {"type": "text", "text": "全16成分の最高峰。機能性表示食品。1日¥149〜", "size": "xs", "color": "#475569", "wrap": true}
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
      {
        "type": "button",
        "action": {
          "type": "message",
          "label": "おすすめを教えて",
          "text": "おすすめはどれ？"
        },
        "style": "primary",
        "color": "#06C755",
        "height": "sm"
      }
    ]
  }
}');

-- Step 2: 翌日（1440分後）に送信（購入案内）
INSERT INTO scenario_steps (id, scenario_id, step_order, delay_minutes, message_type, message_content) VALUES
('nw-step-2', 'naturism-welcome-v1', 2, 1440, 'text', '{{name}}さん、naturismに興味を持っていただきありがとうございます😊

🎁 まずは試してみたい方へ
Blue 7日分（42粒）¥696 がおすすめです！

🛍 お求めはこちら
▸ 公式: naturism-diet.com
▸ 楽天: 「健康エクスプレス」で検索
▸ ドン・キホーテ全国店舗

5,500円以上で送料無料🚚

ご質問はいつでもこちらのLINEにどうぞ✨');
