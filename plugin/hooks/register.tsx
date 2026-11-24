import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import { buildLook, fillFor, normalizeSettings, parseSkin, renderScene, sceneKey } from './skin'
import type { Settings, Skin } from './skin'

const VERSION = '0.2.1'

// The Theme Switcher app writes selection.json here and saves skins under
// skins/<ref>/; this mod draws what it names. See docs/skin-format.md.
const DIR_NAME = '.claude-theme-switcher'
const POLL_MS = 1500
const HEARTBEAT_MS = 60000
const SCENE_LIMIT = 120000
const REF = /^[a-z0-9][a-z0-9-]{0,38}\.[a-z0-9][a-z0-9-]{0,38}$/
// Ids the 0.1 app wrote.
const ALIASES: Record<string, string> = {
  'firefly-meadow': 'official.firefly-meadow',
  'graphite-circuit': 'official.graphite-circuit',
}

const level = atom({ plugin: 'theme-switcher', key: 'level' } as const, 0)
const rev = atom({ plugin: 'theme-switcher', key: 'rev' } as const, 0)

const toPercent = (percent: number | undefined) =>
  Math.max(0, Math.min(100, Math.floor((percent ?? 0) / 5) * 5))

type Current = { ref: string; skin: Skin; settings: Settings; scene: string }

export const register: Register = on => {
  let current: Current | undefined
  let applied: string | null = null
  let lastError: string | null = null
  let seenMtime = -1

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const { platform } = await $.session.info()
    const home = platform === 'windows' ? await $.env.get('USERPROFILE') : await $.env.get('HOME')

    if (home === undefined || home === '') {
      $.ui.log('theme-switcher: no home folder found, so no selection to read')

      return result
    }
    const dir = `${home}/${DIR_NAME}`
    const selection = `${dir}/selection.json`

    const fail = (message: string) => {
      lastError = message
      $.ui.log(`theme-switcher: ${message}`)
    }

    const readSkinFiles = async (ref: string) => {
      for (const base of [`${dir}/skins/${ref}`, `${$.plugin.root}/skins/${ref}`]) {
        const text = await $.fs.read(`${base}/skin.json`).catch(() => undefined)

        if (text !== undefined) {
          return { base, text }
        }
      }

      return undefined
    }

    const apply = async (theme: string, allSettings: unknown) => {
      const ref = ALIASES[theme] ?? theme

      if (ref === 'default') {
        await $.theme.clear()
        current = undefined
        applied = 'default'
        lastError = null

        return
      }
      if (!REF.test(ref)) {
        fail(`"${ref}" is not a skin name`)

        return
      }
      const files = await readSkinFiles(ref)

      if (files === undefined) {
        fail(`skin ${ref} is not installed`)

        return
      }
      const skin = parseSkin(files.text)
      const raw = typeof allSettings === 'object' && allSettings !== null ? (allSettings as Record<string, unknown>)[ref] : undefined
      const settings = normalizeSettings(raw, skin)
      let scene = ''

      if (skin.backdrop.kind === 'scene') {
        scene = await $.fs.read(`${files.base}/scene.svg`)

        if (scene.length > SCENE_LIMIT) {
          fail(`skin ${ref}: scene.svg is over ${SCENE_LIMIT} characters`)

          return
        }
      }
      const { look, fallback, hasStyle } = buildLook(skin, settings, sceneKey(ref))
      current = { ref, skin, settings, scene }

      try {
        await $.theme.set(look)
      } catch (error) {
        if (!hasStyle) {
          throw error
        }
        $.ui.log(`theme-switcher: ${ref} drawn without its message style: ${String(error)}`)
        await $.theme.set(fallback)
      }
      await update($, rev, n => n + 1)
      applied = ref
      lastError = null
    }

    const check = async () => {
      const stat = await $.fs.stat(selection).catch(() => undefined)

      if (stat === undefined || stat.mtimeMs === seenMtime) {
        return
      }
      seenMtime = stat.mtimeMs
      try {
        const parsed: unknown = JSON.parse(await $.fs.read(selection))
        const body = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}

        if (typeof body.theme === 'string') {
          await apply(body.theme, body.settings)
        }
      } catch (error) {
        fail(String(error))
      }
    }

    const beat = async () => {
      const body = { version: VERSION, platform, lastSeen: await $.clock.now(), applied, error: lastError }
      await $.fs.write(`${dir}/bridge.json`, `${JSON.stringify(body, null, 2)}\n`).catch(() => undefined)
    }

    const { context } = await $.session.usage()
    await update($, level, () => toPercent(context.percent))
    await check()
    await beat()
    $.clock.every(POLL_MS, async () => {
      const before = `${applied}|${lastError}`
      await check()

      if (`${applied}|${lastError}` !== before) {
        await beat()
      }
    })
    $.clock.every(HEARTBEAT_MS, beat)

    return result
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('context')) {
      const percent = toPercent(e.context.percent)

      if (percent !== (await read($, level))) {
        await update($, level, () => percent)
      }
    }

    return next(e)
  })

  on('ui.render', { component: 'Backdrop' }, async ($, e, next) => {
    const isOurs = current !== undefined && e.props.scene === sceneKey(current.ref)

    if ((e.surface !== 'desktop' && e.surface !== 'mobile') || !isOurs || current === undefined) {
      return next(e)
    }
    await read($, rev)
    const fill = fillFor(current.settings, await read($, level))
    const { Svg } = $.ui.resolve(e)

    return (
      <Svg
        source={renderScene(current.scene, current.settings, fill)}
        alt={`${current.skin.name}, drawn at ${Math.round(fill * 100)}% of the context window`}
        isInteractive
      />
    )
  })
}
