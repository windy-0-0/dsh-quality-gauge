/**
 * dsh-quality-gauge — host half.
 *
 * 执行质量评估（Level 1 确定性指标，零额外 LLM 成本，全部为日志纯函数）：
 * 依据 docs/quality-evaluation-research.md 的 L1 方案：
 *   - 工具调用成功率（isError 权威失败标记）
 *   - 失败重试率（同轮失败后同工具再调用）
 *   - 重复调用检测（同轮同工具同参数 ≥2 次）
 *   - 错误循环检测（连续 ≥3 次同工具失败且无成功突破）
 *   - 无进展步（同轮同工具同参数且结果指纹一致 ≥2 次；空结果不判定）
 *   - 每轮步骤数（tool 调用步数）
 * 数据源：会话事件流（turn/start、tool/call、tool/result）。
 * 架构：sessionProjections 投影（可回放、重启不丢）+ HTTP 直读 API（client 轮询）。
 */
import z from 'schemastery'
import { registerJudge, readJudgments, DEFAULT_JUDGE_CONFIG, type JudgeConfig } from './judge.js'

export const name = 'dsh-quality-gauge'

export interface Config extends JudgeConfig {
  // 全部评审配置沿用 judge.ts 的 JudgeConfig（默认见 DEFAULT_JUDGE_CONFIG）
}

export const Config = z.object({
  enabled: z.boolean().default(DEFAULT_JUDGE_CONFIG.enabled),
  judgeProvider: z.string().default(DEFAULT_JUDGE_CONFIG.judgeProvider),
  judgeModel: z.string().default(DEFAULT_JUDGE_CONFIG.judgeModel),
  judgeSamples: z.number().min(1).max(7).default(DEFAULT_JUDGE_CONFIG.judgeSamples),
  judgeTemperature: z.number().min(0).max(1.5).default(DEFAULT_JUDGE_CONFIG.judgeTemperature),
  sampleRate: z.number().min(0).max(1).default(DEFAULT_JUDGE_CONFIG.sampleRate),
  judgeFailTurns: z.boolean().default(DEFAULT_JUDGE_CONFIG.judgeFailTurns),
  judgeTimeoutMs: z.number().min(5000).default(DEFAULT_JUDGE_CONFIG.judgeTimeoutMs),
})

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)

const turnSchema = z.object({
  turn: z.number(),
  toolCalls: z.number(),
  toolSuccess: z.number(),
  toolFail: z.number(),
  retries: z.number(),
  duplicates: z.number(),
  loops: z.number(),
  redundant: z.number(),
  lastTs: z.number(),
  lastMessageId: z.string(),
})

const totalsSchema = z.object({
  toolCalls: z.number(),
  toolSuccess: z.number(),
  toolFail: z.number(),
  retries: z.number(),
  duplicates: z.number(),
  loops: z.number(),
  redundant: z.number(),
})

const stateSchema = z.object({
  turns: z.array(turnSchema),
  totals: totalsSchema,
  currentTurn: z.number(),
  current: z.object({
    toolCalls: z.number(),
    toolSuccess: z.number(),
    toolFail: z.number(),
    retries: z.number(),
    duplicates: z.number(),
    loops: z.number(),
    redundant: z.number(),
    lastFailName: z.string(),
    failStreak: z.number(),
    seenCalls: z.array(z.string()),
    seenFailNames: z.array(z.string()),
    callPairs: z.array(z.array(z.string())),
    lastResultByKey: z.array(z.array(z.string())),
    lastMessageId: z.string(),
  }),
})

type GaugeState = {
  turns: Array<{
    turn: number
    toolCalls: number
    toolSuccess: number
    toolFail: number
    retries: number
    duplicates: number
    loops: number
    redundant: number
    lastTs: number
    lastMessageId: string
  }>
  totals: {
    toolCalls: number
    toolSuccess: number
    toolFail: number
    retries: number
    duplicates: number
    loops: number
    redundant: number
  }
  currentTurn: number
  current: {
    toolCalls: number
    toolSuccess: number
    toolFail: number
    retries: number
    duplicates: number
    loops: number
    redundant: number
    lastFailName: string
    failStreak: number
    seenCalls: string[]
    seenFailNames: string[]
    callPairs: [string, string, string][]
    lastResultByKey: [string, string][]
    lastMessageId: string
  }
}

function emptyCurrent(): GaugeState['current'] {
  return {
    toolCalls: 0, toolSuccess: 0, toolFail: 0, retries: 0, duplicates: 0, loops: 0, redundant: 0,
    lastFailName: '', failStreak: 0, seenCalls: [], seenFailNames: [], callPairs: [], lastResultByKey: [], lastMessageId: '',
  }
}

function init(): GaugeState {
  return {
    turns: [],
    totals: { toolCalls: 0, toolSuccess: 0, toolFail: 0, retries: 0, duplicates: 0, loops: 0, redundant: 0 },
    currentTurn: 0,
    current: emptyCurrent(),
  }
}

