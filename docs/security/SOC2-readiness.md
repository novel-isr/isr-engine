# SOC 2 Readiness — 诚实评估

## 为什么 SOC 2 不是「写代码」可以实现的

SOC 2 是 **AICPA 制定的合规框架** + **CPA 审计师**出具的认证报告，**不是软件功能**。它衡量的是「公司」是否有足够的流程来保护客户数据，不是「框架」的特性。

| 阶段 | 谁做 | 时间 | 我们这里能做的 |
|------|------|------|---------------|
| 1. Type I 准备 | 公司 IT/Security 团队 | 1-3 月 | 文档模板（本目录已交付） |
| 2. Type I 审计 | 外部 CPA 审计师（Deloitte / EY / 等） | 4-6 周 | 配合审计 |
| 3. Type II 评估期 | 公司持续运营 + 收集证据 | **6-12 月** | 框架只是其中工具之一 |
| 4. Type II 审计 | 外部 CPA 审计师 | 6-8 周 | 配合审计 |
| 5. 报告签发 | CPA 签字 | - | 拿报告对外销售 |

## 框架（isr-engine）能贡献的部分

下列 5 个 Trust Service Criteria 里，**框架可以提供的「证据来源」**：

### Security（安全性）

| 控制点 | 要求 | 框架已提供 | 文件 |
|--------|------|-----------|------|
| 访问审计日志 | 谁访问了什么、什么时候 | ✅ `X-Trace-Id` 自动注入 | `src/defaults/runtime/defineServerEntry.tsx:90` |
| 漏洞扫描 | 依赖定期 audit | ⚠️ 需额外接入 `pnpm audit` / Dependabot / SCA 平台 | 当前仓库未内建 |
| 安全 HTTP 头 | CSP / HSTS / X-Frame-Options 等 | ✅ helmet + 严格 CSP | `src/server/middleware.ts:29-46` |
| TLS 加密传输 | HTTPS 强制 | ⚠️ 由 Nginx/CDN 层提供 | engine 不管 |
| 输入验证 | 防 XSS / SQL injection | ⚠️ 业务层职责 | engine 仅在 SEO 注入做 HTML escape |

### Availability（可用性）

| 控制点 | 要求 | 框架已提供 |
|--------|------|-----------|
| 优雅关闭 | SIGTERM 处理，不丢请求 | ✅ `cli/start.ts:170-200` |
| 健康检查 | `/health` 端点 | ✅ |
| 性能监控 | Prometheus 指标 | ✅ `/metrics` 端点 |
| SLO 度量 | 量化可用性 | ⚠️ 需要业务团队跟踪 |

### Confidentiality（保密性）

| 控制点 | 要求 | 框架已提供 |
|--------|------|-----------|
| 敏感数据不入日志 | trace-id 不带 PII | ✅ `genTraceId()` 用 base36+random，无 PII |
| 错误堆栈不泄漏 | 5xx 响应只给 generic message | ✅ csr-shell 静态降级页 |

### Processing Integrity（处理完整性）

| 控制点 | 要求 | 框架已提供 |
|--------|------|-----------|
| 请求-响应一致性 | 一个请求 → 一个响应 + 状态码 | ✅ Express 标准 |
| 缓存一致性 | revalidate 后 next request MISS | ✅ tag/path invalidator |

### Privacy（隐私）

| 控制点 | 要求 | 框架已提供 |
|--------|------|-----------|
| GDPR cookie 同意 | 内置 banner | ❌ 业务层职责 |
| Google Fonts 自托管 | 避免第三方 IP 收集 | ✅ `createFontPlugin({ google: [...] })` |
| Sentry 数据脱敏 | beforeSend 过滤 PII | ⚠️ 用户在 Sentry.init 配 |

## 行动清单 — 公司层面（框架管不到）

- [ ] 任命 Security Officer / DPO
- [ ] 制定信息安全政策（密码、设备、远程办公）
- [ ] 选审计师（Big Four 或专业 SOC2 firm）
- [ ] 接入合规 SaaS（Vanta / Drata / Secureframe）—— 自动收集证据
- [ ] 6 月评估期内持续运营 + 收集证据
- [ ] 培训全员（access review / incident response 演练）
- [ ] 与审计师走 Type I → Type II 流程
- [ ] 拿到报告（90+ 页 PDF），对外销售

## 结论

**SOC 2 不能"立刻实现"** —— 不存在「写一个 SOC2 模块」这种事。我能做的是把框架侧的可观测性 / 安全头 / 优雅关闭这些基础能力收口好，减少你们补控制项的成本。剩下的仍然是公司流程 + 6+ 月运营 + 审计师的事。
