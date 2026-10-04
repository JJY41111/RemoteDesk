export function keyToVk(code) {
  if (/^Key[A-Z]$/.test(code)) return code.charCodeAt(3);
  if (/^Digit[0-9]$/.test(code)) return code.charCodeAt(5);
  if (/^F(?:[1-9]|1[0-2])$/.test(code)) return 0x6f + Number(code.slice(1));
  return {
    ArrowLeft: 0x25, ArrowUp: 0x26, ArrowRight: 0x27, ArrowDown: 0x28,
    Enter: 0x0d, Escape: 0x1b, Space: 0x20, Backspace: 0x08,
    Tab: 0x09, CapsLock: 0x14, Insert: 0x2d, ShiftLeft: 0xa0, ShiftRight: 0xa1,
    ControlLeft: 0x11, ControlRight: 0x11,
    AltLeft: 0x12, AltRight: 0x12,
    MetaLeft: 0x5b, MetaRight: 0x5c,
    Minus: 0xbd, Equal: 0xbb, Period: 0xbe, Comma: 0xbc,
    BracketLeft: 0xdb, BracketRight: 0xdd, Semicolon: 0xba,
    Quote: 0xde, Slash: 0xbf, Backslash: 0xdc, Backquote: 0xc0,
    Delete: 0x2e, Home: 0x24, End: 0x23, PageUp: 0x21, PageDown: 0x22
  }[code];
}

