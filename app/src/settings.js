'use strict'

// Fallback when the claude CLI can't be found: declare the marketplace and
// enable the plugin in Claude Code's user settings file.
// Keys and the "directory" source shape are documented at
// https://code.claude.com/docs/en/settings-reference.md#extraknownmarketplaces
// and #enabledplugins. A relative-path plugin in a marketplace added from a
// local path loads at session start without a separate install
// (https://code.claude.com/docs/en/plugins/loading.md).

const fs = require('node:fs')

const { writeFileAtomic } = require('./atomic')
const { MARKETPLACE_NAME, PLUGIN_ID } = require('./constants')

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v)

const backupStamp = now => new Date(now).toISOString().replace(/[:.]/g, '-')

// Returns { ok: true, settings } or { ok: false, reason }.
const mergeSettings = (current, marketplaceDir) => {
  if (!isPlainObject(current)) {
    return { ok: false, reason: 'not-object' }
  }
  for (const key of ['extraKnownMarketplaces', 'enabledPlugins']) {
    if (current[key] !== undefined && !isPlainObject(current[key])) {
      return { ok: false, reason: 'unexpected-shape', key }
    }
  }
  const markets = current.extraKnownMarketplaces ?? {}
  const existing = isPlainObject(markets[MARKETPLACE_NAME]) ? markets[MARKETPLACE_NAME] : {}

  return {
    ok: true,
    settings: {
      ...current,
      extraKnownMarketplaces: {
        ...markets,
        [MARKETPLACE_NAME]: { ...existing, source: { source: 'directory', path: marketplaceDir } },
      },
      enabledPlugins: { ...(current.enabledPlugins ?? {}), [PLUGIN_ID]: true },
    },
  }
}

const readSettingsText = async file => {
  try {
    return await fs.promises.readFile(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null
    }
    throw error
  }
}

// Returns { ok, reason?, backup?, file }.
const enableInSettings = async ({ settingsFile, marketplaceDir, now = Date.now() }) => {
  const text = await readSettingsText(settingsFile)
  let current = {}

  if (text !== null && text.trim() !== '') {
    try {
      current = JSON.parse(text)
    } catch {
      return { ok: false, reason: 'invalid-json', file: settingsFile }
    }
  }
  const merged = mergeSettings(current, marketplaceDir)

  if (!merged.ok) {
    return { ok: false, reason: merged.reason, key: merged.key, file: settingsFile }
  }
  let backup = null

  if (text !== null) {
    backup = `${settingsFile}.bak-${backupStamp(now)}`
    await fs.promises.copyFile(settingsFile, backup, fs.constants.COPYFILE_EXCL)
  }
  await writeFileAtomic(settingsFile, `${JSON.stringify(merged.settings, null, 2)}\n`)

  return { ok: true, backup, file: settingsFile }
}

// Installed according to settings.json alone (used when there is no CLI).
const settingsSayInstalled = async settingsFile => {
  try {
    const parsed = JSON.parse((await readSettingsText(settingsFile)) ?? '{}')

    return (
      isPlainObject(parsed) &&
      isPlainObject(parsed.enabledPlugins) &&
      parsed.enabledPlugins[PLUGIN_ID] === true &&
      isPlainObject(parsed.extraKnownMarketplaces) &&
      isPlainObject(parsed.extraKnownMarketplaces[MARKETPLACE_NAME])
    )
  } catch {
    return false
  }
}

module.exports = { mergeSettings, enableInSettings, settingsSayInstalled, backupStamp }
