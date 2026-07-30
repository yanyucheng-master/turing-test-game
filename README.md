# 图灵测试小游戏 / Turing Test

匿名限时闲聊后，判断对方是真人还是 AI。匹配真人优先；无人则接入 LLM。双方都需做出判断后揭晓。

## 技术栈

- 前端：React 19 + Vite + tRPC client
- 后端：Hono + tRPC（与 Vite 同进程开发）
- 数据：MySQL（终局统计与跨重启文化记忆，可选）
- 模型：OpenAI 兼容 API（如 DeepSeek）

## 本地运行

```bash
cp .env.example .env
# 填写 DEFAULT_AI_* ；DATABASE_URL 可空（匹配/聊天/结算仍可跑，仅无持久统计）
npm install
npm run dev
```

打开 `http://127.0.0.1:3000/`。

## 匹配规则

- 独立随机 AI 入局时间：0–7 秒
- 独立随机真人冷匹配时间：0–2 秒
- 真人窗口为 `[冷匹配结束, AI 入局时间)`；边界相等时 AI 优先
- 双方真人窗口重叠时立即按 FIFO 撮合，否则 AI 到点入局

## 协议要点（防身份泄漏）

揭晓前网络响应**不得**包含 `opponentSource` / `persona` / `llm` / `player`：

| 接口                      | 行为                                       |
| ------------------------- | ------------------------------------------ |
| `joinMatch` / `pollMatch` | 匹配；`matched` 仅含 `gameId` 与限额       |
| `chat`                    | 统一 `ChatAck`，不返回 reply，不 await LLM |
| `events`                  | 统一拉取对方消息 / 系统提示 / 阶段变化     |
| `finish`                  | 提交判断；结算结果才含真相                 |

真人与 AI 共用同一条消息管线（outbox + `events`）。

## 对话管线（AI）

```
classifyUserAct → emotion → knowledgeBoundary → turnPlan
→ LLM（JSON replyParts）→ styleGuard → timing → outbox
```

人设为 10 个 `SocialPersona` 行为簇，而非履历堆砌。

## 严格文化学习

- 观察 PVP 与 AI 对局中的玩家侧消息；AI 对局也可学习真人回复
- PVP 回复以及对已知文化片段的 AI 局回复，只学习抽象反应方式
- 少于 3 个独立匿名来源时，只保存规范化文本的不可逆指纹
- 达到 3 个来源后，脱敏表达进入隔离区，不能被游戏中的 AI 读取
- 隔离表达会发送给所配置的 AI 服务进行语义审核
- 独立 AI 审核器按安全、隐私、泛化、趣味、证据、新颖度评分
- 隐私、提示词注入等高风险项一票否决；总分低于 60 自动废弃
- 达到 60 分只进入每日学习报告，仍不会自动成为 AI 记忆
- 只有所有者通过本机管理员伴侣批准后，才写入正式记忆
- 人工改写内容会再次经过 AI 安全复审，并标记为 `curated`
- 真人回复只学习抽象反应方式，不保存回复原文
- 过滤联系方式、长标识符、秘密、提示词注入和高风险内容
- 活跃文化片段 30 天过期；搞怪开场白需至少 5 个来源并单独批准
- AI 审核失败时保持隔离，可在审核页手动重试，不会降级为自动通过
- Render 与本机管理员伴侣共享 24 位以上的 `CULTURE_REVIEW_TOKEN`
- 管理密钥仅由本机 Node 代理附加，不进入浏览器、玩家构建或 Git 仓库
- 公网玩家构建不包含管理员页面；公网 `/culture-review` 固定返回 404
- 可用 `CULTURE_REVIEW_MODEL` 指定独立审核模型；不填则使用默认模型
- 未配置数据库时，候选、报告和记忆仅存在于当前进程；跨重启持久化需
  同时配置 `DATABASE_URL` 与 `CULTURE_LEARNING_SALT`

数据库升级后运行：

```bash
npm run db:migrate
```

### 本机管理员伴侣

1. 双击 `打开管理员审核.cmd`。首次运行会创建并打开
   `.env.admin.local`，并在本机自动生成 64 位随机密钥。
2. 将 `ADMIN_REMOTE_URL` 改成 Render 公网根地址，并把自动生成的
   `CULTURE_REVIEW_TOKEN` 复制到 Render 服务环境变量后重新部署。
3. 再次双击启动器；浏览器会自动打开 `http://127.0.0.1:3001`。

本机伴侣只监听 `127.0.0.1`，并仅代理固定的五个审核过程。公网玩家端既
没有审核路由，也不会收到管理员前端资源。关闭启动器窗口即可停止本机入口。

## 脚本

- `npm run dev` — 开发
- `npm run build` / `npm start` — 生产
- `npm run build:admin` — 构建本机管理员伴侣
- `npm run admin` — 启动本机管理员伴侣
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
