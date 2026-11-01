# 写一个适配器

适配器就是**协议端 ⇄ 内核**的翻译器。内核这边只认一套内部消息结构（`src/message.js`），
适配器负责把任意协议的消息翻成它、把要发的内容翻回去。

内核**不内置任何具体的协议端实现**。想接 QQ、微信、Discord、自己的玩具协议，
写一个适配器就行，内核一行都不用改。

---

## 一、契约

继承 `AdapterBase`（`src/adapter.js`），实现三个成员：

```js
import { AdapterBase } from '../src/adapter.js';
import { makeMessage, toSegments } from '../src/message.js';

export class MyAdapter extends AdapterBase {
  static get id() {
    return 'my-adapter';   // 配置里 adapter: 'my-adapter'
  }

  async start() {
    // 连上协议端；连不上就抛错，内核会打日志
    this.running = true;
    this.emitStatus({ connected: true, detail: '...' });

    // 收到消息时：
    this.emitMessage(makeMessage({
      chatKind: 'group',        // 'group' | 'private'
      chatId: '123456',         // 群号 / 对方 id
      sender: { id: '789', name: '群名片' },
      segments: toSegments([{ type: 'text', data: { text: '你好' } }]),
      time: Date.now(),
    }));
  }

  async stop() {
    // 必须幂等：内核可能重复调用
    this.running = false;
  }

  async send({ chatKind, chatId, segments }) {
    // 把内部段翻成协议格式发出去
    // 返回 { messageId } 可选
  }
}
```

### 必须遵守的三条

1. **只做翻译**。别在适配器里建会话、存记忆、管人设、调模型 —— 那些归内核。
   适配器越薄越好换。
2. **`stop()` 必须幂等**。DSH 停止、热重载、出错清理都会调它。
3. **出错别抛死**。内部异常走 `this.emitError(e)`，让内核记日志；
   只有"起不来"才从 `start()` 抛出。

### 生命周期

```
start() ──→ 收消息 emitMessage() / 断线 emitStatus({connected:false})
        └─→ 内核调 send() 发回复
stop()  ──→ 清理（可重复调用）
```

---

## 二、内部消息结构

最小集合，其余一律降级成 `text`，保证协议端加了新类型也不会崩。

| 段类型 | 字段 | 文本降级 |
|---|---|---|
| `text` | `text` | 原文 |
| `image` | `url?` / `file?` | `[图片]` |
| `video` | `url?` / `file?` | `[视频]` |
| `at` | `id` / `name?` | `@名字` |
| `reply` | `id` | （不显示） |
| `file` | `url?` / `file?` / `name?` | `[文件:名字]` |
| `unknown` | `raw` | （不显示） |

**图片和视频必须给 `url`**：内核要在收到消息时立刻下载（URL 有有效期），
没有 `url` 只能当看不到。

发送时至少要支持 `text` / `at` / `image`；不支持的类型直接忽略比报错好。

---

## 三、参考实现

`adapters/onebot.js` 是 OneBot v11 的完整参考实现（CQ 码解析、@ 段、图片、
重连退避、发送回执）。OneBot 是公开协议规范，任何 OneBot 实现（自建的、
开源的协议端）都能对接。

想接别的协议，照它的结构扒：

```
start()       建连接 + 断线重连（指数退避，1s → 30s）
onMessage()   协议事件 → toSegments() → emitMessage()
send()        内部段 → 协议格式 → 调接口 → 返回 messageId
stop()        关连接（幂等）
```

### 几个通用坑

- **重连要两边都排**：只监听 `close` 不够，很多库连不上时只发 `error` 不发 `close`。
- **图片/视频 URL 有时效**：内核收到就下载，适配器别缓存、别延迟投递。
- **@ 的 id**：用协议里的真实 id（QQ 号），别用昵称。内核靠它对记忆认人。
- **`@全体成员`**：一般用特殊值（OneBot 是 `all`），内核会当成"在叫大家"。
- **自己发的消息要不要回投**：看协议端有没有 `reportSelfMessage`。
  不回投会影响上下文连续性，回投要保证不自我循环。

---

## 四、注册

```js
import { AdapterRegistry } from './src/adapter.js';
import { MyAdapter } from './adapters/my-adapter.js';

const registry = new AdapterRegistry();
registry.register(MyAdapter.id, MyAdapter);
```

配置里 `adapter: 'my-adapter'`，`adapterOptions` 原样传给构造函数。

## 五、测试

适配器不需要跑真协议端也能测：用假的 transport（假 WS / 假 HTTP）驱动
`start()`，断言 `emitMessage` 收到了正确结构；再断言 `send()` 把段翻对了。

参考 `test/onebot.test.mjs`。
