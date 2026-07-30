// The one adversarial corpus, so every sanitizer faces identical input and the drift tests can
// diff them row by row. Keep in sync with server/tests/fixtures/hostile.mjs.
//
// INVARIANT: every dangerous character is built with String.fromCharCode / fromCodePoint and
// never written as a \u escape. Tool-call arguments JSON-decode \uXXXX, so a literal escape in
// this file would become a real NUL or lone surrogate byte and turn it binary — which happened
// twice while this suite was being written. See tests/unit/guards/source-encoding.test.ts.

export const NUL = String.fromCharCode(0);
export const SOH = String.fromCharCode(1);
export const UNIT_SEP = String.fromCharCode(31);
export const DEL = String.fromCharCode(127);
export const LONE_HIGH = String.fromCharCode(0xd800);
export const LONE_LOW = String.fromCharCode(0xdc00);
export const GRINNING = String.fromCodePoint(0x1f600); // a valid surrogate pair
export const RTL_OVERRIDE = String.fromCharCode(0x202e);
export const ZWSP = String.fromCharCode(0x200b);
export const NBSP = String.fromCharCode(0x00a0);
export const LINE_SEP = String.fromCharCode(0x2028);
export const BOM = String.fromCharCode(0xfeff);

/** Breaks out of a CSS rule if a colour reaches a stylesheet unvalidated. */
export const CSS_BREAKOUT = "red } body { display: none } .x {";

export const STYLE_CLOSE = "</style>";

export const SCRIPT_TAG = '<script>alert(1)</script>';

export type HostileCase = {
  id: string;
  input: unknown;
  why: string;
};

export const HOSTILE_NAMES: HostileCase[] = [
  { id: "nul", input: `${NUL}Nam${NUL}an`, why: "NUL cannot be stored in a Postgres text or jsonb value at all" },
  { id: "lone-high", input: `A${LONE_HIGH}B`, why: "a lone surrogate fails the whole INSERT, losing the room's code with it" },
  { id: "lone-low", input: `A${LONE_LOW}B`, why: "same, from the other half" },
  { id: "valid-pair", input: `A${GRINNING}B`, why: "a real pair must survive intact" },
  { id: "pair-straddles-cap", input: `${"a".repeat(23)}${GRINNING}b`, why: "the cut is by code point, so the pair must not be halved" },
  { id: "control-chars", input: `A${SOH}${UNIT_SEP}${DEL}B`, why: "control characters wreck a layout and a jsonb value" },
  { id: "long", input: "a".repeat(200), why: "an unbounded name breaks the presence stack" },
  { id: "whitespace-only", input: "  \t\n  ", why: "must reduce to empty and hit the fallback" },
  { id: "css-breakout", input: CSS_BREAKOUT, why: "as a colour it would restyle every participant's page" },
  { id: "style-close", input: STYLE_CLOSE, why: "would close the cursor stylesheet" },
  { id: "script-tag", input: SCRIPT_TAG, why: "React escapes it, but it must not reach an attribute either" },
  { id: "rtl-override", input: `A${RTL_OVERRIDE}B`, why: "survives today; recorded as a known gap, not a claim" },
  { id: "zwsp", input: `A${ZWSP}B`, why: "not matched by \\s, so it survives — recorded deliberately" },
  { id: "exotic-space", input: `A${NBSP}${LINE_SEP}${BOM}B`, why: "all three ARE matched by \\s and collapse" },
  { id: "non-string-number", input: 42, why: "peer-supplied fields are not necessarily strings" },
  { id: "non-string-null", input: null, why: "same" },
  { id: "non-string-object", input: {}, why: "same" },
];

export const HOSTILE_FILENAMES: HostileCase[] = [
  { id: "traversal-unix", input: "../../etc/passwd", why: "reaches <a download> and a zip entry key" },
  { id: "traversal-win", input: "..\\..\\windows\\system32", why: "same, backslash form" },
  { id: "dot", input: ".", why: "survives every replacement and is not a filename" },
  { id: "dotdot", input: "..", why: "same" },
  { id: "dotdotdot", input: "...", why: "same" },
  { id: "nul-name", input: `main${NUL}.py`, why: "NUL in a filename column" },
  { id: "lone-high-name", input: `main${LONE_HIGH}.py`, why: "lone surrogate in a filename column" },
  { id: "pair-straddles-64", input: `a${GRINNING.repeat(32)}`, why: "33 code points / 65 UTF-16 units: the cut must not halve the pair" },
  { id: "long-name", input: "n".repeat(200), why: "cut to 64 code points" },
  { id: "trailing-space", input: "main.py ", why: "trimmed" },
  { id: "traversal-with-space", input: `../../etc/pa sswd${LONE_HIGH}.py`, why: "the exact string CLAUDE.md records reaching Postgres as ....etcpasswd.py" },
  { id: "empty", input: "", why: "must reach the fallback, never produce a nameless download" },
];

/** Colours that must never reach an inline style or a stylesheet. */
export const HOSTILE_COLORS: unknown[] = [
  CSS_BREAKOUT,
  STYLE_CLOSE,
  "#FFF",
  "#gggggg",
  "rgb(1,2,3)",
  "#ffffff ",
  " #ffffff",
  "#ffffff;",
  "red",
  "",
  42,
  null,
  undefined,
  {},
];

export const VALID_COLORS = ["#ffffff", "#FFFFFF", "#ef9a9a", "#AbCdEf", "#000000"];
