#!/usr/bin/env node
/**
 * dsh-usage-guard 脱机自测 —— 只测纯函数，不联网、不读真实凭据。
 *
 * 覆盖 2026-10-01 修复的三条缺陷：
 *   ① `classifyOfficialFailure` 必须把 HTTP 200 里的业务错误码认出来
 *      （实测现场：{"code":40003,"msg":"Authorization Failed (invalid token)"}
 *       旧实现只判 res.ok ⇒ 误报成 'no-series' 静默退化）
 *   ② `detectBalanceAnomaly` 必须**同窗口**比较
 *      （旧实现拿 15 分钟降幅比 24 小时累计的 1.5 倍 ⇒ 实测阈值 53.6 元 > 余额 13.68 元 ⇒ 永不触发）
 *   ③ `readTailLines` / `rotateIfLarge` 必须能限制无界增长
 *
 * 用法：node scripts/selftest.mjs
 */
import { classifyOfficialFailure, detectBalanceAnomaly, primaryFailureStreak, isFreeProvider, priceFor, isPeakTime, countsTowardDeepSeekBalance, detectUsageAnomaly }
  from '../lib/index.js'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readTailLines, rotateIfLarge } from '../lib/index.js'
import { guardView } from '../lib/guard-view.js'

let pass = 0
let fail = 0
const t = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`${ok ? '  ✓' : '  ✗ 失败'} ${name}`)
  if (!ok) console.log(`      期望 ${JSON.stringify(want)}  实得 ${JSON.stringify(got)}`)
}

console.log('【① 官方接口失败分类】')
t('现场真实响应：code 40003 → auth-failed',
  classifyOfficialFailure(200, { code: 40003, msg: 'Authorization Failed (invalid token)', data: null }),
  { kind: 'auth-failed', detail: '平台 token 失效（code=40003 Authorization Failed (invalid token)）——请重新填写' })
t('其它业务码 → api-error',
  classifyOfficialFailure(200, { code: 50001, msg: 'rate limited' })?.kind, 'api-error')
t('业务码 0 + 正常结构 → null（放行给结构判定）',
  classifyOfficialFailure(200, { code: 0, data: { series: [] } }), null)
t('无业务码 + 200 → null',
  classifyOfficialFailure(200, { data: { series: [] } }), null)
t('HTTP 500 → http-error',
  classifyOfficialFailure(500, {})?.kind, 'http-error')

console.log('\n【② 余额哨兵：同窗口比较】')
t('本机花了 10 元、余额掉 10 元 → 正常',
  detectBalanceAnomaly(10, 10), null)
t('本机花了 10 元、余额掉 16 元 → 告警（超 1.5 倍 + 0.5）',
  detectBalanceAnomaly(16, 10), 'suspicious-external-usage-via-balance')
t('本机几乎没花、余额掉 5 元 → 告警（别人在用）',
  detectBalanceAnomaly(5, 0.1), 'suspicious-external-usage-via-balance')
t('余额没掉 → 正常',
  detectBalanceAnomaly(0, 0), null)
t('余额涨了（充值）→ 正常',
  detectBalanceAnomaly(-20, 5), null)
t('浮点噪声 0.005 → 正常',
  detectBalanceAnomaly(0.005, 0), null)
// 旧实现的量纲错误在这里会露出：24 小时累计 35.68 当作 windowCost 时，
// 阈值 53.6 元，而真实余额只有 13.68 元 ⇒ 永不触发。新实现拿同窗口值，正常触发。
t('回归：旧量纲（用 24h 累计当窗口）会漏报，新量纲不漏',
  detectBalanceAnomaly(13.68, 0.5), 'suspicious-external-usage-via-balance')

console.log('\n【③ 精确路径连续失败计数】')
t('尾部 3 条都失败 → 3',
  primaryFailureStreak([{ officialErr: null }, { officialErr: 'auth-failed' }, { officialErr: 'auth-failed' }, { officialErr: 'auth-failed' }]), 3)
t('最后一条成功 → 0',
  primaryFailureStreak([{ officialErr: 'auth-failed' }, { officialErr: null }]), 0)
t('空数组 → 0', primaryFailureStreak([]), 0)

