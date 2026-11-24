/** The context window's fill as a whole percent, in steps of 5. */
export type FillPercent = number

/** Bumped each time a skin or its settings are applied, so the backdrop redraws. */
export type Revision = number

declare module 'claude-code' {
  interface PluginState {
    'theme-switcher': { level: FillPercent; rev: Revision }
  }
}
