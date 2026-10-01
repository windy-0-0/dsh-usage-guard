/**
 * dsh-usage-guard — host half.
 *
 * 用途：防止 DeepSeek API Key 被盗刷——本地账本与官方用量对账。
 *
 * 数据源：
 *  1. 本地账本：session/event 全局聚合（跨会话），与 dsh-cost-meter 同一计费口径
 *     （disjoint token：inputTokens=miss、cacheReadTokens=hit、outputTokens=out 含思考），
 *     峰谷价按事件发生时刻分桶；append-only 落盘 ~/.dsh/usage-guard/ledger.jsonl。
 *  2. 官方用量（精确路径）：platform.deepseek.com /api/v0/usage/by_api_key/amount
 *     —— 按 key 的官方 token 明细（每模型：缓存命中/未命中/响应），与本地账本同窗口对比：
 *       官方 token 明显多于本地 = 这个 key 在别处被使用（疑似盗刷）。
 *  3. 余额哨兵（兜底路径）：/user/balance 快照差分——余额下降速度远超本机消费速度时告警。
 *
 * 告警仅"发现"，不做任何阻断（key 的使用权在平台侧）；用户按提示去平台吊销/轮换。
 *
 * ── 2026-10-01 修复（三条真实缺陷，全部实测复现）────────────────────────────
 * ① **静默失效**：官方接口在 **HTTP 200** 里回业务错误码。实测当时拿到的是
 *    `{"code":40003,"msg":"Authorization Failed (invalid token)","data":null}`
 *    （平台 token 已失效）。旧实现只判 `res.ok`，于是把"认证失败"误报成
 *    `err:'no-series'`（结构不认识），**静默退化成兜底路径**，而 `/api/status`
 *    仍然返回 `ok:true` —— 用户永远不知道防盗刷已经死了。
 *    修法：先解业务码，`40003` 明确报 `auth-failed`；并把"精确路径连续 N 次失败"
 *    提升为可见告警（healthAlert），不再假装健康。
 * ② **兜底路径量纲不匹配**：旧判据 `delta > localCost * 1.5 + 0.1`，其中 `delta` 是
 *    **两次快照之间（≈15 分钟）**的余额降幅，而 `localCost` 是**过去 24 小时**的累计
 *    —— 24h 累计 vs 15min 增量，量纲不一致，阈值实际要求"15 分钟花掉 1.5 天的钱"。
 *    实测当时 localCost=35.68 ⇒ 阈值 53.6 元，而账户余额总共只有 13.68 元 ⇒ **永不触发**。
 *    修法：同窗口比较——用"上次快照到本次快照之间的本地消费"去比余额降幅。
 * ③ **无界增长**：`snapshots.jsonl` 已到 24,286 行 / 5.6MB，启动时**全量读入**；
 *    `ledger.jsonl` 24,001 行 / 3.8MB，**每 15 分钟全量读 + 全量 JSON.parse**。
 *    两个文件都只增不减。修法：读改为只读文件尾部；写改为按行数滚动裁剪。
 */
