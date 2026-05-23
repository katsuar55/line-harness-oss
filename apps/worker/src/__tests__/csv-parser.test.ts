/**
 * Tests for csv-parser utility (LSTEP audit H1、 2026-05-22)
 */

import { describe, it, expect } from 'vitest';
import { parseCsv, parseCsvWithHeader } from '../utils/csv-parser.js';

describe('parseCsv', () => {
  it('simple 3-column 2-row', () => {
    const csv = 'a,b,c\n1,2,3';
    expect(parseCsv(csv)).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  it('CRLF line ending', () => {
    const csv = 'a,b\r\n1,2\r\n';
    expect(parseCsv(csv)).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('CR-only line ending (classic Mac)', () => {
    const csv = 'a,b\r1,2\r3,4';
    expect(parseCsv(csv)).toEqual([
      ['a', 'b'],
      ['1', '2'],
      ['3', '4'],
    ]);
  });

  it('empty cell preserved', () => {
    const csv = 'a,,c\n,2,';
    expect(parseCsv(csv)).toEqual([
      ['a', '', 'c'],
      ['', '2', ''],
    ]);
  });

  it('quoted cell with comma inside', () => {
    const csv = 'name,note\n"Tanaka, Taro","hello, world"';
    expect(parseCsv(csv)).toEqual([
      ['name', 'note'],
      ['Tanaka, Taro', 'hello, world'],
    ]);
  });

  it('quoted cell with newline inside', () => {
    const csv = 'a,b\n"line1\nline2",ok';
    expect(parseCsv(csv)).toEqual([
      ['a', 'b'],
      ['line1\nline2', 'ok'],
    ]);
  });

  it('escaped quote ("") inside quoted cell', () => {
    const csv = 'a,b\n"say ""hello""","ok"';
    expect(parseCsv(csv)).toEqual([
      ['a', 'b'],
      ['say "hello"', 'ok'],
    ]);
  });

  it('BOM removed', () => {
    const csv = '﻿a,b\n1,2';
    expect(parseCsv(csv)).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('trailing empty rows ignored', () => {
    const csv = 'a,b\n1,2\n\n\n';
    expect(parseCsv(csv)).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('no trailing newline → still parsed', () => {
    const csv = 'a,b\n1,2';
    expect(parseCsv(csv)).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('unterminated quote → throw', () => {
    const csv = 'a,b\n"unclosed,x';
    expect(() => parseCsv(csv)).toThrow(/unterminated/);
  });

  it('maxRows exceeded → throw', () => {
    const csv = 'a\n' + Array.from({ length: 100 }, (_, i) => i).join('\n');
    expect(() => parseCsv(csv, { maxRows: 50 })).toThrow(/maxRows/);
  });

  it('header-only CSV → 1 row returned', () => {
    const csv = 'a,b,c';
    expect(parseCsv(csv)).toEqual([['a', 'b', 'c']]);
  });

  it('empty input → empty result', () => {
    expect(parseCsv('')).toEqual([]);
  });

  it('quote inside non-quoted cell → literal (non-strict)', () => {
    const csv = 'a,b\nabc"def,xyz';
    expect(parseCsv(csv)).toEqual([
      ['a', 'b'],
      ['abc"def', 'xyz'],
    ]);
  });

  it('Japanese multi-byte content', () => {
    const csv = 'line_user_id,display_name,memo\nU1234,田中太郎,初回購入\nU5678,佐藤花子,';
    expect(parseCsv(csv)).toEqual([
      ['line_user_id', 'display_name', 'memo'],
      ['U1234', '田中太郎', '初回購入'],
      ['U5678', '佐藤花子', ''],
    ]);
  });
});

describe('parseCsvWithHeader', () => {
  it('separates headers (normalized) from rows', () => {
    const csv = 'Line_User_ID, Display_Name ,Email\nU1,Tanaka,t@example.com\nU2,Sato,s@example.com';
    const result = parseCsvWithHeader(csv);
    expect(result.headers).toEqual(['line_user_id', 'display_name', 'email']);
    expect(result.rows).toEqual([
      ['U1', 'Tanaka', 't@example.com'],
      ['U2', 'Sato', 's@example.com'],
    ]);
  });

  it('header-only CSV → empty rows', () => {
    const result = parseCsvWithHeader('a,b,c');
    expect(result.headers).toEqual(['a', 'b', 'c']);
    expect(result.rows).toEqual([]);
  });

  it('empty input → throw', () => {
    expect(() => parseCsvWithHeader('')).toThrow(/at least 1 header/);
  });

  it('BOM in header removed', () => {
    const result = parseCsvWithHeader('﻿line_user_id,name\nU1,Taro');
    expect(result.headers).toEqual(['line_user_id', 'name']);
    expect(result.rows).toEqual([['U1', 'Taro']]);
  });
});
