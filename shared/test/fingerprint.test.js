import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { normalizeScene, normalizeSkinShape, skinFingerprint } from '../fingerprint.js';
import { validateSkin, validateScene } from '../skin-validate.js';

const official = (slug) => {
  const dir = new URL(`../../plugin/skins/official.${slug}/`, import.meta.url);
  return { skin: validateSkin(JSON.parse(readFileSync(new URL('skin.json', dir), 'utf8'))).skin, scene: readFileSync(new URL('scene.svg', dir), 'utf8') };
};

const SCENE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <!-- a comment -->
  <style>svg{--v-glow:#ffffff}.a{fill:var(--v-glow, #f5c24a)}.b{stroke:rgb(10, 20, 30)}</style>
  <circle class="a" r="5" fill="red"/>
  <rect width="10" height="10" fill="#123"/>
</svg>`;

const skin = (over = {}) => ({
  format: 1,
  slug: 'tiny',
  name: 'Tiny',
  description: 'A tiny one.',
  tags: ['dark'],
  colors: { roles: { accent: '#35b8c9' }, dark: { anchors: { 'surface-0': '#101114', 'text-primary': '#e8e9eb' } } },
  backdrop: { scene: true },
  ...over,
});

test('normalizeScene drops comments, whitespace, colors and var() fallbacks', () => {
  const n = normalizeScene(SCENE);
  assert.doesNotMatch(n, /\s/);
  assert.doesNotMatch(n, /comment/);
  assert.doesNotMatch(n, /#[0-9a-f]{3,8}\b|rgb\(|\bred\b/i);
  assert.match(n, /var\(--v-glow\)/);
  assert.doesNotMatch(n, /var\(--v-glow,/);
  assert.match(n, /<circle/);
  // Fallbacks with parentheses inside, nested var(), and other variables kept as they are.
  assert.equal(normalizeScene('a{x:var(--v-a, var(--v-b, calc(1px + 2px)))}'), 'a{x:var(--v-a)}');
  assert.equal(normalizeScene('a{x:var(--ctx, 1)}'), 'a{x:var(--ctx,1)}');
  // Words that only contain a color name, and #fragments that aren't colors, stay.
  assert.match(normalizeScene('<g class="redish" fill="url(#glow)"/>'), /redish.*url\(#glow\)/);
  // Unclosed comment / call: no throw, the rest is cut or kept.
  assert.equal(normalizeScene('<g/><!-- open'), '<g/>');
  assert.equal(normalizeScene('a{x:var(--v-a, (}'), 'a{x:var(--v-a,(}');
});

test('recoloring, reformatting or renaming keeps the fingerprint', async () => {
  const base = await skinFingerprint(skin(), SCENE);
  assert.match(base, /^[0-9a-f]{64}$/);
  const recolored = SCENE.replace('#ffffff', '#00ff00').replace('#f5c24a', 'hsl(10 50% 50%)').replace('rgb(10, 20, 30)', '#abcdef').replace('fill="red"', 'fill="Blue"').replace('#123', '#456789');
  assert.equal(await skinFingerprint(skin(), recolored), base);
  const reformatted = SCENE.replace(/\n\s*/g, '').replace('<!-- a comment -->', '<!-- mine now -->').replace('var(--v-glow, #f5c24a)', 'var( --v-glow )');
  assert.equal(await skinFingerprint(skin(), reformatted), base);
  const renamed = skin({ slug: 'my-copy', name: 'My copy', description: 'Mine.', tags: ['light'], colors: { roles: { accent: '#ff0000' } } });
  assert.equal(await skinFingerprint(renamed, SCENE), base, 'with a scene only the scene counts');
});

test('changing the shapes changes the fingerprint', async () => {
  const base = await skinFingerprint(skin(), SCENE);
  assert.notEqual(await skinFingerprint(skin(), SCENE.replace('r="5"', 'r="6"')), base);
  assert.notEqual(await skinFingerprint(skin(), SCENE.replace('<rect', '<ellipse').replace('/>\n</svg>', '/>\n</svg>')), base);
  assert.notEqual(await skinFingerprint(skin(), SCENE.replace('</svg>', '<path d="M0 0L10 10"/></svg>')), base);
  assert.notEqual(await skinFingerprint(skin(), SCENE.replace('var(--v-glow, #f5c24a)', 'var(--v-shine)')), base);
});

test('the official skins: distinct, valid, and stable under a recolor', async () => {
  const a = official('firefly-meadow');
  const b = official('graphite-circuit');
  assert.equal(validateScene(a.scene).ok, true);
  const fa = await skinFingerprint(a.skin, a.scene);
  const fb = await skinFingerprint(b.skin, b.scene);
  assert.notEqual(fa, fb);
  const recolored = a.scene.replace(/#[0-9a-fA-F]{6}/g, (h) => `#${h.slice(1).split('').reverse().join('')}`);
  assert.notEqual(recolored, a.scene);
  assert.equal(validateScene(recolored).ok, true);
  assert.equal(await skinFingerprint(a.skin, recolored), fa);
});

