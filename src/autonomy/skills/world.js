// 通用技能：放方块、捡掉落物、探索新区域、打一个生物。
// 每个技能都接收 ctx = { bot, signal, state, log }，signal 被取消时要尽快停下。
import pathfinderPkg from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { equipBestWeapon } from '../../actions/combat.js';
import { goTo, sleep, throwIfAborted } from '../../actions/helpers.js';

const { goals } = pathfinderPkg;

/**
 * 在身边找个空位，把背包里的某个方块放下去（工作台、熔炉……），返回放好的方块。
 * 空位要求：本身是空气（或草这类没碰撞箱的），下面是实心方块，而且不是 NPC 自己站的那一格。
 */
export async function placeBlockNear(ctx, itemName) {
  const { bot } = ctx;
  const item = bot.inventory.items().find((entry) => entry.name === itemName);
  if (!item) throw new Error(`背包里没有 ${itemName}，放不了`);

  const feet = bot.entity.position.floored();
  const spots = [];
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      if (dx === 0 && dz === 0) continue; // 自己站的那一列
      for (let dy = -1; dy <= 1; dy++) {
        const position = feet.offset(dx, dy, dz);
        const here = bot.blockAt(position);
        const below = bot.blockAt(position.offset(0, -1, 0));
        if (!here || !below) continue;
        if (here.boundingBox !== 'empty' || here.name === 'water' || here.name === 'lava') continue;
        if (below.boundingBox !== 'block') continue;
        spots.push(position);
      }
    }
  }
  // 优先离得近、和脚同高的位置
  spots.sort((a, b) => scoreSpot(feet, a) - scoreSpot(feet, b));

  for (const position of spots.slice(0, 8)) {
    throwIfAborted(ctx.signal);
    try {
      await bot.equip(item, 'hand');
      await bot.placeBlock(bot.blockAt(position.offset(0, -1, 0)), new Vec3(0, 1, 0));
      const placed = bot.blockAt(position);
      if (placed?.name === itemName) {
        ctx.log(`放下了 ${itemName}`);
        return placed;
      }
    } catch {
      // 这个位置放不了（被实体挡住、看不到面……），换下一个
    }
  }
  throw new Error(`身边找不到能放 ${itemName} 的地方`);
}

function scoreSpot(feet, position) {
  return Math.abs(position.x - feet.x) + Math.abs(position.z - feet.z) + Math.abs(position.y - feet.y) * 2;
}

/** 走过去把某个位置附近的掉落物捡起来（够不着的就算了） */
export async function collectDrops(ctx, center, radius = 6) {
  const { bot, signal } = ctx;
  await sleep(300, signal);
  for (let round = 0; round < 8; round++) {
    const drops = Object.values(bot.entities)
      .filter((entity) => entity.name === 'item' && entity.position.distanceTo(center) <= radius)
      .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position));
    if (drops.length === 0 || bot.inventory.emptySlotCount() === 0) return;
    const { x, y, z } = drops[0].position;
    try {
      await goTo(bot, new goals.GoalNear(x, y, z, 1), { signal, timeoutMs: 8000 });
      await sleep(250, signal);
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      return;
    }
  }
}

/**
 * 往一个方向走一段，让新的区块加载进来（找不到树、矿、动物时用）。
 * 方向记在 ctx.state 里，一直往同一个方向探索；走不通就转 90 度。
 */
export async function explore(ctx, distance = 48) {
  const { bot, signal, state } = ctx;
  state.heading ??= Math.random() * Math.PI * 2;
  for (let attempt = 0; attempt < 4; attempt++) {
    const from = bot.entity.position;
    const x = Math.round(from.x + Math.cos(state.heading) * distance);
    const z = Math.round(from.z + Math.sin(state.heading) * distance);
    ctx.log(`附近没有要找的东西，往 (${x}, ${z}) 探索`);
    try {
      await goTo(bot, new goals.GoalNearXZ(x, z, 4), { signal, timeoutMs: 90000 });
      return;
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      state.heading += Math.PI / 2; // 此路不通，换个方向
    }
  }
  throw new Error('四个方向都走不通，被困住了');
}

/** 找最近的、名字在列表里的生物 */
export function findNearestEntity(bot, names, maxDistance = 64) {
  return bot.nearestEntity(
    (entity) => names.includes(entity.name) && entity.position.distanceTo(bot.entity.position) <= maxDistance,
  );
}

/** 追上去打一个生物，直到它死掉或跑没影。返回它最后的位置（用来捡掉落物） */
export async function attackUntilDead(ctx, target, timeoutMs = 30000) {
  const { bot, signal } = ctx;
  await equipBestWeapon(bot);
  const startedAt = Date.now();
  let lastPosition = target.position.clone();
  try {
    while (Date.now() - startedAt < timeoutMs) {
      throwIfAborted(signal);
      if (!target.isValid || !bot.entities[target.id]) return lastPosition;
      lastPosition = target.position.clone();
      const distance = target.position.distanceTo(bot.entity.position);
      if (distance > 64) throw new Error(`${target.name} 跑远了`);
      if (distance > 3) {
        if (!bot.pathfinder.goal) bot.pathfinder.setGoal(new goals.GoalFollow(target, 1.5), true);
      } else {
        await bot.lookAt(target.position.offset(0, target.height * 0.7, 0), true);
        bot.attack(target);
      }
      await sleep(600, signal);
    }
    throw new Error(`${target.name} 打了 ${timeoutMs / 1000} 秒还没打死`);
  } finally {
    bot.pathfinder.setGoal(null);
  }
}
