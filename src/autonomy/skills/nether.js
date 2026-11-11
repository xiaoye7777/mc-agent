// 下界技能：找下界要塞、在要塞里打烈焰人。
//
// 下界要塞是用“下界砖”（nether_bricks）盖的，所以找要塞 = 找下界砖。
// 区块数据里能直接看到 96 格内的下界砖；看不到就按“螺旋”往外探索：
// 走 64 格转 90 度，每转两次腿长加 64，这样能把周围一圈圈地扫一遍，不会一直往一个方向走到天边。
import pathfinderPkg from 'mineflayer-pathfinder';
import { countItem, goTo, sleep, throwIfAborted } from '../../actions/helpers.js';
import { goToNether } from './portal.js';
import { equipBestWeapon } from '../../actions/combat.js';
import { canShoot, hasClearShot, shootAt } from './archery.js';
import { attackUntilDead, collectDrops, findNearestEntity } from './world.js';

const { goals } = pathfinderPkg;

const FORTRESS_SEARCH_DISTANCE = 96;
const MAX_SPIRAL_LEGS = 14;

export function inNether(bot) {
  return String(bot.game.dimension).includes('nether');
}

/** 找到下界要塞并走到它旁边，返回一块下界砖的位置 */
export async function findFortress(ctx) {
  const { bot, signal, state } = ctx;
  if (!inNether(bot)) await goToNether(ctx); // 比如死了重生在主世界：先从传送门回去
  const bricksId = bot.registry.blocksByName.nether_bricks.id;

  state.spiral ??= { leg: 0, heading: Math.floor(Math.random() * 4) };
  while (true) {
    throwIfAborted(signal);
    const bricks = bot.findBlock({ matching: bricksId, maxDistance: FORTRESS_SEARCH_DISTANCE });
    if (bricks) {
      state.fortress = bricks.position.clone();
      ctx.log(`找到下界要塞了：${bricks.position}`);
      const { x, y, z } = bricks.position;
      await goTo(bot, new goals.GoalNear(x, y + 1, z, 3), { signal, timeoutMs: 180000 }).catch((err) => {
        if (err.name === 'AbortError') throw err;
      });
      return bricks.position;
    }
    if (state.spiral.leg >= MAX_SPIRAL_LEGS) throw new Error('绕了很大一圈都没找到下界要塞');
    await spiralStep(ctx);
  }
}

/** 螺旋探索的一步：朝当前方向走一条“腿”，然后右转 */
async function spiralStep(ctx) {
  const { bot, signal, state } = ctx;
  const { leg, heading } = state.spiral;
  const length = 64 * (Math.floor(leg / 2) + 1);
  const [dx, dz] = [[1, 0], [0, 1], [-1, 0], [0, -1]][heading % 4];
  const from = bot.entity.position;
  const x = Math.round(from.x + dx * length);
  const z = Math.round(from.z + dz * length);
  ctx.log(`找要塞：往 (${x}, ${z}) 走 ${length} 格（第 ${leg + 1} 段）`);
  try {
    await goTo(bot, new goals.GoalNearXZ(x, z, 8), { signal, timeoutMs: 240000 });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    ctx.log(`这段没走完（${err.message}），换方向`);
  }
  state.spiral = { leg: leg + 1, heading: heading + 1 };
}

/**
 * 打烈焰人：有弓箭就射（它停在 12~14 格外不过来）；没有就举盾挡火球，等它飞近了再放下盾砍。
 * 正面硬打的话几只烈焰人一起喷火球，几秒钟就死了（测试时 4 秒就死了一次）。
 * 盾牌对着火球的方向举起来能挡住火球；烈焰人喷完一轮会飞近，这时放下盾牌砍它。
 * @returns {Promise<import('vec3').Vec3>} 烈焰人最后的位置（捡烈焰棒用）
 */
