/**
 * NDJSON 行切分 —— 从 `runClaude` 的 stdout 缓冲里抽出来，方便单测。
 *
 * 协议事实：`--output-format stream-json` 的最后一帧**不保证**带尾换行。
 * 进程一关，残行就停在 buffer 里。收尾必须再喂一个 `\n`，而且**不能先清空 buffer**。
 *
 * 错法（曾经写进注释当「已修」）：
 *   const tail = outBuf; outBuf = ''; feedStdout('\n')
 * 对，`feedStdout` 做的是 `outBuf += chunk`。buffer 已经空了，换行拼不到任何内容，
 * `result` 帧被扔掉，会话映射存不上。
 */

/**
 * @param {string} buffer 上一轮没成行的残料
 * @param {string} chunk  新到的一段
 * @returns {{ lines: string[], rest: string }}
 */
export function consumeNdjson(buffer, chunk) {
  const combined = String(buffer ?? '') + String(chunk ?? '')
  const parts = combined.split(/\r?\n/)
  const rest = parts.pop() ?? ''
  const lines = []
  for (const part of parts) {
    if (part.trim()) lines.push(part)
  }
  return { lines, rest }
}

/**
 * 进程退出时把最后一行残料收成行。
 * 等价于 `consumeNdjson(buffer, '\n')`，单独具名是为了测试把契约写死。
 */
export function flushNdjson(buffer) {
  if (!buffer) return { lines: [], rest: '' }
  return consumeNdjson(buffer, '\n')
}
