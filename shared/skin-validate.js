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
});

const HEX6 = /^#[0-9a-fA-F]{6}$/;
const HEX6_OR_8 = /^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

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
    errors.push(`${path} must not contain control characters.`);
    return undefined;
  }
  if (min > 0 && v.trim() === '') {
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

// Elements a scene may use. Anything else (script, image, feImage,
// foreignObject, iframe, a, metadata, namespaced tags...) is refused.
const SVG_ELEMENTS = new Set(
  [
    'svg', 'g', 'defs', 'symbol', 'use', 'title', 'desc', 'style',
    'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
    'text', 'tspan', 'textPath',
    'linearGradient', 'radialGradient', 'stop', 'pattern', 'clipPath', 'mask', 'marker',
    'filter', 'feBlend', 'feColorMatrix', 'feComponentTransfer', 'feComposite', 'feConvolveMatrix',
    'feDiffuseLighting', 'feDisplacementMap', 'feDistantLight', 'feDropShadow', 'feFlood',
    'feFuncA', 'feFuncB', 'feFuncG', 'feFuncR', 'feGaussianBlur', 'feMerge', 'feMergeNode',
    'feMorphology', 'feOffset', 'fePointLight', 'feSpecularLighting', 'feSpotLight', 'feTile', 'feTurbulence',
    'animate', 'animateMotion', 'animateTransform', 'mpath', 'set',
  ].map((n) => n.toLowerCase()),
);

// Simple substring refusals (case-insensitive). Each is linear to scan.
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

/**
 * Validate the text of a scene.svg. Conservative: refuses when unsure.
 * @param {unknown} text
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateScene(text) {
  const errors = [];
  if (typeof text !== 'string') return { ok: false, errors: ['scene.svg must be a string.'] };
  if (text.length > SKIN_LIMITS.sceneMaxChars) {
    return { ok: false, errors: [`scene.svg has ${text.length} characters; at most ${SKIN_LIMITS.sceneMaxChars}.`] };
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
  const hrefRe = /href\s*=\s*(["']?)\s*(.?)/gi;
  for (let m; (m = hrefRe.exec(body)); ) {
    if (m[2] !== '#') {
      errors.push('scene.svg href / xlink:href must be a #fragment.');
      break;
    }
  }
  // Any href without "=" right after (e.g. split by entities) is suspicious too.
  if (/href(?!\s*=)/i.test(body)) errors.push('scene.svg uses href outside an attribute.');

  // url( must be url(#id).
  const urlRe = /url\s*\(\s*(["']?)\s*(.?)/gi;
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

  // Element allowlist (case-insensitive; namespaced tags are refused).
  const tagRe = /<\/?\s*([A-Za-z_][\w:.-]*)/g;
  const bad = new Set();
  for (let m; (m = tagRe.exec(body)); ) {
    const name = m[1].toLowerCase();
    if (!SVG_ELEMENTS.has(name)) bad.add(m[1]);
    if (bad.size >= 5) break;
  }
  if (bad.size) errors.push(`scene.svg uses elements that are not allowed: ${[...bad].map((b) => `<${b}>`).join(', ')}.`);
  // A "<" that does not start a tag, comment or end tag is malformed.
  if (/<(?![A-Za-z_/!?])/.test(body)) errors.push('scene.svg has a stray "<".');

  return { ok: errors.length === 0, errors };
}