function finalizeTurn(state: GaugeState): void {
  const c = state.current
  const existing = state.turns.find((t) => t.turn === state.currentTurn)
  const rec = existing ?? {
    turn: state.currentTurn,
    toolCalls: 0, toolSuccess: 0, toolFail: 0, retries: 0, duplicates: 0, loops: 0, redundant: 0,
    lastTs: 0, lastMessageId: '',
  }
  rec.toolCalls += c.toolCalls
  rec.toolSuccess += c.toolSuccess
  rec.toolFail += c.toolFail
  rec.retries += c.retries
  rec.duplicates += c.duplicates
  rec.loops += c.loops
  rec.redundant += c.redundant
  rec.lastTs = Date.now() / 1000
  rec.lastMessageId = c.lastMessageId || rec.lastMessageId
  if (existing === undefined) state.turns.push(rec)
  if (state.turns.length > 400) state.turns = state.turns.slice(-400)

  state.totals.toolCalls += c.toolCalls
  state.totals.toolSuccess += c.toolSuccess
  state.totals.toolFail += c.toolFail
  state.totals.retries += c.retries
  state.totals.duplicates += c.duplicates
  state.totals.loops += c.loops
  state.totals.redundant += c.redundant

  state.current = emptyCurrent()
}

/** 结果指纹：tool-result 块内文本/结构化内容的紧凑摘要。
 *  空结果返回 ''（不参与无进展判定——状态变更型工具常以空输出确认成功）。 */
function resultFingerprint(blocks: any[]): string {
  try {
    const first: any = blocks && blocks[0]
    const inner: any[] = Array.isArray(first?.content) ? first.content : (Array.isArray(blocks) ? blocks : [])
    const parts: string[] = []
    for (const b of inner) {
      if (typeof b === 'string') { if (b) parts.push(b); continue }
      if (!b || typeof b !== 'object') continue
      if (b.type === 'text' && typeof b.text === 'string' && b.text) parts.push(b.text)
      else { try { parts.push(JSON.stringify(b)) } catch { /* skip */ } }
    }
    const fp = parts.join('\n').trim()
    return fp.length > 0 ? fp.slice(0, 2000) : ''
  } catch {
    return ''
  }
}

function reduceQuality(state: GaugeState, event: any): GaugeState {
  if (event === null || typeof event !== 'object') return state
  const data: any = event.data
  const type: unknown = event.type

  if (type === 'turn/start') {
    if (state.current.toolCalls > 0) finalizeTurn(state)
    if (Number.isInteger(data?.turn)) {
      state.currentTurn = data.turn
    }
    return state
  }

  if (type === 'tool/call') {
    const name = typeof data?.name === 'string' ? data.name : ''
    const argsKey = name + '|' + (typeof data?.arguments === 'string' ? data.arguments : JSON.stringify(data?.arguments ?? {}))
    // 重复调用：同轮同工具同参数再次出现
    if (state.current.seenCalls.includes(argsKey)) state.current.duplicates += 1
    state.current.seenCalls.push(argsKey)
    if (state.current.seenCalls.length > 200) state.current.seenCalls = state.current.seenCalls.slice(-200)
    // 重试：此前该工具失败过（失败记录在 seenFailNames）
    if (state.current.seenFailNames.includes(name)) state.current.retries += 1
    state.current.toolCalls += 1
    const cid = typeof data?.callId === 'string' ? data.callId : ''
    if (cid && name) {
      state.current.callPairs.push([cid, name, argsKey])
      if (state.current.callPairs.length > 200) state.current.callPairs = state.current.callPairs.slice(-200)
    }
    return state
  }

  if (type === 'tool/result') {
    // content[0] 为 { type:'tool-result', toolCallId, content, isError }
    // 注意：tool/result 事件顶层没有 callId，必须从 tool-result 块取
    const blocks: any[] = Array.isArray(data?.message?.content) ? data.message.content : []
    const first: any = blocks[0]
    const isError = first && first.type === 'tool-result' && first.isError === true
    const cid = typeof first?.toolCallId === 'string' ? first.toolCallId
      : (typeof data?.callId === 'string' ? data.callId : '')
    let callName = ''
    let argsKey = ''
    if (cid) {
      for (let i = state.current.callPairs.length - 1; i >= 0; i--) {
        if (state.current.callPairs[i][0] === cid) {
          callName = state.current.callPairs[i][1]
          argsKey = typeof state.current.callPairs[i][2] === 'string' ? state.current.callPairs[i][2] : ''
          break
        }
      }
    }
    // 无进展步：同轮同工具同参数的结果指纹与上一次完全一致 → 可证明的零新信息
    const fp = resultFingerprint(blocks)
    if (argsKey && fp) {
      const prev = state.current.lastResultByKey.find((p) => p[0] === argsKey)
      if (prev !== undefined && prev[1] === fp) state.current.redundant += 1
      state.current.lastResultByKey.push([argsKey, fp])
      if (state.current.lastResultByKey.length > 100) state.current.lastResultByKey = state.current.lastResultByKey.slice(-100)
    }
    if (isError) {
      state.current.toolFail += 1
      state.current.failStreak += 1
      // 错误循环：连续 ≥3 次失败（同工具失败名靠最近失败名近似，跨工具连续失败同样算"停滞"信号）
      if (state.current.failStreak >= 3 && state.current.loops === Math.floor(state.current.failStreak / 3)) {
        // 每 3 次连续失败计一次循环（避免重复计数）
      }
      if (state.current.failStreak >= 3 && (state.current.failStreak % 3 === 0)) {
        state.current.loops += 1
      }
      // 记录失败工具名（精确；关联不到时记未知）
      state.current.lastFailName = callName || '(unknown)'
      state.current.seenFailNames.push(state.current.lastFailName)
      if (state.current.seenFailNames.length > 100) state.current.seenFailNames = state.current.seenFailNames.slice(-100)
    } else {
      state.current.toolSuccess += 1
      state.current.failStreak = 0
    }
    return state
  }

  if (type === 'assistant/message') {
    const mid = data?.message?.id
    if (typeof mid === 'string' && mid) state.current.lastMessageId = mid
    return state
  }

  return state
}