import { appendFileSync, mkdirSync, existsSync, statSync, openSync, readSync, closeSync, writeFileSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

export const name = 'dsh-usage-guard'
/** 声明式硬依赖：webServer 就绪前不激活（bundle 装配早于服务时 ctx.get 拿空，路由静默丢失） */
export const inject = ['webServer']

// ── 定价（2026-10-01 校准为官方现行价，见下方核对说明）──
// 官方来源：https://api-docs.deepseek.com/zh-cn/quick_start/pricing
// 校准方法：拉官方 /usage/by_api_key/amount（分时 token）+ /usage/by_api_key/cost（分时真实扣费），
//          用「本表价 × token」去拟合官方 cost，2026-09-19…10-03 共 15 天 ¥225.15 全部吻合（差 <¥0.005/天）。
// 旧价（hit 0.05/0.10、miss 1.5/3、out 4.5/9）已被官方下调，用它会把金额**高估约 1.9 倍**。
const PEAK_HOURS: ReadonlyArray<readonly [number, number]> = [[9, 12], [14, 18]]
/**
 * 2026 年法定节假日（国务院办公厅 2025-11-04 通知，节假日全天按**空闲时段**计价）。
 * 逐日核对（见上）确认官方口径：**只有「周一至周五 且 非法定节假日」才是工作日**；
 * 调休上班的周末（如 2026-09-20 周日上班）官方仍按空闲时段计——故本表**不含**调休上班日。
 */
const CN_HOLIDAYS_2026: ReadonlySet<string> = new Set([
  // 元旦
  '2026-01-01', '2026-01-02', '2026-01-03',
  // 春节
  '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
  // 清明节
  '2026-04-04', '2026-04-05', '2026-04-06',
  // 劳动节
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
  // 端午节
  '2026-06-19', '2026-06-20', '2026-06-21',
  // 中秋节
  '2026-09-25', '2026-09-26', '2026-09-27',
  // 国庆节
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07',
])

export interface PriceTable { hit: [number, number]; miss: [number, number]; out: [number, number] }
/** deepseek-flash（含旧名 v4-flash / v4-flash-vision-exp，官方按 Flash 价计费）：[空闲, 高峰] */
const BASE_PRICE: PriceTable = { hit: [0.02, 0.04], miss: [1.0, 2.0], out: [4.0, 8.0] }
const PRO_PRICE: PriceTable = { hit: [0.15, 0.30], miss: [4.5, 9.0], out: [13.5, 27.0] }
const PRICING: Record<string, PriceTable> = {
  'deepseek-v4-pro': PRO_PRICE,
  // 旧名仍可调用，但请求由 DeepSeek-V4.1-Flash 提供、按 Flash 价计费 ⇒ 落到 BASE_PRICE
  'deepseek-v4-flash-vision-exp': BASE_PRICE,
  'deepseek-v4-flash': BASE_PRICE,
  'deepseek-flash': BASE_PRICE,
  'deepseek-chat': BASE_PRICE,
  'deepseek-reasoner': BASE_PRICE,
}
/**
 * 零价档：**免费网页通道 + 本机/局域推理**。它们没有 API 账单，必须计 0。
 * 只按模型名查表会把 `deepseek-web/deepseek-chat` 算进付费的 `deepseek-chat` 档、
 * 把本地模型（名字带路径）落到兜底付费档（2026-09-27 于 cost-meter 同源修复，此处对齐）。
 */
const ZERO_PRICE: PriceTable = { hit: [0, 0], miss: [0, 0], out: [0, 0] }
/**
 * 已知**第三方中转/订阅**平台：走它们自己的计费通道，**不扣 DeepSeek 官方余额**。
 * 来源：本机 settings.yaml 的 jet-hub.accounts（2026-10-01 实读）。
 * 新增平台时请一并补充此表，否则它的消耗会被当成官方用量算进对账分母（只会偏向保守，不会误报）。
 */
const THIRD_PARTY_PROVIDERS: ReadonlySet<string> = new Set([
  'codearts', 'buddy', 'lobsterai', 'trae',
])
export function isFreeProvider(provider: string | undefined): boolean {
  const p = String(provider ?? '').toLowerCase()
  if (!p) return false
  if (p === 'deepseek-web') return true
  return /(^|[/@-])(local|localhost|ollama|lmstudio|llama\.cpp|vllm|mlx)([/@-]|$)/.test(p) || p.startsWith('local')
}
export function priceFor(model: string | undefined, provider?: string): PriceTable {
  if (isFreeProvider(provider)) return ZERO_PRICE
  const m = String(model ?? '').toLowerCase()
  for (const key of Object.keys(PRICING)) if (m.includes(key)) return PRICING[key]
  return BASE_PRICE
}
/**
 * 北京时间下该时刻是否属于**高峰时段**（决定计价档位）。
 *
 * 官方规则（2026-10-01 逐日核对确认）：仅「周一至周五 **且** 非法定节假日」为工作日，
 * 高峰时段为北京时间 9:00–12:00、14:00–18:00；其余（含周末、法定节假日全天）均为空闲时段。
 * 注意「调休上班的周末」官方仍按空闲时段计价，因此**不能**用行政调休表把它算成工作日。
 *
 * @param timeSec 事件发生时刻（**Unix 秒**，不是毫秒）
 * @returns true = 高峰价
 */
export function isPeakTime(timeSec: number): boolean {
  if (!Number.isFinite(timeSec)) return false
  // 平移到北京时间后按 UTC 取值（避免依赖宿主时区）
  const bj = new Date(timeSec * 1000 + 8 * 3600 * 1000)
  const dow = bj.getUTCDay()
  if (dow === 0 || dow === 6) return false                                   // 周末 → 空闲
  if (CN_HOLIDAYS_2026.has(bj.toISOString().slice(0, 10))) return false      // 法定节假日全天 → 空闲
  const h = bj.getUTCHours()
  return PEAK_HOURS.some(([a, b]) => h >= a && h < b)
}
/**
 * 该条账本记录是否计入「可能扣减 DeepSeek 余额」的对账分母。
 *
 * 背景：本机同时挂着多个**第三方中转**平台（codearts / buddy / lobsterai / trae）与
 * 网页免费通道（deepseek-web）、本地推理。它们都不消耗 DeepSeek 官方余额，
 * 而官方接口只统计官方 key 的用量 ⇒ 分母必须把"确定不扣官方余额"的消耗剔除。
 *
 * 采用**黑名单**（剔除已知不扣费者）而非白名单，理由有二：
 *  1. 归因字段是 2026-10-01 才补上的，**历史账本 provider 全空**；白名单会把它们全判为
 *     "不计入"，使分母归零、对账彻底失效（实测当天 1.92 亿 tok 全未归因）。
 *  2. 未知 provider 宁可**算进分母**：分母偏大 ⇒ 比值偏小 ⇒ 偏向保守（少报而非误报），
 *     不会因为归因缺失就制造假告警。
 *
 * @param provider 账本记录里的 provider（可能为空 = 归因缺失）
 * @returns true = 计入对账分母
 */
export function countsTowardDeepSeekBalance(provider: string | undefined): boolean {
  const p = String(provider ?? '').toLowerCase()
  // 归因缺失 ⇒ 保守计入（历史数据、以及未跑到 request/context 的会话）
  if (!p) return true
  // 免费网页通道：无 API 账单
  if (isFreeProvider(p)) return false
  // 已知第三方中转/订阅平台：走各自计费通道，不扣 DeepSeek 余额
  if (THIRD_PARTY_PROVIDERS.has(p)) return false
  // 官方路由与其余未知来源：计入
  return true
}

/**
 * 官方用量接口的统计窗口起点——**本地时区当日 0 点**（Unix 秒）。
 *
 * 这个值是「官方 token 数」与「本机账本 token 数」能否直接相比的唯一前提：
 * 两侧必须同窗口。生成 URL 与聚合本机账本都必须调用本函数，不得各写一份。
 *
 * @returns 当天 00:00:00（宿主本地时区）的 Unix 秒
 */
export function officialWindowStart(now: Date = new Date()): number {
  return Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000)
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)

