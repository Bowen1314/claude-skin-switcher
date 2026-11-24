// skin-validate.js: the single validator for skin format v1 (docs/skin-format.md).
// Plain ESM, zero dependencies. Runs in Node 20+, Electron and Cloudflare Workers.
//
//   validateSkin(value)  -> { ok: true, skin } | { ok: false, errors: string[] }
//   validateScene(text)  -> { ok: boolean, errors: string[] }
//   SKIN_LIMITS          -> the numeric and pattern limits used below
//
// validateSkin returns a normalized copy: unknown top-level keys and unknown
// fields inside backdrop / glass / variables are dropped, `author` and
// `version` are stripped (the gallery sets them). Unknown color names, style
// parts, style keys and variable types are errors, because Claude refuses them.

export const SKIN_LIMITS = Object.freeze({
  format: 1,
  slugPattern: /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/,
  nameMax: 40,
  descriptionMax: 140,
  tagsMax: 5,
  tagPattern: /^[a-z0-9-]{1,20}$/,
  variablesMax: 12,
  variableKeyPattern: /^[a-z][a-z0-9-]{0,23}$/,
  labelMax: 32,
  glassBlur: [0, 64],
  glassOpacity: [0, 1],
  fontSize: [11, 28],
  letterSpacing: [-1, 4],
  lineHeight: [12, 48],
  borderWidth: [0, 8],
  radius: [0, 64],
  padding: [0, 48],
  shadowOffset: [-64, 64],
  shadowBlur: [0, 64],
  fontFamilyMax: 5,
  sceneMaxChars: 120000,
  // Scene resource limits (docs/skin-format.md). The official skins use
  // 452 elements, depth 5, no filters, and animations of 3.2s or longer.
  sceneMaxElements: 2000,
  sceneMaxDepth: 24,
  sceneMaxDrawn: 4000,
  sceneMaxFilterPrimitives: 32,
  sceneMaxFilterUses: 32,
  sceneMaxBlur: 50,
  sceneMaxOctaves: 4,
  sceneMaxMorphologyRadius: 20,
  sceneMaxConvolveOrder: 5,
  sceneMinAnimationSeconds: 0.5,
  sceneMaxViewBox: 100000,
});

const HEX6 = /^#[0-9a-fA-F]{6}$/;
const HEX6_OR_8 = /^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
// Control characters (C0, DEL, C1), invisible ones, and the ones that change
// text direction, which could make a name read as something else.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u061c\u200b\u200e\u200f\u2028\u2029\u202a-\u202e\u2060-\u2069\ufeff]/;
// Something other than space and blank-looking letters (Hangul fillers, braille blank).
const VISIBLE = /[^\s\u115f\u1160\u2800\u3164\uffa0\u200d]/;

const ROLE_NAMES = ['accent', 'danger', 'success', 'warning', 'pro'];
const MODES = ['light', 'dark'];
const SURFACES = ['surface-0', 'surface-1', 'surface-2', 'surface-3'];
const ANCHOR_NAMES = [...SURFACES, 'text-primary', 'text-secondary', 'text-muted'];
const STYLE_PARTS = ['Text', 'Heading', 'UserMessage', 'AssistantMessage', 'ToolUse'];
const FONT_FAMILIES = ['sans', 'serif', 'mono', 'code', 'cursive'];
const FONT_WEIGHTS = ['regular', 'medium', 'semibold', 'bold'];
const THEME_COLOR_NAMES = [
  'surface-0', 'surface-1', 'surface-2', 'surface-3',
  'border', 'border-strong', 'border-stronger',
  'fill-accent', 'text-accent', 'bg-accent', 'border-accent',
];
const TYPE_KEYS = ['color', 'fontFamily', 'fontSize', 'fontWeight', 'italic', 'letterSpacing', 'lineHeight'];
const BOX_KEYS = ['backgroundColor', 'borderColor', 'borderWidth', 'radius', 'padding', 'paddingX', 'paddingY', 'shadow'];
const PART_KEYS = {
  Text: TYPE_KEYS,
  Heading: TYPE_KEYS,
  UserMessage: [...TYPE_KEYS, ...BOX_KEYS],
  AssistantMessage: [...TYPE_KEYS, ...BOX_KEYS],
  ToolUse: ['color', 'fontFamily', ...BOX_KEYS],
};

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const charLen = (s) => [...s].length;
const show = (v) => {
  try {
    const s = JSON.stringify(v);
    return s === undefined ? String(v) : s.length > 40 ? `${s.slice(0, 37)}...` : s;
  } catch {
    return typeof v;
  }
};
const key = (path, k) => (/^[A-Za-z_$][\w$]*$/.test(k) ? `${path}.${k}` : `${path}[${JSON.stringify(k)}]`);

