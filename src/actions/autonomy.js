// 自主发育的开关：让大模型能在玩家要求时启动“从零发育”。
// 只有 .env 里 NPC_AUTONOMY 不是 off 时才会出现在工具清单里（自主发育会大量挖方块、放方块，只能在测试服用）。
import { startAutonomy } from '../autonomy/index.js';

/** @type {import('./index.js').Action[]} */
export const autonomyActions = [
  {
    name: 'start_autonomy',
    description:
      '开始从零自主发育：自己砍树、做工具、挖矿、烧铁、做盔甲、找钻石，一步步往打败末影龙的方向发展。' +
      '玩家说“自己去发育”“自己玩吧”“去打末影龙”时使用。会持续很久，期间可以聊天，玩家说停下就停。',
    parameters: { type: 'object', properties: {} },
    run({ bot, tasks, player, isWhisper }) {
      return startAutonomy({ bot, tasks, owner: player, isWhisper });
    },
  },
];
