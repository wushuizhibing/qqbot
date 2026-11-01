/**
 * 运行时配置：不重启 DSH 也能调参数。
 *
 * 原理：
 *   - 启动时从 cordis.patch.yml 读到 base 配置；
 *   - 再叠一份 `qq-kit-live.json`（运行时覆写文件），后者的字段优先；
 *   - 文件改动会被盯着，2 秒内自动重读并通知订阅者。
 *
 * 只允许"热更新安全"的字段：合并节奏、情绪、记忆上限、人格档位这类。
 * **不允许**改 adapter / 路由 / 密钥 —— 那些牵动连接和重启，得走正规重启。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 允许热更新的字段白名单（点分路径）。不在表里的一律忽略并告警。 */
export const HOT_KEYS = new Set([
  'dryRun',
  'summarizeEvery',
  'memoryMaxOthers',
  'moodHistoryMax',
  'moodKeepDays',
  'coldSilenceMs',
  'atUrgent',
  'merge.windowMs',
  'merge.maxMessages',
  'merge.maxWaitMs',
  'merge.perMinute',
  'agentOptions.model',
  'vision.maxImages',
  'vision.maxBytes',
  'memeRoots',
  'personaMode',
  'notifyOnMention',
  'notifyUsage.threshold',
]);

/**
 * 深合并：source 里有值的字段覆盖 target。
 * @param {any} target
 * @param {any} source
 */
export function deepMerge(target, source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return target;
  const out = { ...target };
  for (const [k, v] of Object.entries(source)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = deepMerge(target?.[k] ?? {}, v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * 从覆写对象里挑出允许热更新的字段（保留嵌套结构）。
 * @param {object} patch
 * @param {(m: string) => void} [warn]
 */
export function pickHotKeys(patch, warn) {
  /** @type {Record<string, any>} */
  const out = {};
  const walk = (obj, prefix) => {
    for (const [k, v] of Object.entries(obj ?? {})) {
      const full = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        walk(v, full);
        continue;
      }
      if (HOT_KEYS.has(full)) {
        // 反向写回嵌套结构
        const parts = full.split('.');
        let cur = out;
        for (let i = 0; i < parts.length - 1; i += 1) {
          cur[parts[i]] = cur[parts[i]] ?? {};
          cur = cur[parts[i]];
        }
        cur[parts[parts.length - 1]] = v;
      } else {
        warn?.(`热更新忽略不可调字段: ${full}（改它需要重启）`);
      }
    }
  };
  walk(patch, '');
  return out;
}

/**
 * 创建一个"会变"的配置对象：读的时候总是拿最新值。
 *
 * @param {{
 *   base: object,
 *   file?: string,
 *   warn?: (m: string) => void,
 *   onChange?: (next: object) => void,
 *   pollMs?: number,
 * }} options
 */
export function createLiveConfig(options) {
  const { base, file } = options;
  const warn = options.warn ?? (() => {});
  const onChange = options.onChange ?? (() => {});
  const pollMs = options.pollMs ?? 2000;

  let merged = { ...base };
  let lastStamp = 0;
  let timer = null;

  const readPatch = () => {
    if (!file) return null;
    try {
      const st = fs.statSync(file);
      const stamp = st.mtimeMs;
      if (stamp === lastStamp) return null; // 没变，别重复读
      lastStamp = stamp;
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        warn(`热更新文件格式不对（应为对象）: ${file}`);
        return null;
      }
      return pickHotKeys(raw, warn);
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') return null;
      warn(`读热更新文件失败（${file}）：${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  };

  const applyPatch = () => {
    const patch = readPatch();
    if (!patch) return;
    merged = deepMerge(base, patch);
    try {
      onChange(merged);
    } catch (error) {
      warn(`热更新回调失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  /** 立刻读一次（启动时用） */
  const reload = () => {
    applyPatch();
    return merged;
  };

  /** 开始盯着文件变化 */
  const start = () => {
    if (timer || !file) return;
    reload();
    timer = setInterval(applyPatch, pollMs);
    timer.unref?.();
  };

  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };

  /** 当前生效的配置（每次读都是最新的） */
  const current = () => merged;

  /** 手动写回一份覆写（面板用） */
  const writePatch = (patch) => {
    if (!file) throw new Error('没有配置热更新文件路径');
    const picked = pickHotKeys(patch, warn);
    const next = deepMerge(merged, picked);
    // 只把"跟 base 不同"的部分写进文件，保持文件干净
    const diff = diffKeys(base, next);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(diff, null, 2), 'utf8');
    merged = next;
    lastStamp = 0; // 下一轮重新读一次，保持与文件一致
    onChange(merged);
    return merged;
  };

  return { current, reload, start, stop, writePatch, file };
}

/**
 * 找出跟 base 不同的字段（用于写回热更新文件）。
 * @param {any} base
 * @param {any} next
 */
export function diffKeys(base, next) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const [k, v] of Object.entries(next ?? {})) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const sub = diffKeys(base?.[k] ?? {}, v);
      if (Object.keys(sub).length) out[k] = sub;
    } else if (JSON.stringify(v) !== JSON.stringify(base?.[k])) {
      out[k] = v;
    }
  }
  return out;
}
