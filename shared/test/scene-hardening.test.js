// Red-team cases for scene.svg and skin.json text: shapes Claude refuses,
// resource limits, and display-spoofing characters. Each case once passed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { validateSkin, validateScene, sceneStats, SKIN_LIMITS } from '../skin-validate.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const wrap = (inner) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${inner}</svg>`;

function refused(svg, re) {
  const r = validateScene(svg);
  assert.equal(r.ok, false, `expected refusal: ${String(svg).slice(0, 160)}`);
  if (re) assert.match(r.errors.join('\n'), re);
}
function passes(svg) {
  const r = validateScene(svg);
  assert.equal(r.ok, true, `${String(svg).slice(0, 160)}\n${r.errors.join('\n')}`);
}

test('malformed shapes Claude refuses are refused here too', () => {
  refused(wrap('<style><rect/></style>'), /<style>/);
  refused(wrap('<style>rect{fill:red}'), /<style>|not closed/);
  refused(wrap('<rect hidden/>'), /attribute/);
  refused(wrap('<rect class="a>b"/>'), /attribute/);
  refused(wrap('<use h\nref="#a"/>'), /attribute/);
  refused(wrap('<rect fill=red/>'), /attribute/);
  refused(wrap('<rect x="1"y="2"/>'), /attribute/);
  refused(wrap('<rect x="1" x="2"/>'), /twice/);
  refused(wrap('<g><rect></g></rect>'), /closes|not closed/);
  refused(wrap('<g>'), /closes|not close/);
  refused(`${wrap('')}<rect/>`, /after <\/svg>/);
  refused(`${wrap('')}text`, /after <\/svg>/);
  refused(wrap('<RECT/>'), /not allowed/);
  refused(wrap('<lineargradient/>'), /not allowed/);
  // renderScene writes visibility="hidden" next to data-ctx; a second one breaks the XML.
  refused(wrap('<g data-ctx="0.5" visibility="visible"/>'), /visibility/);
});

test('namespaces: no xmlns redefinition or foreign namespaced attributes', () => {
  refused(wrap('<g xmlns="http://www.w3.org/1999/xhtml"><style>a{}</style></g>'), /xmlns/);
  refused('<svg xmlns="http://www.w3.org/1999/xhtml" viewBox="0 0 1 1"></svg>', /xmlns/);
  refused(wrap('<rect xmlns:x="http://example.com" x:foo="1"/>'), /xmlns|attribute/);
  refused(wrap('<rect ev:event="click"/>'), /attribute/);
  passes('<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 1 1"><g id="a"/><use xlink:href="#a"/></svg>');
});

