/**
 * dsh-usage-guard — host half.
 *
 * 用途：防止 DeepSeek API Key 被盗刷——本地账本与官方用量精确对账。
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
 */
import { appendFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

export const name = 'dsh-usage-guard'

// ── 定价（与 dsh-cost-meter 完全一致）──
const PEAK_HOURS: ReadonlyArray<readonly [number, number]> = [[9, 12], [14, 18]]
const WEEKEND_VALLEY_FROM_SEC = Math.floor(Date.UTC(2026, 7, 22, 16, 0, 0) / 1000)

interface PriceTable { hit: [number, number]; miss: [number, number]; out: [number, number] }
const BASE_PRICE: PriceTable = { hit: [0.05, 0.1], miss: [1.5, 3.0], out: [4.5, 9.0] }
const PRO_PRICE: PriceTable = { hit: [0.15, 0.3], miss: [4.5, 9.0], out: [13.5, 27.0] }
const PRICING: Record<string, PriceTable> = {
  'deepseek-v4-pro': PRO_PRICE,
  'deepseek-v4-flash-vision-exp': BASE_PRICE,
  'deepseek-v4-flash': BASE_PRICE,
  'deepseek-chat': BASE_PRICE,
  'deepseek-reasoner': BASE_PRICE,
}
function priceFor(model: string | undefined): PriceTable {
  const m = String(model ?? '').toLowerCase()
  for (const key of Object.keys(PRICING)) if (m.includes(key)) return PRICING[key]
  return BASE_PRICE
}
function isPeakTime(timeSec: number): boolean {
  if (!Number.isFinite(timeSec)) return false
  const bj = new Date(timeSec * 1000 + 8 * 3600 * 1000)
  const dow = bj.getUTCDay()
  if (timeSec >= WEEKEND_VALLEY_FROM_SEC && (dow === 0 || dow === 6)) return false
  const h = bj.getUTCHours()
  return PEAK_HOURS.some(([a, b]) => h >= a && h < b)
}
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)

const AUTH_SCHEME = 'Bearer'
const BALANCE_URL = 'https://api.deepseek.com/user/balance'
const USAGE_URL_PREFIX = 'https://platform.deepseek.com/api/v0/usage/by_api_key/amount'

const GUARD_DIR = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'usage-guard')
const LEDGER_FILE = join(GUARD_DIR, 'ledger.jsonl')
const SNAPSHOTS_FILE = join(GUARD_DIR, 'snapshots.jsonl')

interface LedgerEntry {
  ts: number
  model: string
  inputTokens: number
  cacheReadTokens: number
  outputTokens: number
  costCny: number
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
}

function appendLine(file: string, obj: unknown): void {
  try {
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, JSON.stringify(obj) + '\n')
  } catch { /* 静默 */ }
}

function readLedgerTail(since: number): LedgerEntry[] {
  try {
    if (!existsSync(LEDGER_FILE)) return []
    const out: LedgerEntry[] = []
    for (const line of readFileSync(LEDGER_FILE, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const e = JSON.parse(line) as LedgerEntry
        if (typeof e.ts === 'number' && e.ts >= since) out.push(e)
      } catch { /* skip broken line */ }
    }
    return out
  } catch {
    return []
  }
}

