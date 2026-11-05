import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { renderDiaryHtml, listDiaryPeople, readDiary } from '../src/diary-panel.js';

function tmpDiary() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diarypanel-'));
  const dir = path.join(root, '200000001');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, '123456789.md'),
    [
      '# 某人（QQ 123456789）',
      '',
      '## 事件',
      '',
      '- 11-03 18:20 让我把情绪调淡一点',
      '- 11-02 23:15 半夜还在改配置',
      '',
    ].join('\n'),
    'utf8',
  );
  return root;
}

test('listDiaryPeople：读出名字、号、条数', () => {
  const root = tmpDiary();
  const list = listDiaryPeople(root, '200000001');
  assert.equal(list.length, 1);
  assert.equal(list[0].name, '某人');
  assert.equal(list[0].userId, '123456789');
  assert.equal(list[0].count, 2);
  fs.rmSync(root, { recursive: true, force: true });
});

test('listDiaryPeople：目录不存在时返回空，不炸', () => {
  assert.deepEqual(listDiaryPeople('/不存在的路径', '123'), []);
  assert.deepEqual(listDiaryPeople('', ''), []);
});

test('listDiaryPeople：按最近更新排', () => {
  const root = tmpDiary();
  const dir = path.join(root, '200000001');
  fs.writeFileSync(path.join(dir, '100000001.md'), '# 老一点（QQ 100000001）\n\n## 事件\n\n- 10-01 08:00 很久以前\n', 'utf8');
  const list = listDiaryPeople(root, '200000001');
  assert.equal(list[0].userId, '123456789', '最近说话的排前面');
  fs.rmSync(root, { recursive: true, force: true });
});

test('readDiary：读得到，读不到返回空串', () => {
  const root = tmpDiary();
  assert.match(readDiary(root, '200000001', '123456789'), /情绪调淡/);
  assert.equal(readDiary(root, '200000001', '999'), '');
  fs.rmSync(root, { recursive: true, force: true });
});

test('readDiary：路径穿越不行', () => {
  const root = tmpDiary();
  assert.equal(readDiary(root, '../../etc', '../../passwd'), '');
  fs.rmSync(root, { recursive: true, force: true });
});

