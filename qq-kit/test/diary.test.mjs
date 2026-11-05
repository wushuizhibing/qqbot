import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  diaryPath,
  formatStamp,
  parseDiary,
  renderDiary,
  mergeDiary,
  writeDiaryFile,
  pickPeopleForDiary,
  DIARY_MAX_EVENTS,
} from '../src/diary.js';

test('diaryPath：按群号/QQ号分目录，文件名要安全', () => {
  const p = diaryPath('D:/dsh-data/qq-diary', '200000001', '123456789');
  assert.match(p, /200000001/);
  assert.match(p, /123456789\.md$/);
  assert.equal(path.basename(p), '123456789.md');
});

test('diaryPath：非法字符不能进文件名', () => {
  const p = diaryPath('/root', '../evil', '../../etc/passwd');
  assert.ok(!p.includes('..'), `路径不该有 ..: ${p}`);
  assert.ok(!p.includes('etc/passwd'), `不该串到别的目录: ${p}`);
});

test('diaryPath：群号和号都不能为空', () => {
  const p = diaryPath('/root', '', '');
  assert.match(p, /unknown/);
});

test('formatStamp：月日时分，补零', () => {
  const d = new Date(2026, 0, 5, 8, 3); // 1 月 5 日 08:03
  assert.equal(formatStamp(d.getTime()), '01-05 08:03');
});

test('renderDiary：标题带 QQ 号，事件带时间', () => {
  const text = renderDiary({
    name: '老王',
    userId: '100000001',
    events: [{ at: new Date(2026, 10, 3, 18, 20).getTime(), text: '让我把情绪调淡一点' }],
  });
  assert.match(text, /^# 老王（QQ 100000001）/);
  assert.match(text, /## 事件/);
  assert.match(text, /- 11-03 18:20 让我把情绪调淡一点/);
});

test('renderDiary：没有事件时说清楚，不留空', () => {
  const text = renderDiary({ name: '甲', userId: '1', events: [] });
  assert.match(text, /还没有记下什么/);
});

test('parseDiary：能读回来（round-trip）', () => {
  const src = {
    name: '老李',
    userId: '200000002',
    events: [
      { at: new Date(2026, 10, 1, 10, 30).getTime(), text: '答应了明天开黑' },
      { at: new Date(2026, 10, 2, 20, 5).getTime(), text: '说了自己搬家了' },
    ],
  };
  const text = renderDiary(src);
  const back = parseDiary(text);
  assert.equal(back.name, '老李');
  assert.equal(back.userId, '200000002');
  assert.equal(back.events.length, 2);
  assert.equal(back.events[0].text, '答应了明天开黑', '事件内容要原样回来');
  assert.deepEqual(
    back.events.map((e) => [e.at, e.text]),
    [...src.events].sort((a, b) => a.at - b.at).map((e) => [e.at, e.text]),
    '时间戳要对得上',
  );
});

test('parseDiary：坏文本不炸', () => {
  assert.deepEqual(parseDiary(''), { name: '', userId: '', intro: '', events: [] });
  assert.deepEqual(parseDiary(null).events, []);
});

test('mergeDiary：新事件并进去，按时间排', () => {
  const old = {
    name: '甲',
    userId: '1',
    events: [{ at: new Date(2026, 10, 3, 12, 0).getTime(), text: '旧事件' }],
  };
  const next = mergeDiary(old, [{ at: new Date(2026, 10, 2, 9, 0).getTime(), text: '更早的事件' }]);
  assert.equal(next.events.length, 2);
  const sorted = renderDiary(next);
  assert.ok(sorted.indexOf('11-02') < sorted.indexOf('11-03'), '渲染时按时间排');
});

test('mergeDiary：同一分钟内一样的话不记两遍', () => {
  const at = new Date(2026, 10, 3, 12, 0).getTime();
  const old = { name: '甲', userId: '1', events: [{ at, text: '让我安静' }] };
  const next = mergeDiary(old, [{ at: at + 5000, text: '让我 安静' }]);
  assert.equal(next.events.length, 1, '去掉空白后相同就算重复');
});

test('mergeDiary：空事件跳过', () => {
  const old = { name: '甲', userId: '1', events: [] };
  const next = mergeDiary(old, [{ at: Date.now(), text: '   ' }, { at: Date.now(), text: '' }]);
  assert.equal(next.events.length, 0);
});

test('mergeDiary：单条太长要截断', () => {
  const old = { name: '甲', userId: '1', events: [] };
  const next = mergeDiary(old, [{ at: Date.now(), text: 'x'.repeat(200) }]);
  assert.ok(next.events[0].text.length <= 60, `实际 ${next.events[0].text.length}`);
});

test('renderDiary：事件太多只留最近 N 条', () => {
  const events = Array.from({ length: DIARY_MAX_EVENTS + 20 }, (_, i) => ({
    at: new Date(2026, 0, 1).getTime() + i * 60000,
    text: `事件${i}`,
  }));
  const text = renderDiary({ name: '甲', userId: '1', events });
  const count = (text.match(/^- \d{2}-\d{2}/gm) ?? []).length;
  assert.equal(count, DIARY_MAX_EVENTS);
  assert.ok(text.includes(`事件${events.length - 1}`), '留的是最新的');
  assert.ok(!text.includes('事件0'), '最旧的被丢掉了');
});

test('writeDiaryFile：写盘 + 备份 + 原子写', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diary-'));
  const file = path.join(dir, '200000001', '123456789.md');

  const r1 = writeDiaryFile(file, '# 甲（QQ 1）\n\n## 事件\n');
  assert.equal(r1.backup, null, '第一次没有备份');
  assert.ok(fs.existsSync(file));

  const r2 = writeDiaryFile(file, '# 甲（QQ 1）\n\n## 事件\n- 11-03 12:00 新的一条\n');
  assert.ok(r2.backup && fs.existsSync(r2.backup), '第二次要备份');
  assert.ok(!fs.existsSync(`${file}.tmp-${process.pid}`), '临时文件不能留');
  assert.match(fs.readFileSync(file, 'utf8'), /新的一条/);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('pickPeopleForDiary：按说话条数排，同一个人只算一次', () => {
  const records = [
    { id: '1', name: '甲' }, { id: '1', name: '甲' }, { id: '1', name: '甲' },
    { id: '2', name: '乙' },
    { id: '3', name: '丙' }, { id: '3', name: '丙' },
  ];
  const picked = pickPeopleForDiary(records, 2);
  assert.deepEqual(picked.map((p) => p.id), ['1', '3'], '说话多的排前面');
  assert.equal(picked[0].count, 3);
});

test('pickPeopleForDiary：没号没名的人跳过', () => {
  const records = [{ id: '', name: '甲' }, { id: '2', name: '' }, { id: '3', name: '丙' }];
  assert.deepEqual(pickPeopleForDiary(records).map((p) => p.id), ['3']);
});
