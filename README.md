# 🛡 dsh-usage-guard

> **DeepSeek API 用量守卫** —— 本地账本与官方用量精确对账，疑似盗刷分钟级发现。

[English](README_EN.md) | 中文

![License](https://img.shields.io/github/license/windy-0-0/dsh-usage-guard?style=flat-square)
![Release](https://img.shields.io/github/v/release/windy-0-0/dsh-usage-guard?style=flat-square)

## 为什么需要它

API Key 被盗刷的真实案例越来越多：key 泄露后，攻击者**绕过 DSH 直接**调用模型 API 消耗你的额度。此时：

- 你在 DSH 里看到的一切都正常；
- 平台账单上额度却在快速蒸发；
- 等你月底发现，损失已经发生。

**dsh-usage-guard 的价值 = 分钟级发现**：把"本机账本"与"官方按 key 用量明细"做**精确对账**——官方记录的 token 明显多于本机 = 有别的进程/设备在用你的 key（疑似盗刷），立即红色告警。

## 工作原理

```
本机账本（跨会话聚合,与 dsh-cost-meter 同口径,append-only 落盘）
      ▲ session/event 事件流
      │
      ├── 每 15 分钟 + 启动时 ──► 官方用量明细（按 key 的 token 桶：缓存命中/未命中/响应）
      │                          └─ 官方 tokens > 本机 × 1.2 且差额 > 5000 ──► 🚨 红色告警
      │
      └── 余额哨兵（未配平台 token 时兜底）──► 余额下降速度远超本机消费 ──► 🚨 告警
```

- 输入框上方守卫状态行：🛡 余额 · 官方今日 tok · 本机 tok/费用 · 对账时间；
- 疑似盗刷时整条变红并提示：**立即到平台吊销并轮换密钥**。

## 能力边界（诚实声明）

| 能做什么 | 不能做什么 |
|---|---|
| ✅ 精确对账：官方 token vs 本机 token（铁证级证据） | ❌ 无法阻止非本机进程直接调用 API（key 一旦泄露，平台侧没有任何 IP 白名单） |
| ✅ 余额哨兵：降幅异常告警 | ❌ 无法回收已泄露的 key |
| ✅ 全自动：15 分钟周期 + 启动即检 | ❌ 无法监控别的电脑（对账是事后发现，不是事前拦截） |

**彻底消除盗刷的正道**（配合本插件）：

1. **换新 key**（旧 key 视作已泄露）；
2. 在 DeepSeek 平台设置**额度上限/告警**；
3. 本机凭据保护（dsh-safety 已保护 credentials 文件）——见你的加固清单；
4. 开着 dsh-usage-guard：万一再次泄露，**15 分钟内**你就会看到红色告警，而不是月底才发现。

## 安装

```bash
npm install dsh-usage-guard
# 加入 profile bundles 重启；或 dsh-super-injector 热装配（dev_inject_plugin）
```

### 配置凭据（对账数据源）

- `DEEPSEEK_API_KEY`：余额哨兵用（DSH 模型设置里已配置的 API key）；
- `DEEPSEEK_PLATFORM_TOKEN`（推荐）：**平台 token**——精确对账必需。在 DeepSeek 开放平台创建平台 token 后，加入 DSH 凭据（名称必须为 `DEEPSEEK_PLATFORM_TOKEN`）。未配置时自动降级为余额哨兵模式。

## Roadmap

- [x] v0.1 本地账本 + 官方精确对账 + 余额哨兵 + 告警 UI
- [ ] 告警历史与趋势面板
- [ ] 多 key 支持

## License

BSD-3-Clause
