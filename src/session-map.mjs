/**
 * dsh sessionId ↔ claude UUID 的映射规则。
 *
 * 只抽「解析」和「该不该写」两段纯逻辑。落盘仍由 index 里的 loadMap/saveMap 做，
 * 因为路径、日志、mkdir 都是 I/O。
 */

/**
 * 读盘得到的 JSON 可能是 null / 数组 / 字符串（手改过、写了一半）。
 * 那种值不能当 map 用：`map[key] = uuid` 会静默丢弃或抛错。
 * 对象里的非字符串值也丢掉 —— 映射只认 UUID 字符串。
 *
 * @param {string} raw
 * @returns {Record<string, string>}
 */
export function parseMapJson(raw) {
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {}
  }
  const out = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === 'string' && value !== '') out[key] = value
  }
  return out
}

/**
 * 只要 claude 报了自己的 UUID，就该记 —— 不管这一轮 is_error / cancelled。
 *
 * 限流、工具失败、用户 Esc 时 stdout 里往往仍带着 session_id。
 * 以前只在 ok 时 saveMap，下一轮不带 --resume，界面上还有旧 transcript，模型却像失忆。
 *
 * @param {string} dshSid
 * @param {{ session_id?: unknown } | null | undefined} result
 * @returns {string | null} 要写入的 claude UUID；不该写则 null
 */
export function mappingIdFromResult(dshSid, result) {
  const sid = result?.session_id
  if (typeof sid !== 'string' || sid === '') return null
  if (sid === dshSid) return null
  return sid
}