async function fightBlaze(ctx, blaze) {
  const { bot, signal } = ctx;
  const hasShield = bot.inventory.slots[45]?.name === 'shield';
  await equipBestWeapon(bot);
  let shieldUp = false;
  const raise = () => {
    if (hasShield && !shieldUp) {
      bot.activateItem(true); // true = 副手
      shieldUp = true;
    }
  };
  const lower = () => {
    if (shieldUp) {
      bot.deactivateItem();
      shieldUp = false;
    }
  };
  const startedAt = Date.now();
  let shots = 0;
  let lastReposition = 0;
  let lastPosition = blaze.position.clone();
  try {
    while (Date.now() - startedAt < 60000) {
      throwIfAborted(signal);
      if (!blaze.isValid || !bot.entities[blaze.id]) return lastPosition;
      lastPosition = blaze.position.clone();
      const eye = blaze.position.offset(0, blaze.height * 0.6, 0);
      const distance = eye.distanceTo(bot.entity.position.offset(0, 1.6, 0));
      await bot.lookAt(eye, true);
      if (distance <= 3.2) {
        lower();
        await equipBestWeapon(bot);
        bot.attack(blaze);
        await sleep(600, signal);
      } else if (canShoot(bot) && distance <= MAX_SHOT && hasClearShot(bot, blaze)) {
        // 有弓有箭、视线没被挡：放下盾射它（空地上测试 4 箭一只，箭箭命中）
        lower();
        if (await shootAt(ctx, blaze)) {
          shots += 1;
          ctx.log(`射烈焰人第 ${shots} 箭（${Math.round(distance)} 格，它还剩 ${Math.round(blaze.health ?? blaze.metadata?.[9] ?? 0)} 血，箭剩 ${countItem(bot, 'arrow')}）`);
        }
        await sleep(200, signal);
      } else if (canShoot(bot) && distance <= MAX_SHOT && Date.now() - lastReposition > 4000) {
        // 视线被墙 / 栅栏挡住了：在附近找个能看见它、脚下又安全的位置挪过去
        lastReposition = Date.now();
        const spot = findShootingSpot(bot, blaze);
        if (spot) {
          lower();
          await goTo(bot, new goals.GoalBlock(spot.x, spot.y, spot.z), { signal, timeoutMs: 10000 }).catch((err) => {
            if (err.name === 'AbortError') throw err;
          });
        } else {
          raise();
          await sleep(250, signal);
        }
      } else {
        // 不追：要塞的桥没有栏杆，追着烈焰人跑会被火球顶下去摔死（测试时真这样死过）。原地举盾等它飞近
        raise();
        await sleep(250, signal);
      }
      if (bot.health < 10) {
        // 血少了：放下盾，自己吃东西（本能反应在举盾 / 拉弓时不会吃，会冲突）
        lower();
        await eatNow(bot);
      }
    }
    throw new Error('烈焰人打了 60 秒还没打死');
  } finally {
    lower();
  }
}

const MAX_SHOT = 24; // 再远的话烈焰人飘来飘去，命中率太低，白费箭

/** 马上吃一个最好的食物（打架时手动调用） */
async function eatNow(bot) {
  const foods = bot.registry.foodsByName;
  const food = bot.inventory
    .items()
    .filter((item) => foods[item.name] && !['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish'].includes(item.name))
    .sort((a, b) => foods[b.name].foodPoints - foods[a.name].foodPoints)[0];
  if (!food || bot.food >= 20) return;
  try {
    await bot.equip(food, 'hand');
    await bot.consume();
  } catch {
    // 吃不了就算了
  }
}

/** 附近 6 格内找一个能看见烈焰人、脚下安全（周围 3x3 都是实心地面）的站位，挑最近的 */
function findShootingSpot(bot, target) {
  const feet = bot.entity.position.floored();
  let best = null;
  for (let dx = -6; dx <= 6; dx++) {
    for (let dz = -6; dz <= 6; dz++) {
      for (let dy = -2; dy <= 2; dy++) {
        const stand = feet.offset(dx, dy, dz);
        if (!isSafeStand(bot, stand)) continue;
        if (!hasClearShot(bot, target, stand.offset(0.5, 1.62, 0.5))) continue;
        if (!best || stand.distanceTo(feet) < best.distanceTo(feet)) best = stand;
      }
    }
  }
  return best;
}

/** 站位安全：身体两格是空的，脚下和周围 8 格的地面都是实心的（被顶一下不会掉下去），不挨着岩浆 */
function isSafeStand(bot, stand) {
  if (bot.blockAt(stand)?.boundingBox !== 'empty' || bot.blockAt(stand.offset(0, 1, 0))?.boundingBox !== 'empty') return false;
  for (let ox = -1; ox <= 1; ox++) {
    for (let oz = -1; oz <= 1; oz++) {
      const below = bot.blockAt(stand.offset(ox, -1, oz));
      if (below?.boundingBox !== 'block' || below.name === 'lava') return false;
    }
  }
  return true;
}

