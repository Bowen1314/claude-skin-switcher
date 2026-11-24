'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const R = require('../src/skin-render')
const { deps } = require('./deps-helper')
const { TINY_SCENE, tinySkin } = require('./fixtures')

const skinText = (extra = {}) => JSON.stringify(tinySkin(extra))

// Vectors from plugin/tests/bridge.test.tsx; the bridge reads a 42% context.
test('same scene as the bridge for the first bridge vector', () => {
  const skin = R.parseSkin(skinText())
  const settings = R.normalizeSettings(
    { blur: 22, panelOpacity: 0.4, dim: 0.3, bubbleRadius: 12, textSize: 16, vars: { glow: '#00ff88', size: 9, stars: false } },
    skin,
  )
  const fill = R.fillFor(settings, R.toPercent(42))
  const svg = R.renderScene(TINY_SCENE, settings, fill)

  assert.equal(fill, 0.4)
  assert.equal(settings.blur, 22)
  assert.equal(settings.panelOpacity, 0.4)
  assert.ok(svg.includes('svg{--ctx:0.4;--v-glow:#00ff88;--v-size:2;--v-stars:0;}</style>'))
  assert.ok(svg.includes('<g data-ctx="0.3"><circle'))
  assert.ok(svg.includes('<g data-ctx="0.75" visibility="hidden">'))
  assert.ok(svg.includes('opacity="0.3"/></svg>'))
})

test('motion off and a fixed fill, as in the second bridge vector', () => {
  const skin = R.parseSkin(skinText())
  const settings = R.normalizeSettings({ motion: false, reactive: false, fixedFill: 0.8 }, skin)
  const svg = R.renderScene(TINY_SCENE, settings, R.fillFor(settings, R.toPercent(42)))

  assert.ok(svg.includes('--ctx:0.8;'))
  assert.ok(svg.includes('*{animation:none!important}'))
  assert.ok(!svg.includes('visibility="hidden"'))
  assert.ok(!svg.includes('fill="#000000"'))
})

test('defaults come from the skin glass, then the spec defaults', () => {
  const skin = R.parseSkin(skinText())
  const s = R.normalizeSettings({}, skin)

  assert.deepEqual(s, { dim: 0, blur: 10, panelOpacity: 0.7, motion: true, reactive: true, fixedFill: 0.5, accent: null, textSize: null, bubbleRadius: null, vars: { glow: '#f5c24a', size: 1, stars: true } })
  const flat = R.normalizeSettings({ dim: 5, textSize: 40, bubbleRadius: -3, accent: 'red' }, R.parseSkin(skinText({ backdrop: { color: '#112233' } })))

  assert.deepEqual([flat.dim, flat.blur, flat.panelOpacity, flat.textSize, flat.bubbleRadius, flat.accent], [0.8, 16, 0.6, 18, 0, null])
})

test('the fill follows the bridge: floor to 5%, then 0.05 steps', () => {
  const s = R.normalizeSettings({}, R.parseSkin(skinText()))

  assert.deepEqual([0, 4, 5, 43, 99, 100, 140].map(p => R.fillFor(s, R.toPercent(p))), [0, 0, 0.05, 0.4, 0.95, 1, 1])
})

test('a scene without <style> gets one after the svg tag', () => {
  const s = R.normalizeSettings({}, R.parseSkin(skinText({ variables: [] })))

  assert.equal(R.renderScene('<svg viewBox="0 0 1 1"><rect/></svg>', s, 0.5), '<svg viewBox="0 0 1 1"><style>svg{--ctx:0.5;}</style><rect/></svg>')
})

test('parse errors match the bridge', () => {
  assert.throws(() => R.parseSkin('{"format":1}'), /colors missing/)
  assert.throws(() => R.parseSkin('{"format":2,"colors":{}}'), /not a format 1 skin/)
})

test('colorsInput mirrors buildLook: the accent setting changes the accent ramp', async () => {
  const { makeColors } = await deps()
  const skin = R.parseSkin(skinText())
  const fill = input => makeColors(input).theme.inputs.dark['role-accent-fill']
  const plain = R.colorsInput(skin, R.normalizeSettings({}, skin))
  const tuned = R.colorsInput(skin, R.normalizeSettings({ accent: '#ff0066' }, skin))

  assert.equal(tuned.roles.accent, '#ff0066')
  assert.notEqual(fill(tuned), fill(plain))
  assert.equal(R.colorsInput(R.parseSkin(skinText({ colors: { dark: tinySkin().colors.dark } })), null).only, 'dark')
  assert.throws(() => R.colorsInput(R.parseSkin(skinText({ colors: { roles: {} } })), null), /light or dark anchors/)
})

test('forceScheme pins the scene to the preview mode', () => {
  const svg = '<style>@media (prefers-color-scheme: light){.a{fill:#fff}}@media (prefers-color-scheme:dark){.b{}}</style>'

  const T = '(min-width:0px)'
  const F = '(min-width:1px) and (max-width:0px)'

  assert.equal(R.forceScheme(svg, 'light'), `<style>@media ${T}{.a{fill:#fff}}@media ${F}{.b{}}</style>`)
  assert.equal(R.forceScheme(svg, 'dark'), `<style>@media ${F}{.a{fill:#fff}}@media ${T}{.b{}}</style>`)
  assert.equal(R.forceScheme('@media screen and (prefers-color-scheme: light){}', 'light'), `@media screen and ${T}{}`)
})

test('mock colours come from the anchors and the accent', () => {
  const skin = R.parseSkin(skinText())
  const dark = R.mockColors(skin, R.normalizeSettings({}, skin), 'dark')
  const light = R.mockColors(skin, R.normalizeSettings({ accent: '#ff0066' }, skin), 'light')

  assert.equal(dark.surface0, '#101114')
  assert.equal(dark.text, '#e8e9eb')
  assert.equal(dark.accent, '#35b8c9')
  assert.equal(light.surface0, '#eceef1')
  assert.equal(light.accent, '#ff0066')
  assert.match(light.surface2, /^#[0-9a-f]{6}$/)
  const darkOnly = R.parseSkin(skinText({ colors: { dark: tinySkin().colors.dark } }))

  assert.deepEqual(R.modesOf(darkOnly), ['dark'])
  assert.equal(R.mockColors(darkOnly, R.normalizeSettings({}, darkOnly), 'light').mode, 'dark')
  assert.deepEqual(R.mockShape(skin, R.normalizeSettings({}, skin)), { textSize: 14, bubbleRadius: 3, bubbleBorder: 1, headingMono: false, toolMono: true })
  assert.equal(R.mockShape(skin, R.normalizeSettings({ bubbleRadius: 12, textSize: 16 }, skin)).bubbleRadius, 12)
})

test('REF and aliases match the bridge', () => {
  assert.ok(R.REF.test('official.graphite-circuit'))
  assert.ok(!R.REF.test('../../etc'))
  assert.ok(!R.REF.test('a.b.c'))
  assert.equal(R.ALIASES['graphite-circuit'], 'official.graphite-circuit')
})
