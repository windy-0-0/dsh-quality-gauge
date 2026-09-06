# 🎯 dsh-quality-gauge

> **DSH 执行质量评估（L1 确定性指标）** —— 每轮与会话的工具执行质量，零额外 LLM 成本。

![License](https://img.shields.io/github/license/windy-0-0/dsh-quality-gauge?style=flat-square)

## 指标（全部为日志纯函数，可回放、可复现、抗提示注入）

| 指标 | 定义 | 依据 |
|---|---|---|
| 工具调用成功率 | 成功数 / 总调用数（`isError` 权威失败标记） | SWE-bench 式程序化判定 |
| 失败重试 | 失败后同工具再次调用 | ToolEmu 风险维度 |
| 重复调用 | 同轮同工具同参数 ≥2 次 | 过程质量信号 |
| 错误循环 | 连续 ≥3 次失败（每 3 次计 1） | AgentBoard progress-rate 反面 |
| 每轮步骤数 | 工具调用步数 | AgentBench 轨迹惯例 |

## 展示

- **每条回答动作行**：`🛠 3✓/0✗ · 重试 1 · 循环 0`（失败/循环红色告警）
- **会话标题行**：`🛠 95% · 循环 1` 累计徽章
- **输入框上方**：上一轮执行简报

## 设计依据

[docs/quality-evaluation-research.md](docs/quality-evaluation-research.md) —— 36 篇权威文献调研（LLM-as-a-judge 偏差协议、SWE-bench/WebArena/τ-bench 程序化验证金标准、AgentBoard 进展率、防注入要求）。

## 安装

```bash
npm install dsh-quality-gauge
# 加入 profile bundles 重启；或 dsh-super-injector 热装配
```

## Roadmap

- [x] v0.1 L1 确定性指标（成功率/重试/重复/循环）+ 每轮与会话展示
- [ ] 无进展步占比（状态 diff 判定）
- [ ] L2 按需 LLM-judge（rubric + 多采样 + 防偏差协议）

## License

BSD-3-Clause

## L2 按需评分（v0.2）

- **触发**：L1 失败/循环轮自动触发（可关）+ 可配随机采样（默认关，成本优先）+ 手动 API
- **协议**：六维 rubric（正确性/有用性/相关性/简洁性/指令遵循/格式）冻结 v1；n=3 采样（temp 0.7）报告 mean±std；std>2 标低置信；评委默认 `deepseek-v4-flash`（与被评模型分离）；被评内容置于分隔符内声明为不可信数据（防注入）；冗长不得加分
- **成本**：仅触发时调用；评委费用自动计入 dsh-cost-meter / dsh-usage-guard 账本
