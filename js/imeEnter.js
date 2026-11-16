// Enter during IME composition (CJK input) confirms the candidate in the
// composing text, it does not commit the field. Wrap any keydown listener
// that acts on Enter in this guard so composing keystrokes never reach it.
export function guardIme(handler) {
  return (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    handler(e);
  };
}
