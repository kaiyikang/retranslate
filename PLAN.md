# retranslate — 设计共识

> 来源：`requirement` 草稿 + 2026-10-30 grilling 会话。状态：**已实现（2026-10-31），尚未部署**。

## 定位
DeepL 简化版，单页面、快。典型场景：游戏中 Cmd+Tab 切过来 → 粘贴 → 看译文 → 切回去。

## 架构
- **一个 Cloudflare Worker**：Workers static assets 托管 `public/`（index.html + app.js + style.css，无构建步骤）+ `src/worker.ts` 提供 API。不用 Pages（CF 已将新功能投入集中到 Workers）。
  - `POST /api/translate`：流式
  - `GET/POST/DELETE /api/saved`：保存条目增删查
- **存储**：D1。
- **鉴权**：Cloudflare Access（Zero Trust，≤50 人免费）挡在 Worker 前，代码里不写登录流程。
  - Worker 校验 `Cf-Access-Jwt-Assertion` 的签名、iss、aud、exp（WebCrypto，约 30 行；不用 `ctx.access`，因为官方文档说配置了 Static Assets 时它不会传给 Worker），从中取邮箱作为 `user_id`；所有 SQL 都带 `WHERE user_id = ?`。（实现时相比原计划多了这一步：只信 `Cf-Access-Authenticated-User-Email` 头的话，一旦 Access 被误关，请求头可以伪造；校验签名能保证这种情况下请求被拒绝。）
  - 本地开发：`npx wrangler dev --var DEV_USER:you@local` 跳过校验。`DEV_USER` 绝不能设成线上变量。
  - 这就是未来多用户/会员的扩展点；不建 users 表、不写 auth 模块。真要做会员时只替换"取 user_id"这一处。
- **模型**：`wrangler.jsonc` 中 `vars.MODEL = "deepseek/deepseek-v4-flash"`（2026-10-31 与 qwen3.7-flash、mistral-small-3.2 实测对比后选定：$0.091/M 入、$0.182/M 出，单词释义错误最少；1 万次段落翻译约 $1.1-1.3）。
  - 请求固定带 `reasoning: { enabled: false }` 关闭 thinking，以及 `provider: { sort: "latency", max_price: { prompt: 0.1, completion: 0.2 } }`：优先首字延迟最低的服务商，同时排除贵的（同一模型各家价格差 7 倍以上；上限设为 0.2/0.6 时实际路由到了 Crusoe，$0.14/$0.28，收紧后走 DeepInfra，$0.09/$0.18，延迟基本不变）。2026-10-31 实测首字延迟约 1s → 约 0.6s。注意 `include_reasoning: false` / `exclude: true` 只隐藏不关闭，照样计费。
  - 备选：`mistralai/mistral-small-3.2-24b-instruct`（无推理，$0.075/$0.20）。qwen 若返回 400（变成强制推理）就换 `vars.MODEL`。
  - `OPENROUTER_API_KEY` 用 `wrangler secret put`；本地开发用 `.dev.vars`（不入库）。
  - 原文上限 5000 字符，超出直接拒绝（成本兜底）。

## 翻译行为
- **触发**：`paste` 事件立即翻；打字 debounce 800ms，删除后改为 2000ms（删字多半是为了重打，删到一半的句子不值得翻译）；输入法拼写中（`isComposing`）不触发，`compositionend` 后再计时；同一会话内相同的原文和目标语言直接走前端缓存，内容没变时不打断正在进行的请求；`AbortController` 取消旧请求。（2026-10-31：300ms 时边想边打一个长单词会发出十几次请求，每次请求约有 200 token 的固定 prompt 开销，费用涨了数倍，因此改成 800ms 并加了缓存。）无翻译按钮，回车 = 换行。
- **语言**：中、英、德、日。原文自动检测（不在 UI 显示检测结果）；目标语言下拉框，存 `localStorage`。
- **原文 == 目标语言** → 润色模式：修正语法和拼写、表达更自然、保留原意。
- **单词/短语**：最多 3 个常用义项，每行一个；德语名词带冠词+复数（如 `das Schloss, -¨er — 城堡；锁`），日语带读音。句子/片段只出译文，不加解释。
- 以上全部由一个 prompt 在一次调用内完成，输出纯文本。

## 交互
- 窗口 `focus` → 输入框自动聚焦并全选，粘贴或打字直接覆盖；旧译文随之清空。
- **保存**：按钮 + `Cmd+S`。原文空 / 译文空 / 正在流式输出时置灰。
- 主译文区右上角有复制按钮。成功后按钮短暂显示 ✓，不弹 toast。
- **保存列表**：在页面下方，按 `created_at` 倒序，一次全部加载（ponytail：几百条以内没问题，多了再加分页/搜索）。每条带复制、删除（不确认）。
- **去重**：`UNIQUE(user_id, source, target_lang)`，原文先 trim；重复保存时 `ON CONFLICT DO UPDATE` 更新 `target` 和 `created_at`。
- **导出**：`Cmd+Shift+S` 导出全部保存条目为 CSV，不设按钮（保存按钮悬停提示里写明），手机端不支持。UTF-8 BOM（Excel 识别中日文），列 `source,target,target_lang,saved_at`，全部字段加引号（多行译文安全）。文件名 `retranslate-YYYY-MM-DD-HHMMSS.csv`（本地时间），列表为空时不导出。前端用已加载的列表生成，不加后端接口。

## 数据表
```sql
CREATE TABLE saved (
  id INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL,
  source TEXT NOT NULL,
  target TEXT NOT NULL,
  target_lang TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(user_id, source, target_lang)
);
```

## 样式
纯 CSS（不用 Tailwind：CDN 版只能用于开发，且有无样式闪烁；CLI 版要加构建步骤）。CSS 变量 + `prefers-color-scheme` 深色模式。宽屏左右分栏，<700px 上下单栏。不做 PWA。

## 实现细节（已定）
- Worker 把 OpenRouter 的 SSE 转成纯文本流，前端直接读取。
- 错误在译文区用红字显示。
- 只写一个测试：`node:test` 测 SSE 解析。
- 实现时用几句中、德、日的例句实测模型质量。

## 部署与运维
见 [`DEPLOY.md`](DEPLOY.md)（首次部署步骤、Access 配置、日常操作、排错）。

## 本次不做
会员/付费、分页/搜索、显示检测到的语言、PWA、Tailwind、UI 上切换模型、Pi/Docker 部署。