console.log('\n【④ 无界增长：尾部读 + 滚动裁剪】')
const dir = mkdtempSync(join(tmpdir(), 'usage-guard-selftest-'))
try {
  const f = join(dir, 'big.jsonl')
  const lines = []
  for (let i = 0; i < 5000; i += 1) lines.push(JSON.stringify({ i, pad: 'x'.repeat(50) }))
  writeFileSync(f, lines.join('\n') + '\n', 'utf8')
  const before = readFileSync(f, 'utf8').split('\n').filter(Boolean).length
  const tail = readTailLines(f, 20_000)
  const okTail = tail.length > 0 && tail.length < before && JSON.parse(tail[tail.length - 1]).i === 4999
  okTail ? pass++ : fail++
  console.log(`${okTail ? '  ✓' : '  ✗ 失败'} 尾部读只取一部分且最后一行完整（读到 ${tail.length} / 共 ${before} 行）`)
  if (!okTail) console.log('      ' + JSON.stringify({ got: tail.length, before }))

  const rotated = rotateIfLarge(f, 3000, 1200)
  const after = readFileSync(f, 'utf8').split('\n').filter(Boolean).length
  t('裁剪触发', rotated, true)
  t('裁剪后保留 1200 行', after, 1200)
  t('裁剪保留的是最新数据', JSON.parse(readFileSync(f, 'utf8').split('\n').filter(Boolean).pop()).i, 4999)
  t('未达阈值不裁剪', rotateIfLarge(f, 3000, 1200), false)

  // ⑨ 多实例并发：多个 DSH 实例共享同一份账本后，轮转必须互斥且不丢对方的数据。
  //    旧实现用固定 tmp 名 `${file}.rotating`：并发实例会互相覆盖临时文件。
  const c = join(dir, 'concurrent.jsonl')
  writeFileSync(c, Array.from({ length: 3500 }, (_, i) => JSON.stringify({ i })).join('\n') + '\n', 'utf8')
  const results = [rotateIfLarge(c, 3000, 1200), rotateIfLarge(c, 3000, 1200), rotateIfLarge(c, 3000, 1200)]
  t('并发轮转只有一方真正执行', results.filter(Boolean).length, 1)
  const cAfter = readFileSync(c, 'utf8').split('\n').filter(Boolean)
  t('并发后仍保留完整 1200 行（未被互相覆盖）', cAfter.length, 1200)
  t('并发后最新行完好', JSON.parse(cAfter[cAfter.length - 1]).i, 3499)
  const leftovers = readFileSync(c, 'utf8') && (await import('node:fs')).readdirSync(dir).filter((n) => n.includes('.rotating'))
  t('不留 .rotating 临时文件', leftovers.length, 0)
  t('不留 .lock 锁文件', (await import('node:fs')).readdirSync(dir).filter((n) => n.endsWith('.lock')).length, 0)
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log('\n【⑤ 回归：定价与峰谷口径】')
t('免费通道计 0 价', priceFor('deepseek-chat', 'deepseek-web'), { hit: [0, 0], miss: [0, 0], out: [0, 0] })
t('本机模型计 0 价', isFreeProvider('local/llama.cpp'), true)
// 2026-10-01 校准：官方现行价（旧价 hit 0.05/0.10、miss 1.5/3、out 4.5/9 会把金额高估约 1.9 倍）
t('flash 现行价（deepseek-flash）', priceFor('deepseek-flash', 'deepseek-official'),
  { hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] })
t('旧名 v4-flash 同样落到 flash 档', priceFor('deepseek-v4-flash', 'deepseek-official'),
  { hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] })
t('pro 现行价', priceFor('deepseek-v4-pro', 'deepseek-official').miss, [4.5, 9])
// ⚠ isPeakTime 收的是**秒**（Unix 秒），不是毫秒。
//   本自测第一版在这里传了毫秒，导致断言在测一个垃圾日期——其中一个还"碰巧"通过。
//   保留这条注释：这个单位的坑值得被后来者看见。
// ⚠ 基准日必须避开法定节假日：2026-10-01 是国庆节（全天空闲），
//   拿它测"峰时"会得到 false —— 本自测第一版就踩了这个坑。改用 2026-09-24（周四，工作日）。
const bjSec = (h) => Date.UTC(2026, 8, 24, h - 8, 0, 0) / 1000   // 北京时间 h 点 → Unix 秒
t('峰时：工作日北京 10 点（落在 [9,12)）', isPeakTime(bjSec(10)), true)
t('谷时：工作日北京 13 点（不在任何峰段）', isPeakTime(bjSec(13)), false)
t('峰时：工作日北京 15 点（落在 [14,18)）', isPeakTime(bjSec(15)), true)
t('谷时：工作日北京 19 点（峰段外）', isPeakTime(bjSec(19)), false)
t('非法输入 NaN → false', isPeakTime(NaN), false)

