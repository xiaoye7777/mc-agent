// 挖矿技能：找到最近的目标方块 → 挖一条路过去 → 换合适的工具 → 挖 → 捡掉落物，直到满足条件。
//
// 怎么“找到”埋在地下的矿？mineflayer 收到的区块数据里本来就有所有方块（包括地下的），
// 所以 bot.findBlocks 能直接搜到 64 格内的铁矿、钻石——相当于“透视”。真人玩家得靠挖矿道碰运气，
// 机器人可以直接挖一条路过去。
import pathfinderPkg from 'mineflayer-pathfinder';
import { goTo, throwIfAborted } from '../../actions/helpers.js';
import { collectDrops, explore, tidyInventory } from './world.js';

const { goals } = pathfinderPkg;

const UNREACHABLE_MS = 5 * 60 * 1000;
const MAX_FAILURES_BEFORE_EXPLORE = 6;

/**
 * 一直挖 blockNames 里的方块，直到 isDone() 返回 true。
 * @param {object} ctx
 * @param {string[]} blockNames 要挖的方块
 * @param {() => boolean} isDone
 * @param {{ searchDistance?: number, maxExplore?: number }} [options]
 */
export async function mineUntil(ctx, blockNames, isDone, { searchDistance = 64, maxExplore = 8 } = {}) {
  const { bot, signal } = ctx;
  const ids = blockNames.map((name) => bot.registry.blocksByName[name]?.id).filter((id) => id !== undefined);
  if (ids.length === 0) throw new Error(`不认识方块 ${blockNames.join('/')}`);

  let explores = 0;
  let failures = 0;
  while (!isDone()) {
    throwIfAborted(signal);
    await ctx.rest?.(); // 天黑了先睡觉
    await tidyInventory(ctx);
    if (bot.inventory.emptySlotCount() === 0) throw new Error('背包满了');

    const block = findTarget(ctx, ids, searchDistance);
    if (!block || failures >= MAX_FAILURES_BEFORE_EXPLORE) {
      if (explores >= maxExplore) throw new Error(`走了很远都没找到能挖的 ${blockNames[0]}`);
      explores += 1;
      failures = 0;
      await explore(ctx);
      continue;
    }

    try {
      await digBlock(ctx, block);
      failures = 0;
    } catch (err) {
      if (err.name === 'AbortError' || err.fatal || signal.aborted) throw err;
      ctx.state.unreachable.set(block.position.toString(), Date.now() + UNREACHABLE_MS);
      failures += 1;
      ctx.log(`挖不到 ${block.name} ${block.position}：${err.message}`);
    }
  }
}

/** 挖一个方块：挖路过去（或者走到能够着的位置）→ 换工具 → 挖 → 捡 */
export async function digBlock(ctx, block) {
  const { bot, signal } = ctx;
  const { x, y, z } = block.position;
  // 两种“到位”都行：站在能看见它、手够得着的地方；或者挖路挖到它旁边（埋在地下的矿只能这样）
  const goal = new goals.GoalCompositeAny([
    new goals.GoalLookAtBlock(block.position, bot.world, { reach: 4.5 }),
    new goals.GoalGetToBlock(x, y, z),
  ]);
  await goTo(bot, goal, { signal, timeoutMs: 90000 });
  throwIfAborted(signal);

  const current = bot.blockAt(block.position);
  if (!current || current.type !== block.type) return; // 已经没了（可能挖路时顺手挖掉了）

  const tool = bot.pathfinder.bestHarvestTool(current);
  if (tool) await bot.equip(tool, 'hand');
  if (!current.canHarvest(bot.heldItem?.type ?? null)) {
    const err = new Error(`挖 ${current.name} 需要更好的镐子`);
    err.fatal = true;
    throw err;
  }

  const onAbort = () => bot.stopDigging();
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    await bot.dig(current, true);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
  await collectDrops(ctx, block.position, 5);
}

/** 找最近的、没被标记成“够不着”、旁边没有岩浆的目标方块 */
function findTarget(ctx, ids, searchDistance) {
  const { bot, state } = ctx;
  const positions = bot.findBlocks({ matching: ids, maxDistance: searchDistance, count: 48 });
  const now = Date.now();
  for (const position of positions) {
    if ((state.unreachable.get(position.toString()) ?? 0) > now) continue;
    if (nearLiquid(bot, position)) continue; // 挖开会让岩浆 / 水灌进来（测试时真的淹死过）
    return bot.blockAt(position);
  }
  return null;
}

function nearLiquid(bot, position) {
  for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
    const name = bot.blockAt(position.offset(dx, dy, dz))?.name;
    if (name === 'lava' || name === 'water') return true;
  }
  return false;
}
