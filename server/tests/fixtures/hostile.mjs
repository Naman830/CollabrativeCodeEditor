// Mirror of web/tests/fixtures/hostile.ts. The two workspaces share no code, so this is the
// eighth hand-maintained cross-workspace duplication — recorded as such in CLAUDE.md.
//
// INVARIANT: every dangerous character is built with String.fromCharCode / fromCodePoint and
// never written as a \u escape. Tool-call arguments JSON-decode \uXXXX, so a literal escape here
// would become a real NUL or lone-surrogate byte and turn this file binary.

export const NUL = String.fromCharCode(0);
export const SOH = String.fromCharCode(1);
export const UNIT_SEP = String.fromCharCode(31);
export const DEL = String.fromCharCode(127);
export const LONE_HIGH = String.fromCharCode(0xd800);
export const LONE_LOW = String.fromCharCode(0xdc00);
export const GRINNING = String.fromCodePoint(0x1f600);
export const RTL_OVERRIDE = String.fromCharCode(0x202e);
export const ZWSP = String.fromCharCode(0x200b);

export const CSS_BREAKOUT = "red } body { display: none } .x {";
export const STYLE_CLOSE = "</style>";

export const hasLoneSurrogate = (s) =>
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(s) || /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

export const hasNul = (s) => s.includes(NUL);

export const HOSTILE_FILENAMES = [
  "../../etc/passwd",
  "..\\..\\windows\\system32",
  ".",
  "..",
  "...",
  `main${NUL}.py`,
  `main${LONE_HIGH}.py`,
  `a${GRINNING.repeat(32)}`,
  "n".repeat(200),
  "main.py ",
  `../../etc/pa sswd${LONE_HIGH}.py`,
  "",
];

export const HOSTILE_NAMES = [
  `${NUL}Nam${NUL}an`,
  `A${LONE_HIGH}B`,
  `A${LONE_LOW}B`,
  `A${GRINNING}B`,
  `${"a".repeat(23)}${GRINNING}b`,
  `A${SOH}${UNIT_SEP}${DEL}B`,
  "a".repeat(200),
  "  \t\n  ",
  CSS_BREAKOUT,
  STYLE_CLOSE,
  `A${RTL_OVERRIDE}B`,
];

export const HOSTILE_COLORS = [
  CSS_BREAKOUT,
  STYLE_CLOSE,
  "#FFF",
  "#gggggg",
  "rgb(1,2,3)",
  "#ffffff ",
  "red",
  "",
  42,
  null,
  undefined,
  {},
];
