# 部署与运维手册

> 资料核实日期：2026-10-31。Cloudflare 控制台改版很频繁，路径对不上时以页面上的名称为准，参考文末来源。
> 标注 ⚠️ 的内容没有在官方文档中核实到，操作时请留意。

## 一、整体是怎么连起来的

```
你的电脑                       Cloudflare                                   OpenRouter
─────────                      ──────────────────────────────────────       ──────────
wrangler ──(OAuth token)──>    Cloudflare API：创建 D1、上传代码、存 secret
                                     │
浏览器 ──────────────────>     Access（Zero Trust）
                               ├ 没登录 → 登录页（邮箱验证码）
                               ├ 邮箱不在名单里 → 拒绝，不会发验证码
                               └ 通过 → 附带签名的 JWT（内含邮箱）
                                     │
                                     ▼
                               Worker `retranslate`
                               ├ public/  页面（HTML/JS/CSS）
                               ├ 验证 JWT（ACCESS_TEAM + ACCESS_AUD）→ 邮箱 = user_id
                               ├ /api/translate ──(OPENROUTER_API_KEY)──────> 翻译模型
                               └ /api/saved ──> D1（按 user_id 隔离）
```

- **wrangler**：本地命令行工具。登录一次后，用 Cloudflare API 替你完成创建数据库、存 secret、部署这些操作。**除了 Access，其他都不需要在网页上点。**
- **Access（Zero Trust）**：挡在 Worker 前面的门卫，决定谁能进。只有名单里的邮箱能登录。
- **Worker**：你们的应用。它不自己做登录，只认 Access 签发的 JWT：签名对得上（`ACCESS_TEAM` 定位你团队的公钥）、发给的是这个应用（`ACCESS_AUD`），才放行。JWT 里的邮箱就是 `user_id`，所以**每个人只能看到自己保存的内容**。
- 为什么不按 IP 限制：家里宽带、手机网络、出门在外的 IP 都会变，运营商 NAT 还会让陌生人共用同一个 IP。按邮箱限制最准确。

## 二、准备工作

1. **Cloudflare 账号**：免费账号就行。
2. **开通 Zero Trust**：Cloudflare 控制台 → Zero Trust → 按引导选 **Free** 计划。引导里**必须填付款信息，但免费版不会扣费**。会让你起一个团队名（team name），它就是之后的 `ACCESS_TEAM`。
   - ⚠️ 免费版的人数上限没有核实到，两个人肯定没问题，以 Cloudflare 价格页为准。
3. **单独为这个应用新建一个 OpenRouter key**，并设置额度上限（例如每月 5 美元）。万一泄露，损失有限，换掉也不影响别的项目。
   - OpenRouter 支持按 key 设置额度上限，还能按天、周、月自动重置。
   - ⚠️ 没有核实网页上的 Keys 页面能不能直接设置上限。如果没有这个选项，可以用 Management API 设置（见来源）。

## 三、首次部署

以下命令都在项目根目录执行。

### 1. 登录 wrangler
```bash
npx wrangler login --use-keyring   # 浏览器里授权；--use-keyring 会把 token 存进 macOS 钥匙串
npx wrangler whoami                # 确认登录的是哪个账号
```
不加 `--use-keyring` 的话，token 会以**明文**存在 `~/.config/.wrangler/config/default.toml`。

### 2. 创建 D1 数据库
```bash
npx wrangler d1 create retranslate
```
把输出里的 `database_id` 填进 `wrangler.jsonc`，替换掉 `"local"`。

### 3. 建表
```bash
npx wrangler d1 migrations apply retranslate --remote
```

### 4. 第一次部署
```bash
npx wrangler deploy
```
输出里会有地址 `https://retranslate.<你的子域>.workers.dev`。
**检查**：打开这个地址，页面能显示，但翻译会报 `unauthorized`。这是正常的：还没配置 Access，所有接口都返回 401，不会把接口暴露给外人。

### 5. 存 API key
```bash
npx wrangler secret put OPENROUTER_API_KEY   # 按提示粘贴 key
```
- 这条命令会**立即部署**一个新版本，不需要再 deploy。
- 存进去之后，网页上和 wrangler 里都看不到明文，只能用同一条命令覆盖。

### 6. 配置 Access（只有这一步要在网页上操作）

**6.1 加上邮箱验证码登录**
新建的 Zero Trust 组织默认用"Cloudflare 账号"登录。你女朋友不一定有 Cloudflare 账号，所以要加上一次性验证码：
Zero Trust → **Integrations** → **Identity providers** → **Add new identity provider** → **One-time PIN**。

**6.2 建一个只允许你们两人的策略**
Zero Trust → **Access controls** → **Policies** → 新建：
- Action：**Allow**
- Include → **Emails**：填你和你女朋友的邮箱
- Session duration：**1 month**（最长就是 1 个月，这样平时几乎不用重新登录）

