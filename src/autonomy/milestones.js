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
    name: '弓箭',
    // 烈焰人停在 12~14 格外不过来，近战打不到；最后打末影龙射末影水晶也要用弓
    // 弓 = 3 线（打蜘蛛）+ 3 木棍；箭 = 燧石 + 木棍 + 羽毛（打鸡），一次做 4 支
    goals: [{ item: 'bow' }, { item: 'arrow', count: 48 }, { item: 'golden_boots' }],
    // 金靴子：下界里的猪灵看到没穿金装备的玩家会直接动手（测试时被猪灵打死过），穿一件金的就不打你
  },
  {
    name: '下界传送门',
    goals: [
      { item: 'flint_and_steel' },
      { item: 'obsidian', count: 10 },
      { item: 'cobblestone', count: 8 }, // 门框四个角 + 备用
      {
        label: '搭门、点火、走进下界',
        // 在下界里，或者附近已经有点着的传送门（死后重生在主世界时，不用再搭一个）
        done: (bot) =>
          String(bot.game.dimension).includes('nether') ||
          Boolean(bot.findBlock({ matching: bot.registry.blocksByName.nether_portal.id, maxDistance: 160 })),
        async run(ctx) {
          const inside = await buildPortal(ctx);
          await enterPortal(ctx, inside);
        },
      },
    ],
  },
  {
    name: '下界',
    // 末影之眼 = 烈焰粉 + 末影珍珠，要 12 个左右（填末地门 + 扔出去找要塞时会碎几个）
    goals: [{ item: 'blaze_rod', count: 7 }, { item: 'ender_pearl', count: 12 }],
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

/** 穿上背包里的盔甲，盾牌拿在副手（每个阶段开始前都会调用一次，捡到 / 做出新盔甲就自动穿上） */
export async function wearArmor(ctx) {
  const { bot } = ctx;
  const slots = { helmet: 'head', chestplate: 'torso', leggings: 'legs', boots: 'feet' };
  for (const item of bot.inventory.items()) {
    if (item.name === 'golden_boots') continue; // 最后单独穿
    const kind = Object.keys(slots).find((suffix) => item.name.endsWith(`_${suffix}`));
    if (kind) await bot.equip(item, slots[kind]);
    else if (item.name === 'shield') await bot.equip(item, 'off-hand');
  }
  // 有金靴子就穿金靴子（护甲少 1 点，但下界的猪灵不会主动打你）
  const goldenBoots = bot.inventory.items().find((item) => item.name === 'golden_boots');
  if (goldenBoots) await bot.equip(goldenBoots, 'feet');
  ctx.log('穿好了盔甲');
}
