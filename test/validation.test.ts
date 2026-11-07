import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isRecord,
  parseRecord,
  stringArray,
  numberArray,
  requiredString,
  requiredNumber,
  optionalBoolean,
} from '../src/validation.js';

test('JSON record boundaries reject primitives, arrays and malformed input', () => {
  assert.deepEqual(parseRecord('{"name":"course"}'), { name: 'course' });
  for (const text of ['null', '[]', '1', 'true', '"value"', '{']) {
    assert.throws(() => parseRecord(text));
  }
  assert.equal(isRecord(null), false);
  assert.equal(isRecord([]), false);
});

test('array boundaries reject mixed entries and non-finite numbers', () => {
  assert.deepEqual(stringArray(['a', 'b']), ['a', 'b']);
  assert.deepEqual(numberArray([0, 1]), [0, 1]);
  for (const value of [null, {}, 'a', ['a', 1]]) {
    assert.throws(() => stringArray(value));
  }
  for (const value of [null, {}, 1, [1, '2'], [NaN], [Infinity]]) {
    assert.throws(() => numberArray(value));
  }
});

test('scalar boundaries do not coerce missing or wrongly typed fields', () => {
  assert.equal(requiredString(''), '');
  assert.equal(requiredNumber(0), 0);
  assert.equal(optionalBoolean(undefined), undefined);
  assert.equal(optionalBoolean(false), false);
  assert.throws(() => requiredString(1));
  assert.throws(() => requiredNumber('1'));
  assert.throws(() => requiredNumber(NaN));
  assert.throws(() => optionalBoolean(null));
  assert.throws(() => optionalBoolean('false'));
});
