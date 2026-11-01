# dsh-qq-kit

把 QQ 接进 [DeepSeek Harness](https://github.com/deepseek-ai)，**会话、人格、记忆、决策全归 DSH**，
QQ 协议端只当翻译器，随时可换。

> 让 QQ 群里的那个机器人真的住进你的 DSH——用它自己的会话、自己的记忆、
> 自己的子代理思考，而不是被协议端插件牵着走。

## 为什么要另做一个

现有的 QQ 方案（各种 `OneBot` 系列插件）基本是同一个形状：**把会话、人设、存储都塞在协议端那一侧**，
DSH 只是被调用的一个壳。用起来处处像外挂——

- 会话不在工作区里，查不到、开不了；
- 记忆各存一套，跟 DSH 的会话记忆打不通；
- 行为不受控：改人格得去翻插件配置，换模型得看插件支不支持；
- 插件作者怎么想，你就只能怎么用。

这个项目把主从关系倒过来：

```
BEFORE（大多数方案）        AFTER（这个插件）
协议端                     协议端  ← 只做格式翻译
 └ 会话 / 人设 / 记忆              ↓
 └ 插件自己的心智          dsh-qq-kit  ← 薄适配，不含业务
 └ 收到消息调一次模型              ↓
                          DSH 自己的会话 / 人格 / 记忆 / 子代理
```

于是机器人的"人"跑在 DSH 里：它能用 DSH 的会话管理、DSH 的记忆组织方式、
DSH 的模型选择，也能被当成一个工作区来调教——而不是一个只能改配置文件的黑盒。

## 它是什么样的

不是"接个 webhook 然后调模型回一句话"那种。装了之后：

- **它会记得**。每个群一份档案（谁是谁、什么脾气、有什么约定），每轮只取当前说话那几个人相关的几条塞进 prompt，不会把整份记忆倒进去。
- **它会挑时候说话**。消息会攒一小批一起看（`merge`，默认 800ms 窗口），被 @ 立刻插队，
  群里冷场太久会主动搭一句；没想说的就不发——`NO_REPLY` 是内部哨兵，绝不会漏到群里。
- **它会想**。每一轮拆成两个子代理：一个总结（管记住），一个思考（管怎么接）。
  互不调用，靠摘要交接——总结挂了不影响回话，回话挂了不污染摘要。
  思考子代理还会顺手说一句"心里那一下"（`thought`），只给面板看，不进群。
- **它会变**。群友的印象每 6 小时自动从聊天流水里提炼；新人第一次说话就建档，不用等谁手动维护。
- **它有情绪**。装着 [`dsh-mood-kit`](../mood-kit/README.md) 的话，
  它会带着心情说话；面板上能看到"近一小时什么心情"。
- **它有面板**。`/qq-kit` 看连接、会话、消息流水，连它"心里怎么想的"都一并列出来。

上面这些都能单独关掉，见下面的配置。

## 架构

```
QQ 客户端
   ↓ 协议挂载（任意协议端）
OneBot v11 over WebSocket
   ↓
adapters/<id>.js         只做格式翻译，不含业务
   ↓  内部消息结构（src/message.js，不依赖 OneBot）
src/merge.js             合并 / 限流 / @ 抢跑 / 冷场抢跑
   ↓
src/session.js           会话键 group:<群号> / private:<QQ号>
   ↓
src/bridge.js            两段式：总结子代理 → 思考子代理 → 发送计划
   ↓
DSH sessionController    起一次性会话，跑完归档清场
   ↓
回群 / 私聊
```

**两段式为什么拆开**：总结管"记得住"，思考管"怎么接"。互不调用，靠共享状态交接：
摘要 → 计划。这样总结挂了不影响回话，回话挂了不上污染摘要。

```
一批消息
  ├─ 总结子代理：上一轮摘要 + 这批新消息 → 摘要（每 N 轮真跑一次，其余复用）
  ├─ 思考子代理：人格 + 群记忆 + 摘要 + 新消息 → {"send":bool,"text":"..."}
  └─ 执行侧：校验后发送（脏计划、NO_REPLY 一律不发）
```

## 特性

**协议无关（核心设计）**
- 内核**不内置任何具体的协议端实现**，协议端只当翻译器
- 内置 `mock`（离线跑通链路）和 `onebot`（OneBot v11 公开协议，通用实现）
- 接新协议 = 加一个 `adapters/xxx.js`，内核一行不改 → 见 [docs/writing-adapters.md](docs/writing-adapters.md)
- 情绪、人格、记忆、合并、两段式这些都在内核里，所以**同一套心智可以装到任何协议上**

**消息**
- 群 / 私聊，文本 / @ / 图片 / 视频 / 文件 / 回复
- 一条不漏：全部进窗口，合并只决定"什么时候触发"
- 限流：每群每分钟 N 次主动触发；**被 @ 时绕过限流立刻触发**
- 冷场抢跑：隔久了再来消息，不等窗口

**识图与视频**
- 图片收到立刻下载，作为多模态输入交给模型（不走文字描述）
- 视频用 ffmpeg 抽 3 帧当图看
- 下载失败一律降级成"这轮没图"，不让思考挂掉

**人格与记忆**
- 人格从 `soul.md` 读，`core` 档只取关键几节（约 7KB），也能 `full` 全文
- 群档案按**当前说话人**裁剪（实测 6.8KB → 2.4KB）
- 摘要落盘，重启接着用
- 认人靠稳定 id（QQ 号），不靠昵称（昵称随时改）

**情绪**
- 情绪活在摘要里（谁引起的、多强），不单独建模
- 影响语气，不影响态度；不拿它当不回话的理由

**安全**
- 配合"纯聊天"预设，子代理**没有 shell / 文件 / 任务工具**
- `NO_REPLY` 双层拦截，哨兵不会漏进群里
- `dryRun` 只打印不发送，第一次接入先观察

**可观测**
- 面板 `/qq-kit`：连接状态、会话列表、最近消息
- 本地 trace：每次收消息、计划、发送都记

## 安装

### 1. 前置：跑一个 OneBot v11 协议端

内置的 `onebot` 适配器对接的是 **OneBot v11 协议规范**，
你需要一个实现了它的协议端（把 QQ 消息翻译成 OneBot 的独立程序）。
具体用哪个、怎么装，取决于你自己；本项目**不附带、不分发**任何协议端。

> 协议端接入 QQ 属于非官方方式，有封号风险，且各协议端许可不同（多为非商用、禁改版公开）。
> 请自行评估并遵守其许可。

启动协议端后，确认它的 WS 服务配置：

- `role` = `Universal`（同一条连接既收事件又能发动作；`Event` 只收不发、`Api` 只发不收）
- `messageFormat` = `string` **必须是 string**，用 `array` 时事件可能推不出来（实测）
- `reportSelfMessage` 按需（true 才能看到自己发的）

### 2. 装插件

```powershell
# 1) 随便放一个目录（下面以 C:\plugins\qq-kit-plugin 为例）
git clone https://github.com/wushuizhibing/qqbot.git C:\plugins\qqbot

# 2) 链进 DSH 的 profile
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-qq-kit" `
  -Target "C:\plugins\qqbot\qq-kit"

# 3) profile 的 package.json 里加依赖 + bundle
#    4) profile 的 cordis.patch.yml 里加 - id: qq-kit 配置块
```

配置照抄 `examples/profile-config.example.yml` 改路径即可。
**第一次务必 `dryRun: true`** —— 先看它打算回什么，别直接往群里发。

### 3. 安全预设（强烈建议）

`examples/preset-qq-chat.example.yml` —— 裁掉 shell/文件/任务工具，只留聊天+联网。
不加这个，群里有人诱导它执行命令就麻烦了。

### 4. 重启 DSH

验证：`$env:USERPROFILE\qq-kit-trace.log` 里能看到 `recv` 事件；
面板 `http://<web端口>/qq-kit` 显示"已连接"。

## 配置要点

| 键 | 说明 |
|---|---|
| `adapter` | `mock`（离线）/ `onebot`（OneBot v11） |
| `adapterOptions.messageFormat` | 必须 `string` |
| `useDshAgents` | true 用 DSH 子代理；false 退回占位（离线测试） |
| `agentOptions.agentPreset` | 建议配纯聊天预设 |
| `agentOptions.model` | 只作用于 QQ 线的一次性会话，不影响网页端 |
| `dryRun` | true = 只打印不发 |
| `selfId` | 机器人自己的 QQ 号，用来认 @我 |
| `atUrgent` | 被 @ 时绕过限流 |
| `notifyOnMention` | 别人的号被 @ 时硬发提醒（不走模型） |
| `personaPath` / `personaMode` | 人格文件与档位 |
| `memoryDir` / `knownUsersPath` | 群档案目录 / 认人表 |
| `summarizeEvery` | 每几轮真跑一次总结 |
| `merge.perMinute` | 每群每分钟主动触发上限 |

## 目录

```
index.js                 插件入口（apply / config / 生命周期 / 面板路由）
src/message.js           内部消息结构 + CQ 码解析 + @ 判定
src/merge.js             合并器：窗口 / 限流 / 紧急消息
src/session.js           会话键 / 路由 / 上下文窗口
src/adapter.js           适配器基类 + 注册表
src/bridge.js            两段式桥接 + 发送计划校验（含 NO_REPLY 拦截）
src/dsh-agents.js        DSH 子代理：起会话 / 换模型 / 等 turn-end / 归档
src/persona.js           人格加载与裁剪
src/memory.js            群档案 / 认人表 / 按说话人裁剪
src/storage.js           摘要持久化（临时文件 + rename）
src/panel.js             面板页与状态快照
src/trace.js             本地 trace 日志
src/usage-watch.js       用量看门狗（到阈值私聊通知）
adapters/mock.js         mock 适配器（不连外部）
adapters/onebot.js       OneBot v11 适配器（公开协议，通用）
examples/                配置示例
test/                    单元测试（204 个）
```

## 和人设、记忆的关系

这个插件**不自带任何人物性格和群记忆**：

- **人格**：`personaPath` 指向你自己的 `soul.md`；留空则用内置的中性人格（只是不像客服，没有个性）
- **记忆**：`memoryDir` 指向你自己的群档案目录；留空则认不出任何人

想让它"有灵魂"，得自己写人格文件和群记忆 —— 那部分属于你和你的群，不该跟着代码走。

情绪与人物星图由姊妹项目 [`dsh-mood-kit`](../mood-kit/README.md) 负责，
装了就自动接上（面板在 `/mood-kit`），没装也能跑（退回内置实现）。

## 开发

```bash
node --test "test/**/*.test.mjs"   # 全部测试
node demo.mjs                      # 冒烟：mock 适配器跑一遍链路
```

## 踩过的坑（给后来者）

1. **配置不是 `ctx.config`** —— 是 `apply(ctx, bundleConfig)` 的第二参数。cordis 的 Context 是 Proxy，
   读未 inject 的属性直接抛 `cannot get property "..." without inject`。
2. **`apply` 返回值必须为空** —— 非函数会被当 `Invalid effect`。
3. **服务要用 `ctx.inject([...], child => …)`** —— `ctx.get()` 同样会炸。
4. **插件加载失败会静默跳过** —— 自己包 try/catch 写固定路径日志才查得到。
5. **`messageFormat: "array"` 事件推不出来** —— 必须 `string`。
6. **ws 模块要按真实路径往上爬** —— ESM `import('ws')` 从插件目录找不到。
7. **连不上时 ws 只发 error 不发 close** —— 重连必须两边都排。
8. **getter 传依赖别解构** —— inject 异步就绪，提前解构会拿到 null。
9. **PowerShell 写 JSON 带 BOM 会解析失败** —— 用 `[IO.File]::WriteAllText(..., UTF8Encoding($false))`。

## 限制

- **单号**：一个账号，不做多号并发。会话键不带自身 id。
- **协议端依赖现实**：这类实现通常都要挂一个完整客户端，客户端升级可能跟丢。
- **发空间动态**：不在 OneBot 标准范围内，需要各协议端私有接口，风险高，未实现。
- **子代理是完整 agent 会话**：靠预设裁工具，不是沙箱。

## 许可

本项目 MIT。

**本项目不包含、不分发任何协议端代码。** 协议端由使用者自行安装和遵守各自许可
（多数是"非商用 + 禁改版公开"）。本内核只通过公开协议规范（如 OneBot v11）与它们交互，
`adapters/onebot.js` 是针对协议规范本身写的通用实现，与任何具体协议端的产品无关。

想接具体协议端，自己写一个适配器即可 —— 见 [docs/writing-adapters.md](docs/writing-adapters.md)。