const AUTH_SCHEME = 'Bearer'
const BALANCE_URL = 'https://api.deepseek.com/user/balance'
const USAGE_URL_PREFIX = 'https://platform.deepseek.com/api/v0/usage/by_api_key/amount'

/** 平台侧业务码：非 0 即业务失败（HTTP 仍是 200）。实测 40003 = Authorization Failed。 */
const PLATFORM_CODE_OK = 0
const PLATFORM_CODE_AUTH = 40003

const GUARD_DIR = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'usage-guard')
const LEDGER_FILE = join(GUARD_DIR, 'ledger.jsonl')
const SNAPSHOTS_FILE = join(GUARD_DIR, 'snapshots.jsonl')

/** 读大文件时只从尾部取这么多字节（账本/快照都是 append-only，旧数据对"近 N 小时"无意义）。 */
const TAIL_BYTES = 1_500_000
/** 超过这么多行就滚动裁剪到 KEEP_LINES 行。 */
const ROTATE_OVER_LINES = 3000
const KEEP_LINES = 1200
/** 精确路径连续失败多少次后升级为可见告警（15 分钟一次 ⇒ 3 次 ≈ 45 分钟）。 */
const PRIMARY_FAIL_ALERT_STREAK = 3

interface LedgerEntry {
  ts: number
  model: string
  inputTokens: number
  cacheReadTokens: number
  outputTokens: number
  costCny: number
  provider?: string
}

/** 官方用量失败的原因分类（比旧实现的单一 'no-series' 精确得多）。 */
export type OfficialErrorKind =
  | 'no-platform-token'
  | 'auth-failed'
  | 'api-error'
  | 'http-error'
  | 'shape-changed'
  | 'network'

interface OfficialResult {
  tokens: number
  cost: number
  err?: OfficialErrorKind
  /** 人类可读的补充说明（业务码 / HTTP 状态 / msg），用于 UI 与日志 */
  detail?: string
}

interface SnapshotEntry {
  ts: number
  kind: 'official-usage' | 'balance'
  windowStart: number
  windowEnd: number
  officialTokens: number
  officialCost: number
  localTokens: number
  localCost: number
  balance: number | null
  currency: string | null
  /** 精确路径的失败原因（null = 上一次是成功的）。 */
  officialErr?: OfficialErrorKind | null
}

function appendLine(file: string, obj: unknown): void {
  try {
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, JSON.stringify(obj) + '\n')
  } catch { /* 静默 */ }
}

