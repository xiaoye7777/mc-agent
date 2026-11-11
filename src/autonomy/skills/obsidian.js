// 黑曜石和燧石。
//
// 黑曜石：自然生成的黑曜石全挨着岩浆或水（测试世界里 238 块没有一块是“干”的），直接挖很危险。
// 所以用玩家常用的办法自己“造”：找一片岩浆池，站在岸上往池边倒水 → 水流到的岩浆源头变成黑曜石 →
// 把水收回桶里 → 站在岸上把黑曜石挖下来（绝不站到黑曜石上，下面可能还是岩浆）。
//
// 用桶最容易出错的是“瞄准”：桶是按视线打到的第一个方块来放水的。站得太近、角度太陡，
// 视线会先打到脚边的方块，水（或岩浆）就倒在自己身边了——测试时真这样过。
// 所以每次用桶前先看 bot.blockAtCursor() 确认准星确实对着想要的方块和面。
import pathfinderPkg from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { countItem, digWithTimeout, goTo, sleep, throwIfAborted } from '../../actions/helpers.js';
import { collectDrops, explore, placeBlockNear } from './world.js';

const { goals } = pathfinderPkg;

const REACH = 4.5;
// 地表很少有岩浆池，大部分在地下深处（y=-55 附近的岩浆湖），离地面 120 多格，所以搜得远一点
const LAVA_SEARCH_DISTANCE = 160;
const SIDES = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)];

// ---------- 燧石 ----------

/** 挖砂砾直到掉出燧石（10% 概率）。挖到的是砂砾就放下再挖，直到出燧石 */
export async function getFlint(ctx, count = 1) {
  const { bot, signal } = ctx;
  for (let tries = 0; countItem(bot, 'flint') < count; tries++) {
    throwIfAborted(signal);
    if (tries > 60) throw new Error('挖了 60 次砂砾都没出燧石');
    if (countItem(bot, 'gravel') === 0) {
      await ctx.obtain('gravel', 1);
      continue;
    }
    const placed = await placeBlockNear(ctx, 'gravel');
    await sleep(300, signal); // 砂砾会往下掉，等它落稳
    const settled = bot.blockAt(placed.position)?.name === 'gravel' ? placed : bot.findBlock({ matching: placed.type, maxDistance: 4 });
    if (!settled) continue;
    await bot.dig(settled, true);
    await collectDrops(ctx, settled.position, 3);
  }
  ctx.log('拿到燧石了');
}

// ---------- 水桶 ----------

/** 把空桶装满水（找最近的水源，对准，用桶） */
export async function fillWaterBucket(ctx) {
  const { bot, signal } = ctx;
  if (countItem(bot, 'water_bucket') > 0) return;
  if (countItem(bot, 'bucket') === 0) await ctx.obtain('bucket', 1);

  for (let attempt = 0; attempt < 6; attempt++) {
    throwIfAborted(signal);
    const water = findLiquidSource(bot, 'water', 48);
    if (!water) {
      await explore(ctx);
      continue;
    }
    await goTo(bot, new goals.GoalNear(water.x, water.y, water.z, 2), { signal, timeoutMs: 40000 }).catch(() => {});
    await bot.equip(bot.inventory.items().find((item) => item.name === 'bucket'), 'hand');
    await bot.lookAt(water.offset(0.5, 0.8, 0.5), true);
    await sleep(200, signal);
    bot.activateItem();
    await sleep(800, signal);
    if (countItem(bot, 'water_bucket') > 0) {
      ctx.log('装好一桶水');
      return;
    }
  }
  throw new Error('装不上水');
}

// ---------- 黑曜石 ----------

