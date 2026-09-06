/**
 * dsh-quality-gauge — client half.
 * 数据：HTTP 轮询 host 直读 API /dsh-quality-gauge/api/status?sessionId=...
 * 展示点：
 *   1. 每条回答动作行（assistant-actions, id dsh-quality-turn）本轮执行质量：
 *      🛠 3✓/0✗ · 重试1 · 循环0（有失败/循环时红色告警）
 *   2. 会话标题行（header.utilities, id dsh-quality-total）累计：成功率与循环数
 */
import * as React from 'react'

export const inject = ['slots']

const SEC = 'var(--dsw-alias-label-secondary, #888)'
const DANGER = 'var(--dsw-alias-state-error-primary, #d54941)'
const OK = 'var(--dsw-alias-state-success-primary, #2e9e5b)'

interface TurnRec {
  turn: number
  toolCalls: number
  toolSuccess: number
  toolFail: number
  retries: number
  duplicates: number
  loops: number
  lastMessageId: string
}

interface QualityView {
  turns: TurnRec[]
  totals: { toolCalls: number; toolSuccess: number; toolFail: number; retries: number; duplicates: number; loops: number }
}

function useQualityView(sessionId: string | undefined, intervalMs: number): QualityView | null {
  const [data, setData] = React.useState<QualityView | null>(null)
  React.useEffect(() => {
    if (sessionId === undefined || sessionId === null || sessionId === '') { setData(null); return }
    let alive = true
    const poll = () => {
      fetch('/dsh-quality-gauge/api/status?sessionId=' + encodeURIComponent(String(sessionId)))
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (alive && d && d.ok && d.data) setData(d.data as QualityView)
          else if (alive && d && d.ok && d.data === null) setData(null)
        })
        .catch(() => {})
    }
    poll()
    const id = setInterval(poll, intervalMs)
    return () => { alive = false; clearInterval(id) }
  }, [sessionId, intervalMs])
  return data
}

function TurnQuality(props: { messageId?: unknown; sessionId?: string }): React.ReactElement | null {
  const view = useQualityView(props.sessionId, 3000)
  if (view === null) return null
  const rec = view.turns.find((t) => t.lastMessageId !== '' && t.lastMessageId === props.messageId)
  if (rec === undefined || !Number.isFinite(rec.toolCalls) || rec.toolCalls <= 0) return null
  const color = rec.loops > 0 || rec.toolFail > 0 ? DANGER : SEC
  return React.createElement(
    'div',
    {
      style: { display: 'flex', alignItems: 'center', gap: '10px', fontSize: '11px', lineHeight: 1, color, padding: '0 2px', userSelect: 'none' },
      title: `本轮工具调用 ${rec.toolCalls} · 成功 ${rec.toolSuccess} · 失败 ${rec.toolFail} · 重试 ${rec.retries} · 重复 ${rec.duplicates} · 错误循环 ${rec.loops}`,
    },
    React.createElement('span', null, `🛠 ${rec.toolSuccess}✓/${rec.toolFail}✗`),
    rec.retries > 0 ? React.createElement('span', null, `重试 ${rec.retries}`) : null,
    rec.loops > 0 ? React.createElement('span', { style: { fontWeight: 600 } }, `循环 ${rec.loops}`) : null,
  )
}

function TotalQuality(props: { sessionId?: string }): React.ReactElement | null {
  const view = useQualityView(props.sessionId, 3000)
  const totals = view?.totals
  if (totals === undefined || !Number.isFinite(totals.toolCalls) || totals.toolCalls <= 0) return null
  const successRate = totals.toolCalls > 0 ? (totals.toolSuccess / totals.toolCalls) * 100 : 0
  const color = totals.loops > 0 || totals.toolFail > 0 ? DANGER : OK
  return React.createElement(
    'span',
    {
      style: { fontSize: '11.5px', color, userSelect: 'none', whiteSpace: 'nowrap' },
      title: `工具调用 ${totals.toolCalls} · 成功 ${totals.toolSuccess} · 失败 ${totals.toolFail} · 重试 ${totals.retries} · 重复 ${totals.duplicates} · 错误循环 ${totals.loops}`,
    },
    `🛠 ${successRate.toFixed(0)}% · 循环 ${totals.loops}`,
  )
}

/** 每轮质量小条：挂在输入 dock（全宽，随轮次更新显示最近轮） */
function LatestTurnQuality(props: { sessionId?: string }): React.ReactElement | null {
  const view = useQualityView(props.sessionId, 2000)
  const turns = view?.turns
  if (!turns || turns.length === 0) return null
  const last = turns[turns.length - 1]
  if (last === undefined || last.toolCalls <= 0) return null
  const color = last.loops > 0 || last.toolFail > 0 ? DANGER : SEC
  return React.createElement(
    'div',
    {
      style: {
        display: 'flex', alignItems: 'center', gap: '8px',
        fontSize: '11px', color, padding: '1px 6px 0', userSelect: 'none',
      },
      title: `上一轮工具调用 ${last.toolCalls} · 成功 ${last.toolSuccess} · 失败 ${last.toolFail} · 重试 ${last.retries} · 重复 ${last.duplicates} · 错误循环 ${last.loops}`,
    },
    React.createElement('span', null, `🛠 上轮 ${last.toolSuccess}✓/${last.toolFail}✗ · 重试 ${last.retries} · 循环 ${last.loops}`),
  )
}

export function apply(ctx: any): void {
  ctx.effect(() => ctx.slots.inject('conversation.chat.assistant-actions', () =>
    ctx.slots.register({ name: "conversation.chat.assistant-actions", id: "dsh-quality-turn", order: 41, label: () => "执行质量" }, TurnQuality),
  ), 'dsh-quality-gauge: turn quality')
  ctx.effect(() => ctx.slots.inject('conversation.session.header.utilities', () =>
    ctx.slots.register({ name: "conversation.session.header.utilities", id: "dsh-quality-total", order: 61, label: () => "执行质量" }, TotalQuality),
  ), 'dsh-quality-gauge: header total')
  ctx.effect(() => ctx.slots.inject('conversation.input.dock', () =>
    ctx.slots.register({ name: "conversation.input.dock", id: "dsh-quality-latest", order: 36, label: () => "执行质量" }, LatestTurnQuality),
  ), 'dsh-quality-gauge: latest turn')
}
