/**
 * Minimal RFC 4180 lite CSV parser (LSTEP audit H1、 2026-05-22)
 *
 * 役割:
 *   - friends 一括インポートで CSV text を行 → 列 配列にする
 *   - quote 対応 (= "..." 内に comma / newline を含める)
 *   - escaped quote (= "" → ")
 *   - BOM 除去 (UTF-8)
 *   - 末尾空行を無視
 *
 * 制限:
 *   - 1 行あたり最大列数は呼出側で制御 (= validate で reject)
 *   - 文字列のみ (= 型変換は呼出側)
 *
 * 関連: routes/friends.ts (= POST /api/friends/import が利用)
 */

export interface ParseCsvOptions {
  /** 最大行数 (header 含む)、 超過時 throw。 default 5001 (= header + 5000 rows) */
  maxRows?: number;
}

const DEFAULT_MAX_ROWS = 5001;
const BOM = '﻿';

/**
 * CSV 文字列を 2 次元配列にパースする。
 *
 * - 行区切り: \r\n / \n / \r
 * - 列区切り: ,
 * - quote: " ... "
 * - escaped quote: ""  → "
 * - BOM 除去
 * - 末尾の空行は無視
 *
 * @throws Error  maxRows 超過時 / 未終了 quote
 */
export function parseCsv(text: string, options: ParseCsvOptions = {}): string[][] {
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
  // 1. BOM 除去
  const src = text.startsWith(BOM) ? text.slice(BOM.length) : text;

  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuote = false;
  let i = 0;
  const len = src.length;

  while (i < len) {
    const ch = src[i];

    if (inQuote) {
      if (ch === '"') {
        // 次が " なら escaped quote (= "")、 そうでなければ quote 終了
        if (i + 1 < len && src[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        inQuote = false;
        i++;
        continue;
      }
      cell += ch;
      i++;
      continue;
    }

    // not in quote
    if (ch === '"') {
      // 空 cell の先頭でのみ quote 開始
      if (cell.length === 0) {
        inQuote = true;
        i++;
        continue;
      }
      // cell の途中に " が現れた場合、 そのまま literal として扱う (= 非厳密 RFC)
      cell += ch;
      i++;
      continue;
    }
    if (ch === ',') {
      row.push(cell);
      cell = '';
      i++;
      continue;
    }
    if (ch === '\r') {
      // \r\n または \r 単独
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      if (i + 1 < len && src[i + 1] === '\n') {
        i += 2;
      } else {
        i++;
      }
      if (rows.length > maxRows) {
        throw new Error(`CSV too large: exceeded maxRows=${maxRows}`);
      }
      continue;
    }
    if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i++;
      if (rows.length > maxRows) {
        throw new Error(`CSV too large: exceeded maxRows=${maxRows}`);
      }
      continue;
    }
    cell += ch;
    i++;
  }

  if (inQuote) {
    throw new Error('CSV parse error: unterminated quoted field');
  }

  // 末尾 cell / row を flush (= 最後の改行なし対応)
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  // 末尾の空行 (= [''] only) を除去
  while (rows.length > 0) {
    const last = rows[rows.length - 1];
    if (last.length === 1 && last[0] === '') {
      rows.pop();
    } else {
      break;
    }
  }

  return rows;
}

/**
 * header 行 + data 行に分離。
 * header の column 名は trim + lowercase に正規化する (= マッピング容易化)。
 *
 * @returns { headers: string[], rows: string[][] }
 * @throws Error  rows.length === 0
 */
export function parseCsvWithHeader(
  text: string,
  options: ParseCsvOptions = {},
): { headers: string[]; rows: string[][] } {
  const all = parseCsv(text, options);
  if (all.length === 0) {
    throw new Error('CSV must have at least 1 header row');
  }
  const headers = all[0].map((h) => h.trim().toLowerCase());
  const rows = all.slice(1);
  return { headers, rows };
}
