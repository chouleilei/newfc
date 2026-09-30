/**
 * 在独立 worker_threads Worker 中执行预测重算(AC-F11 / AC-X09)。
 *
 * - Worker 带 resourceLimits(堆上限),超出记 FORECAST_RESOURCE_LIMIT;
 * - 从 Worker 就绪起计时,超时记 FORECAST_TIMEOUT;
 * - 无论成功、失败或超时,都会 terminate Worker(finally),调用方随后释放任务槽。
 */
import path from 'path';
import { Worker } from 'worker_threads';
import type { RunInput, RunOutput } from './formula/engine';

export type WorkerRunOutput = RunOutput | { ok: false; code: 'FORECAST_TIMEOUT' | 'FORECAST_RESOURCE_LIMIT'; message: string; diagnostics: unknown[] };

let active = 0;
/** 当前存活的预测 Worker 数(资源释放验收用)。 */
export const activeForecastWorkers = () => active;

export interface RunnerLimits { timeoutMs: number; maxOldGenerationSizeMb: number }

export function forecastLimits(): RunnerLimits {
  const num = (v: string | undefined, dflt: number, min: number, max: number) => {
    const n = Number(v);
    return Number.isSafeInteger(n) && n >= min && n <= max ? n : dflt;
  };
  return {
    timeoutMs: num(process.env.NEWFC_FORECAST_TIMEOUT_MS, 30_000, 10, 600_000),
    maxOldGenerationSizeMb: num(process.env.NEWFC_FORECAST_MEMORY_MB, 512, 32, 4096),
  };
}

function workerEntry(): { file: string; execArgv: string[] } {
  // 源码运行(ts-node / vitest)时 Worker 也以 ts-node 转译加载;发布包直接加载编译后的 .js
  if (__filename.endsWith('.ts')) return { file: path.join(__dirname, 'forecast-worker.ts'), execArgv: ['-r', 'ts-node/register/transpile-only'] };
  return { file: path.join(__dirname, 'forecast-worker.js'), execArgv: [] };
}

export function runForecastInWorker(input: RunInput, limits: RunnerLimits = forecastLimits()): Promise<WorkerRunOutput> {
  const entry = workerEntry();
  const worker = new Worker(entry.file, {
    execArgv: entry.execArgv,
    resourceLimits: { maxOldGenerationSizeMb: limits.maxOldGenerationSizeMb, maxYoungGenerationSizeMb: Math.min(64, Math.max(8, limits.maxOldGenerationSizeMb / 8)), stackSizeMb: 8 },
  });
  active += 1;
  let timer: NodeJS.Timeout | undefined;
  // 启动兜底:Worker 迟迟不就绪(加载失败)也不能无限占用任务槽
  const startup = setTimeout(() => settle({ ok: false, code: 'FORECAST_TIMEOUT', message: '计算进程启动超时', diagnostics: [] }), limits.timeoutMs + 60_000);
  let settle: (out: WorkerRunOutput) => void = () => undefined;
  const result = new Promise<WorkerRunOutput>((resolve) => {
    let done = false;
    settle = (out) => {
      if (done) return;
      done = true;
      clearTimeout(startup);
      if (timer) clearTimeout(timer);
      resolve(out);
    };
    worker.on('message', (msg: { type: string; out?: RunOutput; message?: string }) => {
      if (msg.type === 'ready') {
        timer = setTimeout(() => settle({ ok: false, code: 'FORECAST_TIMEOUT', message: `计算超过 ${Math.round(limits.timeoutMs / 1000)} 秒未完成`, diagnostics: [] }), limits.timeoutMs);
        worker.postMessage(input);
      } else if (msg.type === 'result') settle(msg.out!);
      else settle({ ok: false, code: 'FORECAST_RESOURCE_LIMIT', message: `计算进程异常:${msg.message ?? ''}`.slice(0, 500), diagnostics: [] });
    });
    worker.on('error', (err: Error & { code?: string }) => {
      const oom = err.code === 'ERR_WORKER_OUT_OF_MEMORY';
      settle({ ok: false, code: 'FORECAST_RESOURCE_LIMIT', message: oom ? '计算内存超过上限' : `计算进程异常:${err.message}`.slice(0, 500), diagnostics: [] });
    });
    worker.on('exit', (code) => settle({ ok: false, code: 'FORECAST_RESOURCE_LIMIT', message: `计算进程意外退出(${code})`, diagnostics: [] }));
  });
  return result.finally(async () => {
    try { await worker.terminate(); } finally { active -= 1; }
  });
}
