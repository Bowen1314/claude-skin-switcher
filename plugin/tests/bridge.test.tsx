import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { buildLook, normalizeSettings, parseSkin, renderScene, sceneKey } from '../hooks/skin'

type Hooks = Parameters<typeof mock.clock>[0]
type ThemeCall = { kind: 'set'; scene?: string; glass?: unknown; style?: unknown; accentSeen?: string } | { kind: 'clear' }

const TINY_SCENE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><style>svg{--v-glow:#ffffff;--v-size:1;--v-stars:1}.a{fill:var(--v-glow)}</style><circle class="a" r="5"/><g data-ctx="0.3"><circle r="2"/></g><g data-ctx="0.75"><circle r="3"/></g></svg>`

const tinySkin = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    format: 1,
    slug: 'tiny',
    name: 'Tiny',
    colors: {
      roles: { accent: '#35b8c9' },
      dark: { anchors: { 'surface-0': '#101114', 'surface-1': '#16181c', 'text-primary': '#e8e9eb', 'text-muted': '#8b9099' } },
      light: { anchors: { 'surface-0': '#eceef1', 'surface-1': '#f3f4f6', 'text-primary': '#15181d', 'text-muted': '#555c67' } },
    },
    backdrop: { scene: true, glass: { blur: 10, opacity: 0.7 } },
    style: { UserMessage: { radius: 3, borderWidth: 1 } },
    variables: [
      { key: 'glow', label: 'Glow', type: 'color', default: '#f5c24a' },
      { key: 'size', label: 'Size', type: 'range', min: 0.5, max: 2, step: 0.1, default: 1 },
      { key: 'stars', label: 'Stars', type: 'toggle', default: true },
    ],
    ...extra,
  })

type Files = Record<string, string>

// The engine beneath the mod: a file system in memory (paths matched by their
// tail, since a Mac host reads a Windows path as relative), a mocked clock and env.
function engine(
  on: Hooks,
  files: Files,
  os: { platform: 'macos' | 'windows'; home: string } = { platform: 'macos', home: '/Users/t' },
) {
  const themes: ThemeCall[] = []
  const mtimes: Record<string, number> = {}
  const clock = mock.clock(on, { now: 1000 })
  const find = (path: string) => Object.keys(files).find(key => path === key || path.endsWith(key))

  mock.env(on, os.platform === 'windows' ? { USERPROFILE: os.home, HOME: '/wrong' } : { HOME: os.home })
  on('ui.log', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.info', () => ({ value: { transcriptPath: '', platform: os.platform, isHosted: false } }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1000, percent: 42 }, rateLimits: [] } }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('fs.stat', (_, e) => {
    const key = find(e.path)

    if (key === undefined) {
      throw new Error('ENOENT')
    }

    return { value: { kind: 'file', size: files[key]?.length ?? 0, mtimeMs: mtimes[key] ?? 1, isLink: false } }
  })
  on('fs.read', (_, e) => {
    const key = find(e.path)

    if (key === undefined) {
      throw new Error('ENOENT')
    }

    return { value: files[key] ?? '' }
  })
  on('fs.write', (_, e) => {
    files[e.path] = e.text

    return { value: undefined }
  })
  on('theme.set', (_, e) => {
    const backdrop = e.backdrop as { scene?: string; glass?: unknown } | undefined
    const style = (e as { style?: unknown }).style

    themes.push({ kind: 'set', scene: backdrop?.scene, glass: backdrop?.glass, style })

    return { value: { isDrawn: true, requestId: 't' } }
  })
  on('theme.clear', () => {
    themes.push({ kind: 'clear' })

    return { value: { isDrawn: true, requestId: 'c' } }
  })

  return {
    themes,
    files,
    select: (body: unknown) => {
      const key = `${os.home}/.claude-theme-switcher/selection.json`
      files[key] = JSON.stringify(body)
      mtimes[key] = (mtimes[key] ?? 1) + 1
    },
    tick: () => clock.advance(1500),
    heartbeat: () => {
      const key = Object.keys(files).find(k => k.endsWith('.claude-theme-switcher/bridge.json'))

      return JSON.parse(key === undefined ? '{}' : (files[key] ?? '{}')) as Record<string, unknown>
    },
  }
}

