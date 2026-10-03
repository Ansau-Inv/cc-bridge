/**
 * host / window / takeover 三态。
 *
 *   host     —— 日常 DSH：只挂 /ccb 和 ccb_*，不换 factory、不改立绘
 *   window   —— /ccb 拉起的独立终端：factory + 橙色女仆 + 信箱
 *   takeover —— 独立 profile / run-plugin.ps1：整窗 Claude，特色模式
 *
 * 显式 `config.mode` 优先；否则看 `CCB_MODE` / `CCB_MAILBOX_ID` / 独立 profile 名。
 * 默认为 host，避免日常窗口被误换成 Claude。
 */

/**
 * 插件状态目录（日志、信箱、会话映射）。
 *
 *   ① CCB_STATE_DIR
 *   ② $DSH_HOME/cc-bridge
 *   ③ ~/.dsh 存在则 ~/.dsh/cc-bridge（跟 dsh 家目录走；--import 时 DSH_HOME 常还没设）
 *   ④ ~/.cc-bridge
 */
export function resolveStateDir(env = process.env, {
  home,
  exists,
} = {}) {
  if (typeof env.CCB_STATE_DIR === 'string' && env.CCB_STATE_DIR.trim()) {
    return env.CCB_STATE_DIR.trim()
  }
  const { homedir } = process.getBuiltinModule('node:os')
  const { join } = process.getBuiltinModule('node:path')
  const { existsSync } = process.getBuiltinModule('node:fs')
  const homeDir = home || homedir()
  const existsFn = exists || existsSync
  if (typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim()) {
    return join(env.DSH_HOME.trim(), 'cc-bridge')
  }
  const dsh = join(homeDir, '.dsh')
  if (existsFn(dsh)) return join(dsh, 'cc-bridge')
  return join(homeDir, '.cc-bridge')
}

export function resolveMode(config = {}, env = process.env) {
  const explicit = typeof config.mode === 'string' ? config.mode.trim().toLowerCase() : ''
  if (explicit === 'host' || explicit === 'window' || explicit === 'takeover') return explicit
  const fromEnv = typeof env.CCB_MODE === 'string' ? env.CCB_MODE.trim().toLowerCase() : ''
  if (fromEnv === 'host' || fromEnv === 'window' || fromEnv === 'takeover') return fromEnv
  if (typeof env.CCB_MAILBOX_ID === 'string' && env.CCB_MAILBOX_ID.trim()) return 'window'
  const hay = `${env.DSH_PROFILE ?? ''} ${env.DSH_PROFILE_DIR ?? ''}`
  if (/cc-bridge-(tui|headless)/i.test(hay)) return 'takeover'
  return 'host'
}

/**
 * 橙色窗口里 claude 的工作目录。
 * 优先跟 DeepSeek 会话（信箱记下的 cwd / TUI meta），不要回落到插件仓库。
 */
export function resolveWindowCwd({ metaCwd, configCwd, mailboxCwd, processCwd } = {}) {
  for (const c of [metaCwd, configCwd, mailboxCwd, processCwd]) {
    if (typeof c === 'string' && c.trim()) return c.trim()
  }
  return typeof processCwd === 'string' ? processCwd : ''
}

/** window / takeover 缺外观字段时补上，避免掉回官方女仆 / DEEPSEEK HARNESS。 */
export function windowAppearanceDefaults(config = {}) {
  if (config.appearance === false) {
    return {
      maidArt: config.maidArt,
      maidArtHappy: config.maidArtHappy,
      splashTitle: config.splashTitle,
      splashSubtitle: config.splashSubtitle,
      welcomeTagline: config.welcomeTagline,
    }
  }
  return {
    maidArt: config.maidArt || 'assets/maid.png',
    maidArtHappy: config.maidArtHappy || 'assets/maid-happy.png',
    splashTitle: config.splashTitle || 'CLAUDE CODE',
    splashSubtitle: config.splashSubtitle || 'BRIDGE',
    welcomeTagline: config.welcomeTagline || '这用户有股味！',
  }
}
