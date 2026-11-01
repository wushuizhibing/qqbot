/**
 * 用量看门狗：今天花费到阈值时提醒一次。
 *
 * 数据源：鲸鱼小组件写的 `$DSH_HOME/.dshw-usage.json`（字段 todayUsage / date）。
 * 只看数、不碰钱包；到阈值发一条私聊通知，然后当天不再重复。
 *
 * 阈值单位按小组件自己的单位（人民币元）。配置里写 25 就是 25。
 */
import fs from 'node:fs';

/**
 * @param {{
 *   file: string,
 *   threshold: number,
 *   onExceed: (info: { today: number, threshold: number, date: string }) => void | Promise<void>,
 *   warn?: (m: string) => void,
 *   now?: () => Date,
 *   intervalMs?: number,
 * }} options
 */
export function createUsageWatch(options) {
  const { file, threshold, onExceed } = options;
  const warn = options.warn ?? (() => {});
  const now = options.now ?? (() => new Date());
  const intervalMs = options.intervalMs ?? 60000;
  let timer = null;
  let notifiedFor = ''; // 已经提醒过的日期，避免同一天刷屏
  let lastToday = 0;

  /** 读今天的用量；读不到返回 null。 */
  function readUsage() {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      const date = String(raw?.date ?? '');
      const today = Number(raw?.todayUsage ?? 0);
      if (!Number.isFinite(today)) return null;
      return { date, today };
    } catch (error) {
      // 文件还没有 / 正在被写：都当"暂时读不到"，不吵
      return null;
    }
  }

  async function tick() {
    const usage = readUsage();
    if (!usage) return;
    lastToday = usage.today;
    if (!(threshold > 0)) return;
    if (usage.today < threshold) return;
    if (notifiedFor === usage.date) return;
    notifiedFor = usage.date;
    try {
      await onExceed({ today: usage.today, threshold, date: usage.date });
    } catch (error) {
      warn(`用量提醒发送失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => void tick(), intervalMs);
      timer.unref?.();
      void tick();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    /** 供测试直接驱动一次 */
    tick,
    /** 当前读到的今日用量（调试/面板用） */
    current() {
      return lastToday;
    },
    /** 已经提醒过的日期（调试用） */
    notifiedDate() {
      return notifiedFor;
    },
  };
}
