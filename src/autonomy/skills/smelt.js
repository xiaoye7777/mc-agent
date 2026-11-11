// 冶炼技能：备好原料和燃料 → 找（或放）一个熔炉 → 放进去 → 等烧好 → 取出来。
import pathfinderPkg from 'mineflayer-pathfinder';
import { countItem, goTo, sleep } from '../../actions/helpers.js';
import { FUELS, SMELTING, WOOD_FUEL_PER_ITEM } from '../knowledge.js';
import { nearestTreeWood } from './craft.js';
import { placeBlockNear } from './world.js';

const { goals } = pathfinderPkg;

const SECONDS_PER_ITEM = 10;

/** 烧到背包里有 count 个 outputName 为止 */
export async function smelt(ctx, outputName, count) {
  const { bot, signal } = ctx;
  const inputName = SMELTING[outputName];
  const want = count - countItem(bot, outputName);
  if (want <= 0) return;

  await ctx.obtain(inputName, want);
  const fuel = await ensureFuel(ctx, want);
  const furnaceBlock = await ensureFurnace(ctx);

  ctx.log(`用熔炉烧 ${inputName} x${want} → ${outputName}（燃料 ${fuel.name} x${fuel.count}）`);
  await withFurnace(bot, furnaceBlock, async (furnace) => {
    if (furnace.outputItem()) await furnace.takeOutput(); // 上次没取走的
    await furnace.putFuel(bot.registry.itemsByName[fuel.name].id, null, fuel.count);
    await furnace.putInput(bot.registry.itemsByName[inputName].id, null, want);
  });

  // 等的时候把熔炉界面关掉：开着界面没法换武器，怪物来了还不了手（真的被僵尸打死过）
  const deadline = Date.now() + (want * SECONDS_PER_ITEM + 20) * 1000;
  while (countItem(bot, outputName) < count && Date.now() < deadline) {
    await sleep(5000, signal);
    if (furnaceBlock.position.distanceTo(bot.entity.position) > 4) {
      const { x, y, z } = furnaceBlock.position;
      await goTo(bot, new goals.GoalNear(x, y, z, 2), { signal, timeoutMs: 30000 });
    }
    await withFurnace(bot, bot.blockAt(furnaceBlock.position), async (furnace) => {
      if (furnace.outputItem()) await furnace.takeOutput();
    });
  }
  if (countItem(bot, outputName) < count) throw new Error(`${outputName} 没烧够（可能燃料不够）`);
}

async function withFurnace(bot, block, work) {
  const furnace = await bot.openFurnace(block);
  try {
    await work(furnace);
  } finally {
    furnace.close();
  }
}

/** 备燃料：优先煤（1 个烧 8 个），附近有煤矿就去挖；实在没有就烧木板 */
async function ensureFuel(ctx, items) {
  const { bot } = ctx;
  for (const [name, perItem] of Object.entries(FUELS)) {
    const needed = Math.ceil(items / perItem);
    if (countItem(bot, name) >= needed) return { name, count: needed };
  }

  const coalNeeded = Math.ceil(items / FUELS.coal);
  const coalOre = bot.findBlock({
    matching: ['coal_ore', 'deepslate_coal_ore'].map((name) => bot.registry.blocksByName[name].id),
    maxDistance: 32,
  });
  if (coalOre && items >= 4) {
    try {
      await ctx.obtain('coal', coalNeeded);
      return { name: 'coal', count: coalNeeded };
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      ctx.log(`挖煤失败（${err.message}），改烧木板`);
    }
  }

  const planksNeeded = Math.ceil(items / WOOD_FUEL_PER_ITEM);
  const planks = `${nearestTreeWood(bot)}_planks`;
  const existing = bot.inventory.items().find((item) => item.name.endsWith('_planks') && item.count >= planksNeeded);
  if (existing) return { name: existing.name, count: planksNeeded };
  await ctx.obtain(planks, planksNeeded);
  return { name: planks, count: planksNeeded };
}

/** 附近（24 格内）有熔炉就走过去用，没有就弄一个放下 */
async function ensureFurnace(ctx) {
  const { bot, signal } = ctx;
  const furnaceId = bot.registry.blocksByName.furnace.id;
  const existing = bot.findBlock({ matching: furnaceId, maxDistance: 24 });
  if (existing) {
    if (existing.position.distanceTo(bot.entity.position) > 3.5) {
      const { x, y, z } = existing.position;
      await goTo(bot, new goals.GoalNear(x, y, z, 2), { signal, timeoutMs: 30000 });
    }
    return bot.blockAt(existing.position);
  }
  await ctx.obtain('furnace', 1);
  return placeBlockNear(ctx, 'furnace');
}
