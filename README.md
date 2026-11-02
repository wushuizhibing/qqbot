# qq-kit & mood-kit

![qq-kit](https://img.shields.io/badge/qq--kit-v0.3.0-38bdf8?style=flat-square)
![mood-kit](https://img.shields.io/badge/mood--kit-v0.2.0-a78bfa?style=flat-square)
![license](https://img.shields.io/badge/license-MIT-4ade80?style=flat-square)

把 QQ 机器人接进 [DeepSeek Harness](https://github.com/deepseek-ai) 的两个 DSH 插件。

```
qq-kit     v0.3.0   QQ 适配层：会话、人格、记忆、决策全归 DSH，协议端只当翻译器
mood-kit   v0.2.0   情绪与关系记忆：不卡死的情绪状态机 + 星图面板 + 人物关系图
```

两个可以单独装，也可以一起装。装在一起时 mood-kit 会自动接管 qq-kit 的情绪，
效果是**它带着心情说话，你能在面板上看到它此刻什么心情**。

**当前版本：qq-kit `0.3.0` · mood-kit `0.2.0`**

| 插件 | 版本 | 说明 |
|---|---|---|
| `dsh-qq-kit` | **0.3.0** | 会话、人格、记忆、两段式思考、面板 |
| `dsh-mood-kit` | **0.2.0** | 情绪状态机、星图、人物关系、面板 |

---

## 这是什么

一个 QQ 群里会聊天的机器人，**"人"跑在 DeepSeek Harness 里**。

大多数 QQ 机器人方案是这样：协议端插件收到消息 → 调一次模型 → 回一句。会话、人设、
记忆全塞在插件自己那套状态里，DSH 只是个被调用的壳。

这个项目反过来：

```
BEFORE（大多数方案）              AFTER（这个项目）
协议端                           协议端（只做格式翻译）
 └ 会话 / 人设 / 记忆              ↓
 └ 插件自己那套心智          qq-kit（薄适配）
 └ 调一次模型就完                 ↓
                           DSH 的会话 / 人格 / 记忆 / 子代理
                                  ↓
                           mood-kit 负责情绪与关系
```

结果就是：它能用上 DSH 的会话管理、DSH 的记忆方式、DSH 的模型选择，
也能被当成一个工作区来调教——而不是一个只能改配置文件的黑盒。

---

## 装了之后是什么样的

不是"接个 webhook 然后回一句话"。具体一点：

**它会记得。** 每个群一份档案：谁是谁、什么脾气、聊过什么约定。
每轮只取当前说话那几个人相关的几条塞进 prompt，不会把整份记忆倒进去。

**它会挑时候说话。** 消息会攒一小批一起看（默认 800ms 窗口），
有人 @ 它立刻插队，群里冷场太久会主动搭一句。
没想说的就不发——`NO_REPLY` 是内部的哨兵，绝不会漏到群里。

**它会想。** 每一轮拆成两个子代理：

```
总结子代理   上一轮摘要 + 这批新消息        →  摘要（记得住）
思考子代理   人格 + 群记忆 + 摘要 + 新消息  →  怎么接
```

一个管记住，一个管怎么接。互不调用，靠摘要交接——总结挂了不影响回话，
回话挂了不污染摘要。思考子代理还会顺手说一句"心里那一下"，
只给面板看，不进群。

**它会变。** 群友的印象每 6 小时自动从聊天流水里提炼一次；
新人第一次说话就建档，不用等谁手动维护。
（这些都能关掉，见各子项目的配置说明。）

**它有情绪。** 装着 mood-kit 的话，它带着心情说话：被怼了语气会更短，
被夸了会美一会儿，隔了几小时气就消了。面板上有情绪星图和走势曲线。

**它有面板。** `/qq-kit` 看连接状态、工作区会话、最近消息流水，
连它"心里怎么想的"都一并列出来。`/mood-kit` 看情绪和人物关系图。

---

## 先说清楚：装了之后 DSH 会多出很多会话

这是最容易被忽略的一条，所以放前面。

**每批消息至少产生 2 个一次性会话**——一个总结、一个思考。都是起隔离会话跑完立刻归档，
不会混进你日常聊天的工作区，但**数量上确实会多**：群活跃的时候，一小时十几个到几十个很正常。

```
群友 @ 了一句         →  2 个会话（已归档）
连发三条被合并成一批   →  还是 2 个
群友印象自动更新一次   →  再加 1 个
```

如果嫌多，`qq-kit` 的配置里可以调：

- `summarizeEvery: 2` —— 隔轮才真跑总结，省一半
- `impressions.enabled: false` —— 关掉印象自动更新
- `useDshAgents: false` —— 退回占位实现（只适合测试，回的是假数据）

细节见 [`qq-kit/README.md`](qq-kit/README.md#装了之后-dsh-里会多出很多会话)。

---

## 先看哪个

| 你想做什么 | 看这里 |
|---|---|
| 一步步装起来 | [`安装指南.md`](安装指南.md) |
| 让 AI 帮你装 | [`AI安装说明.md`](AI安装说明.md) |
| 了解项目全貌 | [`介绍.md`](介绍.md) |
| 让 QQ 群里有个会聊天的机器人 | [`qq-kit/README.md`](qq-kit/README.md) |
| 给它加上情绪和人物关系图 | [`mood-kit/README.md`](mood-kit/README.md) |
| 自己写一个别的协议的适配 | [`qq-kit/docs/writing-adapters.md`](qq-kit/docs/writing-adapters.md) |

> **AI 安装**：把 [`AI安装说明.md`](AI安装说明.md) 连同这句话丢给 DSH 或别的 AI agent——
> 「按这个文档帮我装」——它会自己拉代码、建链接、改配置，只在需要你的 QQ 号和群号时停下来问你。

---

## 几个设计取舍

**协议端只是翻译器。** 内部有一套自己的消息结构，不依赖 OneBot。
适配器只负责"外面的格式 ↔ 内部格式"，换协议端不动业务代码。
内置 `mock`（离线测试）、`onebot`（公开协议规范，通用）两个。

**两段式思考。** 总结和思考是两个独立的一次性子代理，靠摘要交接。
这样"记得住"和"怎么接"可以分别调优、分别失败。

**情绪是状态机，不是一句话。** 强度会放大、会随时间老化、沿用有轮数和时间窗双重上限，
状态落盘、重启可恢复。这些都在 mood-kit 里，和协议无关——
哪天把 QQ 换成微信，这层不用重写。

**配置分层。** 插件代码里只有中性默认值，所有个人化的东西（人格、记忆、QQ 号、
路由）都在你的 profile 配置里。所以这套代码可以直接给别人用，不带任何私人数据。

---

## 这个仓库不自带

**任何人物性格。** `qq-kit` 里的人格是空壳：不像客服，但也没有个性。
要性格就写一份 `soul.md`，放到 `persona/soul.md` 就会自动用上，**改完不用重启**。

**任何群记忆。** 认人、记脾气都从你自己的群记忆文件来。
没有的话它会认不出任何人，每次对话都是新的。

**任何协议端。** 用 SnowLuma / NapCat 之类的自己装，本项目**不附带、不分发**。
装好后在配置里填它的 WebSocket 地址和 accessToken 即可。

---

## 快速开始

两个仓库，内容一样，挑快的用：

```powershell
# 国内（Gitee，直连快）
git clone https://gitee.com/wushuizhibing/qqbot.git C:\plugins\qqbot

# 海外（GitHub）
git clone https://github.com/wushuizhibing/qqbot.git C:\plugins\qqbot
```

然后照 [`qq-kit/README.md`](qq-kit/README.md#安装) 的步骤走。四个要点：

1. **先跑一个 OneBot v11 协议端**，确认 `messageFormat` 是 `string`、`role` 是 `Universal`
2. **第一次务必 `dryRun: true`** —— 它只打印打算回什么，不往群里发
3. **加上安全预设**（`qq-kit/examples/preset-qq-chat.example.yml`），裁掉子代理的 shell/文件工具
4. **知道它会花钱** —— 每轮两次模型调用。想省就把 `summarizeEvery` 调到 2，或者用便宜模型

### 装依赖慢的话

插件本身的源码没有 npm 依赖，但它跑在 DSH 里、要用 `ws` 这个包。
国内直连 npm 官方经常超时，可以换镜像：

```powershell
npm config set registry https://registry.npmmirror.com
```

（只影响下载速度，跟插件功能无关。）

---

## 可能会遇到的坑

这些是实际踩过的，不是理论风险。按遇到概率排：

### 装完发现工作区里一堆会话

正常。每批消息 2 个一次性会话，跑完就归档。嫌多就把 `summarizeEvery` 调成 2、
或者关掉 `impressions`。见上面那节。

### 插件装了但没反应，日志也没有

最常见的原因是 bundle 的 `cordis.patch.yml` 写成了普通条目而不是 `insert:` 形式。
写错的时候 DSH 会**静默跳过整个 bundle**，不报错。

```yaml
# 错
- id: qq-kit
  name: dsh-qq-kit

# 对
- insert:
    - id: qq-kit
      name: dsh-qq-kit
```

### 报 `cannot get property "xxx" without inject`

cordis 的 ctx 是 Proxy，读没在 `inject` 里声明过的属性会直接抛。
如果你要写自己的插件接这套：可选依赖用 `ctx.get('xxx')`，别用 `ctx.xxx`。

赋值的话反过来——得先 `ctx.provide('xxx')` 才能 `ctx.xxx = ...`。

### 连不上协议端

按这个顺序查：

- accessToken 对不上（401）
- 协议端没开 WS 服务，或者端口不对（ECONNREFUSED）
- `messageFormat` 写成了 `array` —— **必须 `string`**，用 array 时事件可能推不出来
- `role` 不是 `Universal` —— `Event` 只收不发、`Api` 只发不收

`qq-kit-trace.log` 里能看到具体是哪类。

### 它回得毫无个性 / 像个客服

`personaPath` 没指到你的 `soul.md`，用的是内置中性人格。
把 `soul.md` 放到 `persona/soul.md`（或显式配 `personaPath`）就会用上，改完不用重启。

### 它认不出人 / 每次对话都像第一次见

`memoryDir` 没配，或者配的目录是空的。它不会凭空记住谁，得有一份群记忆文件。

### 情绪面板一片"平静"，几乎不动

两种可能，都不是 bug：

- 这段时间它真的没情绪，模型连着很多轮返回"无"
- 分类词表不认识它用的那些说法，统一掉进了"平静"

`mood-kit/README.md` 里有一节专门讲这个。

### 一句话情绪挂很久不变

旧版本有这个问题，现在沿用情绪最多续 2 轮、且不超过 10 分钟。
如果你还遇到，看 `qq-kit-trace.log` 里的 `mood-parse` 探针，能看到模型每轮到底吐了什么。

### 图片看不出是谁发的

已经修了：正文里会有 `[图1]` `[图2]` 编号，提示词里逐张标注发送人和时间。
如果版本旧，更新一下。

### 重启后它忘了刚发生的事

摘要和情绪都是落盘的，正常不会丢。如果丢了，检查 `DSH_HOME` 是否指向了别的目录
——数据文件是按它定位的。

---

## 限制

- **单号**：一个账号，不做多号并发
- **协议端依赖现实**：这类实现通常要挂一个完整客户端，客户端升级可能跟丢
- **不是沙箱**：子代理是完整的 agent 会话，靠预设裁工具来限制能力
- **发空间动态**：不在 OneBot 标准范围内，需要各协议端私有接口，风险高，未实现
- **有成本**：每轮两次模型调用，按你用的模型计价。群活跃的话一天几块钱很正常

---

## 版本与发布

当前版本：**qq-kit v0.3.0** · **mood-kit v0.2.0**

版本号写在两个 `package.json` 里，改功能时一起改：

```
qq-kit/package.json    "version": "0.3.0"
mood-kit/package.json  "version": "0.2.0"
```

### 发一个新版本

```powershell
# 1. 改功能
# 2. 改对应的 package.json 里的 version（比如 0.3.0 → 0.3.1）
# 3. 跑测试
cd qq-kit;   node --test "test/**/*.test.mjs"
cd mood-kit; node --test "test/**/*.test.mjs"

# 4. 提交
git add -A
git commit -m "修复 xxx"

# 5. 打标签（说明写清楚这次改了什么）
git tag -a v0.3.1 -m "v0.3.1 — 修复 xxx"

# 6. 推代码 + 标签
git push origin main
git push origin v0.3.1

git push gitee main
git push gitee v0.3.1
```

**别忘推标签**——只推 `main` 的话，Releases 页面不会出现新版本。

### 版本号怎么定

| 变化 | 版本 | 例子 |
|---|---|---|
| 加功能 | 次版本 +1 | 0.3.0 → 0.4.0 |
| 只修 bug | 修订号 +1 | 0.3.0 → 0.3.1 |
| 不兼容的改动 | 主版本 +1 | 0.3.0 → 1.0.0 |

现在还是 0.x，说明配置格式可能变——升级前看一眼 changelog。

### 两个仓库一起推

本地配了两个远程，内容是同一份：

```powershell
git push origin main   # GitHub
git push gitee main    # Gitee
```

只推一边的话，另一边就落后了。

---

## 许可

两个插件都是 MIT。

**本项目不包含、不分发任何 QQ 协议端代码。** 协议端由使用者自行安装并遵守各自许可
（多数是"非商用 + 禁改版公开"）。本内核只通过公开协议规范（如 OneBot v11）与它们交互，
`qq-kit/adapters/onebot.js` 是针对协议规范本身写的通用实现，与任何具体协议端的产品无关。

接入 QQ 属于非官方方式，**有封号风险**。请自行评估。
