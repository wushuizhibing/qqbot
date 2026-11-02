# dsh-mood-kit

情绪与关系记忆插件，**与聊天协议无关**。

别的聊天插件（QQ / 微信 / Discord / 自己的玩具协议）负责产生情绪，
这个插件负责：状态机、历史、星图面板。一套逻辑，多处复用。

```
聊天插件 A ─┐
聊天插件 B ─┼→ ctx.moodKit.observe(...) → 情绪状态 / 历史 / 星图 / 人物星系
聊天插件 C ─┘
```

> **一句话**：聊天机器人做情绪，难的不是"让它有点心情"，是**别让它永远挂着同一句**。
> 这个插件把那些坑填了，对外只剩一个 `observe()`。

**它和其它情绪方案的区别**：大多数做法是把一句情绪塞进 prompt 就完事，于是会遇到
"一直挂着同一句""强度永远 2""重启就忘"这类问题——每个都要单独打补丁。
这个插件把这些当成**状态机问题**来解：情绪有强度、会老化、有沿用上限、会落盘，
而且**和协议无关**——哪天你把 QQ 换成微信，这层不用重写。

## 它填了哪些坑

做情绪系统真正花时间的地方，全在"边角"上：

| 问题 | 这个插件的答案 |
|---|---|
| 模型说"没情绪"就一路沿用，一句旧情绪挂一整天 | 最多沿用 2 轮 **且** 不超过 10 分钟 |
| 模型把上一轮的话换个词再吐一次 | 相似度判重（Jaccard ≥ 0.55），按"没给新情绪"处理 |
| 强度永远挤在 1-4 这个安全区 | 新情绪放大 ×1.35 并托底到 2 |
| 隔了几小时还在摆脸色 | 6h 减半、12h 剩三成、24h 几乎归零 |
| 星图上一片"平静" | 那通常是词表太窄 —— 见「为什么星图会骗人」 |
| 重启后情绪全丢 | 启动时从历史恢复每个会话的状态 |

## 一个包，两种半边

装上这一个包，同时得到：

| 半边 | 内容 |
|---|---|
| **服务端** | 情绪中枢（`ctx.moodKit`）+ HTTP 面板 `/mood-kit` |
| **客户端** | DSH 侧边栏的「情绪」图标 + 主区域 iframe 嵌入 |

两半在同一个包里，靠 `package.json` 的两个声明被发现：

```json
{
  "main": "index.js",                    // 服务端入口
  "exports": { "./client": "./lib/client.js" },  // 客户端入口
  "dsh": {
    "client": { "platform": "web" },     // 声明有客户端那半
    "bundle": { "patch": "./cordis.patch.yml" }
  }
}
```

客户端的 `lib/client.js` 必须是 `window.__ModuleLoader__.load({ id, factory })`
格式的预打包文件（不是普通 ESM），`factory` 收到的 `require` 能拿到
`react` / `react/jsx-runtime`。

**侧边栏图标怎么来的**：客户端插件往 `sidebar.panellist` 注册一个图标组件
（字段 `id`），再往 `main` 注册同名的面板（字段 `key` —— 注意两个插槽字段名不一样，
写成一样的会"图标能点但主区域空白"）。点开后 `main` 里是一个 iframe，指向
服务端那一半提供的 `/mood-kit`。


## 它解决什么

聊天机器人做情绪，常见做法是把"情绪"塞进 prompt 里当一句话。问题：

- 情绪会**无限续命**（模型说"没情绪"就沿用上一轮，挂一整天）
- 没有**强度**（"有点烦"和"烦炸了"没区别）
- 没有**历史**（重启就忘，看不出走势）
- 每接一个新聊天插件都得重写一遍

这个插件把这四件事固定下来，对外只有一个 `observe()`。

## 接入方式

```js
// 在你的聊天插件里（每轮对话结束后）
const moodKit = ctx.moodKit;              // 没装就是 undefined，做降级
if (moodKit) {
  const result = moodKit.observe({
    sessionKey: 'group:123456',           // 随便什么字符串，建议 <类型>:<id>
    mood: '被老王连怼两句，有点不爽',        // 模型给的情绪原文，空串 = 没情绪
    intensity: 4,                          // 模型给的 0-10 强度
  });
  // result: { mood, intensity, label, carried, classification, point, merged }
}

// 下一轮组装 prompt 时读回来
const now = moodKit?.current('group:123456');
// { mood, intensity, label, since, carried }
```

**关键点**：`observe()` 会自己处理"照抄上一轮""沿用上限""老化""落盘"，
调用方只要诚实把模型输出丢进来，不用管状态。

## 完整 API

| 方法 | 说明 |
|---|---|
| `observe({ sessionKey, mood, intensity })` | 记录一轮情绪，返回处理后的结果 |
| `current(sessionKey)` | 读该会话当前情绪（含放大后的强度与语气档位） |
| `stats('hour'\|'day'\|'all')` | 情绪类别占比（星图数据）；不传返回三个窗口 |
| `people({ memoryDir, chatIds })` | 人物关系节点（从群记忆文件抽） |
| `points()` | 历史点（面板曲线用） |
| `latest()` | 最近一个点 |
| `classes` | 类别清单（雷达图维度） |

## 面板

装好后访问 `/mood-kit`：

- **情绪监控**：当前情绪、极性条、10 格强度条、双线走势图
- **情绪星图**：8 维雷达图（开心/好奇/烦/亲近/疲惫/得意/尴尬/平静）+ 占比条 + 时间窗切换
- **记忆星系**：力导向关系图，连线粗细 = 亲密度，颜色 = 群来源