/** 刷怪笼附近找一个安全站位：脚下实心，周围 8 格的地面也都是实心（被顶一下不会掉下去） */
function findSafeStand(bot, around) {
  const candidates = [];
  for (let dx = -6; dx <= 6; dx++) {
    for (let dz = -6; dz <= 6; dz++) {
      for (let dy = -3; dy <= 2; dy++) {
        const stand = around.offset(dx, dy, dz);
        const distance = stand.distanceTo(around);
        if (distance < 3 || distance > 7) continue;
        if (bot.blockAt(stand)?.boundingBox !== 'empty' || bot.blockAt(stand.offset(0, 1, 0))?.boundingBox !== 'empty') continue;
        let solidAround = true;
        for (let ox = -1; ox <= 1 && solidAround; ox++) {
          for (let oz = -1; oz <= 1; oz++) {
            const below = bot.blockAt(stand.offset(ox, -1, oz));
            if (below?.boundingBox !== 'block' || below.name === 'lava') {
              solidAround = false;
              break;
            }
          }
        }
        if (solidAround) candidates.push(stand);
      }
    }
  }
  candidates.sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position));
  return candidates[0] ?? null;
}

/**
 * 沿着要塞探索一步：在看得到的下界砖里，挑一块“所在区域还没去过、离现在最远”的走过去。
 * 去过的区域按 32x32 的格子记下来，这样会一直往要塞没探索过的方向推进。
 */
async function exploreFortress(ctx) {
  const { bot, signal, state } = ctx;
  state.fortressVisited ??= new Set();
  const cell = (position) => `${Math.floor(position.x / 32)},${Math.floor(position.z / 32)}`;
  state.fortressVisited.add(cell(bot.entity.position));

  const bricksId = bot.registry.blocksByName.nether_bricks.id;
  const bricks = bot.findBlocks({ matching: bricksId, maxDistance: FORTRESS_SEARCH_DISTANCE, count: 3000 });
  const unexplored = bricks
    .filter((position) => !state.fortressVisited.has(cell(position)))
    .filter((position) => bot.blockAt(position.offset(0, 1, 0))?.boundingBox === 'empty'); // 上面能站人
  if (unexplored.length === 0) {
    state.fortress = null; // 这片要塞走完了：重新找（可能是别的要塞）
    state.fortressVisited.clear();
    throw new Error('这座要塞走遍了也没找到烈焰人刷怪笼');
  }
  const farthest = unexplored.reduce((a, b) =>
    a.distanceTo(bot.entity.position) >= b.distanceTo(bot.entity.position) ? a : b,
  );
  ctx.log(`沿着要塞探索：去 ${farthest}`);
  try {
    await goTo(bot, new goals.GoalNear(farthest.x, farthest.y + 1, farthest.z, 3), { signal, timeoutMs: 120000 });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
  }
  state.fortressVisited.add(cell(farthest));
  state.fortressVisited.add(cell(bot.entity.position));
}

/**
 * 在要塞附近打烈焰人，直到 isDone()。看不到烈焰人就在要塞里随便走走（烈焰人在刷怪笼附近刷）。
 */
export async function huntInFortress(ctx, mobs, isDone) {
  const { bot, signal, state } = ctx;
  let idleRounds = 0;
  while (!isDone()) {
    throwIfAborted(signal);
    // 死了会重生在主世界：先回下界（主世界的地牢里也有刷怪笼，别认错）
    if (!inNether(bot)) {
      state.fortress = null;
      await goToNether(ctx);
    }
    if (!state.fortress) await findFortress(ctx);

    const target = findNearestEntity(bot, mobs, 48);
    if (target) {
      idleRounds = 0;
      ctx.log(`打 ${target.name}（${Math.round(target.position.distanceTo(bot.entity.position))} 格外）`);
      try {
        const where = target.name === 'blaze' ? await fightBlaze(ctx, target) : await attackUntilDead(ctx, target, 40000);
        await collectDrops(ctx, where, 6);
      } catch (err) {
        if (err.name === 'AbortError') throw err;
        ctx.log(err.message);
      }
      continue;
    }

    if (++idleRounds > 90) throw new Error(`在要塞里等了很久都没遇到 ${mobs.join('/')}`);

    // 烈焰人只在刷怪笼附近（16 格内有玩家时）刷出来：找到刷怪笼，站在旁边等
    const spawner = bot.findBlock({ matching: bot.registry.blocksByName.spawner.id, maxDistance: 96 });
    if (spawner) {
      const stand = findSafeStand(bot, spawner.position);
      if (stand && stand.distanceTo(bot.entity.position) > 1.5) {
        ctx.log(`去烈焰人刷怪笼旁边的安全位置等：${stand}`);
        await goTo(bot, new goals.GoalBlock(stand.x, stand.y, stand.z), { signal, timeoutMs: 120000 }).catch((err) => {
          if (err.name === 'AbortError') throw err;
        });
      }
      await sleep(2000, signal); // 等它刷
      continue;
    }

    // 没看到刷怪笼：沿着要塞往没去过的地方走（刷怪笼在要塞中间的楼梯房里，入口那段桥上没有）
    await exploreFortress(ctx);
  }
}
