# 🎯 dsh-quality-gauge

> **Execution-quality evaluation for DSH agents (L1 deterministic metrics)** — per-turn and per-session tool-execution quality with **zero extra LLM cost**.

![License](https://img.shields.io/github/license/windy-0-0/dsh-quality-gauge?style=flat-square)

[English](README_EN.md) | [中文](README.md)

## Metrics (pure functions of the session log — replayable, reproducible, injection-proof)

| Metric | Definition | Grounding |
|---|---|---|
| Tool success rate | successes / total calls (authoritative `isError` flag) | SWE-bench-style programmatic verification |
| Failure retries | same tool re-invoked after a failure | ToolEmu risk dimension |
| Duplicate calls | same tool + same arguments ≥ 2 times in one turn | process-quality signal |
| **No-progress steps** | same tool + same arguments **and byte-identical result fingerprint** ≥ 2 times in one turn (provably zero new information; empty results are never judged — state-changing tools often confirm with empty output) | AgentBoard progress rate (inverse) |
| Error loops | ≥ 3 consecutive failures (1 per 3) | AgentBoard progress-rate (inverse) |
| Steps per turn | number of tool invocations | AgentBench trajectory convention |

All counters are computed from `turn/start`, `tool/call`, and `tool/result` events via a `sessionProjections` projection (stateVersion 2), so they replay over the full session log and survive restarts.

## On-demand L2 judge (v0.2+)

- **Triggers**: automatically for L1 failure/loop turns (configurable) + optional random sampling (off by default, cost-first) + manual API
- **Protocol**: frozen six-dimension rubric v1 (correctness / helpfulness / relevance / conciseness / instruction-following / format); n=3 samples (temp 0.7) reported as mean±std; std>2 flagged low-confidence; judge defaults to `deepseek-v4-flash` (separated from the evaluated model); evaluated content is wrapped in delimiters and declared untrusted data (anti-injection); verbosity never earns points
- **Cost**: judge calls only on trigger; judge spend flows into dsh-cost-meter / dsh-usage-guard ledgers

## Display

- **Per answer (assistant actions row)**: `🛠 3✓/0✗ · 重试 1 · 无进展 2 · 循环 0` (red alert on failures/loops; amber on no-progress)
- **Session header**: `🛠 95% · 循环 1` cumulative badge (hover for the full breakdown incl. no-progress ratio)
- **Above the input**: last-turn brief

## HTTP API

- `GET /dsh-quality-gauge/api/status?sessionId=…` — L1 view (`turns`, `totals` incl. `redundant` and `noProgressRatio`)
- `GET /dsh-quality-gauge/api/judgments?sessionId=…&messageId=…` — L2 judgments
- `POST /dsh-quality-gauge/api/judge` `{"sessionId": "…"}` — manual L2 judgment for the latest assistant message (historical warm-up included)

## Design rationale

[docs/quality-evaluation-research.md](docs/quality-evaluation-research.md) — 36-reference literature survey (LLM-as-a-judge bias protocols, SWE-bench/WebArena/τ-bench programmatic verification gold standards, AgentBoard progress rate, anti-injection requirements).

## Install

```bash
npm install dsh-quality-gauge
# add to profile bundles and restart; or hot-assemble with dsh-super-injector
```

## Roadmap

- [x] v0.1 L1 deterministic metrics (success/retry/duplicate/loop) + per-turn and session display
- [x] v0.2 L2 on-demand LLM judge (rubric + multi-sample + anti-bias protocol)
- [x] v0.3 no-progress step ratio (same-args same-result fingerprint)
- [ ] Human calibration set (κ regression against L2 scores)

## License

BSD-3-Clause