## 内部机制（为什么这么设计）

### 强度放大

模型给的强度天生保守（"有点不爽"永远是 3）。`amplifyIntensity()` 乘 1.35 并给下限 2：

```
模型给 1 → 2    模型给 4 → 5    模型给 8 → 10
0 仍然是 0（没情绪不能凭空造）
```

### 老化

隔久了情绪该淡：

```
6 小时后强度减半 → 24 小时后剩 15%
```

### 沿用上限

模型连续说"没情绪"时，`carryMood()` 最多续 `MAX_CARRY_ROUNDS`（2）轮：

```
轮1 有情绪 → 正常
轮2 空     → 沿用，强度减半
轮3 空     → 沿用，强度再减半
轮4 空     → 清空
```

这修的是真实 bug：不加上限时，一句旧情绪能挂一整天，看起来像系统卡死。

### 防照抄

模型很爱把上一轮的描述原样抄回来。`observe()` 里做了一次判断：
**这一轮的文字和上一轮完全相同 → 当作没给新情绪**，交给沿用逻辑去衰减。

### 情绪分类

把自由文本归到 8 个固定维度，才能统计比例、画雷达图。分类靠关键词 + 否定词预处理：

```
"松了口气" → 不能因为含"气"就算生气
"提不起劲" → 不能因为含"起劲"就算开心（疲惫）
"没劲/懒得" → 疲惫，不是烦
```

## 人物星系

从"群记忆"文件（`<memoryDir>/<群号>.md`）里抽人：

```markdown
- **某人（QQ 123456789）**：主人，管着这摊事。
- **老友乙**（旧 openid `BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB`）：熟，爱开玩笑。
- **新人丙(1234567)**：偶尔来。
```

处理规则：

- **号可能是 QQ 号、openid，也可能没有**（早期档案只写名字）
- **同一个人的多条记录合并**（openid 版 + QQ 号版）
- **跨群出现只算一个人**，群归属累加
- **排除非人名条目**（"风格""其它""和某某的梗"）

关系判定：主人 / 管理员 / 熟人 / 陌生，按记忆里的关键词。

## 安装

```powershell
# 1) clone 到任意目录
# 国内用 Gitee，海外用 GitHub，内容一样
git clone https://gitee.com/wushuizhibing/qqbot.git C:\plugins\qqbot
# git clone https://github.com/wushuizhibing/qqbot.git C:\plugins\qqbot

# 2) 链进 DSH 的 profile
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-mood-kit" `
  -Target "C:\plugins\mood-kit"
```

3. profile 的 `package.json` 里加依赖和 bundle：

```json
{
  "dependencies": { "dsh-mood-kit": "link:C:/plugins/mood-kit" },
  "dsh": { "profile": { "bundles": ["...", "dsh-mood-kit"] } }
}
```

4. profile 的 `cordis.patch.yml` 里加配置（全部可省，留空用默认）：

```yaml
- id: mood-kit
  name: dsh-mood-kit
  config:
    dataFile: ''       # 留空 = $DSH_HOME/mood-kit-history.json
    memoryDir: ''      # 留空 = 不画人物星系
    maxPoints: 2000
    keepDays: 7
```

5. 重启 DSH，侧边栏出现「情绪」图标，或直接访问 `http://<web端口>/mood-kit`。

> ⚠️ **bundle 的 `cordis.patch.yml` 必须用 `insert:` 形式**（仓库里已经是了）。
> 写成普通 `- id:` 会让 DSH 静默跳过整个 bundle，表现为"插件没加载、日志也没有"。

## 为什么星图会骗人

打开面板看到"近 1 小时 100% 平静"时，先别怀疑代码 —— 大概率是下面两种情况之一：

**① 这段时间它真的没情绪。** 模型连着十几轮返回"无"，历史里就不新增点，
窗口里始终是那几条旧数据，占比当然不动。（面板会提示"这段时间她一直没被打动"）

**② 分类词表不认识这些说法。** 词表覆盖不到的表达会统一掉进"平静"。
真实数据里曾经有 26 种说法无命中，平静一度占到 36%。

修词表时要盯住一件事：**"描述发生了什么事"的词不能进情绪词表**。
"被点名"只说明发生了什么，不说明感受 —— 放进"尴尬"里会让所有被点名的场合都记成尴尬，
实测一度让尴尬占到 100%。

## 数据与隐私

这个插件**不联网、不上传任何东西**，所有数据都在本地：

- 情绪历史：`dataFile` 指向的 JSON
- 人物星系：从 `memoryDir` 里的 `<群号>.md` 读，**只读不写**

`memoryDir` 留空就完全不碰任何记忆文件。想彻底不带个人数据发布，
把 `dataFile` 和 `memoryDir` 都留空即可。

## 目录

```
index.js              插件入口（挂 ctx.moodKit + 面板路由）
lib/client.js         浏览器端（侧边栏图标 + iframe）
src/core.js           情绪中枢（observe / current / stats / people）
src/emotion.js        情绪状态机（放大、老化、沿用上限 + 时间窗）
src/fade.js           历史点的淡化与过期
src/normalize.js      情绪值与强度的规整
src/mood-stats.js     8 维分类与占比统计
src/polarity.js       粗糙极性估计
src/mood-log.js       历史落盘（按条数 + 天数裁剪）
src/people.js         人物抽取与合并
src/relationship.js   关系判定与提示语
src/panel-hub.js      外部插件往面板里加区块
src/panel.js          面板页与状态快照
src/staleness.js      检测"改了代码没重启"
test/                 单元测试（52 个）
```

## 许可

MIT。