/** 弄到 count 块黑曜石（往岩浆池边倒水造出来，再挖） */
export async function makeObsidian(ctx, count) {
  const { bot, signal } = ctx;
  let rounds = 0;
  while (countItem(bot, 'obsidian') < count) {
    throwIfAborted(signal);
    if (rounds++ > 15) throw new Error('试了很多次还是没弄够黑曜石');

    // 1. 附近已经有造好的黑曜石，并且站在岸上就够得着 → 直接挖
    if (await mineReachableObsidian(ctx, count)) continue;

    // 2. 造新的：要一桶水
    await fillWaterBucket(ctx);
    const spot = findPourSpot(bot, ctx.state.unreachable);
    if (!spot) {
      ctx.log('附近没有合适的岩浆池，去别处找');
      await explore(ctx);
      continue;
    }
    // 先走到池边附近，再挑一个能看见岸边那块方块“上表面”的位置站好
    ctx.log(`去岩浆池边 ${spot.edge}`);
    await goTo(bot, new goals.GoalNear(spot.edge.x, spot.edge.y + 1, spot.edge.z, 4), { signal, timeoutMs: 240000 });
    if (!(await pourFromGoodSpot(ctx, spot))) {
      ctx.log('倒水没对准，换个地方');
      ctx.state.unreachable.set(spot.lava.toString(), Date.now() + 5 * 60 * 1000);
      continue;
    }
    await sleep(2500, signal); // 等水流过去、岩浆凝固
    await scoopWater(ctx, spot.edge.offset(0, 1, 0));
  }
  ctx.log(`黑曜石够了（${countItem(bot, 'obsidian')} 块）`);
}

/**
 * 找几个站位试着倒水：站位脚下实心、身体两格是空气，不是岸边那块本身，也不是要倒水的那一格，
 * 离岸边上表面 1.5~4 格。站到岸边方块上面的话是看不到它的上表面的（之前就是这样一直对不准）。
 */
async function pourFromGoodSpot(ctx, spot) {
  const { bot, signal } = ctx;
  const target = spot.edge.offset(0.5, 1, 0.5);
  const stands = [];
  for (let dx = -3; dx <= 3; dx++) {
    for (let dz = -3; dz <= 3; dz++) {
      for (let dy = -1; dy <= 2; dy++) {
        const stand = spot.edge.offset(dx, dy + 1, dz);
        if (stand.x === spot.edge.x && stand.z === spot.edge.z) continue; // 岸边那块的正上方
        if (stand.x === spot.lava.x && stand.z === spot.lava.z) continue;
        const below = bot.blockAt(stand.offset(0, -1, 0));
        if (below?.boundingBox !== 'block' || below.name === 'obsidian') continue;
        if (bot.blockAt(stand)?.name !== 'air' || bot.blockAt(stand.offset(0, 1, 0))?.name !== 'air') continue;
        const distance = stand.offset(0.5, 1.62, 0.5).distanceTo(target);
        if (distance >= 1.5 && distance <= 4) stands.push(stand);
      }
    }
  }
  stands.sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position));
  for (const stand of stands.slice(0, 5)) {
    try {
      await goTo(bot, new goals.GoalBlock(stand.x, stand.y, stand.z), { signal, timeoutMs: 20000 });
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      continue;
    }
    if (await pourWater(ctx, spot.edge)) return true;
  }
  return false;
}

/** 往 edge 方块的上表面倒水。先确认准星对准了，才真的用桶 */
async function pourWater(ctx, edge) {
  const { bot, signal } = ctx;
  await bot.equip(bot.inventory.items().find((item) => item.name === 'water_bucket'), 'hand');
  for (const [ox, oz] of [[0.5, 0.5], [0.3, 0.3], [0.7, 0.7], [0.3, 0.7], [0.7, 0.3]]) {
    await bot.lookAt(edge.offset(ox, 1, oz), true);
    await sleep(150, signal);
    const cursor = bot.blockAtCursor(REACH);
    if (cursor && cursor.position.equals(edge) && cursor.face === 1) {
      bot.activateItem();
      await sleep(600, signal);
      return countItem(bot, 'water_bucket') === 0;
    }
  }
  return false;
}

/** 把刚倒的水收回来（水源在 position） */
async function scoopWater(ctx, position) {
  const { bot, signal } = ctx;
  if (countItem(bot, 'bucket') === 0) return;
  await bot.equip(bot.inventory.items().find((item) => item.name === 'bucket'), 'hand');
  for (const oy of [0.8, 0.5, 0.2]) {
    await bot.lookAt(position.offset(0.5, oy, 0.5), true);
    await sleep(150, signal);
    bot.activateItem();
    await sleep(600, signal);
    if (countItem(bot, 'water_bucket') > 0) return;
  }
  ctx.log('水没收回来（下次再装一桶）');
}

