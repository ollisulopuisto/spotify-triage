// Run with: node --test spotify-crate/tests/ime-enter.test.mjs
//
// Enter during IME composition (CJK input) is the composition's confirm key,
// not a submit. legacy-scan (ime-safe-enter-submit) flagged the Client ID
// field's keydown listener in js/main.js for clicking sign-in on Enter
// without checking event.isComposing / event.keyCode === 229. The guard must
// sit at the top of that handler. (main.js is a browser module, so this
// checks the source rather than importing it.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('the Client ID Enter handler returns early during IME composition', () => {
  const source = readFileSync(new URL('../js/main.js', import.meta.url), 'utf8').split('\n');
  const listener = source.findIndex((line) => line.includes("$('clientId').addEventListener('keydown'"));
  assert.notEqual(listener, -1, 'clientId keydown listener not found; re-anchor the test');
  const head = source.slice(listener + 1, listener + 4).join('\n');
  assert.match(head, /isComposing/, 'no isComposing guard at the top of the handler');
});
