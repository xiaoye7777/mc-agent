// 食物与打猎：打动物拿生肉 → 烧成熟肉，直到背包里的食物够吃。
import { countItem, throwIfAborted } from '../../actions/helpers.js';
import { MEAT } from '../knowledge.js';
import { smelt } from './smelt.js';
import { attackUntilDead, collectDrops, explore, findNearestEntity } from './world.js';

// 不算“能吃的”食物（有副作用）
const BAD_FOODS = new Set(['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'chicken']);

/** 背包里的食物一共能顶多少饱食度 */
export function foodPoints(bot) {
  const foods = bot.registry.foodsByName;
  return bot.inventory
    .items()
    .filter((item) => foods[item.name] && !BAD_FOODS.has(item.name))
    .reduce((sum, item) => sum + foods[item.name].foodPoints * item.count, 0);
}

/** 打猎 + 烤肉，直到食物够 minPoints 点饱食度 */
export async function ensureFood(ctx, minPoints) {
  const { bot, signal } = ctx;
  let explores = 0;
  while (foodPoints(bot) < minPoints) {
    throwIfAborted(signal);
    await ctx.rest?.();

    // 先把背包里的生肉烤了
    const raw = Object.values(MEAT).find(({ raw }) => countItem(bot, raw) > 0);
    if (raw && countItem(bot, raw.raw) >= 3) {
      await smelt(ctx, raw.cooked, countItem(bot, raw.cooked) + countItem(bot, raw.raw));
      continue;
    }

    const animal = findNearestEntity(bot, Object.keys(MEAT), 64);
    if (!animal) {
      if (raw) {
        // 附近没动物了，手上的生肉不多也先烤了
        await smelt(ctx, raw.cooked, countItem(bot, raw.cooked) + countItem(bot, raw.raw));
        continue;
      }
      if (explores++ >= 8) throw new Error('走了很远都没找到动物');
      await explore(ctx);
      continue;
    }

    ctx.log(`打猎：${animal.name}`);
    const where = await attackUntilDead(ctx, animal);
    await collectDrops(ctx, where, 5);
  }
}