test('renderDiaryHtml：列出群和人对，能点进详情', () => {
  const root = tmpDiary();
  const groups = [{ id: '200000001', label: '群 200000001', people: listDiaryPeople(root, '200000001') }];
  const html = renderDiaryHtml({
    groups,
    activeGroup: '200000001',
    activePerson: groups[0].people[0],
    content: readDiary(root, '200000001', '123456789'),
    root,
  });
  assert.match(html, /群友日记/);
  assert.match(html, /某人/);
  assert.match(html, /123456789/);
  assert.match(html, /让我把情绪调淡一点/, '事件要出现在时间线里');
  assert.match(html, /timeline/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('renderDiaryHtml：没选人时给提示，不报错', () => {
  const html = renderDiaryHtml({ groups: [{ id: '1', label: '群 1', people: [] }], activeGroup: '1' });
  assert.match(html, /左边选一个人/);
  assert.match(html, /还没有日记/);
});

test('renderDiaryHtml：XSS 要转义', () => {
  const html = renderDiaryHtml({
    groups: [{ id: '1', label: '<script>alert(1)</script>', people: [{ userId: '1', name: '<img onerror=x>', count: 0, last: 0 }] }],
    activeGroup: '1',
  });
  assert.ok(!html.includes('<script>alert(1)</script>'), '群名不能原样进 HTML');
  assert.ok(!html.includes('<img onerror'), '昵称不能原样进 HTML');
});

test('renderDiaryHtml：数据内嵌，切换不刷新', () => {
  const root = tmpDiary();
  const groups = [{ id: '200000001', label: '群 200000001', people: listDiaryPeople(root, '200000001') }];
  const diaries = { '200000001/123456789': readDiary(root, '200000001', '123456789') };
  const html = renderDiaryHtml({
    groups,
    diaries,
    activeGroup: '200000001',
    activePerson: groups[0].people[0],
    content: diaries['200000001/123456789'],
    root,
  });

  assert.match(html, /var DATA =/, '数据要内嵌进页面');
  assert.match(html, /data-person=/, '左栏要有 data-person 供点击');
  assert.match(html, /\$list\.addEventListener/, '要有点击监听');
  assert.ok(!/location\.href\s*=/.test(html), '不能用跳转（那样会刷新）');
  assert.match(html, /history\.replaceState/, '地址栏要跟着变但不刷新');

  fs.rmSync(root, { recursive: true, force: true });
});

test('renderDiaryHtml：时间线新的在上', () => {
  const root = tmpDiary();
  const dir = path.join(root, '200000001');
  fs.writeFileSync(
    path.join(dir, '100000001.md'),
    [
      '# 甲（QQ 100000001）',
      '',
      '## 事件',
      '',
      '- 11-01 10:00 早的事',
      '- 11-03 20:00 晚的事',
      '',
    ].join('\n'),
    'utf8',
  );
  const html = renderDiaryHtml({
    groups: [{ id: '200000001', label: '群', people: listDiaryPeople(root, '200000001') }],
    activeGroup: '200000001',
    activePerson: { userId: '100000001', name: '甲', last: Date.now() },
    content: readDiary(root, '200000001', '100000001'),
    root,
  });
  const i晚 = html.indexOf('晚的事');
  const i早 = html.indexOf('早的事');
  assert.ok(i晚 > 0 && i早 > 0);
  assert.ok(i晚 < i早, '新的应该排在前面');
  fs.rmSync(root, { recursive: true, force: true });
});

test('listDiaryPeople：补全名单，有日记的排前面', () => {
  const root = tmpDiary();
  const roster = [
    { id: '123456789', name: '某人' },   // 有日记
    { id: '100000001', name: '老王' },        // 没日记
    { id: '100000002', name: '小李' },        // 没日记
  ];
  const list = listDiaryPeople(root, '200000001', { roster });

  assert.equal(list.length, 3, '三个都要列出来');
  assert.equal(list[0].userId, '123456789', '有日记的排前面');
  assert.equal(list[0].hasDiary, true);
  assert.equal(list[0].count, 2);

  const rest = list.slice(1);
  assert.ok(rest.every((p) => p.hasDiary === false), '没日记的在后');
  assert.ok(rest.every((p) => p.count === 0), '没日记的 count 是 0');
  assert.ok(rest.every((p) => p.userId && p.name), '号名字都要有');

  fs.rmSync(root, { recursive: true, force: true });
});

test('listDiaryPeople：补全按 QQ 号去重，不重复列出同一个人', () => {
  const root = tmpDiary();
  const roster = [
    { id: '123456789', name: '改名了的主人' },  // 跟日记里重号
    { id: '999', name: '新人' },
  ];
  const list = listDiaryPeople(root, '200000001', { roster });
  const hits = list.filter((p) => p.userId === '123456789');
  assert.equal(hits.length, 1, '同号只能有一条');
  assert.equal(hits[0].hasDiary, true, '以日记里的为准');
  fs.rmSync(root, { recursive: true, force: true });
});

test('listDiaryPeople：名单里没号的条目跳过', () => {
  const root = tmpDiary();
  const list = listDiaryPeople(root, '200000001', {
    roster: [{ id: '', name: '没号的人' }, { name: '也没号' }, { id: '123', name: '有号' }],
  });
  assert.ok(!list.some((p) => p.name === '没号的人'), '没号的不该出现');
  assert.ok(list.some((p) => p.userId === '123'), '有号的要出现');
  fs.rmSync(root, { recursive: true, force: true });
});

test('listDiaryPeople：没有日记目录但有名单时，也能列出人', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'nodir-'));
  const list = listDiaryPeople(empty, '999', { roster: [{ id: '1', name: '甲' }] });
  assert.equal(list.length, 1);
  assert.equal(list[0].hasDiary, false);
  fs.rmSync(empty, { recursive: true, force: true });
});

test('listDiaryPeople：主人永远排第一，哪怕没日记', () => {
  const root = tmpDiary();
  const roster = [
    { id: '100000001', name: '老王' },
    { id: '123456789', name: '主人', isOwner: true },
    { id: '100000002', name: '小李' },
  ];
  const list = listDiaryPeople(root, '200000001', { roster, ownerId: '123456789' });
  assert.equal(list[0].userId, '123456789', '主人要在第一位');
  assert.equal(list[0].isOwner, true);
});

test('listDiaryPeople：ownerId 能标出主人，不依赖 roster 里的 isOwner', () => {
  const root = tmpDiary();
  const list = listDiaryPeople(root, '200000001', { roster: [{ id: '123456789', name: '主人' }], ownerId: '123456789' });
  const me = list.find((p) => p.userId === '123456789');
  assert.equal(me.isOwner, true, '靠 ownerId 也要能标上');
});

test('listDiaryPeople：没 diary、没 roster 时不会凭空造人', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'noroster-'));
  assert.deepEqual(listDiaryPeople(empty, '1', { ownerId: '123456789' }), []);
  fs.rmSync(empty, { recursive: true, force: true });
});
