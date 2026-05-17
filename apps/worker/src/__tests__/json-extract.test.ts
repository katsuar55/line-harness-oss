/**
 * Tests for utils/json-extract.ts (Phase 5γ-5).
 *
 * 以前は scenario-conductor.test.ts と food-analyzer.test.ts に個別配置されていた
 * extractJsonObject の test を、 utils 集約に合わせてここに統合した。
 */

import { describe, it, expect } from 'vitest';
import { extractJsonObject } from '../utils/json-extract.js';

describe('extractJsonObject', () => {
  it('extracts JSON wrapped in markdown code fences', () => {
    const wrapped = '```json\n{"name": "test"}\n```';
    const extracted = extractJsonObject(wrapped);
    expect(extracted).toBe('{"name": "test"}');
  });

  it('returns null when no JSON object present', () => {
    expect(extractJsonObject('plain text only')).toBeNull();
    expect(extractJsonObject('no json here')).toBeNull();
    expect(extractJsonObject('')).toBeNull();
  });

  it('extracts JSON with preamble and trailing text', () => {
    expect(extractJsonObject('result: {"a":1}\ndone')).toBe('{"a":1}');
  });

  it('extracts the FIRST valid JSON object when multiple present', () => {
    expect(extractJsonObject('{"a":1} and {"b":2}')).toBe('{"a":1}');
  });

  it('handles nested JSON objects (multi-level depth)', () => {
    const nested = '{"a":1,"b":{"c":{"d":[1,2,3]}}}';
    expect(extractJsonObject('prefix' + nested + 'suffix')).toBe(nested);
  });

  it('preserves } characters inside string values', () => {
    expect(extractJsonObject('{"text":"contains } char"}')).toBe(
      '{"text":"contains } char"}',
    );
  });

  it('preserves escaped quotes inside string values', () => {
    expect(extractJsonObject('{"text":"escaped \\"quote\\""}')).toBe(
      '{"text":"escaped \\"quote\\""}',
    );
  });

  it('returns null when braces are unbalanced (open without close)', () => {
    expect(extractJsonObject('{"a":1')).toBeNull();
    expect(extractJsonObject('hello { world')).toBeNull();
  });

  it('returns null when only opening brace at end of input', () => {
    expect(extractJsonObject('text {')).toBeNull();
  });

  it('handles JSON with whitespace and newlines', () => {
    const json = '{\n  "key": "value",\n  "n": 42\n}';
    expect(extractJsonObject(`prefix ${json} suffix`)).toBe(json);
  });

  it('handles deeply nested objects in string values', () => {
    // A string value containing what looks like a JSON object should be preserved verbatim
    const tricky = '{"text":"{not parsed}"}';
    expect(extractJsonObject(tricky)).toBe(tricky);
  });

  it('handles backslash escapes correctly (not toggling string state)', () => {
    // \\ is an escape — the } after should still be inside the string
    const tricky = '{"text":"\\\\ then }"}';
    expect(extractJsonObject(tricky)).toBe(tricky);
  });

  it('returns empty object when input is just {}', () => {
    expect(extractJsonObject('{}')).toBe('{}');
  });

  it('handles object inside array-like text (extracts the object only)', () => {
    expect(extractJsonObject('[{"a":1}]')).toBe('{"a":1}');
  });
});
