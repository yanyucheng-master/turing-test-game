# 图灵测试小游戏 / Turing Test

匿名限时闲聊后，判断对方是真人还是 AI。匹配真人优先；无人则接入 LLM。双方都需做出判断后揭晓。

## 技术栈

- 前端：React 19 + Vite + tRPC client
- 后端：Hono + tRPC（与 Vite 同进程开发）
- 数据：MySQL（仅终局统计，可选）
- 模型：OpenAI 兼容 API（如 DeepSeek）

## 本地运行

```bash
cp .env.example .env
# 填写 DEFAULT_AI_* ；DATABASE_URL 可空（匹配/聊天仍可跑）
npm install
npm run dev
```

打开 `http://127.0.0.1:3000/`。

## 协议要点（防身份泄漏）

揭晓前网络响应**不得**包含 `opponentSource` / `persona` / `llm` / `player`：

| 接口 | 行为 |
|------|------|
| `joinMatch` / `pollMatch` | 匹配；`matched` 仅含 `gameId` 与限额 |
| `chat` | 统一 `ChatAck`，不返回 reply，不 await LLM |
| `events` | 统一拉取对方消息 / 系统提示 / 阶段变化 |
| `finish` | 提交判断；结算结果才含真相 |

真人与 AI 共用同一条消息管线（outbox + `events`）。

## 对话管线（AI）

```
classifyUserAct → emotion → knowledgeBoundary → turnPlan
→ LLM（JSON replyParts）→ styleGuard → timing → outbox
```

人设为 10 个 `SocialPersona` 行为簇，而非履历堆砌。

## 脚本

- `npm run dev` — 开发
- `npm run build` / `npm start` — 生产
- `npm test` — 含协议契约测试
- `npm run check` — TypeScript

## 密钥安全

- API Key **只**放在本机/服务器环境变量或 gitignored 的 `.env`，**永不**写入前端或仓库
- 浏览器与 GitHub 上看不到 Key；服务端日志会脱敏
- `npm run secrets:check` 会扫描已跟踪文件，发现疑似 Key 即失败
- **无法**做到「程序能调 API，但包括你自己在内任何人都绝对无法访问 Key」——运行时进程必须持有 Key。若 Key 曾出现在聊天/截图中，请到服务商控制台**立刻轮换**

## 说明

- 对局状态在单进程内存中；多实例无法共享匹配队列
- 更完整的研究说明见对话中的项目评估文档
