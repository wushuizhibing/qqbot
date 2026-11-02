# 给 DSH / AI 用的安装说明

> 这份是给 **DSH 里的 AI agent** 读的，不是给人读的。
> 让人读的版本看 [安装指南.md](安装指南.md)。
>
> **AI 请按本文档能做的做完，然后只向用户要「需要人工提供」那节里的值。**

---

# 你能做到的 / 做不到的

| 步骤 | AI 能做 | 说明 |
|---|---|---|
| 拉代码 | ✅ | git clone |
| 建链接 | ✅ | New-Item Junction |
| 装依赖 | ✅ | npm 配置 |
| 改 package.json | ✅ | 加依赖 + bundles |
| 改 cordis.patch.yml | ⚠️ | 能改，但需要用户给 4 个值 |
| 跑测试验证 | ✅ | node --test |
| 装协议端 | ❌ | 需要图形界面登录 QQ |
| 重启 DSH | ❌ | 会中断当前会话 |
| 协议端设置 | ❌ | 需要人在协议端界面里点 |

---

# 阶段一：全自动（不需要问用户）

按顺序执行。**每步都验证，失败就停下报告。**

## 1. 检查前置

```powershell
# DSH 装了吗
Test-Path "$env:USERPROFILE\.dsh\profiles"

# 有哪个 profile
Get-ChildItem "$env:USERPROFILE\.dsh\profiles" -Directory | Where-Object { $_.Name -ne 'node_modules' }
```

**如果 `profiles` 不存在** → 停止，告诉用户"DSH 没装好或从没用过"。

**记住 profile 名**（通常是 `desktop`），后面所有路径都用它。下文用 `<profile>` 表示。

## 2. 决定安装位置

```powershell
$root = 'C:\plugins\qqbot'
```

**如果这个目录已存在** → 说明装过了，先问用户是"更新"还是"重装"。

- 更新：`git -C $root pull`
- 重装：先备份 `cordis.patch.yml`，再删目录

## 3. 拉代码

```powershell
# 先试国内源
git clone https://gitee.com/wushuizhibing/qqbot.git C:\plugins\qqbot
```

**失败了再试 GitHub**：

```powershell
git clone https://github.com/wushuizhibing/qqbot.git C:\plugins\qqbot
```

**验证**：

```powershell
Test-Path 'C:\plugins\qqbot\qq-kit\index.js'   # 应为 True
Test-Path 'C:\plugins\qqbot\mood-kit\index.js' # 应为 True
```

## 4. 建 Junction

```powershell
$nm = "$env:USERPROFILE\.dsh\profiles\<profile>\node_modules"
New-Item -ItemType Directory -Force $nm | Out-Null

if (-not (Test-Path "$nm\dsh-qq-kit")) {
  New-Item -ItemType Junction -Path "$nm\dsh-qq-kit" -Target 'C:\plugins\qqbot\qq-kit'
}
if (-not (Test-Path "$nm\dsh-mood-kit")) {
  New-Item -ItemType Junction -Path "$nm\dsh-mood-kit" -Target 'C:\plugins\qqbot\mood-kit'
}
```

**注意**：如果 `$nm\dsh-qq-kit` 已存在但**不是 Junction**（是普通目录或旧文件），
先 `Remove-Item` 再建。删之前确认它是我们装的。

**验证**：

```powershell
(Get-Item "$nm\dsh-qq-kit").LinkType    # 应为 Junction
(Get-Item "$nm\dsh-mood-kit").LinkType  # 应为 Junction
```

## 5. 装依赖（可选）

插件源码不依赖 npm 包，但它跑在 DSH 里要用 `ws`。
**先检查有没有**：

```powershell
Test-Path "$nm\ws"
```

没有才需要装，而且**要让用户决定**——改 npm registry 是全局影响。

## 6. 备份配置

**改任何配置前必须备份。**

```powershell
$pkg   = "$env:USERPROFILE\.dsh\profiles\<profile>\package.json"
$patch = "$env:USERPROFILE\.dsh\profiles\<profile>\cordis.patch.yml"
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

Copy-Item $pkg   "$pkg.bak-$stamp"   -ErrorAction SilentlyContinue
Copy-Item $patch "$patch.bak-$stamp" -ErrorAction SilentlyContinue
```

## 7. 改 package.json

**只加两处，别的不动。**

用脚本改（别手写 JSON 字符串，容易出错）：

```powershell
node -e @"
const fs = require('fs');
const f = process.argv[1];
const p = JSON.parse(fs.readFileSync(f, 'utf8'));

p.dependencies = p.dependencies || {};
p.dependencies['dsh-qq-kit']   = 'link:C:/plugins/qqbot/qq-kit';
p.dependencies['dsh-mood-kit'] = 'link:C:/plugins/qqbot/mood-kit';

p.dsh = p.dsh || {};
p.dsh.profile = p.dsh.profile || {};
const b = (p.dsh.profile.bundles || []).filter(x => x !== 'dsh-qq-kit' && x !== 'dsh-mood-kit');
// mood-kit 必须排在 qq-kit 前面
b.push('dsh-mood-kit', 'dsh-qq-kit');
p.dsh.profile.bundles = b;

fs.writeFileSync(f, JSON.stringify(p, null, 2) + '\n');
console.log('ok');
"@ $pkg
```

**验证**：

```powershell
$v = Get-Content $pkg -Raw | ConvertFrom-Json
$v.dependencies.'dsh-qq-kit'                                    # link:C:/plugins/qqbot/qq-kit
$v.dsh.profile.bundles -join ',' | Select-String 'dsh-mood-kit,dsh-qq-kit'  # 顺序要对
```