**6.3 用这个策略保护 Worker**
Workers & Pages → `retranslate` → **Access** 标签页 → **Protect this Worker behind Access** → 选 **All traffic** → Authentication policy 选 6.2 建的策略 → **Apply Access**。
- 这里的内置选项只有"Cloudflare account"和"Email domain"，都不是按具体邮箱限制的，所以要选 6.2 建好的策略。
- 弹出的窗口里会显示 **AUD tag** 和**团队域名**，记下来。

**6.4 如果第 6.3 步的弹窗没显示这两个值**
- AUD：Zero Trust → Access controls → Applications → 选择这个应用 → **Configure** → **Additional settings** → **Application Audience (AUD) Tag**。只要不删除重建这个应用，AUD 就不会变。
- 团队名：就是开通 Zero Trust 时起的那个名字，即 `<team>.cloudflareaccess.com` 里的 `<team>`。⚠️ 它在控制台的具体位置没有核实到。

### 7. 填入 Access 参数，再部署一次
在 `wrangler.jsonc` 里：
```jsonc
"ACCESS_TEAM": "<team>",        // 只填团队名，不要带 .cloudflareaccess.com
"ACCESS_AUD": "<AUD tag>"
```
```bash
npx wrangler deploy
```

### 8. 验收
1. 用无痕窗口打开应用地址 → 应该跳转到 Cloudflare 登录页。
2. 输入你的邮箱 → 收到验证码 → 登录后能翻译、保存。
3. 你女朋友用自己的邮箱登录 → 保存列表是空的，你们的数据互相隔离。
4. 输入一个不在名单里的邮箱 → **收不到验证码**。

## 四、日常操作

| 要做的事 | 怎么做 |
|---|---|
| 改代码后上线 | `npx wrangler deploy` |
| 换模型 | 改 `wrangler.jsonc` 的 `MODEL` → `npx wrangler deploy` |
| 加人或删人 | Zero Trust → Access controls → Policies → 编辑邮箱名单。不用改代码，也不用重新部署 |
| 换 OpenRouter key | OpenRouter 后台新建 key → `npx wrangler secret put OPENROUTER_API_KEY` → 删掉旧 key |
| 看线上日志 | `npx wrangler tail` |
| 改数据表 | 新建 `migrations/0002_xxx.sql` → `npx wrangler d1 migrations apply retranslate --remote` |
| 本地开发 | 第一次先运行 `npx wrangler d1 migrations apply retranslate --local`，之后运行 `npx wrangler dev --var DEV_USER:you@local`（key 自动从 `.env` 读取） |
| 跑测试 | `npm test` |
| 退出 wrangler 登录 | `npx wrangler logout`，同时作废本地 token |

**改成两人共用一个保存列表**：现在是各存各的。要共用的话，把 `src/worker.ts` 里 `accessUser()` 的返回值固定成同一个字符串，并且只在验证通过后返回。

## 五、出问题时查这里

| 现象 | 可能的原因 |
|---|---|
| 所有接口都返回 `unauthorized` | `ACCESS_TEAM` / `ACCESS_AUD` 没填或填错（团队名多带了 `.cloudflareaccess.com`、AUD 复制少了字符），或者 Access 没有保护 All traffic |
| 页面显示 "Request failed. Your session may have expired" | Access 登录过期 → 刷新页面重新登录 |
| 翻译报 `OpenRouter 401` | secret 没存或者 key 已失效 → 重新执行 `secret put` |
| 翻译报 `OpenRouter 402` | 余额不足，或者达到了 key 的额度上限 |
| 翻译报 `OpenRouter 400` | 模型可能改成了强制推理，不能关闭 thinking → 换 `MODEL` |
| 收不到验证码 | 邮箱不在策略名单里，或者 6.1 没有加 One-time PIN；也查一下垃圾邮件。验证码 10 分钟后失效 |
| 保存列表报错 | 第 3 步建表时漏了 `--remote` |

## 六、安全要点

- **`DEV_USER` 只能在本地用**（命令行 `--var` 或 `.env`），**绝不能**设成线上变量，否则鉴权会被直接跳过。
- `.env`、`.dev.vars` 已经在 `.gitignore` 里，不要提交。
- 不要用 `wrangler auth token` 打印 token 后贴到任何地方。
- Worker 为什么要自己验证 JWT：如果只信任请求头里的邮箱，Access 一旦被误关，请求头就能被伪造；验证签名能保证这时请求被拒绝。不用更省事的 `ctx.access`，是因为官方文档说配置了 Static Assets 时，它不会传给 Worker。

## 来源

- [Cloudflare Access for Workers（ctx.access、Access 标签页、Static Assets 限制）](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)
- [Validate JWTs（请求头、公钥地址、iss/aud、AUD 位置）](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)
- [Workers protected by Access（博客）](https://blog.cloudflare.com/workers-protected-by-access/)
- [Zero Trust setup（Free 计划需填付款信息）](https://developers.cloudflare.com/cloudflare-one/setup/)
- [One-time PIN login](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/)
- [Session management](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/)
- [Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Wrangler login / whoami](https://developers.cloudflare.com/workers/wrangler/commands/general/)
- [OpenRouter key 额度上限（Management API）](https://openrouter.ai/docs/guides/overview/auth/provisioning-api-keys)
