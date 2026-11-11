// 睡觉技能：晚上把床放下、睡一觉跳过黑夜、醒来把床收回背包。
// 为什么重要：晚上满地怪物，机器人只会站着还手，很容易死（测试时真的被僵尸打死过）。
import { Vec3 } from 'vec3';
import { sleep } from '../../actions/helpers.js';
import { collectDrops } from './world.js';

// 能上床睡觉的时间段（游戏刻）：大约晚上 7 点半到早上 6 点
const NIGHT_START = 12542;
const NIGHT_END = 23459;
const CHECK_INTERVAL_MS = 20000;

export function isNight(bot) {
  const time = bot.time?.timeOfDay ?? 0;
  return time >= NIGHT_START && time <= NIGHT_END;
}

/**
 * 是晚上、背包里有床，就睡一觉。在各个技能的循环里经常调用，内部自己节流（20 秒最多检查一次）。
 * @returns {Promise<boolean>} 有没有睡
 */
export async function restIfNight(ctx) {
  const { bot, state } = ctx;
  if (Date.now() - (state.lastRestCheck ?? 0) < CHECK_INTERVAL_MS) return false;
  state.lastRestCheck = Date.now();
  if (!isNight(bot)) return false;
  const bedItem = bot.inventory.items().find((item) => item.name.endsWith('_bed'));
  if (bedItem && (await sleepInBed(ctx, bedItem))) return true;
  // 在地下（头顶有方块挡着天空）的话，白天黑夜一样黑，躲也没用，接着干活
  if (isUnderground(bot)) return false;
  return hideUntilMorning(ctx);
}

/** 头顶 40 格内有实心方块 = 在地下 / 室内 */
function isUnderground(bot) {
  const head = bot.entity.position.floored().offset(0, 2, 0);
  for (let dy = 0; dy < 40; dy++) {
    if (bot.blockAt(head.offset(0, dy, 0))?.boundingBox === 'block') return true;
  }
  return false;
}

async function sleepInBed(ctx, bedItem) {
  const { bot, signal } = ctx;
  ctx.log('天黑了，放床睡觉');
  let bed = null;
  try {
    bed = await placeBed(ctx, bedItem);
    await bot.sleep(bed);
    // 睡着以后等天亮（服务器上只有它一个人时，几秒就跳到早上了）
    const deadline = Date.now() + 8 * 60 * 1000;
    while (bot.isSleeping && Date.now() < deadline) await sleep(1000, signal);
    ctx.log('睡醒了');
    return true;
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    ctx.log(`睡不了：${err.message}`); // 附近有怪物、床放不下……改成躲起来
    return false;
  } finally {
    if (bot.isSleeping) await bot.wake().catch(() => {});
    if (bed) {
      // 把床收回来，下次还要用
      const placed = bot.blockAt(bed.position);
      if (placed?.name.endsWith('_bed')) {
        await bot.dig(placed, true).catch(() => {});
        await collectDrops(ctx, bed.position, 4).catch(() => {});
      }
    }
  }
}

const CARDINALS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/**
 * 放床：床占两格，放在“脚前一格”，床头会朝着面对的方向再伸出一格。
 * 所以要找一个方向，前面连续两格都是空的、下面都是实心的。放完等一下，确认两半都出现了。
 */
async function placeBed(ctx, bedItem) {
  const { bot, signal } = ctx;
  const feet = bot.entity.position.floored();
  const isFree = (position) => {
    const here = bot.blockAt(position);
    const below = bot.blockAt(position.offset(0, -1, 0));
    return here?.boundingBox === 'empty' && !['water', 'lava'].includes(here.name) && below?.boundingBox === 'block';
  };
  for (const [dx, dz] of CARDINALS) {
    const foot = feet.offset(dx, 0, dz);
    const head = feet.offset(dx * 2, 0, dz * 2);
    if (!isFree(foot) || !isFree(head)) continue;
    await bot.equip(bedItem, 'hand');
    await bot.lookAt(head.offset(0.5, 0, 0.5), true); // 面朝床头方向
    await sleep(150, signal);
    try {
      await bot.placeBlock(bot.blockAt(foot.offset(0, -1, 0)), new Vec3(0, 1, 0));
    } catch {
      continue;
    }
    await sleep(500, signal); // 等服务器把床的另一半也发过来
    if (bot.blockAt(foot)?.name.endsWith('_bed') && bot.blockAt(head)?.name.endsWith('_bed')) return bot.blockAt(foot);
    if (bot.blockAt(foot)?.name.endsWith('_bed')) {
      await bot.dig(bot.blockAt(foot), true).catch(() => {}); // 只放出半张（不应该发生），收回来换个方向
    }
  }
  throw new Error('身边没有能放下一张床的空地（要连续两格）');
}

const SHELTER_BLOCKS = ['cobblestone', 'cobbled_deepslate', 'dirt', 'netherrack'];

/**
 * 没床（或睡不了）时的保命办法：原地往下挖 3 格，跳进去，在头顶盖一块方块，等天亮。
 * 下面是空洞、岩浆、水的话不挖（会掉进洞穴），这一晚就只能硬扛了。
 */
async function hideUntilMorning(ctx) {
  const { bot, signal } = ctx;
  const cover = bot.inventory.items().find((item) => SHELTER_BLOCKS.includes(item.name));
  if (!cover) return false;

  const feet = bot.entity.position.floored();
  if (!isSafeToDigDown(bot, feet)) {
    ctx.log('脚下不安全（下面是空洞或液体），这晚硬扛');
    return false;
  }

  ctx.log('天黑了，挖个坑躲到天亮');
  try {
    bot.pathfinder.setGoal(null);
    for (let depth = 1; depth <= 3; depth++) {
      const block = bot.blockAt(feet.offset(0, -depth, 0));
      if (block && block.boundingBox === 'block') await bot.dig(block, true);
      await sleep(400, signal); // 等掉下去
    }
    // 现在脚在 y-3、头在 y-2，头顶 y-1 的四周都是实心方块，可以靠着它们封顶
    const coverPosition = feet.offset(0, -1, 0);
    const side = [[1, 0], [-1, 0], [0, 1], [0, -1]]
      .map(([dx, dz]) => bot.blockAt(coverPosition.offset(dx, 0, dz)))
      .find((block) => block?.boundingBox === 'block');
    if (side) {
      await bot.equip(cover, 'hand');
      const face = new Vec3(coverPosition.x - side.position.x, 0, coverPosition.z - side.position.z);
      await bot.placeBlock(side, face).catch(() => {});
    }
    const deadline = Date.now() + 10 * 60 * 1000;
    while (isNight(bot) && Date.now() < deadline) await sleep(2000, signal);
    ctx.log('天亮了，出发');
    return true;
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    ctx.log(`躲不了：${err.message}`);
    return false;
  }
}

/** 往下挖 3 格是否安全：这 3 格和它们四周都是实心方块，最底下也是实心的，附近没有液体 */
function isSafeToDigDown(bot, feet) {
  for (let depth = 1; depth <= 4; depth++) {
    const below = bot.blockAt(feet.offset(0, -depth, 0));
    if (!below || below.boundingBox !== 'block') return false;
    if (depth === 4) break; // 最底下那一格只要实心就行
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const wall = bot.blockAt(feet.offset(dx, -depth, dz));
      if (!wall || wall.boundingBox !== 'block') return false;
    }
  }
  return true;
}
