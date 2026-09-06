/**
 * dsh-usage-guard — client half.
 * 展示点：输入框上方守卫状态行（conversation.input.dock）：
 *   🟢 正常（余额 / 本机累计 / 对账时间）
 *   🔴 疑似非本机消耗（官方用量明显多于本地账本）——提示去平台吊销/轮换密钥
 * 数据来自 host API /dsh-usage-guard/api/status（30 秒轮询）。
 */
import * as React from 'react'

export const inject = ['slots']

const SEC = 'var(--dsw-alias-label-secondary, #888)'
const DANGER = 'var(--dsw-alias-state-error-primary, #d54941)'

interface GuardStatus {
  ok?: boolean
  checkedAt?: string
  local?: { tokens: number; costCny: number }
  official?: { tokens?: number; costCny?: number; err?: string }
  balance?: { value: number; currency: string } | null
  alert?: string | null
  detail?: string | null
}

function fmtTokens(n: number): string {
  if (!Number.isFinite(n)) return '0'
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k'
  return String(Math.round(n))
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

  const balanceText = status.balance
    ? `余额 ¥${status.balance.value.toFixed(2)}`
    : (status.official?.err === 'no-platform-token' ? '未配平台 token（仅余额哨兵）' : '余额不可用')
  const officialText = status.official?.err === undefined
    ? `官方今日 ${fmtTokens(status.official.tokens ?? 0)} tok`
    : (status.official?.err === 'no-platform-token' ? '' : '官方用量不可用')
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
      title: 'dsh-usage-guard：本地账本与 DeepSeek 官方用量对账（每 15 分钟自动核对）',
    },
    React.createElement('span', null, '🛡 守卫'),
    React.createElement('span', null, balanceText),
    officialText ? React.createElement('span', null, officialText) : null,
    React.createElement('span', null, localText),
    checkedText ? React.createElement('span', null, checkedText) : null,
  )
}

export function apply(ctx: any): void {
  ctx.effect(() => ctx.slots.inject('conversation.input.dock', () =>
    ctx.slots.register({ name: "conversation.input.dock", id: "dsh-usage-guard", order: 38, label: () => "用量守卫" }, GuardBadge),
  ), 'dsh-usage-guard: status line')
}