const HOME_SKIN = '/Users/t/.claude-theme-switcher/skins/alice.tiny'
const start = ($: Engine) =>
  $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

async function scene($: Engine, ref: string) {
  const ui = await $.ui.mount({
    plugin: 'theme-switcher',
    component: 'Backdrop',
    surface: 'desktop',
    props: { scene: sceneKey(ref), plugin: 'theme-switcher', glass: false },
  })
  const svg = String((await ui.find({ type: 'Svg' }))?.props.source ?? '')
  await ui.unmount()

  return svg
}

test('draws a saved skin with the settings the app picked', async ($, on) => {
  const fake = engine(on, { [`${HOME_SKIN}/skin.json`]: tinySkin(), [`${HOME_SKIN}/scene.svg`]: TINY_SCENE })
  fake.select({
    theme: 'alice.tiny',
    settings: { 'alice.tiny': { blur: 22, panelOpacity: 0.4, dim: 0.3, bubbleRadius: 12, textSize: 16, vars: { glow: '#00ff88', size: 9, stars: false } } },
  })
  await start($)

  expect(fake.themes).toEqual([
    {
      kind: 'set',
      scene: sceneKey('alice.tiny'),
      glass: { blur: 22, opacity: 0.4 },
      // The test kit strips `style`; buildLook's merge has its own test below.
      style: undefined,
    },
  ])
  const svg = await scene($, 'alice.tiny')
  // Injected after the skin's own defaults, so it wins; size clamped to its max.
  expect(svg).toContain('svg{--ctx:0.4;--v-glow:#00ff88;--v-size:2;--v-stars:0;}</style>')
  expect(svg).toContain('<g data-ctx="0.3"><circle')
  expect(svg).toContain('<g data-ctx="0.75" visibility="hidden">')
  expect(svg).toContain('opacity="0.3"/></svg>')
  expect(fake.heartbeat().applied).toBe('alice.tiny')
})

test('settings changes reapply; motion off and a fixed fill reach the scene', async ($, on) => {
  const fake = engine(on, { [`${HOME_SKIN}/skin.json`]: tinySkin(), [`${HOME_SKIN}/scene.svg`]: TINY_SCENE })
  fake.select({ theme: 'alice.tiny' })
  await start($)
  fake.select({ theme: 'alice.tiny', settings: { 'alice.tiny': { motion: false, reactive: false, fixedFill: 0.8 } } })
  await fake.tick()

  expect(fake.themes.length).toBe(2)
  const svg = await scene($, 'alice.tiny')
  expect(svg).toContain('--ctx:0.8;')
  expect(svg).toContain('*{animation:none!important}')
  expect(svg).not.toContain('visibility="hidden"')
  expect(svg).not.toContain('fill="#000000"')
})

test('default clears the look; an official skin comes from the plugin folder', async ($, on) => {
  const fake = engine(on, {
    '/skins/official.tiny/skin.json': tinySkin({ style: undefined }),
    '/skins/official.tiny/scene.svg': TINY_SCENE,
  })
  fake.select({ theme: 'official.tiny' })
  await start($)
  expect(fake.themes[0]).toEqual({ kind: 'set', scene: sceneKey('official.tiny'), glass: { blur: 10, opacity: 0.7 }, style: undefined })

  fake.select({ theme: 'default' })
  await fake.tick()
  expect(fake.themes[1]).toEqual({ kind: 'clear' })
  expect(fake.heartbeat().applied).toBe('default')
})

test('a name that could leave the skins folder is refused', async ($, on) => {
  const fake = engine(on, {})
  fake.select({ theme: '../../etc' })
  await start($)

  expect(fake.themes).toEqual([])
  expect(String(fake.heartbeat().error)).toContain('not a skin name')
})

