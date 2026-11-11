// 动作注册表：NPC 会做的所有“动作”都登记在这里，大模型通过工具调用来使用它们。
//
// 每个动作长这样（见下面的 Action 类型）：
//   - name / description / parameters：原样发给大模型，相当于“工具说明书”。
//     大模型读了说明书，自己决定什么时候调用哪个动作、填什么参数（这就是 function calling）。
//   - run(ctx, args)：真正执行的代码，返回一句文字结果，这句结果会再发回给大模型看。
//     瞬间能做完的（看背包、合成）直接做；耗时的（走路、砍树）用 ctx.tasks.start() 放到后台。
//
// 新增动作：在 src/actions/ 下写好动作数组，加进下面的 ACTION_GROUPS 即可，
// 聊天和 Agent 循环那边一行都不用改。
import { setupSurvival } from '../behaviors/survival.js';
import { autonomyActions } from './autonomy.js';
import { combatActions } from './combat.js';
import { gatheringActions } from './gathering.js';
import { haltBot, setupPathfinder } from './helpers.js';
import { itemActions } from './items.js';
import { movementActions } from './movement.js';
import { perceptionActions } from './perception.js';
import { createTaskManager } from './taskManager.js';

/**
 * @typedef {object} ActionContext
 * @property {import('mineflayer').Bot} bot
 * @property {ReturnType<typeof createTaskManager>} tasks 后台任务管理
 * @property {string} player   是哪个玩家让做的
 * @property {boolean} isWhisper 是不是私聊里说的
 * @property {{ allowDig: boolean, allowCombat: boolean, allowAutonomy: boolean }} options
 *
 * @typedef {object} Action
 * @property {string} name
 * @property {string} description
 * @property {object} parameters JSON Schema
 * @property {(ctx: ActionContext, args: object) => string | Promise<string>} run
 */

// 按类别分组；enabled 返回 false 的组不会出现在工具清单里，大模型就根本不知道有这个能力
const ACTION_GROUPS = [
  { actions: perceptionActions },
  { actions: movementActions },
  { actions: itemActions },
  { actions: gatheringActions, enabled: (options) => options.allowDig },
  { actions: combatActions, enabled: (options) => options.allowCombat },
  { actions: autonomyActions, enabled: (options) => options.allowAutonomy },
];

/**
 * @param {{ allowDig: boolean, allowCombat: boolean, allowAutonomy: boolean }} options
 */
export function createActionRegistry(options) {
  const actions = ACTION_GROUPS.filter((group) => group.enabled?.(options) ?? true).flatMap((group) => group.actions);

  let bot = null;
  // 任务被取消时，立刻让 NPC 停下脚步、停止挖掘
  const tasks = createTaskManager({ onCancel: () => bot && haltBot(bot) });

  return {
    tasks,

    /** 每次（重新）进服调用：装寻路插件和本能反应 */
    attach(newBot) {
      tasks.cancel('重新进服');
      bot = newBot;
      setupPathfinder(bot);
      setupSurvival(bot, { tasks, allowCombat: options.allowCombat });
    },

    /** 发给大模型的工具清单（OpenAI 的 tools 格式） */
    toolDefinitions: actions.map((action) => ({
      type: 'function',
      function: {
        name: action.name,
        description: action.description,
        parameters: action.parameters,
      },
    })),

    /**
     * 执行一个动作。不管成功失败都返回一句文字，交给大模型去组织语言回复玩家。
     * @param {string} name
     * @param {object} args
     * @param {{ player: string, isWhisper: boolean }} context
     * @returns {Promise<string>}
     */
    async run(name, args, { player, isWhisper }) {
      const action = actions.find((item) => item.name === name);
      if (!action) return `没有叫 ${name} 的动作`;
      if (!bot?.entity) return '我还没进入世界，做不了';
      try {
        return await action.run({ bot, tasks, player, isWhisper, options }, args ?? {});
      } catch (err) {
        return `执行失败：${err.message}`;
      }
    },

    /** 当前在做什么，例如“挖 5 个 oak_log（进度：2/5）” */
    describeActivity() {
      return tasks.describe();
    },

    /** 立刻停下（不经过大模型，用于玩家喊“停下”时的快速反应） */
    interrupt() {
      return tasks.cancel('玩家叫停');
    },
  };
}
