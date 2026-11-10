// 移动类动作：过来、跟随、停下。
// 寻路交给 mineflayer-pathfinder 插件：给它一个“目标”（走到某坐标附近 / 跟着某个实体），
// 它会自己算路线、绕障碍、跳台阶。
import pathfinderPkg from 'mineflayer-pathfinder';

const { pathfinder, Movements, goals } = pathfinderPkg;

// 走到离玩家几格就算到了（太近会贴脸挤着玩家）
const ARRIVE_DISTANCE = 2;

/** 每次进服调用：给 bot 装上寻路插件，并限制它的走法 */
export function setupMovement(bot) {
  bot.loadPlugin(pathfinder);

  const movements = new Movements(bot);
  // 公网服上是大家的建筑，NPC 只能“走”，不许改动世界：
  movements.canDig = false; // 不挖方块开路
  movements.allow1by1towers = false; // 不在脚下垫方块往上爬
  movements.scafoldingBlocks = []; // 不放任何方块（pathfinder 源码里就是这个拼写）
  bot.pathfinder.setMovements(movements);
}

// 找到玩家的实体（实体 = 世界里能动的东西）。离得太远或不在同一维度时拿不到。
function findPlayerEntity(bot, playerName) {
  return bot.players[playerName]?.entity ?? null;
}

function distanceTo(bot, entity) {
  return bot.entity.position.distanceTo(entity.position).toFixed(0);
}

export const movementActions = [
  {
    name: 'come_to_player',
    description: '走到某个玩家身边。玩家说“过来”“来找我”“到我这来”时使用。',
    parameters: {
      type: 'object',
      properties: {
        player: { type: 'string', description: '要走过去找的玩家游戏 ID' },
      },
      required: ['player'],
    },
    run(bot, { player }, state) {
      const target = findPlayerEntity(bot, player);
      if (!target) return `看不到玩家 ${player}（可能离得太远或不在同一个维度）`;

      const activity = `正在走向 ${player}`;
      state.activity = activity;

      // goto 返回一个 Promise：走到了 resolve；被新目标打断或找不到路会 reject。
      // 这里故意不 await —— 让 NPC 边走边先回一句“来了”，不用等走到再说话。
      const { x, y, z } = target.position;
      bot.pathfinder
        .goto(new goals.GoalNear(x, y, z, ARRIVE_DISTANCE))
        .catch(() => {}) // 被打断或走不过去，都当作结束
        .finally(() => {
          // 只有当前还是“这次的走向”才改回空闲，避免覆盖后来的新动作
          if (state.activity === activity) state.activity = '空闲';
        });

      return `已出发去找 ${player}，距离约 ${distanceTo(bot, target)} 格`;
    },
  },

  {
    name: 'follow_player',
    description: '持续跟着某个玩家走，直到被叫停。玩家说“跟着我”“跟我走”时使用。',
    parameters: {
      type: 'object',
      properties: {
        player: { type: 'string', description: '要跟随的玩家游戏 ID' },
      },
      required: ['player'],
    },
    run(bot, { player }, state) {
      const target = findPlayerEntity(bot, player);
      if (!target) return `看不到玩家 ${player}（可能离得太远或不在同一个维度）`;

      // 第二个参数 true = 动态目标：玩家一动，路线就跟着重算
      bot.pathfinder.setGoal(new goals.GoalFollow(target, ARRIVE_DISTANCE), true);
      state.activity = `正在跟随 ${player}`;
      return `开始跟随 ${player}`;
    },
  },

  {
    name: 'stop_moving',
    description: '停止当前的移动或跟随，原地站好。玩家说“停下”“别跟了”“站住”时使用。',
    parameters: { type: 'object', properties: {} },
    run(bot, _args, state) {
      bot.pathfinder.setGoal(null);
      bot.clearControlStates(); // 松开所有“按键”（前进、跳跃……）
      state.activity = '空闲';
      return '已停下';
    },
  },
];