---

# 阶段二：需要用户提供 4 个值

**在这里停下来问用户。** 一次问全，别挤牙膏。

| # | 要什么 | 从哪拿 | 示例 |
|---|---|---|---|
| 1 | 协议端 WebSocket 地址 | 协议端设置里的 WS 服务 | `ws://127.0.0.1:3001/` |
| 2 | accessToken | 协议端设置里生成或自设的 | `abc123xyz` |
| 3 | 机器人 QQ 号 | 你登录协议端用的那个小号 | `100000001` |
| 4 | 要接管的群号 | 群资料里看，多个用逗号 | `200000001, 200000002` |

**同时确认一件事**：

> 协议端设置里 `messageFormat` 是不是 `string`、`role` 是不是 `Universal`？
> 不是的话先改掉，否则连上也收不到消息。

---

# 阶段三：拿到值之后

## 8. 写 cordis.patch.yml

**关键：必须用 `insert:` 形式。** 写成普通 `- id:` 会被 DSH 静默跳过——
不报错、日志也没有，表现为"装了没反应"。

先读仓库里的两个示例，照着改：

```
C:\plugins\qqbot\qq-kit\examples\preset-qq-chat.example.yml
C:\plugins\qqbot\qq-kit\examples\profile-config.example.yml
```

把这两个文件的内容**追加**到 `<profile>\cordis.patch.yml` 末尾，然后替换占位符：

| 占位符 | 换成用户给的 |
|---|---|
| `ws://127.0.0.1:3001/` | 值 1 |
| `换成你协议端 WS 服务里配的 accessToken` | 值 2 |
| `selfId: ''` | 值 3（加引号） |
| `chatId: '123456789'` | 值 4（每个群一条 route） |

**其它保持默认**，尤其：

- `dryRun: true` ← **第一次必须 true**
- `messageFormat: string`
- `summarizeEvery: 1`
- `personaPath: ''`（留空=自动找）
- `memoryDir: ''`（先不用）

**验证 YAML 能解析**（用 DSH 自己的加载器，最准）：

```powershell
$env:ELECTRON_RUN_AS_NODE='1'
& 'D:\deepseek\DeepSeek Harness.exe' -e @"
const appDir='D:/deepseek/resources/app.asar/dsh';
import('file:///'+appDir+'/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js').then(m=>{
  const prof=m.loadProfileDirectory('dsh','$env:USERPROFILE/.dsh/profiles/<profile>',appDir+'/package.json',{});
  console.log('YAML ok, 插件条目:', prof.patches.length, ', skipped:', JSON.stringify(prof.skippedBundles));
}).catch(e=>{ console.log('FAIL:', e.message); process.exit(1); })
"@
```

**两个关键判断**：

1. **报错** → YAML 写坏了，DSH 起不来，立刻回滚
2. **`skipped` 不是 `[]`** → 有 bundle 被跳过（通常是 `insert:` 写错），必须修

`<profile>` 换成实际 profile 名，DSH 安装路径也按实际调整。

## 9. 直接告诉用户重启

**你没法重启 DSH（会中断自己）。** 明确告诉用户：

> 配置写好了，现在重启 DSH。重启后看日志里有没有这几行：
> - `qq-kit 0.3.0 启动，适配器=onebot`
> - `人格：...`
> - `情绪：...`

---

# 阶段四：重启后的验证（用户回来找你时）

## 检查启动日志

```powershell
Get-ChildItem "$env:USERPROFILE" -Filter 'qq-kit-trace.log' | ForEach-Object {
  Get-Content $_ | Select-String 'qq-kit.*启动|人格|情绪' | Select-Object -Last 5
}
```

## 检查能不能连上

trace 日志里找 `adapter` 或 `connected` 相关事件。

看到 `connected: true` 就是连上了。

**连不上，按这个顺序查**（让用户配合）：

1. accessToken 对不对
2. 协议端 WS 服务开着没
3. `messageFormat` 是不是 `string`
4. `role` 是不是 `Universal`

## 干跑验证

让用户在群里说几句话，然后：

```powershell
Get-Content "$env:USERPROFILE\qq-kit-trace.log" | Select-String '"event":"plan"' | Select-Object -Last 3
```

能看到 plan 就说明它在正常工作（只是没真发）。

---

# 自动化边界（说清楚，别越界）

**你可以改的**：

- `<profile>\package.json`
- `<profile>\cordis.patch.yml`（追加，不覆盖原有内容）

**你不该动的**：

- 现有的 `dsh.dependencies` 里的其它插件
- 现有的 `bundles` 顺序（只在末尾追加两个）
- 任何 `~/.dsh/plugins/` 下的东西（那是别人的）

**你做不到的**：

- 装协议端
- 重启 DSH
- 进协议端界面改设置

---

# 常见失败与对策

| 失败现象 | 原因 | 对策 |
|---|---|---|
| `git clone` 超时 | 网络 | 换另一个源 |
| Junction 创建失败 | 权限 / 目标已被占用 | 检查目标是否存在、问用户 |
| 日志没有任何 qq-kit 输出 | patch 没用 `insert:` | 重写那一段 |
| `cannot get property "xxx" without inject` | ctx 是 Proxy | 这是插件内部问题，让用户提 issue |
| 连不上（ECONNREFUSED） | 协议端没开 | 让用户检查 |
| 连上但收不到消息 | `messageFormat` 是 array | 让用户改 |
| 面板 404 | mood-kit 没加载 | 检查 bundles 顺序 |

---

# 一句话总结

**能做的做到底（拉代码、建链接、改配置），做不到的列清单一次性问清楚，改完配置让用户重启。**
