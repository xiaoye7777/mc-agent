// 移动类动作：过来、跟随、去某个坐标、停下。
// 走路是耗时的，所以前三个都作为“后台任务”运行（见 taskManager.js），工具调用会立刻返回“已出发”。
import pathfinderPkg from 'mineflayer-pathfinder';
import { distanceTo, findPlayerEntity, formatPosition, goTo, sleep } from './helpers.js';

const { goals } = pathfinderPkg;

// 走到离玩家几格以内算“到了”（太近会挤到玩家）
const ARRIVE_DISTANCE = 2;
// 跟随时保持的距离
const FOLLOW_DISTANCE = 2;
// go_to 最远走多远（太远的路寻路会很慢，区块也可能没加载）
const MAX_TRAVEL_DISTANCE = 200;

/** @type {import('./index.js').Action[]} */
export const movementActions = [
  {
    name: 'come_to_player',
    description: '走到某个玩家身边。玩家说“过来”“来找我”“到我这来”时使用。后台执行，立刻返回。',
    parameters: {
      type: 'object',
      properties: {
        player: { type: 'string', description: '要走过去找的玩家游戏 ID' },
      },
      required: ['player'],
    },
    run({ bot, tasks, player: requester, isWhisper }, { player }) {
      const target = findPlayerEntity(bot, player);
      if (!target) return `看不到玩家 ${player}（可能离得太远或不在同一个维度）`;

      const distance = distanceTo(bot, target.position);
      if (distance <= ARRIVE_DISTANCE + 1) return `已经在 ${player} 身边了（${distance} 格）`;

      tasks.start({ label: `走向 ${player}`, kind: 'move', owner: requester, isWhisper, report: 'failure' }, async ({ signal }) => {
        const { x, y, z } = target.position;
        await goTo(bot, new goals.GoalNear(x, y, z, ARRIVE_DISTANCE), { signal, timeoutMs: 60000 });
        return `走到 ${player} 身边了`;
      });
      return `已出发去找 ${player}，距离约 ${distance} 格`;
    },
  },

  {
    name: 'follow_player',
    description: '一直跟着某个玩家走，直到被叫停或开始别的任务。玩家说“跟着我”“跟我走”时使用。',
    parameters: {
      type: 'object',
      properties: {
        player: { type: 'string', description: '要跟随的玩家游戏 ID' },
      },
      required: ['player'],
    },
    run({ bot, tasks, player: requester, isWhisper }, { player }) {
      if (!findPlayerEntity(bot, player)) return `看不到玩家 ${player}，没法跟随`;

      tasks.start({ label: `跟随 ${player}`, kind: 'follow', owner: requester, isWhisper, report: 'failure' }, async ({ signal }) => {
        // dynamic = true：玩家一动，目标点就跟着更新
        bot.pathfinder.setGoal(new goals.GoalFollow(findPlayerEntity(bot, player), FOLLOW_DISTANCE), true);
        // 跟随没有“完成”的时候：每秒检查一次，玩家下线 / 走远到看不见就结束
        while (true) {
          await sleep(1000, signal);
          if (!findPlayerEntity(bot, player)) {
            bot.pathfinder.setGoal(null);
            throw new Error(`跟丢了：看不到 ${player} 了`);
          }
        }
      });
      return `开始跟随 ${player}`;
    },
  },

  {
    name: 'go_to',
    description: '走到指定坐标。玩家给出坐标、或你要去某个找到的方块附近时使用。后台执行，到了会收到任务结果。',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
        z: { type: 'number' },
      },
      required: ['x', 'y', 'z'],
    },
    run({ bot, tasks, player, isWhisper }, { x, y, z }) {
      if (![x, y, z].every(Number.isFinite)) return '坐标格式不对，需要三个数字 x、y、z';
      const distance = Math.round(bot.entity.position.distanceTo({ x, y, z }));
      if (distance > MAX_TRAVEL_DISTANCE) return `太远了（${distance} 格），我一次最多走 ${MAX_TRAVEL_DISTANCE} 格`;

      const where = formatPosition({ x, y, z });
      tasks.start({ label: `前往 ${where}`, kind: 'move', owner: player, isWhisper, report: 'always' }, async ({ signal }) => {
        await goTo(bot, new goals.GoalNear(x, y, z, 1), { signal, timeoutMs: 120000 });
        return `到达 ${where}`;
      });
      return `已出发前往 ${where}，距离约 ${distance} 格`;
    },
  },

  {
    name: 'stop',
    description: '停下手上的一切：不再走路、跟随、挖方块、打怪。玩家说“停下”“别动”“别跟了”“算了”时使用。',
    parameters: { type: 'object', properties: {} },
    run({ tasks }) {
      const label = tasks.current?.label;
      tasks.cancel('玩家叫停');
      return label ? `已停下（之前在：${label}）` : '本来就没在做事，站着呢';
    },
  },
];
