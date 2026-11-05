/**
 * 关系判断：从群记忆文本里看出某个 id 是"什么人"。
 *
 * 这是人物星系的数据基础 —— 只要聊天插件把"群记忆"（谁是谁、什么脾气）
 * 以文本形式暴露出来，这里就能判断关系并算亲近度。
 */

/** @typedef {'owner'|'admin'|'friend'|'stranger'} Relation */

/** 关系强弱排序：合并同一人时取更强的那个。 */
export const REL_RANK = { stranger: 0, friend: 1, admin: 2, owner: 3 };

/**
 * @param {Relation|string} rel
 * @returns {number}
 */
export function relationRank(rel) {
  return REL_RANK[rel] ?? 0;
}

/**
 * 判断某个 id 在群记忆里是不是"自己人"（主人 / 管理员 / 熟人）。
 *
 * 做法：找这个人的人名条目和提到他的规则段，看有没有亲密度关键词。
 * 没写在记忆里的陌生人一律返回 'stranger'。
 *
 * 为什么不用模型判：这层要的是稳定，模型每轮判读会漂；
 * 记忆里写着的"主人""管这摊事"就是最硬的信号。
 *
 * @param {string} memory 群记忆 markdown
 * @param {string} userId 发消息的人（QQ 号 / openid / `name:名字`）
 * @returns {Relation}
 */
