# v1.1.2 Benchmark

## 运行

```text
node scripts/bench.js --suite multi-agent --mode offline
node scripts/bench.js --suite cache --mode replay
node scripts/compare-eval.js --baseline <baseline.json> --current <current.json>
```

`offline` 不需要 Provider Key；报告由固定 seed、离线 mock provider 和固定任务表生成。`online` 在本地 Harness 中只生成配置提示，不会在无密钥的 CI 中阻断构建。Provider Canary 应在具备密钥的环境单独执行。

## Suite

`multi-agent` 固定包含：

- `bug-investigation`
- `security-review`
- `regression-analysis`
- `refactor-planning`
- `partial-failure`
- `cancel-and-resume`
- `queued-scheduling`
- `cache-cold-warm`

`cache` 额外包含 `cache-prefix-invalidation`。

## 报告字段

报告必须包含 `suite`、`task`、`runtimeVersion`、`promptVersion`、`toolsetVersion`、模型、成功率、步骤、工具调用、输入/输出 Token、缓存命中率、节省 Token、费用、p50/p95、队列等待、人机干预、恢复率和错误分类。

## 回归门

比较工具输出 `pass` 和每个指标的 baseline/current/change。默认门禁：成功率下降不超过 `0.05`，输入 Token、费用和 p95 延迟增加不超过 `0.10`。任何预期变化都必须在报告中明确说明。
