/**
 * dsh-usage-guard — 守卫状态与文案（**纯函数，零依赖，host/client 共享**）。
 *
 * 为什么单独成文件：这段逻辑决定"对账失效时用户能否看出来"，
 * 是本次（2026-10-02）修复的核心。放在 client/index.ts 里就无法被
 * `scripts/selftest.mjs` 导入验证（client 产物是浏览器模块格式），
 * 而"显示逻辑不可证伪"恰恰是上一次修复失败的原因。
 *
 * 抽到这里后：host 侧 `lib/guard-view.js` 可直接被 node 导入做脱机自测，
 * client 侧由 tsdown 打进 bundle —— 同一份实现，两处使用。
 */

export type GuardState = 'ok' | 'sentinel-only' | 'degraded' | 'failed'

export interface GuardView {
  state: GuardState
  /** 「守卫」那一格显示什么（状态写在脸上，而不是永远一个静态标签）。 */
  label: string
  /** 官方用量那一格显示什么；'' = 不显示。失效时**必须明说失效**，绝不静默留空。 */
  officialText: string
  /** 悬停说明：讲清"为什么失效 / 怎么恢复"——这才是提示的意义所在。 */
  title: string
}

/** host 端 PRIMARY_FAIL_ALERT_STREAK 必须与此一致（连续失败多少次算"已失效"）。 */
export const FAIL_ALERT_STREAK = 3

export interface GuardInput {
  /** official.err：undefined = 正常；'no-platform-token' = 未配 token；其余 = 能力故障。 */
  officialErr?: string | undefined
  /** health.primaryFailStreak：精确路径连续失败次数。 */
  failStreak?: number
  /** health.sentinel === 'ok'：余额哨兵是否活着。 */
  sentinelOk?: boolean
  /** health.detectionActive：两条路径是否至少一条在工作。 */
  detectionActive?: boolean
  /** health.primaryDetail：失败详情。 */
  primaryDetail?: string | null
  /** official.tokens：正常时的官方用量。 */
  officialTokens?: number
}

export function fmtTokens(n: number): string {
  if (!Number.isFinite(n)) return '0'
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k'
  return String(Math.round(n))
}

/**
 * 计算守卫状态与文案。
 *
 * ★ 背景（2026-10-02，用户指出后重做）：原实现有两条硬伤 ——
 *   1. 失效提示是**常驻横幅**：只要官方 token 没配好就永远挂着 ⇒ 用户视而不见，
 *      真正的失效被淹没（"狼来了"）。
 *   2. `healthAlert` 在接口里声明、host 端也算出来了，但**渲染代码从未使用** ⇒ 死代码。
 *      官方接口挂掉时，UI 只是让「官方今日 …」**静默消失**，整行照常显示 ⇒
 *      用户完全看不出对账能力已失效。
 *
 * 分级：
 *   - `no-platform-token`：**配置缺失**（用户没填平台 token），非故障 ⇒ sentinel-only（黄）。
 *   - 其它 err（network / shape-changed / no-series / balance）：**能力故障**。
 *     连续 < 3 次 ⇒ degraded（黄）；≥ 3 次 ⇒ failed（红）。
 */
export function guardView(s: GuardInput): GuardView {
  const err = s.officialErr
  const streak = s.failStreak ?? 0
  const detectionActive = s.detectionActive ?? true
  const isNoToken = err === 'no-platform-token'
  const degraded = err !== undefined && !isNoToken
  const failed = degraded && streak >= FAIL_ALERT_STREAK
  const sentinelOnly = isNoToken || (s.sentinelOk === true && !detectionActive)

  const state: GuardState = failed
    ? 'failed'
    : degraded
      ? 'degraded'
      : sentinelOnly
        ? 'sentinel-only'
        : 'ok'

  const label = failed
    ? '🛡 守卫·对账已失效'
    : degraded
      ? '🛡 守卫·对账不稳'
      : sentinelOnly
        ? '🛡 守卫·仅余额哨兵'
        : '🛡 守卫'

  const title = failed
    ? `官方用量对账已连续 ${streak} 次失败（${String(err)}）。`
      + '防盗刷仍由**余额哨兵**兜底（余额异常下降照样报警），但"官方 vs 本机"的精确比对暂时不可用。'
      + `详情：${String(s.primaryDetail ?? err)}`
    : degraded
      ? `官方用量对账本次失败（${String(err)}），连续 ${streak} 次；达到 ${FAIL_ALERT_STREAK} 次将标记为已失效。`
      : sentinelOnly
        ? '未配置 DeepSeek 平台 token ⇒ 仅余额哨兵模式（靠余额异常下降发现盗刷）。'
          + '到「设置 → 用量守卫」填入平台 token 可启用精确对账。'
        : 'dsh-usage-guard：本地账本与 DeepSeek 官方用量对账（每 15 分钟自动核对）'

  // 关键：失效时**明说失效**，绝不静默留空（这正是原实现的缺陷）。
  const officialText = err === undefined
    ? `官方今日 ${fmtTokens(s.officialTokens ?? 0)} tok`
    : failed
      ? `官方用量不可用（${String(err)}）`
      : ''

  return { state, label, officialText, title }
}