function relativeLuminance(hex) {
  const ch = (i) => {
    const s = parseInt(hex.slice(i, i + 2), 16) / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(1) + 0.7152 * ch(3) + 0.0722 * ch(5);
}

function inRange(errors, path, v, [lo, hi]) {
  if (!isNum(v)) {
    errors.push(`${path} must be a number from ${lo} to ${hi}, got ${show(v)}.`);
    return false;
  }
  if (v < lo || v > hi) {
    errors.push(`${path} must be from ${lo} to ${hi}, got ${v}.`);
    return false;
  }
  return true;
}

function checkText(errors, path, v, { min, max, required }) {
  if (v === undefined && !required) return undefined;
  if (typeof v !== 'string') {
    errors.push(`${path} must be a string of ${min} to ${max} characters, got ${show(v)}.`);
    return undefined;
  }
  const n = charLen(v);
  if (n < min || n > max) {
    errors.push(`${path} must be ${min} to ${max} characters, got ${n}.`);
    return undefined;
  }
  if (CONTROL.test(v)) {
    errors.push(`${path} must not contain control, invisible or text-direction characters.`);
    return undefined;
  }
  if (min > 0 && !VISIBLE.test(v)) {
    errors.push(`${path} must not be blank.`);
    return undefined;
  }
  return v;
}

function checkColors(errors, value) {
  const path = '$.colors';
  if (!isRecord(value)) {
    errors.push(`${path} is required and must be an object.`);
    return undefined;
  }
  const out = {};
  for (const k of Object.keys(value)) {
    if (k !== 'roles' && !MODES.includes(k)) errors.push(`${key(path, k)} is not allowed (use roles, light, dark).`);
  }
  if (has(value, 'roles')) {
    const roles = value.roles;
    if (!isRecord(roles)) {
      errors.push(`${path}.roles must be an object.`);
    } else {
      out.roles = {};
      for (const k of Object.keys(roles)) {
        const p = key(`${path}.roles`, k);
        if (!ROLE_NAMES.includes(k)) errors.push(`${p} is not a role (use ${ROLE_NAMES.join(', ')}).`);
        else if (typeof roles[k] !== 'string' || !HEX6.test(roles[k])) errors.push(`${p} must be #rrggbb, got ${show(roles[k])}.`);
        else out.roles[k] = roles[k];
      }
    }
  }
  let modes = 0;
  for (const mode of MODES) {
    if (!has(value, mode)) continue;
    modes++;
    const mp = `${path}.${mode}`;
    const half = value[mode];
    if (!isRecord(half)) {
      errors.push(`${mp} must be an object with anchors.`);
      continue;
    }
    for (const k of Object.keys(half)) {
      if (k !== 'anchors') errors.push(`${key(mp, k)} is not allowed (only anchors).`);
    }
    const anchors = half.anchors;
    const ap = `${mp}.anchors`;
    if (!isRecord(anchors)) {
      errors.push(`${ap} is required and must be an object.`);
      continue;
    }
    const outAnchors = {};
    let good = true;
    for (const k of Object.keys(anchors)) {
      const p = key(ap, k);
      if (!ANCHOR_NAMES.includes(k)) {
        errors.push(`${p} is not an anchor (use ${ANCHOR_NAMES.join(', ')}).`);
        good = false;
      } else if (typeof anchors[k] !== 'string' || !HEX6.test(anchors[k])) {
        errors.push(`${p} must be #rrggbb, got ${show(anchors[k])}.`);
        good = false;
      } else {
        outAnchors[k] = anchors[k];
      }
    }
    for (const req of ['surface-0', 'text-primary']) {
      if (!has(anchors, req)) {
        errors.push(`${key(ap, req)} is required.`);
        good = false;
      }
    }
    if (good) {
      const present = SURFACES.filter((s) => has(outAnchors, s));
      for (let i = 1; i < present.length; i++) {
        const prev = present[i - 1];
        const cur = present[i];
        if (relativeLuminance(outAnchors[cur]) < relativeLuminance(outAnchors[prev])) {
          errors.push(
            `${key(ap, cur)} (${outAnchors[cur]}) is darker than ${prev} (${outAnchors[prev]}): surface-0 is the darkest surface and each later one is as light or lighter.`,
          );
        }
      }
      if (
        mode === 'light' &&
        has(outAnchors, 'surface-2') &&
        has(outAnchors, 'surface-3') &&
        outAnchors['surface-2'].toLowerCase() !== outAnchors['surface-3'].toLowerCase()
      ) {
        errors.push(`${key(ap, 'surface-3')} must equal surface-2 in light mode when both are given.`);
      }
    }
    out[mode] = { anchors: outAnchors };
  }
  if (modes === 0) errors.push(`${path} needs light, dark or both.`);
  return out;
}

function checkBackdrop(errors, value) {
  const path = '$.backdrop';
  if (!isRecord(value)) {
    errors.push(`${path} must be an object: { "scene": true, "glass"?: {...} } or { "color": "#rrggbb" }.`);
    return undefined;
  }
  const hasScene = has(value, 'scene');
  const hasColor = has(value, 'color');
  if (hasScene === hasColor) {
    errors.push(`${path} must have exactly one of scene or color.`);
    return undefined;
  }
  if (hasColor) {
    if (typeof value.color !== 'string' || !HEX6.test(value.color)) {
      errors.push(`${path}.color must be #rrggbb, got ${show(value.color)}.`);
      return undefined;
    }
    if (has(value, 'glass')) errors.push(`${path}.glass is only allowed with scene.`);
    return { color: value.color };
  }
  if (value.scene !== true) {
    errors.push(`${path}.scene must be true, got ${show(value.scene)}.`);
    return undefined;
  }
  const out = { scene: true };
  if (has(value, 'glass')) {
    const g = value.glass;
    if (!isRecord(g)) {
      errors.push(`${path}.glass must be an object.`);
    } else {
      const glass = {};
      if (has(g, 'blur') && inRange(errors, `${path}.glass.blur`, g.blur, SKIN_LIMITS.glassBlur)) glass.blur = g.blur;
      if (has(g, 'opacity') && inRange(errors, `${path}.glass.opacity`, g.opacity, SKIN_LIMITS.glassOpacity)) glass.opacity = g.opacity;
      out.glass = glass;
    }
  }
  return out;
}

function checkStyleColor(errors, path, v) {
  if (typeof v === 'string' && (HEX6_OR_8.test(v) || THEME_COLOR_NAMES.includes(v))) return true;
  errors.push(`${path} must be #rrggbb, #rrggbbaa or one of ${THEME_COLOR_NAMES.join(', ')}; got ${show(v)}.`);
  return false;
}

function checkStyleValue(errors, path, k, v) {
  switch (k) {
    case 'color':
    case 'backgroundColor':
    case 'borderColor':
      return checkStyleColor(errors, path, v);
    case 'fontFamily':
      if (!Array.isArray(v) || v.length < 1 || v.length > SKIN_LIMITS.fontFamilyMax) {
        errors.push(`${path} must be a list of 1 to ${SKIN_LIMITS.fontFamilyMax} of ${FONT_FAMILIES.join(', ')}.`);
        return false;
      }
      for (let i = 0; i < v.length; i++) {
        if (!FONT_FAMILIES.includes(v[i])) {
          errors.push(`${path}[${i}] must be one of ${FONT_FAMILIES.join(', ')}, got ${show(v[i])}.`);
          return false;
        }
      }
      return true;
    case 'fontSize':
      return inRange(errors, path, v, SKIN_LIMITS.fontSize);
    case 'fontWeight':
      if (FONT_WEIGHTS.includes(v)) return true;
      errors.push(`${path} must be one of ${FONT_WEIGHTS.join(', ')}, got ${show(v)}.`);
      return false;
    case 'italic':
      if (typeof v === 'boolean') return true;
      errors.push(`${path} must be true or false, got ${show(v)}.`);
      return false;
    case 'letterSpacing':
      return inRange(errors, path, v, SKIN_LIMITS.letterSpacing);
    case 'lineHeight':
      return inRange(errors, path, v, SKIN_LIMITS.lineHeight);
    case 'borderWidth':
      return inRange(errors, path, v, SKIN_LIMITS.borderWidth);
    case 'radius':
      return inRange(errors, path, v, SKIN_LIMITS.radius);
    case 'padding':
    case 'paddingX':
    case 'paddingY':
      return inRange(errors, path, v, SKIN_LIMITS.padding);
    case 'shadow': {
      if (v === 'none') return true;
      if (!isRecord(v)) {
        errors.push(`${path} must be "none" or { x, y, blur, color }, got ${show(v)}.`);
        return false;
      }
      let ok = true;
      for (const sk of Object.keys(v)) {
        if (!['x', 'y', 'blur', 'color'].includes(sk)) {
          errors.push(`${key(path, sk)} is not allowed (use x, y, blur, color).`);
          ok = false;
        }
      }
      for (const sk of ['x', 'y', 'blur', 'color']) {
        if (!has(v, sk)) {
          errors.push(`${path}.${sk} is required.`);
          ok = false;
        }
      }
      if (!ok) return false;
      ok = inRange(errors, `${path}.x`, v.x, SKIN_LIMITS.shadowOffset) && ok;
      ok = inRange(errors, `${path}.y`, v.y, SKIN_LIMITS.shadowOffset) && ok;
      ok = inRange(errors, `${path}.blur`, v.blur, SKIN_LIMITS.shadowBlur) && ok;
      ok = checkStyleColor(errors, `${path}.color`, v.color) && ok;
      return ok;
    }
    default:
      return false;
  }
}

function cloneStyleValue(k, v) {
  if (k === 'fontFamily') return [...v];
  if (k === 'shadow' && isRecord(v)) return { x: v.x, y: v.y, blur: v.blur, color: v.color };
  return v;
}

function checkStyle(errors, value) {
  const path = '$.style';
  if (!isRecord(value)) {
    errors.push(`${path} must be an object.`);
    return undefined;
  }
  const out = {};
  for (const part of Object.keys(value)) {
    const pp = key(path, part);
    if (!STYLE_PARTS.includes(part)) {
      errors.push(`${pp} is not a style part (use ${STYLE_PARTS.join(', ')}).`);
      continue;
    }
    const rule = value[part];
    if (!isRecord(rule)) {
      errors.push(`${pp} must be one rule object.`);
      continue;
    }
    const allowed = PART_KEYS[part];
    const outRule = {};
    for (const k of Object.keys(rule)) {
      const p = key(pp, k);
      if (!allowed.includes(k)) {
        errors.push(`${p} is not allowed on ${part} (allowed: ${allowed.join(', ')}).`);
        continue;
      }
      if (checkStyleValue(errors, p, k, rule[k])) outRule[k] = cloneStyleValue(k, rule[k]);
    }
    if (isNum(outRule.fontSize) && isNum(outRule.lineHeight) && outRule.lineHeight < outRule.fontSize) {
      errors.push(`${pp}.lineHeight (${outRule.lineHeight}) must be at least fontSize (${outRule.fontSize}).`);
    }
    out[part] = outRule;
  }
  return out;
}

function checkVariables(errors, value) {
  const path = '$.variables';
  if (!Array.isArray(value)) {
    errors.push(`${path} must be a list.`);
    return undefined;
  }
  if (value.length > SKIN_LIMITS.variablesMax) {
    errors.push(`${path} has ${value.length} entries; at most ${SKIN_LIMITS.variablesMax}.`);
    return undefined;
  }
  const seen = new Set();
  const out = [];
  value.forEach((v, i) => {
    const p = `${path}[${i}]`;
    if (!isRecord(v)) {
      errors.push(`${p} must be an object.`);
      return;
    }
    const before = errors.length;
    if (typeof v.key !== 'string' || !SKIN_LIMITS.variableKeyPattern.test(v.key)) {
      errors.push(`${p}.key must match ${SKIN_LIMITS.variableKeyPattern}, got ${show(v.key)}.`);
    } else if (seen.has(v.key)) {
      errors.push(`${p}.key ${show(v.key)} is used twice.`);
    } else {
      seen.add(v.key);
    }
    checkText(errors, `${p}.label`, v.label, { min: 1, max: SKIN_LIMITS.labelMax, required: true });
    const item = { key: v.key, label: v.label, type: v.type };
    if (v.type === 'color') {
      if (typeof v.default !== 'string' || !HEX6.test(v.default)) errors.push(`${p}.default must be #rrggbb, got ${show(v.default)}.`);
      item.default = v.default;
    } else if (v.type === 'toggle') {
      if (typeof v.default !== 'boolean') errors.push(`${p}.default must be true or false, got ${show(v.default)}.`);
      item.default = v.default;
    } else if (v.type === 'range') {
      let ok = true;
      for (const f of ['min', 'max', 'step', 'default']) {
        if (!isNum(v[f])) {
          errors.push(`${p}.${f} must be a number, got ${show(v[f])}.`);
          ok = false;
        }
      }
      if (ok) {
        if (!(v.min < v.max)) errors.push(`${p}.min (${v.min}) must be less than max (${v.max}).`);
        else if (!(v.step > 0) || v.step > v.max - v.min) errors.push(`${p}.step must be above 0 and at most max - min, got ${v.step}.`);
        if (v.default < v.min || v.default > v.max) errors.push(`${p}.default (${v.default}) must be within min..max (${v.min}..${v.max}).`);
      }
      Object.assign(item, { min: v.min, max: v.max, step: v.step, default: v.default });
    } else {
      errors.push(`${p}.type must be color, range or toggle, got ${show(v.type)}.`);
    }
    if (errors.length === before) out.push(item);
  });
  return out;
}

/**
 * Validate a parsed skin.json value.
 * @param {unknown} value
 * @returns {{ ok: true, skin: object } | { ok: false, errors: string[] }}
 */
export function validateSkin(value) {
  const errors = [];
  if (!isRecord(value)) return { ok: false, errors: ['$ must be a JSON object.'] };

  if (value.format !== SKIN_LIMITS.format) errors.push(`$.format must be ${SKIN_LIMITS.format}, got ${show(value.format)}.`);

  if (typeof value.slug !== 'string' || !SKIN_LIMITS.slugPattern.test(value.slug)) {
    errors.push(`$.slug must be 3 to 40 of a-z, 0-9 and inner hyphens (${SKIN_LIMITS.slugPattern}), got ${show(value.slug)}.`);
  }
  checkText(errors, '$.name', value.name, { min: 1, max: SKIN_LIMITS.nameMax, required: true });
  checkText(errors, '$.description', value.description, { min: 0, max: SKIN_LIMITS.descriptionMax, required: false });

  let tags = [];
  if (has(value, 'tags')) {
    if (!Array.isArray(value.tags)) {
      errors.push('$.tags must be a list.');
    } else if (value.tags.length > SKIN_LIMITS.tagsMax) {
      errors.push(`$.tags has ${value.tags.length} entries; at most ${SKIN_LIMITS.tagsMax}.`);
    } else {
      value.tags.forEach((t, i) => {
        if (typeof t !== 'string' || !SKIN_LIMITS.tagPattern.test(t)) errors.push(`$.tags[${i}] must match ${SKIN_LIMITS.tagPattern}, got ${show(t)}.`);
        else if (tags.includes(t)) errors.push(`$.tags[${i}] ${show(t)} is listed twice.`);
        else tags.push(t);
      });
    }
  }

  const colors = checkColors(errors, value.colors);
  const backdrop = has(value, 'backdrop') ? checkBackdrop(errors, value.backdrop) : undefined;
  const style = has(value, 'style') ? checkStyle(errors, value.style) : undefined;
  const variables = has(value, 'variables') ? checkVariables(errors, value.variables) : undefined;

  if (errors.length) return { ok: false, errors };

  const skin = {
    format: SKIN_LIMITS.format,
    slug: value.slug,
    name: value.name,
    description: typeof value.description === 'string' ? value.description : '',
    tags,
  };
  skin.colors = colors;
  if (backdrop !== undefined) skin.backdrop = backdrop;
  if (style !== undefined) skin.style = style;
  if (variables !== undefined) skin.variables = variables;
  return { ok: true, skin };
}

// ---------------------------------------------------------------- scene.svg

// Elements a scene may use, exact case (SVG is XML). Anything else (script,
// image, feImage, foreignObject, iframe, a, metadata, marker, namespaced
// tags...) is refused. <marker> is out because it repeats at every vertex.
const SVG_ELEMENTS = new Set([
  'svg', 'g', 'defs', 'symbol', 'use', 'title', 'desc', 'style',
  'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'text', 'tspan', 'textPath',
  'linearGradient', 'radialGradient', 'stop', 'pattern', 'clipPath', 'mask',
  'filter', 'feBlend', 'feColorMatrix', 'feComponentTransfer', 'feComposite', 'feConvolveMatrix',
  'feDiffuseLighting', 'feDisplacementMap', 'feDistantLight', 'feDropShadow', 'feFlood',
  'feFuncA', 'feFuncB', 'feFuncG', 'feFuncR', 'feGaussianBlur', 'feMerge', 'feMergeNode',
  'feMorphology', 'feOffset', 'fePointLight', 'feSpecularLighting', 'feSpotLight', 'feTile', 'feTurbulence',
  'animate', 'animateMotion', 'animateTransform', 'mpath', 'set',
]);
const SMIL_ELEMENTS = new Set(['animate', 'animateMotion', 'animateTransform', 'set']);
// Drawn again for every element that refers to them, like <use>.
const REDRAWN = new Set(['mask', 'pattern', 'clipPath']);
const GRADIENTS = new Set(['linearGradient', 'radialGradient']);
const MAX_ERRORS = 20;

// What SMIL may animate. Filter settings, href, style, class and events are left out.
const ANIMATABLE = new Set([
  'opacity', 'fill', 'fill-opacity', 'stroke', 'stroke-opacity', 'stroke-width', 'stroke-dasharray', 'stroke-dashoffset',
  'stop-color', 'stop-opacity', 'flood-color', 'flood-opacity', 'color', 'visibility', 'display',
  'transform', 'gradientTransform', 'patternTransform', 'offset', 'pathLength', 'startOffset',
  'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'fx', 'fy', 'fr', 'width', 'height', 'd', 'points',
  'font-size', 'letter-spacing', 'word-spacing',
]);

// Functions a style or attribute value may call (compared lower-case). No attr(),
// env(), image(), image-set(), src(), element(), cross-fade(), paint()...
const COLOR_FUNCTIONS = ['rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklab', 'oklch', 'color'];
const FILTER_FUNCTIONS = new Set([
  'url', 'blur', 'drop-shadow', 'brightness', 'contrast', 'grayscale', 'hue-rotate', 'invert', 'opacity', 'saturate', 'sepia',
  ...COLOR_FUNCTIONS,
]);
const CSS_FUNCTIONS = new Set([
  ...FILTER_FUNCTIONS, 'var', 'calc', 'min', 'max', 'clamp', 'abs', 'round', 'sin', 'cos', 'color-mix', 'light-dark',
  'translate', 'translatex', 'translatey', 'scale', 'scalex', 'scaley', 'rotate', 'skew', 'skewx', 'skewy', 'matrix',
  'cubic-bezier', 'steps', 'linear', 'path', 'polygon', 'circle', 'ellipse', 'inset',
  'not', 'is', 'where', 'nth-child', 'nth-last-child', 'nth-of-type', 'nth-last-of-type',
]);
const AT_RULES = new Set(['keyframes', '-webkit-keyframes', 'media', 'supports']);
const NAMESPACED_ATTRS = new Set(['xlink:href', 'xml:space', 'xml:lang']);
const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';

// Simple substring refusals (case-insensitive), a second layer over the raw
// text under the tokenizer below. Each is linear to scan.
const REFUSED = [
  [/<script/i, '<script>'],
  [/<image/i, '<image>'],
  [/<foreignobject/i, '<foreignObject>'],
  [/<iframe/i, '<iframe>'],
  [/<!doctype/i, '<!DOCTYPE'],
  [/<!entity/i, '<!ENTITY'],
  [/cdata/i, 'CDATA'],
  [/<!(?!--)/, '<! declarations other than comments'],
  [/data:/i, 'data: URIs'],
  [/javascript:/i, 'javascript: URLs'],
  [/vbscript:/i, 'vbscript: URLs'],
  [/@import/i, '@import'],
  [/@font-face/i, '@font-face'],
  [/&#/, 'numeric character references (&#...)'],
  [/\\/, 'backslashes (CSS escapes)'],
  [/expression\s*\(/i, 'CSS expression()'],
  [/-moz-binding/i, '-moz-binding'],
  [/behavior\s*:/i, 'CSS behavior'],
  [/xml:base/i, 'xml:base'],
  [/(?:image-set|image|src|element|cross-fade|paint)\s*\(/i, 'CSS resource functions other than url(#id)'],
  // The class after `on` must not overlap the preceding class, or this goes quadratic.
  [/(?:^|[^a-z0-9_-])on[a-z0-9_-]*\s*=/i, 'on... event attributes'],
  [/attributename\s*=\s*["']?\s*(?:on|[a-z0-9_.-]*:?href)/i, 'animating href or event attributes'],
  // eslint-disable-next-line no-control-regex
  [/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/, 'control characters'],
];

const XML_DECL = /^<\?xml\s[^<>?]*\?>/i;
const XML_ENTITIES = new Set(['amp', 'lt', 'gt', 'quot', 'apos']);
const ENTITY_TEXT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s) => s.replace(/&(amp|lt|gt|quot|apos);/g, (_, e) => ENTITY_TEXT[e]);

const NAME = '[A-Za-z_][\\w:.-]*';
const START_TAG = new RegExp(`<(${NAME})`, 'y');
const END_TAG = new RegExp(`</(${NAME})[ \\t\\r\\n]*>`, 'y');
const ATTR = new RegExp(`(${NAME})[ \\t\\r\\n]*=[ \\t\\r\\n]*(?:"([^"]*)"|'([^']*)')`, 'y');
const SPACE = /[ \t\r\n]*/y; // XML whitespace
const NUMBER = '[+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][+-]?\\d+)?';
const TIME = new RegExp(`^(${NUMBER})(ms|s)$`, 'i');
const PLAIN_NUMBER = new RegExp(`^${NUMBER}$`);
const FUNCTION_CALL = /([A-Za-z_-][\w-]*)\(/g;
// Around a #fragment only ASCII spaces: a browser reads "\u00a0#a" as a relative URL.
const FRAGMENT_HREF = /^[ \t\r\n]*#([A-Za-z_][\w.:-]*)[ \t\r\n]*$/;
const URL_START = /url[ \t\r\n]*\([ \t\r\n]*["']?[ \t\r\n]*(.?)/gi;
const URL_REF = /url\([ \t\r\n]*["']?[ \t\r\n]*#([^"')\s]+)/gi;
const COLOR_CALL = new RegExp(`(?:${COLOR_FUNCTIONS.join('|')})\\([^()]*\\)`, 'gi');
const LENGTH = new RegExp(`(${NUMBER})([a-z%]*)`, 'gi');

const numbersOf = (v) => String(v).trim().split(/[\s,]+/).map(Number);

// A SMIL clock value in seconds ("2s", "1.5", "300ms", "00:01.5", "1min"), or null.
function clockSeconds(v) {
  const s = v.trim();
  let m = /^(\d+):([0-5]\d):([0-5]\d(?:\.\d+)?)$/.exec(s);
  if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  m = /^([0-5]?\d):([0-5]\d(?:\.\d+)?)$/.exec(s);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  m = /^(\d+(?:\.\d+)?|\.\d+)(h|min|s|ms)?$/.exec(s);
  if (!m) return null;
  return Number(m[1]) * { h: 3600, min: 60, s: 1, ms: 0.001 }[m[2] ?? 's'];
}

// Everything one pass over a scene learns: errors, counts, and the element tree.
class SceneScan {
  constructor() {
    this.errors = [];
    this.badElements = new Set();
    this.nodes = [];
    this.ids = new Map();
    this.styleRefs = [];
    this.stats = { elements: 0, depth: 0, drawn: 0, filterPrimitives: 0, filterUses: 0, minAnimationSeconds: null };
  }

  // At most MAX_ERRORS, so a scene full of distinct mistakes stays cheap.
  error(msg) {
    if (this.errors.length < MAX_ERRORS && !this.errors.includes(msg)) this.errors.push(msg);
  }

  duration(seconds, what) {
    const s = this.stats;
    if (s.minAnimationSeconds === null || seconds < s.minAnimationSeconds) s.minAnimationSeconds = seconds;
    if (seconds < SKIN_LIMITS.sceneMinAnimationSeconds) {
      this.error(`scene.svg ${what} is shorter than the ${SKIN_LIMITS.sceneMinAnimationSeconds}s minimum animation duration.`);
    }
  }

  // blur() and drop-shadow() take px lengths up to sceneMaxBlur. Linear: each
  // call is read once up to its closing parenthesis, or the scan stops.
  blurs(value) {
    const re = /(blur|drop-shadow)\(/gi;
    for (let m; (m = re.exec(value)); ) {
      let depth = 1;
      let j = re.lastIndex;
      for (; j < value.length && depth > 0; j++) depth += value[j] === '(' ? 1 : value[j] === ')' ? -1 : 0;
      if (depth > 0) return this.error(`scene.svg has an unclosed ${m[1]}(.`);
      const args = value
        .slice(re.lastIndex, j - 1)
        .replace(COLOR_CALL, ' ')
        .replace(/#[0-9a-f]+/gi, ' ');
      if (args.includes('(')) return this.error(`scene.svg ${m[1]}() may only hold lengths and a color.`);
      for (const n of args.matchAll(LENGTH)) {
        if ((n[2] !== '' && n[2].toLowerCase() !== 'px') || Math.abs(Number(n[1])) > SKIN_LIMITS.sceneMaxBlur) {
          return this.error(`scene.svg ${m[1]}() takes px lengths up to ${SKIN_LIMITS.sceneMaxBlur}, got ${show(n[0])}.`);
        }
      }
      re.lastIndex = j;
    }
  }

  functions(value, allowed, where) {
    for (const m of value.matchAll(FUNCTION_CALL)) {
      if (!allowed.has(m[1].toLowerCase())) this.error(`scene.svg ${where} uses ${m[1]}(), which is not allowed (see docs/skin-format.md).`);
    }
  }

  // A filter value: url(#id), none, or filter functions with written-out lengths.
  // Each filter function counts as a filter primitive.
  filterValue(value, node) {
    this.functions(value, FILTER_FUNCTIONS, 'filter');
    for (const m of value.matchAll(FUNCTION_CALL)) if (m[1].toLowerCase() !== 'url') this.stats.filterPrimitives++;
    if (value.trim().toLowerCase() !== 'none') node.filtered = true;
  }

  // CSS from a <style> element (node = null) or a style attribute.
  css(raw, node) {
    let css = '';
    for (let i = 0; i < raw.length; ) {
      const open = raw.indexOf('/*', i);
      if (open === -1) {
        css += raw.slice(i);
        break;
      }
      const close = raw.indexOf('*/', open + 2);
      if (close === -1) return this.error('scene.svg has an unterminated CSS comment.');
      css += raw.slice(i, open);
      i = close + 2;
    }
    for (const m of css.matchAll(/@([\w-]*)/g)) {
      if (!AT_RULES.has(m[1].toLowerCase())) this.error(`scene.svg uses @${m[1]}; only @keyframes, @media and @supports are allowed.`);
    }
    this.functions(css, CSS_FUNCTIONS, node ? 'a style attribute' : '<style>');
    for (const m of css.matchAll(URL_START)) {
      if (m[1] !== '#') this.error('scene.svg url( must be url(#id).');
    }
    if (!node) for (const m of css.matchAll(URL_REF)) this.styleRefs.push(m[1]);
    this.blurs(css);
    for (const m of css.matchAll(/(?:^|[;{\s])((?:-webkit-)?(backdrop-)?filter)\s*:\s*([^;}]*)/gi)) {
      if (m[2]) this.error('scene.svg must not use backdrop-filter.');
      else if (!node) this.error('scene.svg <style> must not set filter: put filter="url(#id)" on the elements, so their number can be checked.');
      else this.filterValue(m[3], node);
    }
    for (const m of css.matchAll(/(?:^|[;{\s])(?:-webkit-)?animation(-duration)?\s*:\s*([^;}]*)/gi)) {
      const decl = m[2].replace(/!\s*important\s*$/i, '');
      if (m[1]) {
        for (const item of decl.split(',')) {
          const t = TIME.exec(item.trim());
          if (!t) this.error('scene.svg animation-duration must be written out as times (no var() or calc()).');
          else this.duration(Number(t[1]) * (t[2].toLowerCase() === 'ms' ? 0.001 : 1), `animation-duration ${show(item.trim())}`);
        }
        continue;
      }
      // Every word is a name, a number or a time, so the duration can't hide.
      const value = decl.replace(/(?:cubic-bezier|steps|linear)\([^()]*\)/gi, ' ');
      const words = value.split(/[\s,]+/).filter(Boolean);
      if (!words.every((w) => /^-?[A-Za-z_][\w-]*$/.test(w) || TIME.test(w) || PLAIN_NUMBER.test(w))) {
        this.error('scene.svg animation must write out its duration: names, numbers and times only (no var() or calc()).');
        continue;
      }
      for (const item of value.split(',')) {
        const t = item.trim().split(/\s+/).map((w) => TIME.exec(w)).find(Boolean);
        if (t) this.duration(Number(t[1]) * (t[2].toLowerCase() === 'ms' ? 0.001 : 1), `animation duration ${show(t[0])}`);
      }
    }
  }

  // Per-element attribute rules. `attrs` holds raw (still entity-encoded) values.
  element(name, attrs, node, isRoot) {
    for (const [k, raw] of attrs) {
      const v = decode(raw);
      if (k === 'xmlns' || k === 'xmlns:xlink') {
        if (!isRoot || v !== (k === 'xmlns' ? SVG_NS : XLINK_NS)) {
          this.error(`scene.svg ${k} is only allowed on the root <svg>, as ${k === 'xmlns' ? SVG_NS : XLINK_NS}.`);
        }
        continue;
      }
      if (k.includes(':') && !NAMESPACED_ATTRS.has(k)) this.error(`scene.svg attribute ${k} is not allowed.`);
      if (k === 'href' || k === 'xlink:href') {
        const id = FRAGMENT_HREF.exec(v);
        if (!id) this.error('scene.svg href / xlink:href must be a #fragment.');
        else node.refs.push(id[1]);
        if (id && name === 'use') node.use = id[1];
      }
      if (k === 'id') {
        if (this.ids.has(v)) this.error(`scene.svg uses the id ${show(v)} twice.`);
        else this.ids.set(v, node);
      }
      for (const u of v.matchAll(URL_REF)) node.refs.push(u[1]);
      if (k === 'style') this.css(v, node);
      else if (k === 'filter') this.filterValue(v, node);
      else this.functions(v, CSS_FUNCTIONS, `attribute ${k}`);
      this.blurs(v);
    }
    if (attrs.has('href') && attrs.has('xlink:href')) {
      this.error(`scene.svg <${name}> must not have both href and xlink:href.`);
    }
    if (attrs.has('data-ctx') && attrs.has('visibility')) {
      this.error('scene.svg elements with data-ctx must not set visibility (the bridge sets it).');
    }
    const L = SKIN_LIMITS;
    const capped = (attr, max, integer = false) => {
      if (!attrs.has(attr)) return;
      const ns = numbersOf(decode(attrs.get(attr)));
      if (ns.some((n) => !Number.isFinite(n) || n < 0 || n > max || (integer && !Number.isInteger(n)))) {
        this.error(`scene.svg <${name}> ${attr} must be ${integer ? 'whole numbers' : 'numbers'} from 0 to ${max}, got ${show(attrs.get(attr))}.`);
      }
    };
    if (name.startsWith('fe')) this.stats.filterPrimitives++;
    if (name === 'feGaussianBlur' || name === 'feDropShadow') capped('stdDeviation', L.sceneMaxBlur);
    if (name === 'feTurbulence') capped('numOctaves', L.sceneMaxOctaves, true);
    if (name === 'feMorphology') capped('radius', L.sceneMaxMorphologyRadius);
    if (name === 'feConvolveMatrix') capped('order', L.sceneMaxConvolveOrder, true);
    if (name === 'filter' && decode(attrs.get('primitiveUnits') ?? '').trim() === 'objectBoundingBox') {
      this.error('scene.svg <filter> must not use primitiveUnits="objectBoundingBox" (it makes blur sizes relative).');
    }
    if (SMIL_ELEMENTS.has(name)) {
      const target = attrs.has('attributeName') ? decode(attrs.get('attributeName')).trim() : null;
      if (target !== null && !ANIMATABLE.has(target)) {
        this.error(`scene.svg <${name}> attributeName ${show(target)} cannot be animated (see docs/skin-format.md).`);
      }
      for (const attr of ['dur', 'max', 'repeatDur']) {
        if (!attrs.has(attr)) continue;
        const v = decode(attrs.get(attr)).trim();
        if (v === 'indefinite' || (attr === 'dur' && v === 'media')) continue;
        const seconds = clockSeconds(v);
        if (seconds === null) this.error(`scene.svg <${name}> ${attr} ${show(v)} is not a clock value.`);
        else this.duration(seconds, `<${name}> ${attr} ${show(v)}`);
      }
    }
    if (isRoot) {
      const vb = numbersOf(decode(attrs.get('viewBox') ?? ''));
      if (vb.length === 4 && (vb.some((n) => !(Math.abs(n) <= L.sceneMaxViewBox)) || !(vb[2] > 0 && vb[3] > 0))) {
        this.error(`scene.svg viewBox needs a positive width and height, every number from -${L.sceneMaxViewBox} to ${L.sceneMaxViewBox}.`);
      }
    }
  }

  // One strict pass: balanced tags, quoted attributes, text-only <style>.
  // Stops at the first malformed spot, so it stays linear.
  tokens(body) {
    const L = SKIN_LIMITS;
    const stack = [];
    let closed = false;
    for (let i = 0; i < body.length; ) {
      const lt = body.indexOf('<', i);
      const end = lt === -1 ? body.length : lt;
      if (stack.length === 0 && end > i && /\S/.test(body.slice(i, end))) return this.error('scene.svg has text after </svg>.');
      if (lt === -1) break;
      if (body.startsWith('<!--', lt)) {
        const close = body.indexOf('-->', lt + 4);
        if (close === -1) return this.error('scene.svg has an unterminated comment.');
        i = close + 3;
        continue;
      }
      if (body[lt + 1] === '/') {
        END_TAG.lastIndex = lt;
        const m = END_TAG.exec(body);
        if (!m) return this.error('scene.svg has a malformed end tag.');
        const top = stack.pop();
        if (!top || top.name !== m[1]) return this.error(`scene.svg closes <${m[1]}> where ${top ? `<${top.name}>` : 'nothing'} is open.`);
        closed = stack.length === 0;
        i = END_TAG.lastIndex;
        continue;
      }
      START_TAG.lastIndex = lt;
      const m = START_TAG.exec(body);
      if (!m) return this.error('scene.svg has a "<" that does not start a tag.');
      if (closed) return this.error('scene.svg has elements after </svg>.');
      const name = m[1];
      if (!SVG_ELEMENTS.has(name) && this.badElements.size < 5) this.badElements.add(name);
      const attrs = new Map();
      let p = START_TAG.lastIndex;
      let selfClosing = false;
      for (;;) {
        SPACE.lastIndex = p;
        SPACE.exec(body);
        const gap = SPACE.lastIndex - p;
        p = SPACE.lastIndex;
        if (body.startsWith('/>', p)) {
          selfClosing = true;
          p += 2;
          break;
        }
        if (body[p] === '>') {
          p += 1;
          break;
        }
        if (gap === 0) return this.error(`scene.svg <${name}> needs a space before each attribute, written name="value".`);
        ATTR.lastIndex = p;
        const a = ATTR.exec(body);
        if (!a) return this.error(`scene.svg <${name}> has a malformed attribute: every attribute is name="value", quoted.`);
        const value = a[2] ?? a[3];
        if (/[<>]/.test(value)) return this.error(`scene.svg attribute ${a[1]} on <${name}> must not contain < or >.`);
        if (attrs.has(a[1])) return this.error(`scene.svg <${name}> has the attribute ${a[1]} twice.`);
        attrs.set(a[1], value);
        p = ATTR.lastIndex;
      }
      const node = { name, kids: [], refs: [], use: null, filtered: false };
      if (stack.length) stack[stack.length - 1].kids.push(node);
      this.nodes.push(node);
      this.element(name, attrs, node, this.nodes.length === 1);
      if (++this.stats.elements > L.sceneMaxElements) {
        return this.error(`scene.svg has more than ${L.sceneMaxElements} elements.`);
      }
      i = p;
      if (selfClosing) continue;
      stack.push(node);
      this.stats.depth = Math.max(this.stats.depth, stack.length);
      if (stack.length > L.sceneMaxDepth) return this.error(`scene.svg nests elements more than ${L.sceneMaxDepth} deep.`);
      if (name === 'style') {
        const close = body.indexOf('</style', p);
        if (close === -1) return this.error('scene.svg has a <style> that is not closed.');
        const text = body.slice(p, close);
        if (text.includes('<')) return this.error('scene.svg <style> must hold text only (no elements or comments).');
        this.css(decode(text), null);
        i = close;
      }
    }
    if (stack.length) this.error(`scene.svg does not close <${stack[stack.length - 1].name}>.`);
    return undefined;
  }

  // Reference cycles, and how many elements and filters are drawn once every
  // <use>, and every reference to a mask, pattern or clipPath, is expanded.
  // Memoised and saturating, so fan-out can't blow it up.
  graph() {
    const L = SKIN_LIMITS;
    const memo = new Map();
    const cap = (n, max) => Math.min(n, max + 1);
    const visit = (node) => {
      const seen = memo.get(node);
      if (seen === 'visiting') throw new Error('cycle');
      if (seen) return seen;
      memo.set(node, 'visiting');
      let drawn = 1;
      let filters = node.filtered ? 1 : 0;
      for (const kid of node.kids) {
        const r = visit(kid);
        drawn += r.drawn;
        filters += r.filters;
      }
      for (const id of node.refs) {
        const target = this.ids.get(id);
        if (!target) continue;
        const r = visit(target);
        if (id === node.use || REDRAWN.has(target.name)) {
          drawn += r.drawn;
          filters += r.filters;
        }
      }
      const out = { drawn: cap(drawn, L.sceneMaxDrawn), filters: cap(filters, L.sceneMaxFilterUses) };
      memo.set(node, out);
      return out;
    };
    let r;
    try {
      r = visit(this.nodes[0]);
    } catch {
      return this.error('scene.svg has a reference cycle (an element that, through href or url(#...), refers back to itself).');
    }
    // A <style> rule can reach any number of elements, so it may only point at gradients.
    for (const id of this.styleRefs) {
      const target = this.ids.get(id);
      if (target && !GRADIENTS.has(target.name)) {
        this.error(`scene.svg <style> may use url(#id) for gradients only; put the reference to <${target.name}> on the elements.`);
      }
    }
    this.stats.drawn = r.drawn;
    this.stats.filterUses = r.filters;
    if (r.drawn > L.sceneMaxDrawn) this.error(`scene.svg draws more than ${L.sceneMaxDrawn} elements once <use> is expanded.`);
    if (r.filters > L.sceneMaxFilterUses) this.error(`scene.svg applies filters more than ${L.sceneMaxFilterUses} times (counting <use> copies).`);
    if (this.stats.filterPrimitives > L.sceneMaxFilterPrimitives) {
      this.error(`scene.svg has ${this.stats.filterPrimitives} filter primitives; at most ${L.sceneMaxFilterPrimitives}.`);
    }
    return undefined;
  }
}

function inspectScene(text) {
  const scan = new SceneScan();
  const errors = scan.errors;
  if (typeof text !== 'string') return { errors: ['scene.svg must be a string.'], stats: scan.stats };
  if (text.length > SKIN_LIMITS.sceneMaxChars) {
    return { errors: [`scene.svg has ${text.length} characters; at most ${SKIN_LIMITS.sceneMaxChars}.`], stats: scan.stats };
  }

  // Optional BOM, whitespace, and one leading UTF-8 XML declaration.
  let body = text.replace(/^﻿/, '');
  const lead = body.length - body.trimStart().length;
  body = body.slice(lead);
  const decl = XML_DECL.exec(body);
  if (decl) {
    const enc = /encoding\s*=\s*["']([^"']*)["']/i.exec(decl[0]);
    if (enc && enc[1].toLowerCase() !== 'utf-8') errors.push(`scene.svg XML declaration must use UTF-8, got ${show(enc[1])}.`);
    body = body.slice(decl[0].length).trimStart();
  }
  const root = /^<svg[\s>][^>]*>/i.exec(body);
  if (!root) {
    errors.push('scene.svg must start with <svg (after optional whitespace and an XML declaration).');
  } else if (!/\sviewBox\s*=\s*(["'])\s*[-+.\deE]+[\s,]+[-+.\deE]+[\s,]+[-+.\deE]+[\s,]+[-+.\deE]+\s*\1/.test(root[0])) {
    errors.push('scene.svg root <svg> needs a viewBox with four numbers.');
  }
  if (body.includes('<?')) errors.push('scene.svg must not contain <? processing instructions (other than a leading XML declaration).');

  for (const [re, what] of REFUSED) {
    if (re.test(body)) errors.push(`scene.svg must not contain ${what}.`);
  }

  // href / xlink:href / anything:href must point at a #fragment.
  const hrefRe = /href\s*=\s*(["']?)[ \t\r\n]*(.?)/gi;
  for (let m; (m = hrefRe.exec(body)); ) {
    if (m[2] !== '#') {
      errors.push('scene.svg href / xlink:href must be a #fragment.');
      break;
    }
  }
  // Any href without "=" right after (e.g. split by entities) is suspicious too.
  if (/href(?!\s*=)/i.test(body)) errors.push('scene.svg uses href outside an attribute.');

  // url( must be url(#id).
  const urlRe = /url[ \t\r\n]*\([ \t\r\n]*(["']?)[ \t\r\n]*(.?)/gi;
  for (let m; (m = urlRe.exec(body)); ) {
    if (m[2] !== '#') {
      errors.push('scene.svg url( must be url(#id).');
      break;
    }
  }

  // Entity references: only the five XML built-ins.
  const entRe = /&([^;\s<>&"']{0,32})(;?)/g;
  for (let m; (m = entRe.exec(body)); ) {
    if (!m[2] || !XML_ENTITIES.has(m[1])) {
      errors.push('scene.svg may only use &amp; &lt; &gt; &quot; &apos; entity references.');
      break;
    }
  }

  // Comments: plain words only.
  for (let i = body.indexOf('<!--'); i !== -1; i = body.indexOf('<!--', i)) {
    const end = body.indexOf('-->', i + 4);
    if (end === -1) {
      errors.push('scene.svg has an unterminated comment.');
      break;
    }
    const inner = body.slice(i + 4, end);
    if (/[<(@]|--|href/i.test(inner) || inner.endsWith('-')) {
      errors.push('scene.svg comments must be plain words (no <, --, href, ( or @).');
      break;
    }
    i = end + 3;
  }

  // A "<" that does not start a tag, comment or end tag is malformed.
  if (/<(?![A-Za-z_/!?])/.test(body)) errors.push('scene.svg has a stray "<".');

  if (root) {
    const before = errors.length;
    scan.tokens(body);
    if (scan.badElements.size) {
      errors.push(`scene.svg uses elements that are not allowed: ${[...scan.badElements].map((b) => `<${b}>`).join(', ')}.`);
    }
    if (errors.length === before) scan.graph();
  }
  return { errors, stats: scan.stats };
}

/**
 * Validate the text of a scene.svg. Conservative: refuses when unsure.
 * @param {unknown} text
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateScene(text) {
  const { errors } = inspectScene(text);
  return { ok: errors.length === 0, errors };
}

/**
 * The counts the scene limits are checked against (for docs and tests).
 * @param {string} text
 * @returns {{ elements: number, depth: number, drawn: number, filterPrimitives: number, filterUses: number, minAnimationSeconds: number|null }}
 */
export function sceneStats(text) {
  return inspectScene(text).stats;
}