test('CSS: functions and at-rules are allowlisted, comments do not hide them', () => {
  refused(wrap('<style>rect{fill:attr(data-x type(&lt;color&gt;))}</style>'), /attr\(/);
  refused(wrap('<rect style="width:env(safe-area-inset-top)"/>'), /env\(/);
  refused(wrap('<style>rect{fill:url/**/(https://e.example/x)}</style>'), /url\(#id\)/);
  refused(wrap('<style>@im/**/port "https://e.example/a.css";</style>'), /@import|@-rule/);
  refused(wrap('<style>@namespace x "https://e.example";</style>'), /@namespace|@-rule/);
  refused(wrap('<style>@font- face{}</style>'), /@-rule|@font/);
  refused(wrap('<style>rect{fill:red} /* unterminated</style>'), /comment/);
  passes(wrap('<style>/* calm */ @media (prefers-color-scheme: dark){rect{fill:oklch(from #123456 calc(l - 0.1) c h)}} @supports (fill:red){a{fill:color-mix(in srgb,#fff 50%,#000)}}</style>'));
});

test('SMIL: only listed attributes may be animated', () => {
  refused(wrap('<filter id="f"><feGaussianBlur stdDeviation="2"><animate attributeName="stdDeviation" values="0;99999" dur="3s"/></feGaussianBlur></filter>'), /attributeName/);
  refused(wrap('<filter id="f"><feTurbulence numOctaves="2"><set attributeName="numOctaves" to="99"/></feTurbulence></filter>'), /attributeName/);
  refused(wrap('<rect><set attributeName="style" to="animation:x 1ms infinite"/></rect>'), /attributeName/);
  refused(wrap('<rect><set attributeName="class" to="fast"/></rect>'), /attributeName/);
  refused(wrap('<rect><set attributeName="filter" to="url(#f)"/></rect>'), /attributeName/);
  passes(wrap('<rect><animate attributeName="opacity" values="0;1" dur="3s" repeatCount="indefinite"/><animateTransform attributeName="transform" type="rotate" from="0" to="360" dur="10s"/></rect>'));
});

test('limits: element count, depth, <use> fan-out and cycles', () => {
  refused(wrap('<g/>'.repeat(SKIN_LIMITS.sceneMaxElements)), /elements/);
  refused(wrap('<g>'.repeat(SKIN_LIMITS.sceneMaxDepth) + '</g>'.repeat(SKIN_LIMITS.sceneMaxDepth)), /deep/);
  passes(wrap('<g>'.repeat(SKIN_LIMITS.sceneMaxDepth - 2) + '</g>'.repeat(SKIN_LIMITS.sceneMaxDepth - 2)));
  // Ten uses of ten uses of ... : 10^6 drawn elements from about 60 tags.
  let defs = '<g id="l0"><rect width="1" height="1"/></g>';
  for (let i = 1; i <= 6; i++) defs += `<g id="l${i}">${`<use href="#l${i - 1}"/>`.repeat(10)}</g>`;
  refused(wrap(`<defs>${defs}</defs><use href="#l6"/>`), /drawn|<use>/);
  refused(wrap('<g id="a"><use href="#b"/></g><g id="b"><use href="#a"/></g>'), /cycle/);
  refused(wrap('<g id="a"><use href="#a"/></g>'), /cycle/);
  refused(wrap('<linearGradient id="a" href="#b"/><linearGradient id="b" href="#a"/>'), /cycle/);
  refused(wrap('<pattern id="p" width="1" height="1"><rect fill="url(#p)"/></pattern>'), /cycle/);
  refused(wrap('<g id="a"/><g id="a"/>'), /id/);
  passes(wrap('<defs><g id="a"><circle r="1"/></g></defs><use href="#a"/><use href="#a" x="5"/>'));
  // The browser follows href; the count must not follow a different xlink:href.
  refused(
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 1 1"><g id="big"/><g id="tiny"/><use href="#big" xlink:href="#tiny"/></svg>',
    /both href and xlink:href/,
  );
  // Masks, patterns and clip paths are drawn again for every element using them.
  const mask = `<mask id="m">${'<circle r="1"/>'.repeat(200)}</mask>`;
  refused(wrap(mask + '<rect mask="url(#m)"/>'.repeat(30)), /drawn|<use>/);
  refused(wrap(`<style>.x{mask:url(#m)}</style>${mask}<rect class="x"/>`), /gradients only/);
  refused(wrap('<pattern id="p" width="1" height="1"><rect/></pattern><style>.x{fill:url(#p)}</style>'), /gradients only/);
  passes(wrap('<linearGradient id="g"/><style>.x{fill:url(#g)}</style><rect class="x"/>'));
  // <marker> repeats at every vertex of a path.
  refused(wrap('<marker id="k"><circle r="1"/></marker><path marker-mid="url(#k)" d="M0 0L1 1L2 2"/>'), /not allowed: <marker>/);
});

test('limits: filters', () => {
  const f = (inner, attrs = '') => wrap(`<filter id="f"${attrs}>${inner}</filter><rect filter="url(#f)"/>`);
  refused(f('<feGaussianBlur stdDeviation="5000"/>'), /stdDeviation/);
  refused(f('<feGaussianBlur stdDeviation="1 5000"/>'), /stdDeviation/);
  refused(f('<feDropShadow stdDeviation="400"/>'), /stdDeviation/);
  refused(f('<feTurbulence baseFrequency="0.01" numOctaves="40"/>'), /numOctaves/);
  refused(f('<feMorphology radius="500"/>'), /radius/);
  refused(f('<feConvolveMatrix order="50" kernelMatrix="1"/>'), /order/);
  refused(f('<feGaussianBlur stdDeviation="0.5"/>', ' primitiveUnits="objectBoundingBox"'), /primitiveUnits/);
  refused(f('<feOffset/>'.repeat(SKIN_LIMITS.sceneMaxFilterPrimitives + 1)), /filter primitives/);
  refused(wrap('<filter id="f"><feGaussianBlur stdDeviation="2"/></filter>' + '<rect filter="url(#f)"/>'.repeat(SKIN_LIMITS.sceneMaxFilterUses + 1)), /filter/);
  refused(wrap('<filter id="f"><feGaussianBlur stdDeviation="2"/></filter><g id="a" filter="url(#f)"/>' + '<use href="#a"/>'.repeat(SKIN_LIMITS.sceneMaxFilterUses)), /filter/);
  // CSS twins.
  refused(wrap('<rect style="filter:blur(999px)"/>'), /blur/);
  refused(wrap('<rect filter="blur(2em)"/>'), /blur/);
  refused(wrap('<rect style="filter:drop-shadow(0 0 900px #000)"/>'), /blur|drop-shadow/);
  refused(wrap('<rect style="backdrop-filter:blur(30px)"/>'), /backdrop-filter/);
  refused(wrap('<style>svg{--b:blur(900px)}</style><rect style="filter:var(--b)"/>'), /var\(|filter/);
  refused(wrap('<style>*{filter:url(#f)}</style>'), /filter/);
  refused(wrap('<filter id="f"><feGaussianBlur stdDeviation="2"/></filter><mask id="m"><rect filter="url(#f)"/></mask>' + '<rect mask="url(#m)"/>'.repeat(SKIN_LIMITS.sceneMaxFilterUses)), /filter/);
  refused(wrap(`<rect style="filter:${'blur(1px) '.repeat(SKIN_LIMITS.sceneMaxFilterPrimitives + 1)}"/>`), /filter primitives/);
  refused(wrap(`<rect filter="${'invert(1) '.repeat(SKIN_LIMITS.sceneMaxFilterPrimitives + 1)}"/>`), /filter primitives/);
  passes(f('<feGaussianBlur stdDeviation="8"/><feTurbulence baseFrequency="0.02" numOctaves="3"/><feMerge><feMergeNode/></feMerge>'));
  passes(wrap('<rect style="filter:drop-shadow(0 2px 6px rgb(0 0 0 / 0.5))"/>'));
});

test('limits: animation durations', () => {
  const css = (decl) => wrap(`<style>@keyframes k{to{opacity:0}}.a{${decl}}</style><rect class="a"/>`);
  refused(css('animation:k 1ms infinite'), /duration/);
  refused(css('animation:k .001s infinite'), /duration/);
  refused(css('animation:k 1e-9s infinite'), /duration/);
  refused(css('animation:k 9s infinite,k 0.01s infinite'), /duration/);
  refused(css('animation-duration:0.05s'), /duration/);
  refused(css('-webkit-animation-duration:10ms'), /duration/);
  refused(css('animation-duration:calc(var(--v-speed) * 1s)'), /duration/);
  refused(css('animation:k var(--d) infinite'), /duration/);
  refused(wrap('<rect style="animation:k 2ms infinite"/>'), /duration/);
  refused(css('animation:k infinite 1ms!important'), /duration/);
  refused(css('animation:k 1ms/**/infinite'), /duration/);
  passes(css('animation:k 9s infinite !important;animation-duration:4s!important'));
  refused(wrap('<rect><animate attributeName="opacity" values="0;1" dur="1ms" repeatCount="indefinite"/></rect>'), /dur/);
  refused(wrap('<rect><animate attributeName="opacity" values="0;1" dur="0.01" repeatCount="indefinite"/></rect>'), /dur/);
  refused(wrap('<rect><animate attributeName="opacity" values="0;1" dur="00:00:00.001" repeatCount="indefinite"/></rect>'), /dur/);
  refused(wrap('<rect><animate attributeName="opacity" values="0;1" dur="fast"/></rect>'), /dur/);
  refused(wrap('<rect><animate attributeName="opacity" values="0;1" dur="9s" max="5ms"/></rect>'), /max/);
  // Delays may be anything: the official skins use small negative ones.
  passes(css('animation:k 3.2s ease-in-out -0.1s infinite;animation-delay:-0.2s'));
  passes(css('animation-duration:18.5s, 4s;animation-timing-function:cubic-bezier(.2,.8,.2,1)'));
  passes(wrap('<rect><animate attributeName="opacity" values="0;1" dur="00:01.5" repeatCount="indefinite"/><set attributeName="fill" to="#fff" begin="2s"/></rect>'));
});

test('fragments: only ASCII spaces around the #', () => {
  refused(wrap('<g id="a"/><use href="\u00a0#a"/>'), /#fragment/);
  refused(wrap('<g id="a"/><rect fill="url(\u00a0#a)"/>'), /url\(#id\)/);
  refused(wrap('<g id="a"/><rect fill="url(\u2003#a)"/>'), /url\(#id\)/);
  refused(wrap('<rect\u00a0x="1"/>'), /attribute/);
});

test('limits: viewBox', () => {
  refused('<svg viewBox="0 0 1e30 1e30"></svg>', /viewBox/);
  refused('<svg viewBox="0 0 0 10"></svg>', /viewBox/);
  refused('<svg viewBox="0 0 -5 10"></svg>', /viewBox/);
});

test('official skins pass with headroom, and sceneStats counts them', () => {
  const seen = {};
  for (const ref of ['official.firefly-meadow', 'official.graphite-circuit']) {
    const svg = readFileSync(join(root, 'plugin/skins', ref, 'scene.svg'), 'utf8');
    passes(svg);
    const s = sceneStats(svg);
    seen[ref] = s;
    assert.ok(s.elements * 3 <= SKIN_LIMITS.sceneMaxElements, `${ref}: ${s.elements} elements`);
    assert.ok(s.depth * 3 <= SKIN_LIMITS.sceneMaxDepth, `${ref}: depth ${s.depth}`);
    assert.ok(s.drawn * 3 <= SKIN_LIMITS.sceneMaxDrawn, `${ref}: ${s.drawn} drawn`);
    assert.ok(s.minAnimationSeconds === null || s.minAnimationSeconds >= SKIN_LIMITS.sceneMinAnimationSeconds * 3);
  }
  assert.deepEqual(
    Object.fromEntries(Object.entries(seen).map(([k, s]) => [k, [s.elements, s.depth, s.drawn, s.filterPrimitives, s.filterUses, s.minAnimationSeconds]])),
    { 'official.firefly-meadow': [452, 5, 452, 0, 0, 3.2], 'official.graphite-circuit': [328, 3, 332, 0, 0, 5.1] },
  );
});

test('scene validation stays fast on adversarial input', () => {
  const big = SKIN_LIMITS.sceneMaxChars - 200;
  let fan = '';
  for (let i = 1; i <= 400; i++) fan += `<g id="n${i}">${i > 1 ? `<use href="#n${i - 1}"/><use href="#n${i - 1}"/>` : '<rect/>'}</g>`;
  const inputs = [
    wrap('<g x="1" '.repeat(Math.floor(big / 9))),
    wrap('<rect style="a:b;"/>'.repeat(Math.floor(big / 20))),
    wrap(`<style>${'a{animation:k 9s}'.repeat(Math.floor(big / 17))}</style>`),
    wrap(`<style>${'/*'.repeat(Math.floor(big / 2))}</style>`),
    wrap(`<rect style="filter:${'drop-shadow('.repeat(Math.floor(big / 13))}"/>`),
    wrap(`<defs>${fan}</defs><use href="#n400"/>`),
    wrap(`<g>${'<g id="a" filter="url(#f)"/>'.repeat(3000)}</g>`),
    wrap(`<rect>${'<animate attributeName="x" dur="9s"/>'.repeat(2500)}</rect>`),
    // Many distinct mistakes: errors stop at a cap instead of piling up.
    wrap(`<style>${Array.from({ length: 20000 }, (_, i) => `f${i.toString(36)}(`).join('').slice(0, big)}</style>`),
    wrap(`<style>${Array.from({ length: 20000 }, (_, i) => `@x${i.toString(36)} `).join('').slice(0, big)}</style>`),
    wrap(`<rect${Array.from({ length: 12000 }, (_, i) => ` a:b${i}=""`).join('').slice(0, big)}/>`),
  ];
  for (const s of inputs) {
    assert.ok(s.length <= SKIN_LIMITS.sceneMaxChars + 100);
    const t = performance.now();
    validateScene(s);
    const ms = performance.now() - t;
    assert.ok(ms < 80, `took ${ms.toFixed(1)} ms on ${JSON.stringify(s.slice(60, 90))}`);
  }
});

// ------------------------------------------------------------------ skin.json text

function skinWith(fields) {
  return { format: 1, slug: 'abc', name: 'A', colors: { dark: { anchors: { 'surface-0': '#000000', 'text-primary': '#ffffff' } } }, ...fields };
}

test('names, descriptions and labels refuse invisible and direction-changing characters', () => {
  for (const ch of ['\u202e', '\u202a', '\u2066', '\u2069', '\u200e', '\u200f', '\u061c', '\u2028', '\u2029', '\u0085', '\u009b', '\u200b', '\u2060', '\ufeff']) {
    const code = ch.codePointAt(0).toString(16);
    assert.equal(validateSkin(skinWith({ name: `Fire${ch}fly` })).ok, false, `name U+${code}`);
    assert.equal(validateSkin(skinWith({ description: `x${ch}y` })).ok, false, `description U+${code}`);
    const variables = [{ key: 'a', label: `L${ch}`, type: 'toggle', default: true }];
    assert.equal(validateSkin(skinWith({ variables })).ok, false, `label U+${code}`);
  }
  // Blank-looking names.
  for (const name of ['\u3164', '\u2800\u2800', '\u115f']) {
    assert.equal(validateSkin(skinWith({ name })).ok, false, `name ${JSON.stringify(name)}`);
  }
  // Emoji ZWJ sequences, accents and CJK still work.
  for (const name of ['👩\u200d💻 Night shift', 'Café Ñoño', '萤火草地', 'مرحبا']) {
    assert.equal(validateSkin(skinWith({ name })).ok, true, name);
  }
});
