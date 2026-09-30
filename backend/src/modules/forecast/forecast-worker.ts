/**
 * 预测重算 Worker 入口(AC-F11)。只做纯计算:接收工作簿与参数,返回输出或失败;不访问数据库与文件。
 * 由 forecast-runner 以 resourceLimits 启动,完成后由主线程终止。
 */
import { parentPort } from 'worker_threads';
import { runWorkbook, type RunInput } from './formula/engine';

const port = parentPort!;
port.once('message', (input: RunInput) => {
  try {
    port.postMessage({ type: 'result', out: runWorkbook(input) });
  } catch (e) {
    port.postMessage({ type: 'crash', message: e instanceof Error ? e.message : String(e) });
  }
});
port.postMessage({ type: 'ready' });
