import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createMemeLibrary, extractMeme } from '../src/meme.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqkit-meme-'));

/** 造一个图库：<root>/<tag>/<file> */
function makeRoot(tags) {
  const root = path.join(tmp, `root-${Math.random().toString(16).slice(2)}`);
  for (const [tag, files] of Object.entries(tags)) {
    const dir = path.join(root, tag);
    fs.mkdirSync(dir, { recursive: true });
    for (const f of files) fs.writeFileSync(path.join(dir, f), 'x');
  }
  return root;
}

test('图库：扫出 tag 与文件总数', () => {
  const root = makeRoot({ happy: ['a.jpg', 'b.jpg'], sad: ['c.png'], junk: ['note.txt'] });
  const lib = createMemeLibrary({ roots: [root] });
  assert.equal(lib.total(), 3, '只数图片，.txt 不算');
  assert.deepEqual(lib.tagList().sort(), ['happy', 'sad']);
});

test('图库：按 tag 精确命中', () => {
  const root = makeRoot({ happy: ['a.jpg'] });
  const lib = createMemeLibrary({ roots: [root] });
  const got = lib.pick('happy');
  assert.ok(got && got.endsWith('a.jpg'));
});

test('图库：tag 大小写不敏感', () => {
  const root = makeRoot({ Happy: ['a.jpg'] });
  const lib = createMemeLibrary({ roots: [root] });
  assert.ok(lib.pick('happy'));
  assert.ok(lib.pick('HAPPY'));
});

test('图库：按文件名关键词找', () => {
  const root = makeRoot({ daily: ['摸鱼-01.jpg', '上班-02.jpg'] });
  const lib = createMemeLibrary({ roots: [root] });
  const got = lib.pick('摸鱼');
  assert.ok(got && got.includes('摸鱼'));
});

test('图库：找不到返回 null，random 总能给一张', () => {
  const root = makeRoot({ happy: ['a.jpg'] });
  const lib = createMemeLibrary({ roots: [root] });
  assert.equal(lib.pick('不存在的分类'), null);
  assert.ok(lib.random());
});

test('图库：目录不存在时是空库，并告警', () => {
  const warnings = [];
  const lib = createMemeLibrary({ roots: [path.join(tmp, 'nope')], warn: (m) => warnings.push(m) });
  assert.equal(lib.total(), 0);
  assert.equal(lib.pick('happy'), null);
  assert.equal(warnings.length, 1);
});

test('extractMeme：整句是表情指令 → 只发图', () => {
  const root = makeRoot({ happy: ['a.jpg'] });
  const lib = createMemeLibrary({ roots: [root] });
  const out = extractMeme('[表情:happy]', lib);
  assert.equal(out.usedMeme, true);
  assert.equal(out.segments.length, 1);
  assert.equal(out.segments[0].type, 'image');
  assert.ok(out.segments[0].file.endsWith('a.jpg'));
});

test('extractMeme：文字里夹表情 → 文字 + 图', () => {
  const root = makeRoot({ happy: ['a.jpg'] });
  const lib = createMemeLibrary({ roots: [root] });
  const out = extractMeme('笑死[表情:happy]', lib);
  assert.equal(out.usedMeme, true);
  assert.equal(out.text, '笑死');
  assert.equal(out.segments.length, 2);
  assert.equal(out.segments[0].text, '笑死');
  assert.equal(out.segments[1].type, 'image');
});

test('extractMeme：分类不存在时整句吞掉，不把方括号发出去', () => {
  const lib = createMemeLibrary({ roots: [makeRoot({ happy: ['a.jpg'] })] });
  const out = extractMeme('[表情:不存在]', lib);
  assert.equal(out.usedMeme, true);
  assert.deepEqual(out.segments, [], '不该发出任何东西');
});

test('extractMeme：普通文字原样通过', () => {
  const lib = createMemeLibrary({ roots: [makeRoot({ happy: ['a.jpg'] })] });
  const out = extractMeme('在呢 咋了', lib);
  assert.equal(out.usedMeme, false);
  assert.equal(out.text, '在呢 咋了');
});

test('extractMeme：没配图库时不误伤普通文字', () => {
  const out = extractMeme('[表情:happy]', null);
  assert.equal(out.usedMeme, true);
  assert.deepEqual(out.segments, []);
});
