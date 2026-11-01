/**
 * 历史日志存储：把 conversation 的每个事件按时序落盘，方便事后翻。
 *
 * 和 trace 的区别：
 *   - trace   = 机制日志（启动、连接、计划、发送），给人 debug 用，会轮转覆盖
 *   - history = 数据日志（谁说了什么、回了什么），给复盘/统计用，按天切文件
 *
 * 存法：每天一个文件 `history-YYYY-MM-DD.jsonl`，一行一个事件。
 * 这样不会无限涨（一天一个文件），要清理删整天即可。
 * 写失败一律静默，绝不影响主链路。
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * 本地日期 YYYY-MM-DD（用本地时区，不是 UTC —— 人看日志按本地天）。
 * @param {Date} [d]
 */
function localDay(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * @param {{
 *   dir?: string,
 *   prefix?: string,
 *   keepDays?: number,
 *   maxBytesPerDay?: number,
 *   warn?: (m: string) => void,
 * }} [options]
 */
export function createHistoryLog(options = {}) {
  const dir = options.dir;
  const prefix = options.prefix ?? 'history';
  const keepDays = Math.max(1, options.keepDays ?? 30);
  const maxBytesPerDay = options.maxBytesPerDay ?? 32 * 1024 * 1024;
  const warn = options.warn ?? (() => {});

  let fd = null;
  let currentDay = '';
  let writtenToday = 0;
  let broken = false;

  /** 删超过 keepDays 的旧日志（只在打开当天文件时顺手做一次）。 */
  const prune = () => {
    if (!dir) return;
    try {
      const files = fs.readdirSync(dir).filter((f) => f.startsWith(`${prefix}-`) && f.endsWith('.jsonl'));
      const days = files
        .map((f) => f.slice(prefix.length + 1, -'.jsonl'.length))
        .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
        .sort()
        .reverse();
      for (const d of days.slice(keepDays)) {
        try {
          fs.unlinkSync(path.join(dir, `${prefix}-${d}.jsonl`));
        } catch {
          /* 删不掉就留着 */
        }
      }
    } catch {
      /* 目录读不到就算了 */
    }
  };

  const openDay = (day) => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${prefix}-${day}.jsonl`);
      try {
        writtenToday = fs.statSync(file).size;
      } catch {
        writtenToday = 0;
      }
      fd = fs.openSync(file, 'a');
      currentDay = day;
      prune();
    } catch (error) {
      broken = true;
      warn(`历史日志打不开（${dir}）：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const closeFd = () => {
    try {
      if (fd !== null) fs.closeSync(fd);
    } catch {
      /* ignore */
    }
    fd = null;
  };

  return {
    /** @param {string} type @param {object} data */
    write(type, data) {
      if (!dir || broken) return;
      try {
        const day = localDay();
        if (day !== currentDay) {
          closeFd();
          openDay(day);
        }
        if (fd === null) return;
        // 单日文件过大就不再写（保护磁盘），下一天会重新开始
        if (writtenToday > maxBytesPerDay) return;
        const line = JSON.stringify({ t: new Date().toISOString(), type, ...data }) + '\n';
        fs.writeSync(fd, line);
        writtenToday += Buffer.byteLength(line);
      } catch (error) {
        broken = true;
        warn(`历史日志写入失败：${error instanceof Error ? error.message : String(error)}`);
      }
    },
    close() {
      closeFd();
    },
    /** 当前写的文件（调试用） */
    currentFile() {
      return dir ? path.join(dir, `${prefix}-${currentDay || localDay()}.jsonl`) : '';
    },
  };
}
