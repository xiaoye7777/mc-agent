// 合成技能：挑最省事的配方 → 把材料备齐（缺什么交给规划器去弄）→ 需要的话放个工作台 → 合成。
import pathfinderPkg from 'mineflayer-pathfinder';
import { countItem, craftVerified, goTo } from '../../actions/helpers.js';
import { INGREDIENT_COST, MINING, MOB_DROPS, SMELTING } from '../knowledge.js';
import { placeBlockNear } from './world.js';

const { goals } = pathfinderPkg;

/**
 * 合成到背包里有 count 个 itemName 为止。缺的材料调用 ctx.obtain() 递归去弄。
 */
export async function craftItem(ctx, itemName, count) {
  const { bot } = ctx;
  const itemId = bot.registry.itemsByName[itemName]?.id;
  const variants = itemId === undefined ? [] : bot.recipesAll(itemId, null, true);
  if (variants.length === 0) throw new Error(`${itemName} 没有合成配方`);

  const want = count - countItem(bot, itemName);
  if (want <= 0) return;

  const variant = chooseVariant(bot, variants, want);
  const times = Math.ceil(want / variant.result.count);
  const needs = ingredientsOf(bot, variant, times);
  ctx.log(`合成 ${itemName} x${want}，需要：${[...needs].map(([name, n]) => `${name} x${n}`).join('、')}`);

  // 需要工作台的话先把工作台弄好：做工作台本身也要吃木板，放到最后会把刚备好的材料吃掉
  if (variant.requiresTable) await ensureCraftingTable(ctx);

  // 备料。做一种材料可能会用掉另一种（做木棍会吃掉木板），所以多检查几遍
  for (let pass = 0; pass < 4; pass++) {
    const missing = [...needs].filter(([name, n]) => countItem(bot, name) < n);
    if (missing.length === 0) break;
    // 先做“由别的材料合成的”（比如木棍），最后补基础材料（木板）
    missing.sort(([a], [b]) => (a === 'stick' ? -1 : 0) - (b === 'stick' ? -1 : 0));
    for (const [name, n] of missing) await ctx.obtain(name, n);
  }

  // 备料时可能走远了（去砍树、挖矿），再回到工作台旁边
  const table = variant.requiresTable ? await ensureCraftingTable(ctx) : null;
  const findRecipe = () => {
    const usable = bot.recipesFor(itemId, null, 1, table);
    return usable.find((r) => sameIngredients(r, variant)) ?? usable[0];
  };
  if (!findRecipe()) throw new Error(`做 ${itemName} 的材料备齐了，但还是合成不了`);

  await craftVerified(bot, itemName, findRecipe, times, table, ctx.signal);
  ctx.log(`合成好了 ${itemName}（现在有 ${countItem(bot, itemName)} 个）`);
}

/** 附近（24 格内）有工作台就走过去用，没有就弄一个放下 */
export async function ensureCraftingTable(ctx) {
  const { bot, signal } = ctx;
  const tableId = bot.registry.blocksByName.crafting_table.id;
  const existing = bot.findBlock({ matching: tableId, maxDistance: 24 });
  if (existing) {
    if (existing.position.distanceTo(bot.entity.position) > 3.5) {
      const { x, y, z } = existing.position;
      await goTo(bot, new goals.GoalNear(x, y, z, 2), { signal, timeoutMs: 30000 });
    }
    return bot.blockAt(existing.position);
  }
  await ctx.obtain('crafting_table', 1);
  return placeBlockNear(ctx, 'crafting_table');
}

/** 一个配方做 times 次需要的材料：Map<物品名, 数量> */
export function ingredientsOf(bot, recipe, times) {
  const needs = new Map();
  for (const entry of recipe.delta) {
    if (entry.count >= 0) continue;
    const name = bot.registry.items[entry.id].name;
    needs.set(name, (needs.get(name) ?? 0) - entry.count * times);
  }
  return needs;
}

/**
 * 同一种东西有很多配方变体，挑“最省事”的那个。
 * 不能只数缺几个材料：白床有两种做法——“3 羊毛 + 3 木板”和“白色染料 + 一张别的颜色的床”，
 * 只数个数的话后者（缺 2 个）比前者（缺 6 个）“便宜”，结果一路推到“要墨囊（只有鱿鱼掉）”走进死胡同。
 * 所以要递归估算每种材料的真实成本：挖/打/砍 = 1，烧 = 原料 + 2，合成 = 各材料成本之和，
 * 推不出来（或绕回自己）= 无穷大。
 */
export function chooseVariant(bot, variants, want) {
  const estimator = createCostEstimator(bot);
  let best = variants[0];
  let bestCost = Infinity;
  for (const variant of variants) {
    const times = Math.ceil(want / variant.result.count);
    let cost = 0;
    for (const [name, n] of ingredientsOf(bot, variant, times)) {
      const missing = Math.max(0, n - countItem(bot, name));
      if (missing > 0) cost += missing * estimator(name);
    }
    if (cost < bestCost) {
      best = variant;
      bestCost = cost;
    }
  }
  return best;
}

const MAX_ESTIMATE_DEPTH = 5;

/** 估算“从零弄到 1 个某物品”有多费劲（带缓存、防循环） */
function createCostEstimator(bot) {
  const nearestWood = nearestTreeWood(bot);
  const memo = new Map();

  function estimate(item, depth, visiting) {
    if (countItem(bot, item) > 0) return 0;
    if (memo.has(item)) return memo.get(item);
    let cost = Infinity;
    if (item.endsWith('_log')) {
      cost = item === `${nearestWood}_log` ? 1 : 3; // 附近就有这种树最省事
    } else if (MINING[item] || MOB_DROPS[item]) {
      cost = INGREDIENT_COST[item] ?? 1;
    } else if (SMELTING[item]) {
      cost = 2 + estimate(SMELTING[item], depth + 1, visiting);
    } else if (depth < MAX_ESTIMATE_DEPTH && !visiting.has(item)) {
      const id = bot.registry.itemsByName[item]?.id;
      const variants = id === undefined ? [] : bot.recipesAll(id, null, true);
      visiting.add(item);
      for (const variant of variants) {
        let variantCost = 0.5; // 合成本身也算一点成本
        for (const [name, n] of ingredientsOf(bot, variant, 1)) {
          variantCost += (n * estimate(name, depth + 1, visiting)) / variant.result.count;
          if (variantCost >= cost) break;
        }
        cost = Math.min(cost, variantCost);
      }
      visiting.delete(item);
    }
    if (INGREDIENT_COST[item] !== undefined && cost !== Infinity) cost = Math.max(cost, INGREDIENT_COST[item]);
    if (depth === 0 || cost !== Infinity) memo.set(item, cost);
    return cost;
  }

  return (item) => estimate(item, 0, new Set());
}

/** 附近最近的树是什么木头（oak / birch / spruce …） */
export function nearestTreeWood(bot) {
  const logIds = Object.values(bot.registry.blocksByName)
    .filter((block) => block.name.endsWith('_log') && !block.name.startsWith('stripped_'))
    .map((block) => block.id);
  const log = bot.findBlock({ matching: logIds, maxDistance: 48 });
  return log ? log.name.replace(/_log$/, '') : 'oak';
}

function sameIngredients(a, b) {
  const ids = (recipe) =>
    recipe.delta
      .filter((entry) => entry.count < 0)
      .map((entry) => entry.id)
      .sort()
      .join(',');
  return ids(a) === ids(b);
}
