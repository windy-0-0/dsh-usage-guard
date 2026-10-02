/**
 * dsh-usage-guard — client half.
 * 展示点：输入框上方守卫状态行（conversation.input.dock）：
 *   🟢 正常（余额 / 本机累计 / 对账时间）
 *   🔴 疑似非本机消耗（官方用量明显多于本地账本）——提示去平台吊销/轮换密钥
 * 数据来自 host API /dsh-usage-guard/api/status（30 秒轮询）。
 */
import * as React from 'react'
import { guardView, fmtTokens } from '../guard-view.js'

export const inject = ['slots']

const SEC = 'var(--dsw-alias-label-secondary, #888)'
const DANGER = 'var(--dsw-alias-state-error-primary, #d54941)'
const WARN = 'var(--dsw-alias-state-warning-primary, #d28b1f)'

interface GuardStatus {
  ok?: boolean
  checkedAt?: string
  local?: { tokens: number; costCny: number }
  official?: { tokens?: number; costCny?: number; err?: string; detail?: string | null }
  balance?: { value: number; currency: string } | null
  alert?: string | null
  detail?: string | null
  /** 两条检测路径各自是否真的在工作（2026-10-01 新增）。 */
  health?: {
    primary: string
    primaryDetail?: string | null
    primaryFailStreak?: number
    sentinel: string
    detectionActive?: boolean
  }
  /** 精确路径长期失效时置位——把"静默退化"变成看得见的告警。 */
  healthAlert?: string | null
}

function GuardBadge(): React.ReactElement | null {
  const [status, setStatus] = React.useState<GuardStatus | null>(null)

  React.useEffect(() => {
    let alive = true
    const poll = () => {
      fetch('/dsh-usage-guard/api/status')
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => { if (alive && d) setStatus(d as GuardStatus) })
        .catch(() => {})
    }
    poll()
    const id = setInterval(poll, 30000)
    return () => { alive = false; clearInterval(id) }
  }, [])

  if (status === null) return null

  if (status.alert === 'suspicious-external-usage') {
    return React.createElement(
      'div',
      {
        role: 'alert',
        style: {
          display: 'flex', alignItems: 'center', gap: '8px',
          padding: '6px 12px', margin: '4px 6px 0',
          borderRadius: '8px',
          border: '1px solid ' + DANGER,
          background: 'color-mix(in srgb, ' + DANGER + ' 10%, transparent)',
          color: 'var(--dsw-alias-label-primary, #333)',
          fontSize: '12.5px', lineHeight: 1.5,
        },
        title: String(status.detail ?? ''),
      },
      React.createElement('span', null,
        '🚨 疑似非本机消耗：官方用量 ' + fmtTokens(status.official?.tokens ?? 0) +
        ' tok，本机账本仅 ' + fmtTokens(status.local?.tokens ?? 0) +
        ' tok——你的 API Key 可能已被盗用，请立即到平台吊销并轮换密钥。'),
    )
  }

  // ── 能力状态：降级必须**自己说出来**，而不是让文字悄悄消失 ────────────────
  //
  // ★ 2026-10-02 重做（用户指出：原"⚠️ 精确对账不可用"横幅**意义不明且常驻**，
  //   因此毫无提示效果——问题不在"该不该显示"，而在**这个设计本身是坏的**）。
  //
  // 原设计的两个硬伤：
  //   1. 它是**常驻横幅**：只要官方 token 没配好就永远挂在那里 ⇒ 用户很快对它视而不见，
  //      真正的失效反而被淹没（"狼来了"）。
  //   2. 它是**静态文案**：`healthAlert` 在接口里声明、host 端也算出来了，但渲染代码
  //      从未使用 ⇒ **死代码**。官方接口挂掉时，UI 只是让「官方今日 …」那一小段**静默消失**，
  //      整行照常显示 ⇒ 用户完全看不出对账能力已经失效。
  //
  // 新设计：状态判定抽成纯函数 `guardView`（可脱机自测），"守卫"本身即状态指示器，
  // 失效时自己变色+说原因，且**只在真的失效时**才出现文字——不再常驻。
  const view = guardView({
    officialErr: status.official?.err,
    failStreak: status.health?.primaryFailStreak,
    sentinelOk: status.health?.sentinel === 'ok',
    detectionActive: status.health?.detectionActive,
    primaryDetail: status.health?.primaryDetail,
    officialTokens: typeof status.official?.tokens === 'number' ? status.official.tokens : 0,
  })
  const failed = view.state === 'failed'
  const guardLabel = view.label
  const guardTitle = view.title
  const guardColor = view.state === 'failed' ? DANGER
    : view.state === 'ok' ? SEC : WARN

  const err = status.official?.err
  const isNoToken = err === 'no-platform-token'
  const balanceText = status.balance
    ? `余额 ¥${status.balance.value.toFixed(2)}`
    : (isNoToken ? '未配平台 token（仅余额哨兵）' : '余额不可用')
  const officialText = view.officialText
  const localText = `本机 ${fmtTokens(status.local?.tokens ?? 0)} tok · ¥${(status.local?.costCny ?? 0).toFixed(4)}`
  const checked = status.checkedAt ? new Date(status.checkedAt) : null
  const checkedText = checked === null ? '' : `对账 ${String(checked.getHours()).padStart(2, '0')}:${String(checked.getMinutes()).padStart(2, '0')}`

  return React.createElement(
    'div',
    {
      style: {
        display: 'flex', alignItems: 'center', gap: '10px',
        fontSize: '11px', color: SEC, padding: '1px 6px 0', userSelect: 'none',
      },
      title: guardTitle,
    },
    // 「守卫」本身即状态指示器：失效时变色并把原因写在脸上（不再常驻静态文案）。
    React.createElement('span', {
      style: { color: guardColor, fontWeight: failed ? 600 : 400 },
    }, guardLabel),
    React.createElement('span', null, balanceText),
    // 失效时明确标红，避免"文字静默消失"造成的假安心。
    officialText
      ? React.createElement('span', failed ? { style: { color: DANGER } } : null, officialText)
      : null,
    React.createElement('span', null, localText),
    checkedText ? React.createElement('span', null, checkedText) : null,
  )
}

