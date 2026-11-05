import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { findArchivable, archiveSessions } from '../src/archive.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-11-05T20:00:00+08:00').getTime();

/** 造一个会话目录 */
function mkSession(root, profile, name, { preset = 'qq-kit-chat', ageDays = 10, body = [] } = {}) {
  const dir = path.join(root, profile, name);
  fs.mkdirSync(dir, { recursive: true });
  const meta = { type: 'session', version: 4, id: name, agentPreset: preset, createdAt: NOW - ageDays * DAY };
  const lines = [JSON.stringify(meta), ...body.map((b) => JSON.stringify(b))];
  const packed = zlib.zstdCompressSync(Buffer.from(lines.join('\n'), 'utf8'));
  const file = path.join(dir, 'session.v4.jsonl.zstd');
  fs.writeFileSync(file, packed);
  // mtime 设成 old
  const t = new Date(NOW - ageDays * DAY);
  fs.utimesSync(file, t, t);
  return dir;
}

function mkRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'archive-'));
}

const PROFILE = '--C-Users-x-.dsh-profiles-desktop--';

test('findArchivable：只挑 qq-kit-chat，不碰 standard', () => {
  const root = mkRoot();
  mkSession(root, PROFILE, 'session-a', { preset: 'qq-kit-chat', ageDays: 10 });
  mkSession(root, PROFILE, 'session-b', { preset: 'standard', ageDays: 10 });

  const r = findArchivable({ sessionsRoot: root, keepDays: 7, now: NOW });
  assert.equal(r.candidates.length, 1, '只该挑 QQ 会话');
  assert.ok(r.candidates[0].dir.endsWith('session-a'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('findArchivable：还没到日子就不动', () => {
  const root = mkRoot();
  mkSession(root, PROFILE, 'session-new', { ageDays: 2 });
  const r = findArchivable({ sessionsRoot: root, keepDays: 7, now: NOW });
  assert.equal(r.candidates.length, 0, '2 天前的不该归档');
  fs.rmSync(root, { recursive: true, force: true });
});

test('findArchivable：有对话内容的跳过（删了补不回来）', () => {
  const root = mkRoot();
  mkSession(root, PROFILE, 'session-full', {
    ageDays: 20,
    body: [{ type: 'message', role: 'user', content: '有人在吗' }, { type: 'message', role: 'assistant', content: '在' }],
  });
  const r = findArchivable({ sessionsRoot: root, keepDays: 7, now: NOW });
  assert.equal(r.candidates.length, 0, '有内容的不归档');
  assert.equal(r.skippedWithContent, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test('findArchivable：空壳才归档', () => {
  const root = mkRoot();
  mkSession(root, PROFILE, 'session-empty', { ageDays: 20, body: [] });
  const r = findArchivable({ sessionsRoot: root, keepDays: 7, now: NOW });
  assert.equal(r.candidates.length, 1);
  assert.equal(r.candidates[0].ageDays, 20);
  fs.rmSync(root, { recursive: true, force: true });
});

test('archiveSessions：移动而不是删除', () => {
  const root = mkRoot();
  const dir = mkSession(root, PROFILE, 'session-x', { ageDays: 20 });
  const backupRoot = path.join(root, 'backup');

  const res = archiveSessions([{ dir }], { backupRoot, stamp: '2026-11-05' });
  assert.equal(res.moved, 1);
  assert.ok(!fs.existsSync(dir), '原位置应该没有了');
  assert.ok(fs.existsSync(path.join(res.target, 'session-x')), '备份目录里应该有');
  fs.rmSync(root, { recursive: true, force: true });
});

test('archiveSessions：空列表不报错', () => {
  const root = mkRoot();
  const res = archiveSessions([], { backupRoot: path.join(root, 'b') });
  assert.equal(res.moved, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test('findArchivable：目录不存在时返回空，不抛', () => {
  const r = findArchivable({ sessionsRoot: 'D:/不存在的路径/xyz', now: NOW });
  assert.equal(r.candidates.length, 0);
});

test('findArchivable：损坏的会话文件跳过，不乱动', () => {
  const root = mkRoot();
  const dir = path.join(root, PROFILE, 'session-broken');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'session.v4.jsonl.zstd');
  fs.writeFileSync(f, Buffer.from('不是 zstd'));
  const t = new Date(NOW - 30 * DAY);
  fs.utimesSync(f, t, t);

  const r = findArchivable({ sessionsRoot: root, keepDays: 7, now: NOW });
  assert.equal(r.candidates.length, 0, '读不出来就别动它');
  fs.rmSync(root, { recursive: true, force: true });
});