console.log('\n【⑥ 节假日与周末全天空闲（2026-10-01 校准）】')
// 官方口径（逐日核对 15 天确认）：仅「周一至周五 且 非法定节假日」为工作日。
const bjDay = (y, m, d, h) => Date.UTC(y, m - 1, d, h - 8, 0, 0) / 1000
t('国庆节 10-01（周四）上午 10 点 → 空闲', isPeakTime(bjDay(2026, 10, 1, 10)), false)
t('国庆节 10-01（周四）下午 15 点 → 空闲', isPeakTime(bjDay(2026, 10, 1, 15)), false)
t('春节 02-17（周二）上午 10 点 → 空闲', isPeakTime(bjDay(2026, 2, 17, 10)), false)
t('劳动节 05-04（周一）下午 15 点 → 空闲', isPeakTime(bjDay(2026, 5, 4, 15)), false)
t('普通周六 09-26 上午 10 点 → 空闲', isPeakTime(bjDay(2026, 9, 26, 10)), false)
// 关键对照：行政调休上班的周末（9-20 周日）官方**仍按空闲**计价（核对结果差 ¥12.72 若当作工作日）
t('调休上班的周日 09-20 上午 10 点 → 仍空闲（不按工作日）', isPeakTime(bjDay(2026, 9, 20, 10)), false)
t('普通工作日 09-24（周四）上午 10 点 → 高峰', isPeakTime(bjDay(2026, 9, 24, 10)), true)
t('节后首个工作日 10-08（周四）上午 10 点 → 高峰', isPeakTime(bjDay(2026, 10, 8, 10)), true)

console.log('\n【⑧ 盗刷判据：分母必须是「本机全部消耗」】')
// ★ 2026-10-02 R-L 事故回归：真实数字取自当天实测。
//   官方 158M；归因到官方口径的 metered 只有 53.9M（1 亿 tok 被串味记成 trae）；
//   本机全部消耗 240.9M（含第三方）。
//   旧实现：158/53.9 = 2.93 > 1.2 ⇒ **假盗刷告警**。
//   新实现：158/240.9 = 0.66 ⇒ 正常（官方用量完全能被本机活动解释，无盗刷）。
const accident = detectUsageAnomaly(158_012_694, 240_965_834, 53_885_404)
t('R-L 事故真实数字 → 不再误报', accident.alert, false)
t('R-L 事故真实数字 → 标记归因存疑', accident.attributionSuspect, true)

// 真盗刷必须仍然报出来：官方 300M 远超本机全部 100M
const realTheft = detectUsageAnomaly(300_000_000, 100_000_000, 50_000_000)
t('真盗刷（官方 300M ≫ 本机全部 100M）→ 报警', realTheft.alert, true)
t('真盗刷 → 不标归因存疑', realTheft.attributionSuspect, false)

// 边界：官方略高于总量但未超 1.2 倍 → 不报
t('官方 110M vs 本机全部 100M（1.1 倍）→ 不报', detectUsageAnomaly(110_000_000, 100_000_000, 50_000_000).alert, false)
// 边界：差值过小（噪声）→ 不报，即使比值高
t('小量高比值（差值 < 5000）→ 不报', detectUsageAnomaly(1200, 1000, 500).alert, false)
// 边界：账本无数据（total=0）→ 不报（属"账本没数据"，不是盗刷）
t('账本为空（total=0）→ 不报（避免除零）', detectUsageAnomaly(1_000_000, 0, 0).alert, false)
// 归因正常（官方 ≤ metered）→ 不标存疑
t('归因正常（官方 ≤ 官方口径量）→ 不标存疑', detectUsageAnomaly(50_000_000, 100_000_000, 60_000_000).attributionSuspect, false)

// ── 第二条误报路径：账本覆盖不全 ─────────────────────────────────────────
// 官方统计的是**整个 API key**；本账本只记「装了本插件的那个实例」。
// 本机实测只有 web profile 装了本插件（desktop/headless/dsh-tui 未装，free2 是独立 DSH_HOME）。
// 这些实例走官方通道时：计入官方、不进本账本 ⇒ 缺口放大到 1.2 倍即误报，路径与本次事故同构。
// 覆盖缺口本身**不该**改变报警判定（那是 detectUsageAnomaly 的事），只由 health.coverage 暴露。
t('覆盖缺口场景（官方 130M vs 账本 100M）→ 仍按判据报警', detectUsageAnomaly(130_000_000, 100_000_000, 90_000_000).alert, true)
t('覆盖缺口场景 → 不误标归因存疑', detectUsageAnomaly(130_000_000, 100_000_000, 90_000_000).attributionSuspect, false)