/** 设置页：配置 DeepSeek 平台 token（精确对账凭据） */
function SettingsPage(): React.ReactElement {
  const [configured, setConfigured] = React.useState<boolean | null>(null)
  const [value, setValue] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [msg, setMsg] = React.useState<string | null>(null)

  React.useEffect(() => {
    fetch('/dsh-usage-guard/api/cred-status')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d) setConfigured(Boolean(d.configured)) })
      .catch(() => {})
  }, [])

  const save = () => {
    if (!value.trim() || busy) return
    setBusy(true)
    setMsg(null)
    fetch('/dsh-usage-guard/api/cred', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: value.trim() }),
    })
      .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        setBusy(false)
        if (ok && d.ok) { setConfigured(true); setValue(''); setMsg('✅ 已保存，精确对账已启用') }
        else setMsg('❌ 保存失败：' + String((d && d.error) || '未知错误'))
      })
      .catch(() => { setBusy(false); setMsg('❌ 网络错误') })
  }

  return React.createElement(
    'div',
    { style: { padding: '12px 4px', maxWidth: 640 } },
    React.createElement('h3', null, 'DeepSeek 平台 token'),
    React.createElement('p', { style: { fontSize: 13, color: 'var(--dsw-alias-label-secondary, #888)', lineHeight: 1.7 } },
      '用于官方用量精确对账（官方记录的 token 明显多于本机账本时红色告警）。' +
      '到 DeepSeek 开放平台创建平台 token 后粘贴到下面。'),
    configured === true
      ? React.createElement('p', { style: { fontSize: 13, color: 'var(--dsw-alias-state-success-primary, #2e9e5b)' } },
          '当前状态：已配置 ✅（值不回显；如已轮换请重新粘贴覆盖）')
      : configured === false
        ? React.createElement('p', { style: { fontSize: 13, color: 'var(--dsw-alias-state-warn-primary, #b8860b)' } },
            '当前状态：未配置——精确对账未启用，仅余额哨兵模式。')
        : null,
    React.createElement('input', {
      type: 'password',
      value,
      placeholder: '粘贴平台 token',
      onChange: (e: React.ChangeEvent<HTMLInputElement>) => setValue(e.target.value),
      style: {
        width: '100%', padding: '8px 10px', borderRadius: '6px',
        border: '1px solid var(--dsw-alias-border-l2, #999)',
        background: 'transparent', color: 'var(--dsw-alias-label-primary, #333)',
        fontSize: 13, marginBottom: 10,
      },
    }),
    React.createElement('button', {
      type: 'button',
      onClick: save,
      disabled: busy || !value.trim(),
      style: {
        padding: '7px 16px', borderRadius: '6px', cursor: 'pointer', fontSize: 13,
        border: '1px solid var(--dsw-alias-border-l2, #999)',
        background: 'transparent', color: 'var(--dsw-alias-label-primary, #333)',
      },
    }, busy ? '保存中…' : '保存'),
    msg ? React.createElement('p', { style: { fontSize: 13, marginTop: 10 } }, msg) : null,
  )
}

export function apply(ctx: any): void {
  ctx.effect(() => ctx.slots.inject('conversation.input.dock', () =>
    ctx.slots.register({ name: "conversation.input.dock", id: "dsh-usage-guard", order: 38, label: () => "用量守卫" }, GuardBadge),
  ), 'dsh-usage-guard: status line')
  ctx.effect(() => ctx.slots.inject('settings.section', () =>
    ctx.slots.register({ name: "settings.section", id: "usage-guard", order: 90, label: () => "用量守卫" }, SettingsPage),
  ), 'dsh-usage-guard: settings page')
}