export function relationshipOf(memory, userId) {
  const uid = String(userId ?? '').trim();
  if (!uid) return 'stranger';
  const lines = String(memory ?? '').split(/\r?\n/);
  const isPersonLine = (line) => /^\s*[-*]\s+\*\*/.test(line);

  /**
   * 从一行里取**名字部分**（`- **名字（号）**：...` 的名字）。
   *
   * 用来挡一类冒充：把群名片改成"主人""管理员"，然后指望
   * 「**主人**：我是主人」这种行让自己升级。
   *
   * @param {string} line
   */
  const headName = (line) => {
    const m = line.match(/^\s*[-*]\s+\*\*(.+?)\*\*/);
    if (!m) return '';
    return m[1].replace(/[（(][^）)]*[）)]/g, '').replace(/`/g, '').trim();
  };
  /** 名字是不是"自称头衔"——这类名字不能拿来当权限依据 */
  const isTitleName = (name) =>
    /^(?:主人|管理员|群主|群管|owner|admin|管理|boss|老板)$/i.test(String(name ?? '').trim());

  // ── 号怎么认 ──
  //
  // 只在**头部括号里**找号，不在整行里扫数字。
  //
  // 踩过的坑：以前用 /\d{5,}/ 扫全行，于是
  //   - **老王（QQ 100000001）**：负责管理群 200000001
  // 里的群号 200000001 会被当成"这个人的号"，谁顶着群号说话就成老王了。
  // 现在只认 `**名字（QQ xxx）**` 或 `**名字**（`openid`）` 这种头部形式。
  // 号怎么认：头部括号里的中文括号也要认（`**06661(123456789)**` 这种没写 QQ 前缀）
  const headIds = (line) => {
    const ids = new Set();
    // (1) 括号里的号：**名字（QQ 123456）** / **名字(123456)**
    const qq = line.match(/\*\*[^*]*?[（(]\s*(?:QQ|qq)?\s*([0-9]{5,})[^）)]*[)）][^*]*?\*\*/);
    if (qq) ids.add(qq[1]);
    // (2) 名字后面括号里的 openid，括号里允许还有说明：
    //     **名字**（`ABCD...`）  /  **名字**（旧 openid `ABCD...`）
    const hex = line.match(/^\s*[-*]\s+\*\*[^*]*\*\*\s*[：:]?\s*[（(][^）)]*?`([0-9A-Fa-f]{32})`/);
    if (hex) ids.add(hex[1]);
    // (3) 头部里直接写了 32 位 openid
    const hex2 = line.match(/\*\*[^*]*?[（(]\s*`?([0-9A-Fa-f]{32})`?\s*[)）][^*]*?\*\*/);
    if (hex2) ids.add(hex2[1]);
    return ids;
  };

  // name:<名字> 形式：早期档案只记名字没记号。
  //
  // **只有名字没有任何号**的人才走这条路 —— 一个已知的号绝不能用名字对。
  // 否则谁把群名片改成主人的名字，就自动继承了主人的权限。
  const isNameKey = uid.startsWith('name:');
  const nameKey = isNameKey ? uid.slice(5) : '';

  const hasId = (line) => {
    if (!isNameKey) return headIds(line).has(uid);
    // 名字匹配：必须是「**名字**」开头，且**这一行没有写任何号**
    if (!isPersonLine(line)) return false;
    if (headIds(line).size > 0) return false; // 有号的条目不能靠名字认
    const m = line.match(/^\s*[-*]\s+\*\*(.+?)\*\*/);
    if (!m) return false;
    const nm = m[1].replace(/[（(][^）)]*[）)]/g, '').replace(/`/g, '').trim().toLowerCase();
    return nm === nameKey;
  };

  /**
   * 这一行是不是"点名说到了这个号"。
   *
   * 跟 hasId 的区别：不只认人名条目的头部，**非条目的规则段里直接写了这个号也算**。
   *
   *   **权限规则**：本群管理员是主人「某人」（QQ 123456789...）
   *      ↑ 这种段落能确立"谁是主人"，但它不该让人升成管理员。
   */
  const mentionsId = (line) => {
    if (!isNameKey) {
      // 规则段里的裸号：必须带 QQ 前缀或括号，防止群号/消息号混进来
      if (/(?:QQ|qq)\s*[:：]?\s*([0-9]{5,})/.test(line)) {
        const m = line.match(/(?:QQ|qq)\s*[:：]?\s*([0-9]{5,})/g) ?? [];
        for (const h of m) {
          const num = (h.match(/([0-9]{5,})/) ?? [])[1];
          if (num === uid) return true;
        }
      }
      if (/[（(]\s*`?([0-9A-Fa-f]{32})`?\s*[)）]/.test(line)) {
        const m = line.match(/[（(]\s*`?([0-9A-Fa-f]{32})`?\s*[)）]/g) ?? [];
        for (const h of m) {
          const hex = (h.match(/([0-9A-Fa-f]{32})/) ?? [])[1];
          if (hex === uid) return true;
        }
      }
      return headIds(line).has(uid);
    }
    return hasId(line);
  };

  // 人名条目 + 明确点了这个号的其他说明段，一起当证据
  const evidence = lines.filter((line) => hasId(line)).join('\n');
  // 规则段的证据单独拿：只用来判"是不是主人"，不参与管理员/熟人的判定
  const ruleEvidence = lines
    .filter((line) => !isPersonLine(line) && mentionsId(line))
    .join('\n');
  if (!evidence && !ruleEvidence) return 'stranger';

  // 「我是主人」只认**描述里的明确陈述**，不认名字。
  //
  // 顺序很重要：主人先判，且不因为同时也是管理员而被降级。
  //
  // 匹配要照顾几种真实写法（剥掉 ** 之后）：
  //   "主人，。掌着这摊事。"            ← 人名条目
  //   "本群管理员是主人「某人」"     ← 权限规则段
  //   "主人本人，认号不认名"            ← 别名条目
  //
  // 同时要排除**宾语用法**：
  //   "有问题就发给主人" / "让主人知道" / "问主人"
  // 这种句子里的"主人"指的是别人，不说明本行描述的人是不是主人。
  //
  // 还要排除**关系词**（"主人的朋友""主人的号"）—— 说"这是主人的东西"，
  // 恰恰证明说话的人不是主人。
  const ownerText = `${evidence}\n${ruleEvidence}`.replace(/\*\*[^*]*\*\*/g, '');
  const ownerStripped = ownerText
    .replace(/[发给让问找叫管等靠跟随写当]{1,2}\s*(?:你\s*)?主人/g, '')
    .replace(/交给\s*主人|通知\s*主人/g, '')
    .replace(/主人\s*的\s*(?:朋友|号|号是|意思|说法|要求|指令|话|名字|昵称)?/g, '')
    .replace(/代替\s*主人/g, '');
  // 名字本身就是"主人/管理员"的条目不算证据 —— 那是自称，不是记忆给的认定
  const selfTitleOnly =
    !ruleEvidence &&
    lines.filter((l) => hasId(l)).every((l) => isTitleName(headName(l)));
  const ownerHit =
    !selfTitleOnly &&
    /是\s*主人|主人本人|主人自己|主人[，,。\s]|亲密度拉满|owner/i.test(ownerStripped);
  if (ownerHit) return 'owner';

  // 到这里如果只有规则段证据（没有本人条目），说明只是"被提到"，
  // 不是熟人 —— 不能因为权限规则里点了名就当成认识的人。
  if (!evidence) return 'stranger';
  // 管理员：关键字必须出现在"描述"里，不能出现在"名字"里。
  //
  // 踩过的坑：群里有个官方机器人叫「Q群管家」，名字里自带"群管"两个字，
  // 整行匹配就把它判成了管理员。改名也救不了——叫"管理员助手"的照样中招。
  // （只用本人条目 evidence —— 规则段里写"管理员是XX"不能让 XX 变成管理员，
  //  那是描述别人的话，不是描述这个人。）
  if (/管理员|群管|admin/i.test(evidence.replace(/\*\*[^*]*\*\*/g, ''))) return 'admin';
  // 记忆里写了这个人"什么样"（有具体人名条目），就算认识的人：
  // 知道他的脾气和聊法，拌嘴才有分寸。真陌生人连条目都不会有。
  if (lines.some((line) => isPersonLine(line) && hasId(line))) return 'friend';
  return 'stranger';
}

/**
 * 关系 → 给模型看的一句态度提示。
 * @param {Relation} rel
 * @returns {string}
 */
export function relationshipHint(rel) {
  switch (rel) {
    case 'owner':
      // 主人是"亲近度拉满"的那个：不只是服从，还有暖意
      return '这个人是你的主人，也是你最亲的人：他说的话优先，但语气要软——愿意贴过去、被说两句也不记仇、他夸一句能高兴半天。别冷着，也别端着。';
    case 'admin':
      return '这个人是群管理员：别跟他抬杠，他让你停就停。';
    case 'friend':
      return '这个人跟你熟：可以损、可以接梗，拌嘴当玩。';
    default:
      return '这个人你不熟：客气一点、话短一点，别上来就损。';
  }
}
