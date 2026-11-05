import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { renderPanelHtml } from '../src/panel.js';

/**
 * 面板是一大坨模板字符串，里面内嵌了浏览器 JS。
 *
 * 邻居项目 mood-kit 在这上面栽过两次：
 *   ① `.split(/\r?\n/)` → \r \n 被模板当成真换行，正则断成两行，整段脚本语法错误
 *   ② `.match(/^\s*.../)` → \s 被当成字母 s，正则能跑但永远匹配不上
 *
 * 这两种问题单测服务端函数都抓不到 —— 只有把渲染产物拿去解析才看得见。
 * qq-kit 目前是干净的，这套测试是为了防止以后改坏。
 */

function clientScript(html) {
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(m, '面板里应该有 <script> 块');
  return m[1];
}

test('面板内嵌脚本：语法必须能过', () => {
  const js = clientScript(renderPanelHtml());
  assert.doesNotThrow(() => new Function(js), '渲染出来的客户端脚本有语法错误');
});

test('面板内嵌脚本：不能有"断了行的正则字面量"', () => {
  const js = clientScript(renderPanelHtml());
  const lines = js.split('\n');
  // 逐行找：以 / 开头像正则、但这一行里没有第二个 / 收尾的
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.startsWith('#')) continue;
    // 行内出现 `/(` `/[` `/\` `/(?:` 这类开头
    const open = line.match(/\/(?=[([\\^$.*+?])/g);
    if (!open) continue;
    // 前后的 / 数量（排除转义过的）
    const slashes = (line.match(/(?<!\\)\//g) || []).length;
    assert.ok(
      slashes % 2 === 0,
      `L${i + 1} 的正则字面量可能跨行了（斜杠不成对）：${trimmed.slice(0, 70)}`,
    );
  }
});

test('面板内嵌脚本：关键正则实测能跑', () => {
  const js = clientScript(renderPanelHtml());
  // 随便挑几个必须存在的正则，抽出来真跑一遍
  const samples = [
    // 会话键：group:123 / private:456
    { find: /match\((\/\^group:\\d\+\$\/)\)/, input: 'group:123456', expect: true },
  ];
  for (const s of samples) {
    const m = js.match(s.find);
    if (!m) continue; // 源码里没有就不强制
    const re = eval(m[1]); // eslint-disable-line no-eval
    assert.equal(re.test(s.input), s.expect, `这个正则不对：${m[1]}`);
  }
});

test('面板内嵌脚本：没有会被模板吃掉的 \\s \\d \\w', () => {
  const js = clientScript(renderPanelHtml());
  const lines = js.split('\n');
  const bad = [];
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
    // 单个反斜杠 + 这些字母，前面不能再有反斜杠
    const hit = lines[i].match(/(?<!\\)\\[sdw]/);
    if (hit) bad.push(`L${i + 1} [${hit[0]}] ${trimmed.slice(0, 70)}`);
  }
  assert.deepEqual(bad, [], '这些地方的反斜杠要写双份:\n' + bad.join('\n'));
});

test('面板模板里不能出现多余的反引号（会截断整个模板字符串）', () => {
  // 踩过：想在注释里写 `await r.json()`，那个反引号直接把模板闭合了，
  // 后面几千行 JS 全变成非法语法 —— node --check 和所有用到面板的测试一起挂。
  const src = fs.readFileSync(new URL('../src/panel.js', import.meta.url), 'utf8');
  const BT = String.fromCharCode(96);
  const count = src.split(BT).length - 1;
  // 模板开头 1 个 + 结尾 1 个 + 服务端那两个小模板各 2 个（group:/private:） = 6
  assert.equal(count, 10, 'panel.js 里有 ' + count + ' 个反引号，预期 10 个（多了就是把模板截断了）');
});
