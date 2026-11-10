// 任务管理：让 NPC 能“在后台干活”，同时嘴上还能继续聊天。
//
// 为什么需要它？砍 5 棵树要一两分钟。如果大模型调用工具后要一直等到砍完，
// 这段时间里 NPC 就是个聋子：玩家说“停下”“你在干嘛”都没人理。
// 所以耗时的动作都包装成“任务”：
//
//   大模型调用 collect_block ──> start() 立刻返回“已开始” ──> NPC 回一句“这就去”
//                                     │
//                                     └─ 后台慢慢砍树（随时能被 stop 打断）
//                                            │
//                         干完 / 失败 ──> 发出“任务结果”事件 ──> 聊天模块把结果交给大模型，
//                                                              它决定下一步（比如把木头交给玩家）
//
// 同一时间只有一个任务：开始新任务会先取消旧任务（人也只有一双手）。
import { createLogger } from '../logger.js';

const log = createLogger('task');

/**
 * 什么时候要把结果告诉大模型：
 *   always  —— 不管成功失败都报告（砍树、送东西这种有明确结果的任务）
 *   failure —— 只有失败才报告（“过来”成功了不用再啰嗦一句“我到了”）
 *   never   —— 都不报告
 */
const REPORT_MODES = new Set(['always', 'failure', 'never']);

export function createTaskManager({ onCancel } = {}) {
  let current = null;
  let nextId = 1;
  const listeners = new Set();

  /**
   * 开始一个后台任务。
   * @param {object} info
   * @param {string} info.label   给人看的名字，例如“砍 5 个 oak_log”
   * @param {string} [info.kind]   任务类型：move / follow / gather / give / combat，本能反应层会看它决定能不能分心
   * @param {string} [info.owner] 谁让做的（结果会回给这个玩家）
   * @param {boolean} [info.isWhisper] 是不是私聊里让做的
   * @param {'always'|'failure'|'never'} [info.report]
   * @param {(ctx: { signal: AbortSignal, setProgress: (text: string) => void }) => Promise<string>} work
   *   真正干活的函数：必须经常检查 signal（被取消时尽快停），返回一句结果文字
   */
  function start({ label, kind = 'work', owner = null, isWhisper = false, report = 'always' }, work) {
    if (!REPORT_MODES.has(report)) throw new Error(`未知的 report 模式：${report}`);
    cancel(`被新任务「${label}」替换`);

    const controller = new AbortController();
    const task = { id: nextId++, label, kind, owner, isWhisper, report, controller, progress: '' };
    current = task;
    log.info(`开始任务 #${task.id}：${label}`);

    const setProgress = (text) => {
      task.progress = text;
    };

    // 放到下一个微任务再开始，保证 start() 先把“已开始”返回给大模型
    Promise.resolve()
      .then(() => work({ signal: controller.signal, setProgress }))
      .then(
        (result) => finish(task, { ok: true, result: result ?? '完成了' }),
        (err) => finish(task, { ok: false, result: err?.message ?? String(err) }),
      );

    return task;
  }

  function finish(task, outcome) {
    if (current === task) current = null;
    const aborted = task.controller.signal.aborted;
    log.info(`任务 #${task.id} ${aborted ? '已取消' : outcome.ok ? '完成' : '失败'}：${outcome.result}`);

    // 被取消的任务不报告：取消它的人（stop 或新任务）已经知道了
    if (aborted) return;
    if (task.report === 'never') return;
    if (task.report === 'failure' && outcome.ok) return;

    for (const listener of listeners) {
      try {
        listener({ task, ...outcome });
      } catch (err) {
        log.error('任务结果监听器出错：', err.message);
      }
    }
  }

  /** 取消当前任务（没有任务时返回 false） */
  function cancel(reason = '被叫停') {
    if (!current) return false;
    const task = current;
    current = null;
    task.controller.abort(reason);
    onCancel?.();
    return true;
  }

  return {
    start,
    cancel,

    /** 当前任务（没有为 null） */
    get current() {
      return current;
    },

    /** 当前在做什么，写进 prompt 让 NPC 知道自己在忙什么 */
    describe() {
      if (!current) return '空闲';
      return current.progress ? `${current.label}（进度：${current.progress}）` : current.label;
    },

    /** 订阅任务结果：listener({ task, ok, result }) */
    onFinish(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