/**
 * 只读文件尾部的若干字节再按行切分。
 * append-only 的账本**不需要**每 15 分钟全量读 3.8MB / 24k 行——那是纯粹的浪费。
 * @param maxBytes 最多读取的尾部字节数；0 表示不限制（小文件路径）
 */
export function readTailLines(file: string, maxBytes = TAIL_BYTES): string[] {
  try {
    if (!existsSync(file)) return []
    const size = statSync(file).size
    if (size === 0) return []
    const start = maxBytes > 0 && size > maxBytes ? size - maxBytes : 0
    const length = size - start
    const buf = Buffer.allocUnsafe(length)
    const fd = openSync(file, 'r')
    try { readSync(fd, buf, 0, length, start) } finally { closeSync(fd) }
    const text = buf.toString('utf8')
    const lines = text.split('\n')
    // 从中间截断时，第一行极可能是半行 —— 丢掉它
    if (start > 0) lines.shift()
    // JSONL 里的空行没有意义；文件以 '\n' 结尾时尾部必然产生一个空串。
    // 自测（scripts/selftest.mjs ④）抓到的正是这一条：调用方若直接 JSON.parse 末元素会炸。
    return lines.filter((l) => l.trim() !== '')
  } catch {
    return []
  }
}

/**
 * 按行数滚动裁剪。两处收益：① 启动时不再把 24k 行全量读进内存；
 * ② 磁盘占用不再只增不减（实测 snapshots.jsonl 已 5.6MB / ledger.jsonl 3.8MB）。
 * 失败一律静默——裁剪是维护动作，绝不能让主流程受影响。
 */
export function rotateIfLarge(file: string, over = ROTATE_OVER_LINES, keep = KEEP_LINES): boolean {
  try {
    if (!existsSync(file)) return false
    const lines = readTailLines(file, 0)
    if (lines.length <= over) return false
    const kept = lines.filter((l) => l.trim() !== '').slice(-keep)
    const tmp = `${file}.rotating`
    writeFileSync(tmp, kept.join('\n') + '\n', 'utf8')
    // 原子替换（同目录内 rename 才具备原子性）
    renameSync(tmp, file)
    return true
  } catch {
    return false
  }
}

function readLedgerTail(since: number): LedgerEntry[] {
  const out: LedgerEntry[] = []
  for (const line of readTailLines(LEDGER_FILE)) {
    if (!line.trim()) continue
    try {
      const e = JSON.parse(line) as LedgerEntry
      if (typeof e.ts === 'number' && e.ts >= since) out.push(e)
    } catch { /* skip broken line */ }
  }
  return out
}

function readSnapshots(): SnapshotEntry[] {
  const out: SnapshotEntry[] = []
  for (const line of readTailLines(SNAPSHOTS_FILE)) {
    if (!line.trim()) continue
    try { out.push(JSON.parse(line) as SnapshotEntry) } catch { /* skip */ }
  }
  return out
}

// ── 纯函数：便于脱机自测（scripts/selftest.mjs） ──────────────────────────────

/**
 * 把官方接口响应分类。
 * **关键**：平台在 HTTP 200 里回业务错误码，只看 `res.ok` 会把"令牌失效"误判成
 * "结构不认识"。这里先解业务码，再判结构。
 */
export function classifyOfficialFailure(httpStatus: number, body: unknown): { kind: OfficialErrorKind; detail: string } | null {
  const b = body as { code?: unknown; msg?: unknown } | null
  const code = b !== null && typeof b === 'object' && typeof b.code === 'number' ? b.code : undefined
  if (code !== undefined && code !== PLATFORM_CODE_OK) {
    const msg = typeof b?.msg === 'string' ? b.msg : ''
    if (code === PLATFORM_CODE_AUTH) {
      return { kind: 'auth-failed', detail: `平台 token 失效（code=${code}${msg ? ' ' + msg : ''}）——请重新填写` }
    }
    return { kind: 'api-error', detail: `平台返回业务错误 code=${code}${msg ? ' ' + msg : ''}` }
  }
  if (!(httpStatus >= 200 && httpStatus < 300)) return { kind: 'http-error', detail: `HTTP ${httpStatus}` }
  return null
}

/**
 * 余额哨兵判据 —— **同窗口比较**。
 *
 * 旧实现拿"15 分钟的余额降幅"去比"24 小时累计消费的 1.5 倍"，量纲不一致：
 * 实测 localCost=35.68 时阈值 = 53.6 元，而账户余额总共只有 13.68 元 ⇒ 永不触发。
 * 正确做法：比较**同一时间窗内**的两个量 —— 这段时间余额掉了多少 vs 本机花了多少。
 *
 * @param balanceDrop 上次快照到本次快照之间的余额下降（元，>0 表示真的掉了）
 * @param windowCost  **同一窗口**内本机账本累计消费（元）
 * @returns null = 正常；否则返回告警码
 */