function view(state: GaugeState) {
  const ratio = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 1000 : 0)
  return {
    turns: state.turns.map((t) => ({
      turn: t.turn,
      toolCalls: t.toolCalls,
      toolSuccess: t.toolSuccess,
      toolFail: t.toolFail,
      retries: t.retries,
      duplicates: t.duplicates,
      loops: t.loops,
      redundant: t.redundant,
      noProgressRatio: ratio(t.redundant, t.toolCalls),
      lastMessageId: t.lastMessageId,
    })),
    totals: { ...state.totals, noProgressRatio: ratio(state.totals.redundant, state.totals.toolCalls) },
  }
}

export function apply(ctx: any, config: Config): void {
  registerJudge(ctx, config)
  // HTTP 直读 API（client 轮询）
  const webServer = ctx.get('webServer')
  if (webServer && typeof webServer.register === 'function') {
    ctx.effect(() => {
      const dispose = webServer.register({
        kind: 'prefix',
        path: '/dsh-quality-gauge/api',
        handler: async (req: any, res: any) => {
          const send = (code: number, obj: unknown) => {
            res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify(obj))
          }
          try {
            const u = new URL(req.url ?? '/', 'http://localhost')
            const path = u.pathname.replace(/^\/dsh-quality-gauge\/api/, '') || '/'
            if (req.method === 'GET' && path === '/judgments') {
              const sid = u.searchParams.get('sessionId') ?? undefined
              const mid = u.searchParams.get('messageId') ?? undefined
              return send(200, { ok: true, judgments: readJudgments(sid, mid) })
            }
            if (req.method === 'POST' && path === '/judge') {
              const body = JSON.parse(await new Promise<string>((resolve, reject) => {
                let buf = ''
                req.on('data', (c: Buffer) => { buf += c.toString('utf8') })
                req.on('end', () => resolve(buf))
                req.on('error', reject)
              }))
              const sid = String((body && body.sessionId) || '')
              if (!sid) return send(400, { ok: false, error: 'sessionId required' })
              const fn = (ctx as any).__dshQualityJudge
              if (typeof fn !== 'function') return send(503, { ok: false, error: 'judge not enabled' })
              const result = await fn(sid)
              return send(200, result)
            }
            if (req.method === 'GET' && path === '/status') {
              const sid = u.searchParams.get('sessionId')
              if (!sid) return send(400, { ok: false, error: 'sessionId required' })
              const sessions = ctx.get('sessions')
              const sp = ctx.get('sessionProjections')
              const session = sessions && typeof sessions.list === 'function'
                ? sessions.list().find((s: any) => s && String(s.id) === sid)
                : undefined
              if (!session) return send(404, { ok: false, error: 'session not found' })
              if (!sp || typeof sp.stateOf !== 'function') return send(500, { ok: false, error: 'no projection service' })
              try {
                const state = sp.stateOf(session, 'quality-gauge')
                if (state === undefined) return send(200, { ok: true, data: null })
                return send(200, { ok: true, data: view(state) })
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

  ctx.inject(['sessionProjections'], (projectionCtx: any) => {
    projectionCtx.sessionProjections.register({
      key: 'quality-gauge',
      stateSchema,
      init,
      apply: reduceQuality,
      wire: {
        viewSchema: z.object({
          turns: z.array(z.any()),
          totals: z.object({
            toolCalls: z.number(), toolSuccess: z.number(), toolFail: z.number(),
            retries: z.number(), duplicates: z.number(), loops: z.number(),
            redundant: z.number(), noProgressRatio: z.number(),
          }),
        }),
        view,
      },
      stateVersion: 2,
    })
  })
}
