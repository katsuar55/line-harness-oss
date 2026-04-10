#!/usr/bin/env node
/**
 * naturism リッチメニュー セットアップスクリプト v2
 *
 * 使い方:
 *   node scripts/setup-rich-menu.mjs "APIキー"
 *
 * やること（サーバー側で全自動）:
 *   1. 既存デフォルトリッチメニューを解除
 *   2. 6ボタン構造を作成（ストア/マイページ/ランク/友だち紹介/今日のヒント/お問い合わせ）
 *   3. 画像アップロード + デフォルト設定
 */

const API_KEY = process.argv[2];
if (!API_KEY) {
  console.error('Usage: node scripts/setup-rich-menu.mjs "APIキー"');
  process.exit(1);
}

const WORKER_URL = 'https://naturism-line-crm.katsu-7d5.workers.dev';

async function main() {
  console.log('🌿 naturism リッチメニュー セットアップ開始...\n');

  const res = await fetch(`${WORKER_URL}/api/rich-menus/setup-naturism`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
  });

  const data = await res.json();

  if (!data.success) {
    console.error('❌ 失敗:', data.error);
    process.exit(1);
  }

  console.log('✅ ' + data.data.message);
  console.log('📋 リッチメニューID:', data.data.richMenuId);
  console.log('\n🎉 LINEトーク画面を開いてメニューが表示されるか確認してください。');
}

main().catch(console.error);