test('without a scene: identity ignored, keys sorted; colors and shape count', async () => {
  const flat = skin({ backdrop: { color: '#111111' }, style: { UserMessage: { radius: 3, backgroundColor: 'surface-1' } } });
  const base = await skinFingerprint(flat, null);
  const renamed = { name: 'Other', slug: 'other', description: 'x', tags: [], author: 'bob', version: 7, style: { UserMessage: { backgroundColor: 'surface-1', radius: 3 } }, backdrop: { color: '#111111' }, colors: { dark: { anchors: { 'text-primary': '#E8E9EB', 'surface-0': '#101114' } }, roles: { accent: '#35b8c9' } }, format: 1 };
  assert.equal(await skinFingerprint(renamed, null), base, 'renamed, keys reordered, hex case changed');
  assert.equal(await skinFingerprint(flat, ''), base, 'an empty scene is no scene');
  assert.notEqual(await skinFingerprint({ ...flat, backdrop: { color: '#222222' } }, null), base, 'a recolor is a different palette skin');
  assert.notEqual(await skinFingerprint({ ...flat, style: { UserMessage: { radius: 9 } } }, null), base);
  assert.notEqual(await skinFingerprint(flat, SCENE), base, 'scene and no-scene hashes never mix');
  assert.doesNotMatch(normalizeSkinShape(flat), /Tiny|tiny|dark"\]/);
});

test('without a scene, palette-only skins collide only when the palette is identical', async () => {
  const flat = (over) => {
    const { backdrop, ...rest } = skin(over);
    const v = validateSkin(rest);
    assert.equal(v.ok, true, String(v.errors));
    return v.skin;
  };
  const one = flat({ slug: 'one', name: 'One' });
  const same = flat({ slug: 'two', name: 'Two', description: 'Mine.', tags: ['light'] });
  const other = flat({ slug: 'two', name: 'Two', colors: { roles: { accent: '#ff8800' }, dark: { anchors: { 'surface-0': '#fafafa', 'text-primary': '#111111' } } } });
  assert.equal(await skinFingerprint(one, null), await skinFingerprint(same, null));
  assert.notEqual(await skinFingerprint(one, null), await skinFingerprint(other, null));
});

test('a large scene normalizes in linear time', () => {
  const big = `<svg xmlns="http://www.w3.org/2000/svg">${'<circle r="1" fill="rgb(1,2,3)" class="var(--v-a, red)"/>'.repeat(2000)}</svg>`;
  const t = performance.now();
  normalizeScene(big);
  normalizeScene('var(--v-a,'.repeat(10000));
  normalizeScene('rgb('.repeat(30000));
  normalizeScene('<!--'.repeat(30000));
  assert.ok(performance.now() - t < 500);
});
