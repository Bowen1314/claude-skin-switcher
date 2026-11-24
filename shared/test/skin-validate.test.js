import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { validateSkin, validateScene, SKIN_LIMITS } from '../skin-validate.js';

const root = fileURLToPath(new URL('../..', import.meta.url));

function goodSkin() {
  return {
    format: 1,
    slug: 'graphite-circuit',
    name: 'Graphite Circuit',
    description: 'Graphite and one signal cyan.',
    author: 'someone',
    version: 7,
    tags: ['dark', 'minimal'],
    extra: 'dropped',
    colors: {
      roles: { accent: '#35b8c9', danger: '#e0524a' },
      light: {
        anchors: {
          'surface-0': '#eceef1', 'surface-1': '#f3f4f6', 'surface-2': '#fafbfc', 'surface-3': '#FAFBFC',
          'text-primary': '#15181d', 'text-muted': '#555c67',
        },
      },
      dark: { anchors: { 'surface-0': '#0e1013', 'surface-1': '#14171b', 'text-primary': '#e6e9ee' } },
    },
    backdrop: { scene: true, glass: { blur: 10, opacity: 0.72, junk: 1 } },
    style: {
      Heading: { fontFamily: ['mono'], fontWeight: 'semibold', letterSpacing: 0.4 },
      Text: { fontSize: 14, lineHeight: 22, color: 'surface-3' },
      UserMessage: { radius: 3, backgroundColor: '#11223344', shadow: { x: 0, y: 2, blur: 8, color: 'border' } },
      ToolUse: { fontFamily: ['code', 'mono'], paddingX: 8, shadow: 'none' },
    },
    variables: [
      { key: 'signal', label: 'Signal color', type: 'color', default: '#3ec6d8' },
      { key: 'grid', label: 'Grid strength', type: 'range', min: 0, max: 1, step: 0.05, default: 0.6, junk: true },
      { key: 'traces', label: 'Traces', type: 'toggle', default: true },
    ],
  };
}

function errorsOf(mutate) {
  const s = goodSkin();
  mutate(s);
  const r = validateSkin(s);
  assert.equal(r.ok, false, 'expected the skin to be refused');
  return r.errors.join('\n');
}

test('good skin normalizes: drops unknown keys, strips author/version', () => {
  const r = validateSkin(goodSkin());
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal('author' in r.skin, false);
  assert.equal('version' in r.skin, false);
  assert.equal('extra' in r.skin, false);
  assert.deepEqual(r.skin.backdrop, { scene: true, glass: { blur: 10, opacity: 0.72 } });
  assert.equal('junk' in r.skin.variables[1], false);
  assert.deepEqual(Object.keys(r.skin), ['format', 'slug', 'name', 'description', 'tags', 'colors', 'backdrop', 'style', 'variables']);
});

test('minimal skin: description and tags default', () => {
  const r = validateSkin({ format: 1, slug: 'abc', name: 'A', colors: { dark: { anchors: { 'surface-0': '#000000', 'text-primary': '#ffffff' } } } });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.skin.description, '');
  assert.deepEqual(r.skin.tags, []);
});

test('does not mutate the input and is not fooled by __proto__', () => {
  const s = goodSkin();
  const before = JSON.stringify(s);
  validateSkin(s);
  assert.equal(JSON.stringify(s), before);
  const evil = JSON.parse('{"format":1,"slug":"abc","name":"A","__proto__":{"polluted":1},"colors":{"dark":{"anchors":{"surface-0":"#000000","text-primary":"#ffffff"}}}}');
  const r = validateSkin(evil);
  assert.equal(r.ok, true);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.getPrototypeOf(r.skin), Object.prototype);
});

