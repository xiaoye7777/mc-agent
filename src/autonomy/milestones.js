// 发育路线：从零到打败末影龙的里程碑。每个里程碑是一组目标，规划器负责把目标变成具体动作。
//
// 目标的写法：
//   { item: 'iron_pickaxe' }          背包里要有（count 默认 1；有更好档次的也算）
//   { item: 'cobblestone', count: 16 }
//   { food: 30 }                      背包里的食物要能顶 30 点饱食度
//   { label, done(bot), run(ctx) }    自定义动作（比如搭传送门）：done 判断做没做完，run 去做
//   todo: true                        这一阶段还没实现，跑到这里就停下汇报
//   optional: true                    做不成就跳过，不影响后面的阶段
import { foodPoints } from './skills/food.js';
import { hasAtLeast } from './planner.js';
import { buildPortal, enterPortal } from './skills/portal.js';

export const MILESTONES = [
  {
    name: '木器时代',
    goals: [{ item: 'wooden_pickaxe' }],
  },
  {
    name: '石器时代',
    goals: [{ item: 'stone_pickaxe' }, { item: 'stone_sword' }, { item: 'stone_axe' }, { item: 'cobblestone', count: 16 }],
  },
  {
    name: '囤粮',
    goals: [{ food: 30 }],
  },
  {
    name: '床',
    // 有了床，晚上睡一觉直接跳过黑夜：不用和怪物硬拼，也省时间
    goals: [{ item: 'white_bed' }],
    optional: true, // 附近没羊也不影响主线，做不成就跳过
  },
  {
    name: '铁器时代',
    goals: [{ item: 'iron_pickaxe' }, { item: 'iron_sword' }],
  },
  {
    name: '铁甲',
    goals: [
      { item: 'iron_chestplate' },
      { item: 'iron_leggings' },
      { item: 'iron_helmet' },
      { item: 'iron_boots' },
      { item: 'shield' },
    ],
    async after(ctx) {
      await wearArmor(ctx);
    },
  },
  {
    name: '水桶',
    goals: [{ item: 'bucket' }],
  },
  {
    name: '钻石',
    goals: [{ item: 'diamond_pickaxe' }, { item: 'diamond_sword' }],
  },
  // ---- 下面的阶段还没实现：路线和难点先写清楚，方便以后接着做 ----
  {
    name: '下界传送门',
    goals: [
      { item: 'flint_and_steel' },
      { item: 'obsidian', count: 10 },
      { item: 'cobblestone', count: 8 }, // 门框四个角 + 备用
      {
        label: '搭门、点火、走进下界',
        done: (bot) => String(bot.game.dimension).includes('nether'),
        async run(ctx) {
          const inside = await buildPortal(ctx);
          await enterPortal(ctx, inside);
        },
      },
    ],
  },
  {
    name: '下界',
    todo: true,
    plan: '找下界要塞，打烈焰人拿 7 根烈焰棒；末影珍珠 12 个（打末影人，或用金锭和猪灵交易）',
  },
  {
    name: '找末地门',
    todo: true,
    plan: '合成 12 个末影之眼；扔两次、两条直线求交点定位要塞；挖进去找到末地传送门并填满',
  },
  {
    name: '末影龙',
    todo: true,
    plan: '先用弓箭射掉黑曜石柱顶上的末影水晶，龙停在中间柱子上时近战打；准备好床可以炸',
  },
];

/** 这个里程碑的目标是不是都已经满足了 */
export function isMilestoneDone(bot, milestone) {
  return milestone.goals.every((goal) => isGoalDone(bot, goal));
}

export function isGoalDone(bot, goal) {
  if (goal.run) return goal.done(bot);
  if (goal.food !== undefined) return foodPoints(bot) >= goal.food;
  return hasAtLeast(bot, goal.item, goal.count ?? 1);
}

export function describeGoal(goal) {
  if (goal.run) return goal.label;
  if (goal.food !== undefined) return `囤够 ${goal.food} 点饱食度的食物`;
  return `${goal.item} x${goal.count ?? 1}`;
}

/** 穿上背包里的盔甲，盾牌拿在副手 */
async function wearArmor(ctx) {
  const { bot } = ctx;
  const slots = { helmet: 'head', chestplate: 'torso', leggings: 'legs', boots: 'feet' };
  for (const item of bot.inventory.items()) {
    const kind = Object.keys(slots).find((suffix) => item.name.endsWith(`_${suffix}`));
    if (kind) await bot.equip(item, slots[kind]);
    else if (item.name === 'shield') await bot.equip(item, 'off-hand');
  }
  ctx.log('穿好了盔甲');
}
