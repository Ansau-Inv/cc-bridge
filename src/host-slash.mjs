/**
 * 日常 DeepSeek 窗口里，让 /ccb 绝不会落到模型。
 *
 * TUI 的闸门是 PromptInput.tryRunCommand：
 *   commandList 里没有这个名字 → 当普通消息发给 DeepSeek
 *   （用户截图就是这条：模型去 Glob 搜 ccb、乱搜网页）
 *
 * 注册表 commands.register('ccb') 要等 commands/change 刷新才进
 * commandList。若频道先建、注册后到、或这次启动根本没叠 host 补丁，
 * /ccb 就会进模型。
 *
 * 对策（只改本进程的 dsh-tui 副本，不写盘）：
 *   把一条 external: true 的 ccb 推进 LOCAL_COMMANDS。
 *   refreshCommands 从这张表复制；locals 同名会挡住 registry 再插一次。
 *   Chat 的 default 分支认 external && name === 'ccb'，走
 *   runExternalCommand → commands.execute。
 *
 * 真正干活仍靠 commands.register 的 handler。表项只负责截胡。
 * handler 还没挂上时，用户看到 "command not found" 提示，不会进模型。
 *
 * 窗口 / 特色整窗不要调这个：那边会清空 LOCAL_COMMANDS 做斜杠透传。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { tuiPackageRoots, tuiRootTag } from './tui-roots.mjs'

export const HOST_CCB_COMMAND = Object.freeze({
  name: 'ccb',
  description: '另开一扇 cc-bridge-tui，用 Claude Code 做这件事；DeepSeek 继续当指挥。',
  tag: '<任务，可空：只开窗口>',
  external: true,
})

/** TUI 会不会把 `/ccb` 当外部命令截下来（而不是发给模型）。 */
export function interceptsCcb(commandList) {
  if (!Array.isArray(commandList)) return false
  return commandList.some((c) => c
    && c.name === 'ccb'
    && c.external === true)
}

/** 给一张命令表补上 /ccb（external）。给测试和运行时共用。 */
export function ensureHostCcbCommand(list) {
  if (!Array.isArray(list)) return { ok: false, reason: 'not-array' }
  const existing = list.find((c) => c?.name === 'ccb')
  if (existing) {
    if (existing.external !== true) existing.external = true
    return { ok: true, added: false }
  }
  list.push({ ...HOST_CCB_COMMAND })
  return { ok: true, added: true }
}

/** 进程真正加载的那份 commands.js（不要误伤 channel/commands.js）。 */
export function isTuiCommandsModuleUrl(url) {
  if (typeof url !== 'string') return false
  const n = url.replace(/\\/g, '/')
  if (!n.includes('dsh-tui')) return false
  if (n.includes('channel/commands')) return false
  return /\/commands\.js(\?|$)/.test(n)
}

/**
 * 在 commands.js 求值前把 /ccb 推进 LOCAL_COMMANDS。
 * Channel 的 commandList 初始就指向这个数组；refreshCommands 也会复制它。
 * 只改源码文本，不写盘。
 */
export function injectCcbIntoCommandsSource(source) {
  if (typeof source !== 'string' || !source.includes('export const LOCAL_COMMANDS')) {
    return { source, hit: false }
  }
  if (/name:\s*['"]ccb['"]/.test(source) && source.includes('external: true')) {
    return { source, hit: true, already: true }
  }
  const inject = [
    'if (Array.isArray(LOCAL_COMMANDS) && !LOCAL_COMMANDS.some((c) => c && c.name === \'ccb\')) {',
    `  LOCAL_COMMANDS.push({ name: 'ccb', description: ${JSON.stringify(HOST_CCB_COMMAND.description)}, tag: ${JSON.stringify(HOST_CCB_COMMAND.tag)}, external: true });`,
    '}',
    '',
  ].join('\n')
  const marker = 'export const HIDDEN_COMMANDS'
  if (source.includes(marker)) {
    return { source: source.replace(marker, `${inject}${marker}`), hit: true }
  }
  return { source: `${source}\n${inject}`, hit: true }
}

function patchCommandsLoadResult(result) {
  try {
    const src = result?.source
    if (src === undefined || src === null) return result
    const text = typeof src === 'string' ? src : Buffer.from(src).toString('utf8')
    const { source, hit } = injectCcbIntoCommandsSource(text)
    if (!hit || source === text) return result
    return { ...result, source, format: result?.format ?? 'module', shortCircuit: true }
  } catch {
    return result
  }
}

/**
 * `--import` 时挂上：之后加载的每一份 dsh-tui commands.js 都会带 /ccb。
 * npx 缓存里那份 tuiPackageRoots 扫不到，钩子能扫到。
 */
export function installHostSlashLoadHook(log = () => {}) {
  try {
    const { registerHooks } = process.getBuiltinModule('node:module')
    if (typeof registerHooks !== 'function') {
      log('host 斜杠：本 Node 没有 registerHooks，只靠运行时补 LOCAL_COMMANDS')
      return { ok: false, reason: 'no-registerHooks' }
    }
    registerHooks({
      load(url, context, nextLoad) {
        const result = nextLoad(url, context)
        if (!isTuiCommandsModuleUrl(url)) return result
        if (result && typeof result.then === 'function') {
          return result.then((r) => patchCommandsLoadResult(r))
        }
        return patchCommandsLoadResult(result)
      },
    })
    log('host 斜杠：已挂 commands.js 加载钩子（/ccb external）')
    return { ok: true }
  } catch (err) {
    log('host 斜杠：加载钩子失败：' + String(err?.message ?? err))
    return { ok: false, reason: String(err?.message ?? err) }
  }
}

/**
 * 给本进程里每一份 dsh-tui 的 LOCAL_COMMANDS 塞上 /ccb。
 * 幂等；找不到 dsh-tui 时算成功（headless / 网页没有这张表）。
 */
export async function installHostSlashIntercept(log = () => {}) {
  const roots = tuiPackageRoots()
  if (roots.length === 0) {
    log('host 斜杠：本进程没有 dsh-tui，跳过 LOCAL_COMMANDS（网页/headless 走注册表）')
    return { ok: true, roots: [] }
  }
  const report = []
  for (const root of roots) {
    const tag = tuiRootTag(root)
    const rec = { tag, added: false }
    try {
      const cmdPath = join(root, 'lib', 'types', 'commands.js')
      if (!existsSync(cmdPath)) {
        rec.error = 'commands.js 不存在'
        report.push(rec)
        continue
      }
      const mod = await import(pathToFileURL(cmdPath).href)
      const result = ensureHostCcbCommand(mod.LOCAL_COMMANDS)
      if (!result.ok) {
        rec.error = result.reason
      } else {
        rec.added = result.added
        rec.intercepts = interceptsCcb(mod.LOCAL_COMMANDS)
      }
      report.push(rec)
    } catch (err) {
      rec.error = String(err?.message ?? err)
      report.push(rec)
    }
  }
  for (const r of report) {
    if (r.error) log(`  · host 斜杠 [${r.tag}] 失败：${r.error}`)
    else log(`  · host 斜杠 [${r.tag}]：${r.added ? '写入' : '已有'} /ccb（external） intercepts=${r.intercepts}`)
  }
  return { ok: report.some((r) => !r.error), roots: report }
}
