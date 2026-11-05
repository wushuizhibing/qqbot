import test from 'node:test';
import assert from 'node:assert/strict';

import { renderPanelHtml } from '../src/panel.js';

/**
 * 面板整个是一大坨模板字符串，里面内嵌了浏览器 JS。
 *
 * 踩过两次同样的坑，都是"渲染出来的 JS 是坏的"：
 *   ① `.split(/\r?\n/)` → \r \n 被模板当成真换行，正则断成两行，整段脚本语法错误
 *   ② `.match(/^\s*.../)` → \s 被当成字母 s，正则能跑但永远匹配不上，
 *      表现是"左边显示 3 条、右边说没有事件"
 *
 * 这两种问题单测服务端函数都抓不到 —— 只有把渲染产物拿去解析才看得见。
 * 所以这里直接对 renderPanelHtml() 的输出做检查。
 */

/** 把页面里的客户端脚本抠出来 */
function clientScript(html) {
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(m, '面板里应该有 <script> 块');
  return m[1];
}

test('面板内嵌脚本：语法必须能过（构造不出来就是转义写坏了）', () => {
  const js = clientScript(renderPanelHtml());
  assert.doesNotThrow(() => new Function(js), '渲染出来的客户端脚本有语法错误');
});

test('面板内嵌脚本：日记时间线的正则真的对上了', () => {
  const js = clientScript(renderPanelHtml());

  // 从渲染产物里把那段正则取出来，实测它能不能匹配真实的一行日记
  const m = js.match(/line\.match\((\/\^[\s\S]*?\$\/)\)/);
  assert.ok(m, '没找到日记时间线的正则');
  const re = eval(m[1]); // eslint-disable-line no-eval

  const line = '- 11-03 21:49 说我都TM开源了还说骗钱';
  const hit = line.match(re);
  assert.ok(hit, `这个正则匹配不上日记行：${m[1]}`);
  assert.equal(hit[5], '说我都TM开源了还说骗钱', '抓到的正文不对');
});

test('面板内嵌脚本：按行切分的正则真的能切', () => {
  const js = clientScript(renderPanelHtml());
  const m = js.match(/\.split\((\/\\r\?\\n\/)\)/);
  assert.ok(m, '没找到日记分行的正则');
  const re = eval(m[1]); // eslint-disable-line no-eval
  assert.deepEqual('a\r\nb\nc'.split(re), ['a', 'b', 'c'], '换行切分不对');
});

test('面板内嵌脚本：不能出现"断了行的正则字面量"', () => {
  const js = clientScript(renderPanelHtml());
  // 去掉注释，再找"以 / 开头、中间没有闭合就换行"的片段
  const stripped = js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const lines = stripped.split('\n');
  let insideRegex = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    // 粗略判断：出现 `/(` 或 `/[` 后没有闭合的 `/`
    const open = (line.match(/\/(?=[(\[\\^$.*+?])/g) || []).length;
    if (open > 0 && !insideRegex) {
      // 检查这一行里是否有成对的 /
      const slashes = (line.match(/(?<!\\)\//g) || []).length;
      if (slashes % 2 !== 0) insideRegex = true;
    } else if (insideRegex) {
      const slashes = (line.match(/(?<!\\)\//g) || []).length;
      if (slashes > 0) insideRegex = false;
      else assert.fail(`L${i + 1} 的正则字面量跨行了：${line.trim().slice(0, 60)}`);
    }
  }
});