console.log('\n【⑦ 对账分母口径：只算会扣官方余额的消耗】')
// 黑名单语义（见 countsTowardDeepSeekBalance 注释）：第三方中转/免费通道/本地推理剔除；
// 归因缺失**保守计入**（历史账本 provider 全空，白名单会让分母归零 → 对账失效）。
t('第三方中转 codearts → 不计入', countsTowardDeepSeekBalance('codearts'), false)
t('第三方中转 buddy → 不计入', countsTowardDeepSeekBalance('buddy'), false)
t('第三方中转 trae → 不计入', countsTowardDeepSeekBalance('trae'), false)
t('第三方中转 lobsterai → 不计入', countsTowardDeepSeekBalance('lobsterai'), false)
t('免费网页通道 deepseek-web → 不计入', countsTowardDeepSeekBalance('deepseek-web'), false)
t('本地推理 local-qwen → 不计入', countsTowardDeepSeekBalance('local-qwen'), false)
t('官方路由 deepseek-official → 计入', countsTowardDeepSeekBalance('deepseek-official'), true)
t('归因缺失（历史数据）→ 保守计入', countsTowardDeepSeekBalance(''), true)
t('归因缺失 undefined → 保守计入', countsTowardDeepSeekBalance(undefined), true)

console.log('\n【⑩ 守卫状态显示：降级必须可见（2026-10-02 用户指出后重做）】')
// 背景：原实现让「官方今日 …」在失效时**静默消失**，且 healthAlert 从未被渲染（死代码）
// ⇒ 对账失效完全不可见。这组用例锁住"失效必须自己说出来"。
const gv = (o) => guardView(o)

t('正常：官方用量显示数字', gv({ officialTokens: 267149527 }).officialText, '官方今日 267.15M tok')
t('正常：状态 ok', gv({ officialTokens: 1 }).state, 'ok')
t('正常：标签是静态守卫', gv({}).label, '🛡 守卫')

// 关键回归：失效时**不能留空**（原缺陷）
t('失效(streak=3)：状态 failed', gv({ officialErr: 'network', failStreak: 3 }).state, 'failed')
t('失效(streak=3)：官方格明说不可用（非空！）',
  gv({ officialErr: 'network', failStreak: 3 }).officialText, '官方用量不可用（network）')
t('失效(streak=3)：标签写在脸上',
  gv({ officialErr: 'network', failStreak: 3 }).label, '🛡 守卫·对账已失效')
t('失效(streak=3)：悬停说明含原因与兜底',
  gv({ officialErr: 'network', failStreak: 3 }).title.includes('余额哨兵'), true)

t('不稳(streak=1)：状态 degraded', gv({ officialErr: 'network', failStreak: 1 }).state, 'degraded')
t('不稳(streak=2)：仍未失效（阈值3）', gv({ officialErr: 'network', failStreak: 2 }).state, 'degraded')
t('不稳(streak=3)：刚好失效', gv({ officialErr: 'network', failStreak: 3 }).state, 'failed')

// 未配 token 是"配置缺失"而非"故障"——必须区分，否则用户以为插件坏了
t('未配 token：状态 sentinel-only', gv({ officialErr: 'no-platform-token', failStreak: 9 }).state, 'sentinel-only')
t('未配 token：不算 failed（配置问题非故障）', gv({ officialErr: 'no-platform-token', failStreak: 9 }).state !== 'failed', true)
t('未配 token：标签说明仅哨兵', gv({ officialErr: 'no-platform-token' }).label, '🛡 守卫·仅余额哨兵')
t('未配 token：悬停指引去设置页', gv({ officialErr: 'no-platform-token' }).title.includes('设置'), true)

// 各种故障 err 都要被判为故障（不能漏）
for (const e of ['network', 'shape-changed', 'no-series', 'balance']) {
  t(`故障 err=${e} → failed（streak=3）`, gv({ officialErr: e, failStreak: 3 }).state, 'failed')
}
// 哨兵活着但精确路径没了 ⇒ 仍是 sentinel-only 而非 ok（防假安心）
t('detectionActive=false + 哨兵 ok → 不显示为 ok',
  gv({ sentinelOk: true, detectionActive: false }).state, 'sentinel-only')

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
