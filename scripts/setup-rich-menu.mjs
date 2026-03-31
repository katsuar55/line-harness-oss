#!/usr/bin/env node
/**
 * naturism リッチメニュー セットアップスクリプト
 *
 * 使い方:
 *   node scripts/setup-rich-menu.mjs "APIキー"
 *
 * やること（サーバー側で全自動）:
 *   1. リッチメニュー構造を作成（3列: 商品を見る / AI相談 / 購入する）
 *   2. 画像を生成してアップロード（naturism グリーン 3色）
 *   3. デフォルトメニューに設定
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
