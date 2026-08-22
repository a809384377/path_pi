import assert from "node:assert/strict";
import test from "node:test";
import { JsonlDecoder } from "../../npm/src/rpc/jsonl.js";

test("JsonlDecoder handles fragmented UTF-8, multiple frames, CRLF, and embedded Unicode separators", () => {
  const decoder = new JsonlDecoder();
  const text = '{"text":"你好\u2028still-one-line"}\r\n{"value":2}\n';
  const bytes = Buffer.from(text);
  const split = bytes.indexOf(Buffer.from("好")) + 1;

  assert.deepEqual(decoder.push(bytes.subarray(0, split)), []);
  assert.deepEqual(decoder.push(bytes.subarray(split)), [
    '{"text":"你好\u2028still-one-line"}',
    '{"value":2}',
  ]);
  assert.deepEqual(decoder.end(), []);
});

test("JsonlDecoder emits a final EOF fragment", () => {
  const decoder = new JsonlDecoder();
  assert.deepEqual(decoder.push('{"done":true}'), []);
  assert.deepEqual(decoder.end(), ['{"done":true}']);
});
