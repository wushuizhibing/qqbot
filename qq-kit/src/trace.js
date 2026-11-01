/**
 * 本地调试日志：把插件运行轨迹写到一个文件里。
 *
 * 为什么需要：插件跑在 DSH 进程里，logger 输出在 GUI 上不好翻；
 * 联调时得有个能直接 tail 的文件。
 *
 * 用 JSON 字符串转义（而不是直接塞原文）写行，避免中文在 GBK 控制台上变成乱码；
 * 出错静默，绝不影响主链路。
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * @param {string} filePath 绝对路径；传空字符串表示关闭
 * @param {{ maxBytes?: number }} [options]
 */
export function createTrace(filePath, options = {}) {
  if (!filePath) {
    return { write: () => {}, close: () => {}, path: '' };
  }
  const maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
  let fd = null;
  let broken = false;

  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    // 太大就轮转一份，别无限涨
    try {
      const st = fs.statSync(filePath);
      if (st.size > maxBytes) fs.renameSync(filePath, `${filePath}.1`);
    } catch {
      /* 文件不存在，正常 */
    }
    fd = fs.openSync(filePath, 'a');
  } catch {
    broken = true;
  }

  return {
    path: filePath,
    /**
     * @param {string} event
     * @param {unknown} [data]
     */
    write(event, data) {
      if (broken || fd === null) return;
      try {
        const line = JSON.stringify({
          t: new Date().toISOString(),
          event,
          ...(data === undefined ? {} : { data }),
        });
        fs.writeSync(fd, `${line}\n`);
      } catch {
        broken = true;
      }
    },
    close() {
      try {
        if (fd !== null) fs.closeSync(fd);
      } catch {
        /* ignore */
      }
      fd = null;
    },
  };
}
