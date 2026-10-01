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
import { classifyOfficialFailure, detectBalanceAnomaly, primaryFailureStreak, isFreeProvider, priceFor, isPeakTime, countsTowardDeepSeekBalance }
  from '../lib/index.js'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readTailLines, rotateIfLarge } from '../lib/index.js'

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

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