function readSnapshots(): SnapshotEntry[] {
  try {
    if (!existsSync(SNAPSHOTS_FILE)) return []
    const out: SnapshotEntry[] = []
    for (const line of readFileSync(SNAPSHOTS_FILE, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try { out.push(JSON.parse(line)) } catch { /* skip */ }
    }
    return out
  } catch {
    return []
  }
}

export function apply(ctx: any): void {
  let snapshots: SnapshotEntry[] = readSnapshots()

  // ── 1. 本地账本聚合（全局会话事件）──
  ctx.on('session/event', (_session: any, event: any) => {
    if (event === null || typeof event !== 'object' || event.type !== 'assistant/message') return
    const usage = event?.data?.usage
    if (usage === null || typeof usage !== 'object') return
    const input = num(usage.inputTokens)
    const cacheRead = num(usage.cacheReadTokens)
    const output = num(usage.outputTokens)
    if (input + cacheRead + output === 0) return
    const ts = (typeof event.time === 'number' && Number.isFinite(event.time) ? event.time : Date.now()) / 1000
    const model = typeof event?.data?.model === 'string' ? event.data.model : ''
    const price = priceFor(model)
    const off = isPeakTime(ts) ? 1 : 0
    const cost = (input / 1e6) * price.miss[off] + (cacheRead / 1e6) * price.hit[off] + (output / 1e6) * price.out[off]
    const entry: LedgerEntry = { ts, model, inputTokens: input, cacheReadTokens: cacheRead, outputTokens: output, costCny: cost }
    appendLine(LEDGER_FILE, entry)
  })

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
  async function fetchOfficialUsage(): Promise<{ tokens: number; cost: number; err?: string }> {
    const token = await resolveCred('DEEPSEEK_PLATFORM_TOKEN')
    if (!token) return { tokens: 0, cost: 0, err: 'no-platform-token' }
    const now = new Date()
    const start = Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000)
    const end = start + 86400
    const tz = -now.getTimezoneOffset() * 60
    const url = USAGE_URL_PREFIX + '?start=' + start + '&end=' + end + '&tz=' + tz
    try {
      const res = await fetch(url, {
        headers: { Authorization: AUTH_SCHEME + ' ' + String(token).replace(/^Bearer\s+/i, '') },
        signal: AbortSignal.timeout(15000),
      })
      if (!res.ok) return { tokens: 0, cost: 0, err: 'http-' + res.status }
      const data: any = await res.json()
      let d: any = data
      if (d && d.data && d.data.biz_data && Array.isArray(d.data.biz_data.series)) d = d.data.biz_data
      else if (d && d.data && Array.isArray(d.data.series)) d = d.data
      const series = Array.isArray(d?.series) ? d.series : null
      if (!series || series.length === 0) return { tokens: 0, cost: 0, err: 'no-series' }
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
      return found ? { tokens, cost } : { tokens: 0, cost: 0, err: 'no-series' }
    } catch {
      return { tokens: 0, cost: 0, err: 'fetch-failed' }
    }
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
    const windowStart = nowSec - 86400
    const windowEnd = nowSec

    const official = await fetchOfficialUsage()
    const localEntries = readLedgerTail(windowStart)
    const localTokens = localEntries.reduce((a, e) => a + e.inputTokens + e.cacheReadTokens + e.outputTokens, 0)
    const localCost = localEntries.reduce((a, e) => a + e.costCny, 0)

    let balance: number | null = null
    let currency: string | null = null
    let balanceAlert: string | null = null
    if (official.err !== undefined) {
      const b = await fetchBalance()
      if (b !== null) {
        balance = b.balance
        currency = b.currency
        const prev = snapshots.filter((s) => s.kind === 'balance' && s.balance !== null)
        const last = prev.length > 0 ? prev[prev.length - 1] : null
        if (last !== null && last.ts < nowSec - 60) {
          const delta = (last.balance === null ? 0 : last.balance) - b.balance
          if (delta > 0.5 && delta > localCost * 1.5 + 0.1) {
            balanceAlert = 'official-balance-drop-exceeds-local'
          }
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
    }
    snapshots.push(snap)
    if (snapshots.length > 96) snapshots = snapshots.slice(-96)
    appendLine(SNAPSHOTS_FILE, snap)

    return {
      ok: true,
      checkedAt: new Date().toISOString(),
      local: { tokens: localTokens, costCny: Number(localCost.toFixed(6)) },
      official: official.err === undefined
        ? { tokens: official.tokens, costCny: Number(official.cost.toFixed(6)) }
        : { err: official.err },
      balance: balance === null ? null : { value: balance, currency },
      alert: alert === null ? (balanceAlert === null ? null : balanceAlert) : alert,
      detail,
    }
  }

  // ── 5. 定时对账（15 分钟）+ 启动即跑 ──
  let disposed = false
  ctx.inject(['timer'], (timerCtx: any) => {
    timerCtx.interval(() => { if (!disposed) void runCheck().catch(() => {}) }, 15 * 60 * 1000)
    timerCtx.timeout(() => { if (!disposed) void runCheck().catch(() => {}) }, 3000)
  })

  // ── 6. API（client 轮询）──
  const webServer = ctx.get('webServer')
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
            const path = new URL(req.url ?? '/', 'http://localhost').pathname.replace(/^\/dsh-usage-guard\/api/, '') || '/'
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
