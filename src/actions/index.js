// 动作注册表：NPC 会做的所有“动作”都登记在这里。
//
// 每个动作长这样：{ name, description, parameters, run(bot, args, state) }
//   - name / description / parameters：原样发给大模型，相当于“工具说明书”。
//     大模型读了说明书，自己决定什么时候调用哪个动作、填什么参数（这就是 function calling）。
//   - run：真正执行的代码，返回一句文字结果，这句结果会再发回给大模型看。
//
// 新增动作：在 src/actions/ 下写好动作数组，然后加进下面的 allActions 即可，
// 聊天和 Agent 循环那边一行都不用改。
import { movementActions, setupMovement } from './movement.js';

const allActions = [...movementActions];

export function createActionRegistry() {
  // 动作之间共享的状态。activity 会写进 prompt，让 NPC 知道自己正在干嘛。
  const state = { activity: '空闲' };

  return {
    /** 每次（重新）进服调用：装插件、重置状态 */
    attach(bot) {
      state.activity = '空闲';
      setupMovement(bot);
    },

    /** 发给大模型的工具清单（OpenAI 的 tools 格式） */
    toolDefinitions: allActions.map((action) => ({
      type: 'function',
      function: {
        name: action.name,
        description: action.description,
        parameters: action.parameters,
      },
    })),

    /**
     * 执行一个动作。不管成功失败都返回一句文字，交给大模型去组织语言回复玩家。
     * @returns {Promise<string>}
     */
    async run(bot, name, args) {
      const action = allActions.find((item) => item.name === name);
      if (!action) return `没有叫 ${name} 的动作`;
      try {
        return await action.run(bot, args, state);
      } catch (err) {
        return `执行失败：${err.message}`;
      }
    },

    /** 当前在做什么，例如“正在跟随 dana_mac” */
    describeActivity() {
      return state.activity;
    },
  };
}