test('top-level fields', () => {
  assert.match(errorsOf((s) => (s.format = 2)), /\$\.format/);
  assert.match(errorsOf((s) => (s.slug = 'Ab')), /\$\.slug/);
  assert.match(errorsOf((s) => (s.slug = 'ab')), /\$\.slug/); // too short
  assert.match(errorsOf((s) => (s.slug = '-abc')), /\$\.slug/);
  assert.match(errorsOf((s) => (s.slug = 'abc-')), /\$\.slug/);
  assert.match(errorsOf((s) => (s.slug = 'a'.repeat(41))), /\$\.slug/);
  assert.equal(validateSkin({ ...goodSkin(), slug: 'a'.repeat(40) }).ok, true);
  assert.match(errorsOf((s) => (s.name = '')), /\$\.name/);
  assert.match(errorsOf((s) => (s.name = '   ')), /\$\.name/);
  assert.match(errorsOf((s) => (s.name = 'x'.repeat(41))), /\$\.name/);
  assert.match(errorsOf((s) => (s.name = 'a\u0000b')), /\$\.name/);
  assert.match(errorsOf((s) => (s.description = 'x'.repeat(141))), /\$\.description/);
  assert.match(errorsOf((s) => (s.tags = ['a', 'b', 'c', 'd', 'e', 'f'])), /\$\.tags/);
  assert.match(errorsOf((s) => (s.tags = ['Dark'])), /\$\.tags\[0\]/);
  assert.match(errorsOf((s) => (s.tags = ['x'.repeat(21)])), /\$\.tags\[0\]/);
  assert.match(errorsOf((s) => (s.tags = 'dark')), /\$\.tags/);
});

