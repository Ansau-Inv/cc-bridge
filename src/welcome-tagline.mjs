// 换掉开屏立绘下面那句欢迎语（原版「探索未至之境！」）。
//
// ── 接缝 ────────────────────────────────────────────────────────────
//
// 文案在 `lib/types/i18n.js` 的字典里：
//
//     const dict = {
//       'logo-tagline': { zh: '探索未至之境！', en: 'Explore the uncharted!' },
//     }
//     export const i18nDict = dict;     // ← 导出的是同一个对象引用
//
// `t()` 内部读的是 `dict`，而 `i18nDict` 导出的是**同一个对象** —— 所以原地改
// `i18nDict['logo-tagline'].zh` 就能生效，`t()` 立刻看到新值（实测确认）。
//
// 对象未冻结、条目也未冻结，改属性不会抛。
//
// ── 不用管居中对齐 ──────────────────────────────────────────────────
//
// `LogoV2.js` 是**运行时按实际宽度**算缩进的：
//
//     const welcomeWidth = starLine === null ? stringWidth(tagline) : starLine.width;
//     const welcomePad = Math.max(0, Math.round(MAID_BOX_CENTER - welcomeWidth / 2));
//
// 所以换多长的文案都会自动居中，不需要重算 pad。
// （顺带：中文 7 字 = 14 列，和原句等宽，视觉上位置完全不变。）
//
// ── 只改中文 ────────────────────────────────────────────────────────
//
// `en` 保持原样 —— 切到英文界面时那句英文仍然通顺。如果替换文案是中文而
// 用户切到 en，会看到原版英文，这是有意的（比显示一句突兀的中文好）。

/**
 * 把开屏欢迎语换成 `text`。
 *
 * @param text 新文案（中文）。空值则跳过。
 * @param log  日志函数
 * @returns 改了几份 dsh-tui 实例
 */
export async function installWelcomeTagline(text, log = () => {}) {
  if (typeof text !== 'string' || text.trim() === '') {
    return { ok: false, reason: '文案为空' }
  }
  const { existsSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { pathToFileURL } = await import('node:url')
  const { tuiPackageRoots } = await import('./tui-roots.mjs')

  let patched = 0
  let sawDict = false
  const problems = []

  for (const root of tuiPackageRoots()) {
    const i18nPath = join(root, 'lib', 'types', 'i18n.js')
    if (!existsSync(i18nPath)) continue
    try {
      const i18n = await import(pathToFileURL(i18nPath).href)
      const entry = i18n.i18nDict?.['logo-tagline']
      if (!entry || typeof entry !== 'object') {
        problems.push('没找到 logo-tagline 词条')
        continue
      }
      sawDict = true
      // 原地改条目的属性 —— `i18nDict` 与内部 `dict` 是同一个对象，
      // 所以 `t('logo-tagline')` 立刻返回新值。
      entry.zh = text
      patched++
    } catch (err) {
      problems.push(String(err?.message ?? err))
    }
  }

  if (problems.length > 0) log('  欢迎语替换有问题：' + problems.join(' | '))
  if (patched > 0) {
    log(`  开屏欢迎语已更换：${text}（${patched} 份 dsh-tui 实例）`)
    return { ok: true, patched }
  }
  return {
    ok: false,
    reason: sawDict ? '词条写入失败' : '没找到 i18n 字典（上游结构可能变了）',
  }
}