/**
 * 挖站在岸上就够得着的黑曜石（不移动到黑曜石上面）。
 * 只挖“上面是空的”的黑曜石：从上面看得见、挖完下面就算有岩浆也只会留在坑里。
 */
async function mineReachableObsidian(ctx, count) {
  const { bot, signal } = ctx;
  const obsidianId = bot.registry.blocksByName.obsidian.id;
  const candidates = bot
    .findBlocks({ matching: obsidianId, maxDistance: 6, count: 32 })
    .filter((position) => position.distanceTo(bot.entity.position.offset(0, 1.6, 0)) <= REACH)
    .filter((position) => bot.blockAt(position.offset(0, 1, 0))?.boundingBox === 'empty')
    .filter((position) => !position.equals(bot.entity.position.floored().offset(0, -1, 0))); // 不挖脚下那块
  if (candidates.length === 0) return false;

  const pickaxe = bot.inventory.items().find((item) => item.name === 'diamond_pickaxe' || item.name === 'netherite_pickaxe');
  if (!pickaxe) throw Object.assign(new Error('挖黑曜石要钻石镐'), { fatal: true });
  for (const position of candidates) {
    throwIfAborted(signal);
    if (countItem(bot, 'obsidian') >= count) break;
    const block = bot.blockAt(position);
    if (block?.name !== 'obsidian') continue;
    await bot.equip(pickaxe, 'hand');
    const feetBlock = bot.blockAt(bot.entity.position.floored())?.name;
    ctx.log(`挖黑曜石 ${position}（现在 ${countItem(bot, 'obsidian')} 块；预计 ${(bot.digTime(block) / 1000).toFixed(1)} 秒，站稳 ${bot.entity.onGround}，脚下 ${feetBlock}，离眼睛 ${position.offset(0.5, 0.5, 0.5).distanceTo(bot.entity.position.offset(0, 1.62, 0)).toFixed(1)} 格）`);
    try {
      await digWithTimeout(bot, block, bot.digTime(block) + 10000);
    } catch (err) {
      ctx.log(err.message);
      continue;
    }
    await sleep(300, signal);
    // 掉落物就在岸边够得着的地方才去捡，不往池子里走
    const drop = Object.values(bot.entities).find(
      (entity) => entity.name === 'item' && entity.position.distanceTo(position) < 2,
    );
    if (drop && isSafeGround(bot, drop.position.floored())) await collectDrops(ctx, position, 2);
  }
  return true;
}

/**
 * 找倒水的位置：一个岩浆源头 lava（上面是空气 = 在池面上），旁边有一块和它一样高的实心岸 edge，
 * 岸上面是空的（水会倒在那儿，再流进岩浆）。
 */
function findPourSpot(bot, unreachable) {
  const now = Date.now();
  const lavaSources = bot.findBlocks({
    matching: (block) => block.name === 'lava' && block.metadata === 0,
    useExtraInfo: true,
    maxDistance: LAVA_SEARCH_DISTANCE,
    count: 400,
  });
  for (const lava of lavaSources) {
    if ((unreachable.get(lava.toString()) ?? 0) > now) continue;
    if (bot.blockAt(lava.offset(0, 1, 0))?.boundingBox !== 'empty') continue;
    for (const side of SIDES) {
      const edge = lava.plus(side);
      const edgeBlock = bot.blockAt(edge);
      if (edgeBlock?.boundingBox !== 'block') continue;
      if (bot.blockAt(edge.offset(0, 1, 0))?.boundingBox !== 'empty') continue;
      if (bot.blockAt(edge.offset(0, 2, 0))?.boundingBox !== 'empty') continue;
      return { lava, edge };
    }
  }
  return null;
}

function isSafeGround(bot, position) {
  const below = bot.blockAt(position.offset(0, -1, 0));
  return below?.boundingBox === 'block' && below.name !== 'obsidian';
}

/** 最近的液体源头（metadata 0 = 源头），上面是空气（在表面，够得着） */
function findLiquidSource(bot, name, maxDistance) {
  const positions = bot.findBlocks({
    matching: (block) => block.name === name && block.metadata === 0,
    useExtraInfo: true,
    maxDistance,
    count: 64,
  });
  return positions.find((position) => bot.blockAt(position.offset(0, 1, 0))?.boundingBox === 'empty') ?? null;
}