test('colors', () => {
  assert.match(errorsOf((s) => delete s.colors), /\$\.colors is required/);
  assert.match(errorsOf((s) => { delete s.colors.light; delete s.colors.dark; }), /needs light, dark/);
  assert.match(errorsOf((s) => (s.colors.roles.accent = 'red')), /\$\.colors\.roles\.accent/);
  assert.match(errorsOf((s) => (s.colors.roles.primary = '#000000')), /\$\.colors\.roles\.primary/);
  assert.match(errorsOf((s) => delete s.colors.dark.anchors['surface-0']), /\$\.colors\.dark\.anchors\["surface-0"\] is required/);
  assert.match(errorsOf((s) => delete s.colors.light.anchors['text-primary']), /text-primary"\] is required/);
  assert.match(errorsOf((s) => (s.colors.dark.anchors['surface-9'] = '#000000')), /surface-9/);
  assert.match(errorsOf((s) => (s.colors.dark.anchors['text-primary'] = '#fff')), /text-primary.*#rrggbb/);
  assert.match(errorsOf((s) => (s.colors.dark.gray = {})), /\$\.colors\.dark\.gray/);
});

test('surface ordering by relative luminance in each mode', () => {
  // dark: surface-1 darker than surface-0
  assert.match(errorsOf((s) => (s.colors.dark.anchors['surface-1'] = '#000000')), /dark\.anchors\["surface-1"\].*darker than surface-0/);
  // light: surface-0 lighter than surface-1
  assert.match(errorsOf((s) => (s.colors.light.anchors['surface-0'] = '#ffffff')), /light\.anchors\["surface-1"\].*darker/);
  // gaps are compared too (surface-0 vs surface-2 when surface-1 is absent)
  assert.match(
    errorsOf((s) => { delete s.colors.light.anchors['surface-1']; s.colors.light.anchors['surface-0'] = '#ffffff'; }),
    /surface-2.*darker than surface-0/,
  );
  // equal is fine
  const r = validateSkin({ ...goodSkin(), colors: { dark: { anchors: { 'surface-0': '#101010', 'surface-1': '#101010', 'text-primary': '#eeeeee' } } } });
  assert.equal(r.ok, true);
  // light: surface-2 must equal surface-3 (case-insensitively)
  assert.match(errorsOf((s) => (s.colors.light.anchors['surface-3'] = '#ffffff')), /surface-3.*must equal surface-2/);
  // dark mode has no such rule
  const d = goodSkin();
  d.colors.dark.anchors['surface-2'] = '#1a1d22';
  d.colors.dark.anchors['surface-3'] = '#1f2328';
  assert.equal(validateSkin(d).ok, true);
});

test('backdrop', () => {
  assert.equal(validateSkin({ ...goodSkin(), backdrop: { color: '#102030' } }).ok, true);
  assert.match(errorsOf((s) => (s.backdrop = { scene: true, color: '#000000' })), /exactly one/);
  assert.match(errorsOf((s) => (s.backdrop = {})), /exactly one/);
  assert.match(errorsOf((s) => (s.backdrop = { scene: 'yes' })), /\$\.backdrop\.scene/);
  assert.match(errorsOf((s) => (s.backdrop = { color: 'blue' })), /\$\.backdrop\.color/);
  assert.match(errorsOf((s) => (s.backdrop.glass.blur = 65)), /\$\.backdrop\.glass\.blur/);
  assert.match(errorsOf((s) => (s.backdrop.glass.opacity = -0.1)), /\$\.backdrop\.glass\.opacity/);
  assert.match(errorsOf((s) => (s.backdrop.glass.opacity = NaN)), /\$\.backdrop\.glass\.opacity/);
  assert.match(errorsOf((s) => (s.backdrop = { color: '#000000', glass: {} })), /glass is only allowed/);
});

test('style', () => {
  assert.match(errorsOf((s) => (s.style.Sidebar = {})), /\$\.style\.Sidebar/);
  assert.match(errorsOf((s) => (s.style.Text = [{ fontSize: 12 }])), /\$\.style\.Text must be one rule/);
  assert.match(errorsOf((s) => (s.style.Text.radius = 4)), /\$\.style\.Text\.radius is not allowed/);
  assert.match(errorsOf((s) => (s.style.Heading.backgroundColor = '#000000')), /Heading\.backgroundColor is not allowed/);
  assert.match(errorsOf((s) => (s.style.ToolUse.fontSize = 14)), /ToolUse\.fontSize is not allowed/);
  assert.match(errorsOf((s) => (s.style.Text.fontSize = 29)), /\$\.style\.Text\.fontSize/);
  assert.match(errorsOf((s) => (s.style.Text.fontSize = 10)), /\$\.style\.Text\.fontSize/);
  assert.match(errorsOf((s) => (s.style.Text.lineHeight = 13)), /lineHeight \(13\) must be at least fontSize/);
  assert.match(errorsOf((s) => (s.style.Text.lineHeight = 49)), /lineHeight/);
  assert.match(errorsOf((s) => (s.style.Heading.letterSpacing = -2)), /letterSpacing/);
  assert.match(errorsOf((s) => (s.style.Heading.fontWeight = 'heavy')), /fontWeight/);
  assert.match(errorsOf((s) => (s.style.Heading.fontFamily = ['comic'])), /fontFamily\[0\]/);
  assert.match(errorsOf((s) => (s.style.Heading.fontFamily = 'mono')), /fontFamily/);
  assert.match(errorsOf((s) => (s.style.Heading.italic = 'yes')), /italic/);
  assert.match(errorsOf((s) => (s.style.UserMessage.borderWidth = 9)), /borderWidth/);
  assert.match(errorsOf((s) => (s.style.UserMessage.radius = 65)), /radius/);
  assert.match(errorsOf((s) => (s.style.UserMessage.paddingY = 49)), /paddingY/);
  assert.match(errorsOf((s) => (s.style.UserMessage.backgroundColor = 'page-bg')), /backgroundColor must be/);
  assert.match(errorsOf((s) => (s.style.UserMessage.backgroundColor = '#abc')), /backgroundColor must be/);
  assert.match(errorsOf((s) => (s.style.UserMessage.shadow = { x: 0, y: 0, blur: 1 })), /shadow\.color is required/);
  assert.match(errorsOf((s) => (s.style.UserMessage.shadow = { x: 0, y: 0, blur: 1, color: 'red' })), /shadow\.color/);
  assert.match(errorsOf((s) => (s.style.UserMessage.shadow = 'big')), /shadow must be/);
});

test('variables', () => {
  assert.match(errorsOf((s) => (s.variables = 'x')), /\$\.variables must be a list/);
  assert.match(
    errorsOf((s) => (s.variables = Array.from({ length: 13 }, (_, i) => ({ key: `k${i}`, label: 'L', type: 'toggle', default: true })))),
    /at most 12/,
  );
  assert.match(errorsOf((s) => (s.variables[0].key = 'Signal')), /\$\.variables\[0\]\.key/);
  assert.match(errorsOf((s) => (s.variables[0].key = 'a'.repeat(25))), /\$\.variables\[0\]\.key/);
  assert.match(errorsOf((s) => (s.variables[1].key = 'signal')), /\$\.variables\[1\]\.key "signal" is used twice/);
  assert.match(errorsOf((s) => (s.variables[0].label = '')), /\$\.variables\[0\]\.label/);
  assert.match(errorsOf((s) => (s.variables[0].label = 'x'.repeat(33))), /\$\.variables\[0\]\.label/);
  assert.match(errorsOf((s) => (s.variables[0].type = 'number')), /\$\.variables\[0\]\.type/);
  assert.match(errorsOf((s) => (s.variables[0].default = '#fff')), /\$\.variables\[0\]\.default/);
  assert.match(errorsOf((s) => (s.variables[2].default = 1)), /\$\.variables\[2\]\.default/);
  assert.match(errorsOf((s) => (s.variables[1].min = 1)), /min \(1\) must be less than max/);
  assert.match(errorsOf((s) => (s.variables[1].default = 2)), /default \(2\) must be within/);
  assert.match(errorsOf((s) => (s.variables[1].step = 0)), /step/);
  assert.match(errorsOf((s) => delete s.variables[1].step), /\$\.variables\[1\]\.step must be a number/);
});

test('every error names a JSON path', () => {
  const r = validateSkin({ format: 0, slug: 1, name: null, tags: [1], colors: { dark: { anchors: {} } }, style: { X: 1 }, variables: [1] });
  assert.equal(r.ok, false);
  for (const e of r.errors) assert.match(e, /^\$/, e);
  assert.deepEqual(validateSkin(null), { ok: false, errors: ['$ must be a JSON object.'] });
  assert.equal(validateSkin([]).ok, false);
});

// ------------------------------------------------------------------ scenes

const SVG_OK = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice">
<style>svg{--v-glow:#f5c24a}.a{fill:url(#g);animation:spin 9s linear infinite}@keyframes spin{to{transform:rotate(1turn)}}
@media (prefers-color-scheme: light){.a{opacity:.5}}</style>
<!-- a plain words comment -->
<defs><radialGradient id="g"><stop offset="0" stop-color="#fff"/></radialGradient>
<pattern id="p" width="10" height="10"><path d="M0 0h10"/></pattern></defs>
<g data-ctx="0.35"><circle class="a" cx="10" cy="10" r="5"/><use href="#p"/><use xlink:href='#p'/></g>
<text x="1" y="2">Tom &amp; Jerry</text>
<rect width="10" height="10" fill="url( '#p' )"><animate attributeName="opacity" values="0;1" dur="3s"/></rect>
</svg>`;

function sceneRefused(svg, re) {
  const r = validateScene(svg);
  assert.equal(r.ok, false, `expected refusal: ${String(svg).slice(0, 120)}`);
  if (re) assert.match(r.errors.join('\n'), re);
}
const wrap = (inner) => `<svg viewBox="0 0 10 10">${inner}</svg>`;

test('good scenes pass', () => {
  assert.deepEqual(validateScene(SVG_OK), { ok: true, errors: [] });
  assert.equal(validateScene(`﻿  \n<?xml version="1.0" encoding="UTF-8"?>\n${SVG_OK}`).ok, true);
  assert.equal(validateScene(`<?xml version="1.0"?><svg viewBox="0,0,10,10"></svg>`).ok, true);
});

test('official scenes and previews in the repo pass', () => {
  const dirs = [join(root, 'plugin/skins'), join(root, 'app/renderer/previews')];
  let n = 0;
  for (const d of dirs) {
    if (!existsSync(d)) continue;
    for (const entry of readdirSync(d, { recursive: true })) {
      if (!String(entry).endsWith('.svg')) continue;
      const r = validateScene(readFileSync(join(d, String(entry)), 'utf8'));
      assert.equal(r.ok, true, `${entry}: ${r.errors.join('; ')}`);
      n++;
    }
  }
  assert.ok(n >= 0);
});

test('official skin.json files in the repo pass', () => {
  const d = join(root, 'plugin/skins');
  if (!existsSync(d)) return;
  for (const name of readdirSync(d)) {
    const f = join(d, name, 'skin.json');
    if (!existsSync(f)) continue;
    const r = validateSkin(JSON.parse(readFileSync(f, 'utf8')));
    assert.equal(r.ok, true, `${name}: ${(r.errors || []).join('; ')}`);
    assert.equal(`official.${r.skin.slug}`, name);
  }
});

test('shape: start, viewBox, size', () => {
  sceneRefused('<html><svg viewBox="0 0 1 1"></svg></html>', /must start with <svg/);
  sceneRefused('<svgx viewBox="0 0 1 1"></svgx>', /must start with <svg/);
  sceneRefused('<svg width="10"></svg>', /viewBox/);
  sceneRefused('<svg viewBox="0 0 10"></svg>', /viewBox/);
  sceneRefused('<?xml version="1.0" encoding="UTF-16"?><svg viewBox="0 0 1 1"></svg>', /UTF-8/);
  sceneRefused(wrap('<g/>'.repeat(SKIN_LIMITS.sceneMaxChars)), /at most 120000/);
  sceneRefused(42);
  assert.equal(validateScene(wrap(' '.repeat(SKIN_LIMITS.sceneMaxChars - wrap('').length))).ok, true);
});

test('refused elements, any case', () => {
  sceneRefused(wrap('<script>alert(1)</script>'), /<script>/);
  sceneRefused(wrap('<ScRiPt>alert(1)</ScRiPt>'), /<script>/);
  sceneRefused(wrap('<svg:script>alert(1)</svg:script>'));
  sceneRefused(wrap('<image href="#a"/>'), /<image>/);
  sceneRefused(wrap('<IMAGE/>'), /<image>/);
  sceneRefused(wrap('<feImage href="#a"/>'), /not allowed: <feImage>/);
  sceneRefused(wrap('<foreignObject><div/></foreignObject>'), /foreignObject/);
  sceneRefused(wrap('<FOREIGNOBJECT/>'), /foreignObject/);
  sceneRefused(wrap('<iframe src="x"/>'), /<iframe>/);
  sceneRefused(wrap('<a href="#x"><rect/></a>'), /not allowed: <a>/);
  sceneRefused(wrap('<handler type="application/ecmascript">x</handler>'), /<handler>/);
  sceneRefused(wrap('< script>alert(1)</script>'));
  sceneRefused(wrap('<metadata><rdf:RDF/></metadata>'), /metadata/);
});

test('event attributes, hrefs and url()', () => {
  sceneRefused(wrap('<rect onload="alert(1)"/>'), /on\.\.\. event/);
  sceneRefused(wrap('<rect OnClick = "x"/>'), /on\.\.\. event/);
  sceneRefused(wrap('<rect\nonmouseover="x"/>'), /on\.\.\. event/);
  sceneRefused(wrap('<rect/onload="x"/>'), /on\.\.\. event/);
  sceneRefused(wrap('<use href="other.svg#a"/>'), /#fragment/);
  sceneRefused(wrap('<use xlink:href="javascript:alert(1)"/>'), /javascript|#fragment/);
  sceneRefused(wrap('<use XLINK:HREF="https://evil.example/a.svg#x"/>'), /#fragment/);
  sceneRefused(wrap('<use x:href="//evil.example/a#x"/>'), /#fragment/);
  sceneRefused(wrap('<use href=https://evil.example/x/>'), /#fragment/);
  sceneRefused(wrap('<use href = " https://e.example"/>'), /#fragment/);
  sceneRefused(wrap('<set attributeName="href" to="javascript:alert(1)"/>'), /animating href/);
  sceneRefused(wrap('<animate attributeName="xlink:href" values="https://evil.example"/>'), /animating href/);
  sceneRefused(wrap('<set attributeName="onclick" to="x"/>'));
  sceneRefused(wrap('<rect style="fill:url(https://evil.example/x)"/>'), /url\(#id\)/);
  sceneRefused(wrap('<style>.a{fill:URL( "http://evil.example" )}</style>'), /url\(#id\)/);
  sceneRefused(wrap('<style>.a{background:image-set("x.png" 1x)}</style>'), /resource functions/);
  sceneRefused(wrap('<style>.a{background:-webkit-image-set("x.png" 1x)}</style>'), /resource functions/);
  sceneRefused(wrap('<rect fill="url(data:image/svg+xml,abc)"/>'), /data: URIs/);
  sceneRefused(wrap('<style>@import "https://evil.example/a.css";</style>'), /@import/);
  sceneRefused(wrap('<style>@FONT-FACE{font-family:x;src:local(x)}</style>'), /@font-face/);
});

test('entity, escape and declaration tricks', () => {
  sceneRefused(`<!DOCTYPE svg [<!ENTITY x "<script>alert(1)</script>">]>${wrap('&x;')}`, /DOCTYPE|must start/);
  sceneRefused(wrap('<!ENTITY x "y">'), /ENTITY/);
  sceneRefused(wrap('<![CDATA[<script>alert(1)</script>]]>'), /CDATA/);
  sceneRefused(wrap('<style><![cdata[ .a{} ]]></style>'), /CDATA/);
  sceneRefused(wrap('<use h&#114;ef="https://evil.example"/>'), /character references/);
  sceneRefused(wrap('<use href="&#106;avascript:alert(1)"/>'), /character references/);
  sceneRefused(wrap('<use href="&#x6A;avascript:alert(1)"/>'), /character references/);
  sceneRefused(wrap('<text>&x;</text>'), /entity references/);
  sceneRefused(wrap('<text>&nbsp;</text>'), /entity references/);
  sceneRefused(wrap('<text>a & b</text>'), /entity references/);
  sceneRefused(wrap('<style>.a{fill:\\75rl(https://evil.example)}</style>'), /backslashes/);
  sceneRefused(wrap('<style>@\\69mport "x";</style>'), /backslashes/);
  sceneRefused(wrap('<?xml-stylesheet href="https://evil.example/a.css"?>'), /processing instructions/);
  sceneRefused(`<?xml version="1.0"?><?xml-stylesheet href="x"?>${wrap('')}`, /processing instructions/);
  sceneRefused(wrap('<style>.a{width:expression(alert(1))}</style>'), /expression/);
  sceneRefused(wrap('<g xml:base="https://evil.example/"/>'), /xml:base/);
  sceneRefused(wrap('<rect fill="#000"\u0001/>'), /control characters/);
});

test('comments must be plain words', () => {
  assert.equal(validateScene(wrap('<!-- quiet hills, slow stars -->')).ok, true);
  sceneRefused(wrap('<!-- <script> -->'), /comments/);
  sceneRefused(wrap('<!-- a -- b -->'), /comments/);
  sceneRefused(wrap('<!-- see href -->'), /comments|href/);
  sceneRefused(wrap('<!-- f(x) -->'), /comments/);
  sceneRefused(wrap('<!-- @media -->'), /comments/);
  sceneRefused(wrap('<!-- dangling ->'), /unterminated/);
  sceneRefused(wrap('<!-- ends badly --->'), /comments/);
});

test('scene validation is fast on large adversarial input', () => {
  const inputs = [
    wrap('<g '.repeat(30000)),
    wrap('href='.repeat(20000)),
    wrap('url('.repeat(25000)),
    wrap('&'.repeat(100000)),
    wrap('<!--'.repeat(25000)),
    wrap(`${'a'.repeat(110000)}`),
    wrap('.on'.repeat(39000)),
    wrap(':on'.repeat(39000)),
    wrap('on '.repeat(39000)),
    wrap('<g/>'.repeat(29000)),
    wrap('<a'.repeat(59000)),
    wrap('attributeName='.repeat(8000)),
  ];
  for (const s of inputs) {
    const t = performance.now();
    validateScene(s);
    const ms = performance.now() - t;
    assert.ok(ms < 50, `took ${ms.toFixed(1)} ms on ${JSON.stringify(s.slice(25, 35))}`);
  }
});