test('a missing skin and a broken skin are reported, not thrown', async ($, on) => {
  const fake = engine(on, { [`${HOME_SKIN}/skin.json`]: '{"format":1}' })
  fake.select({ theme: 'bob.gone' })
  await start($)
  expect(String(fake.heartbeat().error)).toContain('not installed')

  fake.select({ theme: 'alice.tiny' })
  await fake.tick()
  expect(String(fake.heartbeat().error)).toContain('colors missing')
  expect(fake.themes).toEqual([])
})

// The test kit drops `style` from theme.set and turns off a hook that throws,
// so the look and its style-free fallback are checked on buildLook itself.
test('the look carries the merged style; the fallback for older builds has none', () => {
  const skin = parseSkin(tinySkin())
  const settings = normalizeSettings({ textSize: 16, bubbleRadius: 12, accent: '#ff0066' }, skin)
  const { look, fallback, hasStyle } = buildLook(skin, settings, sceneKey('alice.tiny'))

  expect(hasStyle).toBe(true)
  expect((look as { style?: unknown }).style).toEqual({
    UserMessage: { radius: 12, borderWidth: 1 },
    Text: { fontSize: 16, lineHeight: 25 },
  })
  expect((fallback as { style?: unknown }).style).toBeUndefined()
  expect(fallback.backdrop).toEqual({ scene: sceneKey('alice.tiny'), glass: { blur: 10, opacity: 0.7 } })
  // The accent replaces the skin's own, so the accent ramp changes.
  const plain = buildLook(skin, normalizeSettings({}, skin), sceneKey('alice.tiny'))
  const fill = (colors: unknown) => (colors as { inputs: { dark: Record<string, string> } }).inputs.dark['role-accent-fill']
  expect(fill(look.colors)).not.toBe(fill(plain.look.colors))
})

test('the 0.1 ids still work, and Windows reads USERPROFILE', async ($, on) => {
  const home = 'C:\\Users\\t'
  const fake = engine(
    on,
    {
      '/skins/official.graphite-circuit/skin.json': tinySkin({ style: undefined }),
      '/skins/official.graphite-circuit/scene.svg': TINY_SCENE,
    },
    { platform: 'windows', home },
  )
  fake.select({ theme: 'graphite-circuit' })
  await $.session.start({ cwd: 'C:\\', surface: 'desktop', isInteractive: true })

  expect(fake.themes[0]?.kind).toBe('set')
  expect(fake.heartbeat().applied).toBe('official.graphite-circuit')
})

test('the terminal and other plugins’ scenes are left alone', async $ => {
  const ui = await $.ui.mount({ plugin: 'theme-switcher', component: 'Backdrop', surface: 'terminal', props: { scene: sceneKey('alice.tiny'), plugin: 'theme-switcher', glass: false } })
  expect(await ui.find({ type: 'Svg' })).toBeUndefined()
  await ui.unmount()
})

// Keys and values reach the scene's <style> as `--v-key:value;`, so neither may
// carry `;`, `}` or `</style>`, whatever skin.json or selection.json say.
test('variable keys and values cannot break out of the injected CSS', () => {
  const skin = parseSkin(
    tinySkin({
      variables: [
        { key: 'a}</style><script>x', type: 'color', default: '#ffffff' },
        { key: 'Glow', type: 'color', default: '#ffffff' },
        { key: 'glow', type: 'color', default: 'red;}</style>' },
        { key: 'size', type: 'range', min: 0, max: 1, step: 0.1, default: '1;}' },
        { key: 'stars', type: 'toggle', default: '1}' },
      ],
    }),
  )
  expect(skin.variables.map(v => v.key)).toEqual(['size', 'stars'])
  const settings = normalizeSettings({ dim: '0.5"/><script>', vars: { size: '9}</style>', stars: '}</style><script>', glow: '#000000;}' } }, skin)
  const out = renderScene(TINY_SCENE, settings, 0.5)

  expect(out).toContain('svg{--ctx:0.5;--v-size:0;--v-stars:1;}</style>')
  expect(out).not.toContain('<script')
  expect(out.split('</style>').length).toBe(2)
})
