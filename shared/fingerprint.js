// fingerprint.js: what a skin draws, as one hash, so a recolored or renamed
// copy of a gallery skin can be recognized. Plain ESM, no imports (the app
// copies this file on its own into a packaged build). Runs in Node 20+,
// Electron and Cloudflare Workers (crypto.subtle).
//
//   skinFingerprint(skin, scene?) -> Promise<string>  sha256 hex
//   normalizeScene(text)          -> string           what is hashed for a scene
//   normalizeSkinShape(skin)      -> string           what is hashed without a scene
//
// `skin` should be the output of validateSkin (normalized). With a scene, only
// the scene counts: comments and whitespace go, every color literal becomes
// one placeholder, and var(--v-*, fallback) loses its fallback, so a recolor
// keeps the fingerprint. Without a scene the colors are the design, so they
// stay: the skin minus name/description/tags/slug/author/version, keys sorted
// and hex colors lower-cased, is hashed instead.

// One character the scene validator never lets through (control characters
// are refused), so a placeholder can't be confused with real text.
const COLOR = '\u0001';

// CSS named colors (CSS Color 4), plus the two color keywords.
const NAMED_COLORS = new Set(
  (
    'aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood ' +
    'cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray ' +
    'darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen ' +
    'darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue ' +
    'firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew ' +
    'hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan ' +
    'lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray ' +
    'lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue ' +
    'mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred ' +
    'midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid ' +
    'palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple ' +
    'rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue ' +
    'slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white ' +
    'whitesmoke yellow yellowgreen transparent currentcolor'
  ).split(' '),
);

// Every pass below is linear in the scene's length: no nested quantifiers.
const COLOR_CALL = /(?<![A-Za-z0-9_-])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^()]*\)/gi;
const HEX_COLOR = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![0-9A-Za-z_-])/g;
const WORD = /[A-Za-z0-9_-]+/g;
const VAR_CALL = /var\(/gi;
const IDENT_CHAR = /[A-Za-z0-9_-]/;
const SPACE = /\s+/g;

// Cuts every `open ... close` span (unclosed: to the end).
function cutSpans(text, open, close) {
  let out = '';
  let i = 0;
  for (;;) {
    const start = text.indexOf(open, i);
    if (start === -1) return out + text.slice(i);
    out += text.slice(i, start);
    const end = text.indexOf(close, start + open.length);
    if (end === -1) return out;
    i = end + close.length;
  }
}

// var(--v-key, fallback) -> var(--v-key). The fallback may hold parentheses
// (another var(), calc()...); the call is read once to its closing ")".
function stripVarFallbacks(text) {
  let out = '';
  let i = 0;
  VAR_CALL.lastIndex = 0;
  for (let m; (m = VAR_CALL.exec(text)); ) {
    const start = m.index;
    if (start > 0 && IDENT_CHAR.test(text[start - 1])) continue;
    let j = VAR_CALL.lastIndex;
    while (j < text.length && /\s/.test(text[j])) j++;
    if (!text.startsWith('--v-', j)) continue;
    let k = j + 4;
    while (k < text.length && IDENT_CHAR.test(text[k])) k++;
    const name = text.slice(j, k);
    let depth = 1;
    let e = k;
    for (; e < text.length && depth > 0; e++) depth += text[e] === '(' ? 1 : text[e] === ')' ? -1 : 0;
    if (depth > 0) break; // unclosed: leave the rest as it is
    out += `${text.slice(i, start)}var(${name})`;
    i = e;
    VAR_CALL.lastIndex = e;
  }
  return out + text.slice(i);
}

function replaceColors(text) {
  return text
    .replace(COLOR_CALL, COLOR)
    .replace(HEX_COLOR, COLOR)
    .replace(WORD, (w) => (NAMED_COLORS.has(w.toLowerCase()) ? COLOR : w));
}

/**
 * The drawing of a scene, without what a recolor or a reformat changes.
 * @param {string} text scene.svg
 */
export function normalizeScene(text) {
  let s = String(text);
  s = cutSpans(s, '<!--', '-->');
  s = cutSpans(s, '/*', '*/');
  s = replaceColors(s);
  s = stripVarFallbacks(s);
  return s.replace(SPACE, '');
}

const HEX_VALUE = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

// JSON with sorted keys; hex colors lower-cased (colors are kept).
function canonical(value) {
  if (typeof value === 'string') return JSON.stringify(HEX_VALUE.test(value) ? value.toLowerCase() : value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .filter((k) => value[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

const IDENTITY_KEYS = new Set(['name', 'description', 'tags', 'slug', 'author', 'version']);

/**
 * A skin without a scene: everything but its identity, colors included.
 * Two palette-only skins match only if they are the same apart from
 * name, description, tags, slug, author and version.
 * @param {object} skin a validated skin
 */
export function normalizeSkinShape(skin) {
  const rest = {};
  for (const [k, v] of Object.entries(skin ?? {})) if (!IDENTITY_KEYS.has(k)) rest[k] = v;
  return canonical(rest);
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * sha256 hex of what the skin draws. A scene counts when it is a non-empty
 * string (pass it only when backdrop.scene is true).
 * @param {object} skin a validated skin
 * @param {string | null} [scene]
 * @returns {Promise<string>}
 */
export function skinFingerprint(skin, scene) {
  const hasScene = typeof scene === 'string' && scene !== '';
  return sha256Hex(hasScene ? `scene:1\n${normalizeScene(scene)}` : `skin:1\n${normalizeSkinShape(skin)}`);
}