export function detectBalanceAnomaly(balanceDrop: number, windowCost: number): string | null {
  if (!Number.isFinite(balanceDrop) || !Number.isFinite(windowCost)) return null
  // 忽略浮点噪声与充值造成的非下降
  if (balanceDrop <= 0.01) return null
  // 余额降幅明显超过本机同期消费（1.5 倍 + 0.5 元余量）⇒ 有别人在用这个 key
  if (balanceDrop > Math.max(windowCost, 0) * 1.5 + 0.5) return 'suspicious-external-usage-via-balance'
  return null
}

/** 精确路径连续失败计数（从快照尾部统计）——用于把"静默退化"变成可见告警。 */
export function primaryFailureStreak(snapshots: SnapshotEntry[]): number {
  let n = 0
  for (let i = snapshots.length - 1; i >= 0; i -= 1) {
    const s = snapshots[i]!
    if (s.officialErr === undefined || s.officialErr === null) break
    n += 1
  }
  return n
}

// ── 插件 ────────────────────────────────────────────────────────────────────

export function apply(ctx: any): void {
  let snapshots: SnapshotEntry[] = readSnapshots()
  /**
   * 最近一次 `request/header` 事件里的模型与平台 —— 供后续 `assistant/message` 归因。
   *
   * 为什么必须有：`assistant/message` 事件**通常不带** `data.source.provider`/`data.model`
   * （实测 2026-10-01：本机账本 1621 行 model/provider 全空）。不记住它们，就无法区分
   * 「DeepSeek 官方 API 消耗」与「第三方中转平台（codearts/buddy/…）消耗」——
   * 而后者根本不扣 DeepSeek 余额，混进来会把对账彻底带偏（实测本机 3.9 亿 tok vs 官方 9729 万）。
   * 与 dsh-cost-meter 的 `state.currentModel/currentProvider` 同一做法。
   */
  const current: { model: string; provider: string } = { model: '', provider: '' }

  const onSessionEvent = (event: any, session?: any): void => {
    if (event === null || typeof event !== 'object') return

    // ① 路由元数据：`request/context` 直接给出这条路由的 provider/model（最可靠）
    //    类型见 dsh-session `RequestContext`：{ provider, model, contextWindow? }
    if (event.type === 'request/context') {
      const p = event?.data?.provider
      const m = event?.data?.model
      if (typeof p === 'string' && p) current.provider = p
      if (typeof m === 'string' && m) current.model = m
      return
    }

    // ② request/header：会话级调用配置快照。`header.config` 是 LlmCallConfig { provider, model, … }。
    //    注意：只有 header **变化**时才记录，所以它比 request/context 稀疏 ⇒ 两者都要读。
    if (event.type === 'request/header') {
      const cfg = event?.data?.header?.config
      const m = cfg?.model
      const p = cfg?.provider
      if (typeof m === 'string' && m) current.model = m
      if (typeof p === 'string' && p) current.provider = p
      return
    }

    if (event.type !== 'assistant/message') return
    const usage = event?.data?.usage
    if (usage === null || typeof usage !== 'object') return
    const input = num(usage.inputTokens)
    const cacheRead = num(usage.cacheReadTokens)
    const output = num(usage.outputTokens)
    if (input + cacheRead + output === 0) return
    const ts = (typeof event.time === 'number' && Number.isFinite(event.time) ? event.time : Date.now()) / 1000
    // 归因优先级：事件自带 → 最近记住的 → 会话的 requestContext() 折叠值。
    // 最后这条兜底至关重要：`request/context` 只在路由**变化**时 append，
    // 实测一个模型没换过的会话整场 0 次该事件 ⇒ 只靠事件流归因会得到空 provider。
    // `session.requestContext()` 是 session 对该折叠的缓存读取，无事件也能拿到当前路由。
    let rc: any
    try { rc = typeof session?.requestContext === 'function' ? session.requestContext() : undefined } catch { rc = undefined }
    const model = (typeof event?.data?.model === 'string' && event.data.model)
      ? event.data.model
      : (current.model || (typeof rc?.model === 'string' ? rc.model : ''))
    const provider = (typeof event?.data?.source?.provider === 'string' && event.data.source.provider)
      ? event.data.source.provider
      : (current.provider || (typeof rc?.provider === 'string' ? rc.provider : ''))
    const price = priceFor(model, provider)
    const off = isPeakTime(ts) ? 1 : 0
    const cost = (input / 1e6) * price.miss[off] + (cacheRead / 1e6) * price.hit[off] + (output / 1e6) * price.out[off]
    const entry: LedgerEntry = { ts, model, inputTokens: input, cacheReadTokens: cacheRead, outputTokens: output, costCny: cost, provider }
    appendLine(LEDGER_FILE, entry)
  }
  ctx.on('session/event', (session: any, event: any) => onSessionEvent(event, session))

  async function resolveCred(name: string): Promise<string | null> {
    try {
      const credentials = ctx.get('credentials')
      if (!credentials || typeof credentials.resolve !== 'function') return null
      const cred = await credentials.resolve(name)
      if (cred && typeof cred.value === 'string' && cred.value) return String(cred.value)
    } catch { /* ignore */ }
    return null
  }

  // ── 2. 官方用量（精确对账）──
  async function fetchOfficialUsage(): Promise<OfficialResult> {
    const token = await resolveCred('DEEPSEEK_PLATFORM_TOKEN')
    if (!token) return { tokens: 0, cost: 0, err: 'no-platform-token', detail: '未配置平台 token（只跑余额哨兵）' }
    const now = new Date()
    const start = officialWindowStart(now)
    const end = start + 86400
    const tz = -now.getTimezoneOffset() * 60
    const url = USAGE_URL_PREFIX + '?start=' + start + '&end=' + end + '&tz=' + tz
    let res: Response
    try {
      res = await fetch(url, {
        headers: { Authorization: AUTH_SCHEME + ' ' + String(token).replace(/^Bearer\s+/i, '') },
        signal: AbortSignal.timeout(15000),
      })
    } catch {
      return { tokens: 0, cost: 0, err: 'network', detail: '请求平台接口失败（网络/超时）' }
    }
    let body: any
    try { body = await res.json() } catch { return { tokens: 0, cost: 0, err: 'shape-changed', detail: `响应不是 JSON（HTTP ${res.status}）` } }

    // ① 先判业务码 —— 这一步是 2026-10-01 修复的核心：
    //    平台在 HTTP 200 里回 {"code":40003,"msg":"Authorization Failed"}，
    //    旧实现只看 res.ok ⇒ 把认证失败当成结构不认识，静默退化。
    const failure = classifyOfficialFailure(res.status, body)
    if (failure !== null) return { tokens: 0, cost: 0, err: failure.kind, detail: failure.detail }

    // ② 再判结构
    let d: any = body
    if (d && d.data && d.data.biz_data && Array.isArray(d.data.biz_data.series)) d = d.data.biz_data
    else if (d && d.data && Array.isArray(d.data.series)) d = d.data
    const series = Array.isArray(d?.series) ? d.series : null
    if (!series || series.length === 0) {
      return { tokens: 0, cost: 0, err: 'shape-changed', detail: '响应结构变了：找不到 series（既非 data.biz_data.series 也非 data.series）' }
    }
    let tokens = 0
    let cost = 0
    let found = false
    for (const s of series) {
      if (!s || typeof s !== 'object') continue
      const p = priceFor(s.model)
      for (const b of Array.isArray(s.buckets) ? s.buckets : []) {
        const u = b?.usage
        if (!u || typeof u !== 'object') continue
        const hit = num(u.PROMPT_CACHE_HIT_TOKEN)
        const miss = num(u.PROMPT_CACHE_MISS_TOKEN)
        const out = num(u.RESPONSE_TOKEN)
        if (hit + miss + out === 0) continue
        found = true
        tokens += hit + miss + out
        const off = isPeakTime(num(b.time)) ? 1 : 0
        cost += (hit / 1e6) * p.hit[off] + (miss / 1e6) * p.miss[off] + (out / 1e6) * p.out[off]
      }
    }
    if (!found) return { tokens: 0, cost: 0, err: 'shape-changed', detail: 'series 存在但没有可用 bucket（全为 0）' }
    return { tokens, cost }
  }

  // ── 3. 余额哨兵 ──
  async function fetchBalance(): Promise<{ balance: number; currency: string } | null> {
    const key = await resolveCred('DEEPSEEK_API_KEY')
    if (!key) return null
    try {
      const res = await fetch(BALANCE_URL, {
        headers: { Authorization: AUTH_SCHEME + ' ' + key },
        signal: AbortSignal.timeout(20000),
      })
      if (!res.ok) return null
      const data: any = await res.json()
      const infos = Array.isArray(data?.balance_infos) ? data.balance_infos : []
      const pick = infos.find((x: any) => x && x.currency === 'CNY' && Number(x.total_balance) > 0)
        ?? infos.find((x: any) => x && Number(x.total_balance) > 0)
        ?? infos.find((x: any) => x && x.currency === 'CNY')
        ?? infos[0]
      if (!pick || pick.total_balance === undefined) return null
      return { balance: Number(pick.total_balance), currency: String(pick.currency || 'CNY') }
    } catch {
      return null
    }
  }

  // ── 4. 对账 ──
  async function runCheck(): Promise<Record<string, unknown>> {
    const nowSec = Math.floor(Date.now() / 1000)
    // ★ 本机窗口必须与官方接口**同一个起点**（本地时区当日 0 点），否则两个 token 数不可比。
    //   旧实现本机取「近 24 小时」、官方取「今天 0 点起」，比值被本机的多出的半天严重稀释
    //   （2026-10-01 实测：本机 24h 4.04 亿 vs 本机今日 1.67 亿，差 2.4 倍 ⇒ 漏报）。
    const windowStart = officialWindowStart()
    const windowEnd = nowSec

    const official = await fetchOfficialUsage()
    const localEntries = readLedgerTail(windowStart)
    // ★ 只统计**会扣 DeepSeek 官方余额**的消耗：第三方中转/免费通道/本地推理要剔除，
    //   否则分母被无关消耗撑大，比值被压低 ⇒ 漏报（见 countsTowardDeepSeekBalance 注释）。
    const metered = localEntries.filter((e) => countsTowardDeepSeekBalance(e.provider))
    const localTokens = metered.reduce((a, e) => a + e.inputTokens + e.cacheReadTokens + e.outputTokens, 0)
    const localCost = metered.reduce((a, e) => a + e.costCny, 0)

    let balance: number | null = null
    let currency: string | null = null
    let balanceAlert: string | null = null
    let balanceDetail: string | null = null
    const prevBalanceSnap = [...snapshots].reverse().find((s) => s.kind === 'balance' && s.balance !== null)
    const b = await fetchBalance()
    if (b !== null) {
      balance = b.balance
      currency = b.currency
      if (prevBalanceSnap !== undefined && prevBalanceSnap.balance !== null && prevBalanceSnap.ts < nowSec - 60) {
        const drop = prevBalanceSnap.balance - b.balance
        // ★ 同窗口比较：只统计「上次快照 → 现在」之间本机花掉的钱。
        //   同样只算会扣官方余额的部分——第三方中转的消耗不该替真盗刷"顶账"。
        const windowCost = readLedgerTail(prevBalanceSnap.ts)
          .filter((e) => countsTowardDeepSeekBalance(e.provider))
          .reduce((a, e) => a + e.costCny, 0)
        const verdict = detectBalanceAnomaly(drop, windowCost)
        if (verdict !== null) {
          balanceAlert = verdict
          balanceDetail = `余额降 ¥${drop.toFixed(4)}，同期本机仅消费 ¥${windowCost.toFixed(4)}（窗口 ${Math.round((nowSec - prevBalanceSnap.ts) / 60)} 分钟）`
        }
      }
    }

    let alert: string | null = null
    let detail: string | null = null
    if (official.err === undefined) {
      const tokenRatio = localTokens > 0 ? official.tokens / localTokens : 0
      if (tokenRatio > 1.2 && official.tokens - localTokens > 5000) {
        alert = 'suspicious-external-usage'
        detail = 'officialTokens=' + Math.round(official.tokens) + ' localTokens=' + Math.round(localTokens) + ' costDiff=' + (official.cost - localCost).toFixed(4)
      }
    }

    const snap: SnapshotEntry = {
      ts: nowSec, kind: official.err === undefined ? 'official-usage' : 'balance',
      windowStart, windowEnd,
      officialTokens: official.tokens, officialCost: official.cost,
      localTokens, localCost,
      balance, currency,
      officialErr: official.err ?? null,
    }
    snapshots.push(snap)
    if (snapshots.length > 96) snapshots = snapshots.slice(-96)
    appendLine(SNAPSHOTS_FILE, snap)
    // 顺带做一次滚动裁剪（每 15 分钟一次机会，阈值到了才真写盘）
    rotateIfLarge(SNAPSHOTS_FILE)
    rotateIfLarge(LEDGER_FILE)

    // ── 5. 健康度：精确路径长期失效必须显式说出来 ──────────────────────────
    const streak = primaryFailureStreak(snapshots)
    const healthAlert = official.err !== undefined && official.err !== 'no-platform-token' && streak >= PRIMARY_FAIL_ALERT_STREAK
      ? 'official-usage-unavailable'
      : null
    const primaryHealthy = official.err === undefined
    const sentinelHealthy = b !== null

    return {
      ok: primaryHealthy || sentinelHealthy,
      checkedAt: new Date().toISOString(),
      local: { tokens: localTokens, costCny: Number(localCost.toFixed(6)) },
      official: official.err === undefined
        ? { tokens: official.tokens, costCny: Number(official.cost.toFixed(6)) }
        : { err: official.err, detail: official.detail ?? null },
      balance: balance === null ? null : { value: balance, currency },
      alert: alert === null ? (balanceAlert === null ? null : balanceAlert) : alert,
      detail: detail ?? balanceDetail,
      health: {
        primary: primaryHealthy ? 'ok' : String(official.err),
        primaryDetail: primaryHealthy ? null : (official.detail ?? null),
        primaryFailStreak: streak,
        sentinel: sentinelHealthy ? 'ok' : 'unavailable',
        // 防盗刷能力是否**真的**在生效：两条路径至少一条活着
        detectionActive: primaryHealthy || sentinelHealthy,
      },
      healthAlert,
    }
  }

  // ── 6. 定时对账（15 分钟）+ 启动即跑 ──
  let disposed = false
  ctx.inject(['timer'], (timerCtx: any) => {
    timerCtx.interval(() => { if (!disposed) void runCheck().catch(() => {}) }, 15 * 60 * 1000)
    timerCtx.timeout(() => { if (!disposed) void runCheck().catch(() => {}) }, 3000)
  })

  // ── 7. API（client 轮询）；ctx.webServer 由模块级 inject 保证可用 ──
  const webServer = ctx.webServer
  if (webServer && typeof webServer.register === 'function') {
    ctx.effect(() => {
      const dispose = webServer.register({
        kind: 'prefix',
        path: '/dsh-usage-guard/api',
        handler: async (req: any, res: any) => {
          const send = (code: number, obj: unknown) => {
            res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify(obj))
          }
          try {
            const _url = new URL(req.url ?? '/', 'http://localhost')
            const path = _url.pathname.replace(/^\/dsh-usage-guard\/api/, '') || '/'
            // 定价自测口：与 cost-meter 同口径，便于两插件交叉核对
            if (req.method === 'GET' && path === '/price') {
              const provider = _url.searchParams.get('provider') ?? undefined
              const model = _url.searchParams.get('model') ?? undefined
              return send(200, { ok: true, provider: provider ?? null, model: model ?? null, free: isFreeProvider(provider), price: priceFor(model, provider) })
            }
            if (req.method === 'GET' && path === '/status') return send(200, await runCheck())
            if (req.method === 'POST' && path === '/check') return send(200, await runCheck())
            if (req.method === 'GET' && path === '/cred-status') {
              const credentials = ctx.get('credentials')
              let configured = false
              try {
                const resolved = credentials && typeof credentials.resolve === 'function'
                  ? await credentials.resolve('DEEPSEEK_PLATFORM_TOKEN')
                  : undefined
                configured = !!(resolved && typeof resolved.value === 'string' && resolved.value)
              } catch { configured = false }
              return send(200, { ok: true, configured })
            }
            if (req.method === 'POST' && path === '/cred') {
              const credentials = ctx.get('credentials')
              if (!credentials || typeof credentials.set !== 'function') return send(500, { ok: false, error: 'no credentials service' })
              let value = ''
              try {
                const body = JSON.parse(await new Promise<string>((resolve, reject) => {
                  let buf = ''
                  req.on('data', (c: Buffer) => { buf += c.toString('utf8') })
                  req.on('end', () => resolve(buf))
                  req.on('error', reject)
                }))
                value = String((body && body.value) || '').trim()
              } catch { return send(400, { ok: false, error: 'invalid json body' }) }
              if (!value || value.length < 8) return send(400, { ok: false, error: 'token 太短' })
              try {
                await credentials.set('DEEPSEEK_PLATFORM_TOKEN', value)
                await runCheck()
                return send(200, { ok: true, configured: true })
              } catch (e) {
                return send(500, { ok: false, error: String(e instanceof Error ? e.message : e) })
              }
            }
            return send(404, { ok: false, error: 'not found' })
          } catch (e) {
            return send(500, { ok: false, error: String(e instanceof Error ? e.message : e) })
          }
        },
      })
      return () => { if (typeof dispose === 'function') dispose() }
    })
  }
}
