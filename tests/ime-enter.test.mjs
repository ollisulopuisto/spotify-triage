// Run with: node --test tests/ime-enter.test.mjs  (npm test includes it)
//
// Enter during IME composition (CJK input) is the composition's confirm key,
// not a submit. legacy-scan (ime-safe-enter-submit) flagged the Client ID
// field's keydown listener in js/main.js for clicking sign-in on Enter
// without checking event.isComposing / event.keyCode === 229. That listener
// wraps its handler in guardIme from js/imeEnter.js (main.js boots the app
// at import, so this drives the wrapper directly with composing and plain
// keydown events).
import test from 'node:test';
import assert from 'node:assert/strict';
import { guardIme } from '../js/imeEnter.js';

function fakeField() {
  const listeners = [];
  return {
    addEventListener: (type, fn) => { if (type === 'keydown') listeners.push(fn); },
    keydown: (e) => listeners.forEach((fn) => fn(e)),
  };
}

test('composing keydowns never reach the guarded handler', () => {
  const field = fakeField();
  const seen = [];
  field.addEventListener('keydown', guardIme((e) => seen.push(e)));
  field.keydown({ key: 'Enter', isComposing: true });
  field.keydown({ key: 'Enter', keyCode: 229 });
  assert.equal(seen.length, 0);
});

test('plain keydowns reach the handler with the original event', () => {
  const field = fakeField();
  const seen = [];
  field.addEventListener('keydown', guardIme((e) => seen.push(e)));
  const plain = { key: 'Enter' };
  field.keydown(plain);
  field.keydown({ key: 'Escape' });
  assert.equal(seen.length, 2);
  assert.equal(seen[0], plain);
});
