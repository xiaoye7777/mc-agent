// 规划器：自主发育的核心。给它一个目标（“背包里要有 1 把铁镐”），它自己倒推出整条依赖链并执行。
//
//   obtain(铁镐)
//     └─ 合成：要 3 铁锭 + 2 木棍 + 工作台
//          ├─ obtain(铁锭 x3) → 冶炼：要 3 粗铁 + 燃料 + 熔炉
//          │     ├─ obtain(粗铁 x3) → 挖铁矿：要石镐
//          │     │     └─ obtain(石镐) → 合成：要 3 圆石 + 2 木棍
//          │     │           └─ obtain(圆石 x3) → 挖石头：要木镐 → ……一直推到“砍树”
//          │     ├─ 燃料：有煤用煤，附近有煤矿去挖，否则烧木板
//          │     └─ obtain(熔炉) → 合成：要 8 圆石
//          └─ obtain(木棍 x2) → 合成：要木板 → 要原木 → 砍树
//
// 它是“无状态”的：每一步都看当前背包还缺什么。所以中途死了、被打断了，重新调用就能接着来。
import { countItem, throwIfAborted } from '../actions/helpers.js';
import { MINING, MOB_DROPS, PICKAXE_TIERS, SMELTING } from './knowledge.js';
import { craftItem } from './skills/craft.js';
import { mineUntil } from './skills/mine.js';
import { fillWaterBucket, getFlint, makeObsidian } from './skills/obsidian.js';
import { smelt } from './skills/smelt.js';
import { attackUntilDead, collectDrops, explore, findNearestEntity } from './skills/world.js';

const MAX_DEPTH = 14;

// 常用材料一次多弄点，免得做个木棍跑一趟树、做个熔炉又跑一趟（真人玩家也是这么干的）
const MIN_BATCH = { log: 5, cobblestone: 16, coal: 8 };
const batchOf = (item) => (item.endsWith('_log') ? MIN_BATCH.log : MIN_BATCH[item] ?? 0);

/** 让背包里至少有 count 个 item（已经够了就什么都不做） */
export async function obtain(ctx, item, count) {
  const { bot } = ctx;
  throwIfAborted(ctx.signal);
  if (ownedCount(bot, item) >= count) return;
  if (ctx.depth >= MAX_DEPTH) throw new Error(`规划太深了（${item}），可能有循环依赖`);

  ctx.depth += 1;
  try {
    ctx.log(`需要 ${item} x${count}（现在 ${countItem(bot, item)}）`);
    const target = Math.max(count, batchOf(item));
    const isDone = () => countItem(bot, item) >= target;

    if (item.endsWith('_log')) return await mineUntil(ctx, [item], isDone);

    // 几样要专门技能才能弄到的东西
    if (item === 'flint') return await getFlint(ctx, count);
    if (item === 'obsidian') return await makeObsidian(ctx, count);
    if (item === 'water_bucket') return await fillWaterBucket(ctx);

    const mining = MINING[item];
    if (mining) {
      if (mining.tool) await ensurePickaxe(ctx, mining.tool);
      return await mineUntil(ctx, mining.blocks, isDone, { searchDistance: mining.searchDistance });
    }

    if (SMELTING[item]) return await smelt(ctx, item, count);
    if (MOB_DROPS[item]) return await hunt(ctx, MOB_DROPS[item], isDone);
    return await craftItem(ctx, item, count);
  } finally {
    ctx.depth -= 1;
  }
}

/** 至少要有 minTool 这个档次的镐子（有更好的也行） */
async function ensurePickaxe(ctx, minTool) {
  const need = PICKAXE_TIERS.indexOf(minTool);
  const best = Math.max(...PICKAXE_TIERS.map((name, tier) => (countItem(ctx.bot, name) > 0 ? tier : -1)));
  if (best >= need) return;
  await obtain(ctx, minTool, 1);
}

async function hunt(ctx, mobs, isDone) {
  let explores = 0;
  while (!isDone()) {
    throwIfAborted(ctx.signal);
    await ctx.rest?.();
    const target = findNearestEntity(ctx.bot, mobs, 64);
    if (!target) {
      if (explores++ >= 8) throw new Error(`走了很远都没找到 ${mobs.join('/')}`);
      await explore(ctx);
      continue;
    }
    const where = await attackUntilDead(ctx, target);
    await collectDrops(ctx, where, 5);
  }
}

// ---------- “有没有”的判断：穿在身上、拿在副手的也算 ----------

const ARMOR_AND_OFFHAND_SLOTS = [5, 6, 7, 8, 45];

/** 一共有几个：背包 + 身上的盔甲 + 副手 */
export function ownedCount(bot, itemName) {
  const worn = ARMOR_AND_OFFHAND_SLOTS.map((slot) => bot.inventory.slots[slot]).filter((item) => item?.name === itemName);
  return countItem(bot, itemName) + worn.reduce((sum, item) => sum + item.count, 0);
}

const TIERS = ['wooden', 'stone', 'iron', 'diamond', 'netherite'];
const GEAR = /^(wooden|stone|iron|diamond|netherite)_(pickaxe|sword|axe|shovel|helmet|chestplate|leggings|boots)$/;

/** 有没有“这件或者更好的”：要石镐时有铁镐也算 */
export function hasAtLeast(bot, itemName, count = 1) {
  const match = itemName.match(GEAR);
  if (!match) return ownedCount(bot, itemName) >= count;
  const [, tier, kind] = match;
  const tiers = TIERS.slice(TIERS.indexOf(tier));
  return tiers.reduce((sum, t) => sum + ownedCount(bot, `${t}_${kind}`), 0) >= count;
}
