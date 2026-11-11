// 下界传送门：找一块平地 → 清空 4 宽 5 高的位置 → 搭门框 → 用打火石点燃 → 走进去。
//
// 门框只有中间 10 块必须是黑曜石，四个角可以是任何方块（这里用圆石，省 4 块黑曜石，也方便搭：
// 没有角的话，侧边第一块下面是空的，没地方“贴”上去）。
//
//    x:  0     1     2     3
//  y+4  角   黑曜石 黑曜石  角
//  y+3 黑曜石  空    空   黑曜石
//  y+2 黑曜石  空    空   黑曜石
//  y+1 黑曜石  空    空   黑曜石
//  y+0  角   黑曜石 黑曜石  角        ← 放在地面上
import pathfinderPkg from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { goTo, sleep, throwIfAborted } from '../../actions/helpers.js';
import { collectDrops } from './world.js';

const { goals } = pathfinderPkg;

const CORNER_BLOCKS = ['cobblestone', 'cobbled_deepslate', 'dirt', 'netherrack', 'stone'];

/** 门框每一格放什么：'obsidian' 或 'corner' */
function frameLayout() {
  const cells = [];
  for (let dx = 0; dx <= 3; dx++) {
    for (let dy = 0; dy <= 4; dy++) {
      const edgeX = dx === 0 || dx === 3;
      const edgeY = dy === 0 || dy === 4;
      if (edgeX && edgeY) cells.push({ dx, dy, kind: 'corner' });
      else if (edgeX || edgeY) cells.push({ dx, dy, kind: 'obsidian' });
    }
  }
  return cells;
}

/** 搭一个下界传送门并点燃，返回门里面一格的位置（走进去用） */
export async function buildPortal(ctx) {
  const { bot, signal } = ctx;
  const corner = bot.inventory.items().find((item) => CORNER_BLOCKS.includes(item.name) && item.count >= 4);
  if (countOf(bot, 'obsidian') < 10) throw new Error('黑曜石不够 10 块');
  if (!corner) throw new Error('需要 4 块圆石当门框的角');
  if (countOf(bot, 'flint_and_steel') < 1) throw new Error('没有打火石');

  const origin = findPortalSite(bot);
  if (!origin) throw new Error('附近找不到能搭门的平地（要 4 格宽的平地，上面 5 格高的空间）');
  ctx.log(`在 ${origin} 搭下界传送门`);

  // 站到门前 2 格的位置，所有方块都在手够得着的范围里
  await goTo(bot, new goals.GoalBlock(origin.x + 1, origin.y, origin.z + 2), { signal, timeoutMs: 30000 });

  // 清空门框所在的这一面（包括门里面）
  for (let dx = 0; dx <= 3; dx++) {
    for (let dy = 4; dy >= 0; dy--) {
      throwIfAborted(signal);
      const block = bot.blockAt(origin.offset(dx, dy, 0));
      if (block && block.boundingBox === 'block') await bot.dig(block, true);
    }
  }

  // 从下往上放：每块都“贴”在下面那块（或旁边那块）上
  const cells = frameLayout().sort((a, b) => a.dy - b.dy || a.dx - b.dx);
  const placed = [];
  try {
    for (const { dx, dy, kind } of cells) {
      throwIfAborted(signal);
      const target = origin.offset(dx, dy, 0);
      if (bot.blockAt(target)?.boundingBox === 'block' && kind === 'corner') continue;
      const itemName = kind === 'obsidian' ? 'obsidian' : corner.name;
      await bot.equip(bot.inventory.items().find((item) => item.name === itemName), 'hand');
      const { reference, face } = referenceFor(bot, target);
      if (!reference) throw new Error(`门框 ${target} 找不到可以贴的方块`);
      await bot.placeBlock(reference, face);
      placed.push(target);
      await sleep(150, signal);
    }
  } catch (err) {
    // 搭到一半失败：把已经放下的方块挖回来（尤其是黑曜石，很贵），下次换个地方重搭
    ctx.log(`门框没搭成（${err.message}），把放下的方块收回来`);
    for (const position of placed.reverse()) {
      const block = bot.blockAt(position);
      if (block && block.boundingBox === 'block') {
        const tool = bot.pathfinder.bestHarvestTool(block);
        if (tool) await bot.equip(tool, 'hand');
        await bot.dig(block, true).catch(() => {});
      }
    }
    await collectDrops(ctx, origin.offset(1, 1, 0), 5).catch(() => {});
    throw err;
  }

  // 点火：打火石点在门里面底部那块黑曜石的上表面
  await bot.equip(bot.inventory.items().find((item) => item.name === 'flint_and_steel'), 'hand');
  await bot.activateBlock(bot.blockAt(origin.offset(1, 0, 0)), new Vec3(0, 1, 0));
  await sleep(1000, signal);
  const inside = origin.offset(1, 1, 0);
  if (bot.blockAt(inside)?.name !== 'nether_portal') throw new Error('门框搭好了但没点着');
  ctx.log('下界传送门点着了');
  return inside;
}

/** 回到下界：附近有点着的传送门就走进去（死后重生在主世界时用），没有就报错 */
export async function goToNether(ctx) {
  const { bot } = ctx;
  if (String(bot.game.dimension).includes('nether')) return;
  const portalId = bot.registry.blocksByName.nether_portal.id;
  // 优先用记住的传送门位置（自己搭的那个），远的话先走过去
  const remembered = ctx.state.overworldPortal;
  if (remembered && remembered.distanceTo(bot.entity.position) > 64) {
    ctx.log(`回下界：先走回传送门 ${remembered}（${Math.round(remembered.distanceTo(bot.entity.position))} 格）`);
    await goTo(bot, new goals.GoalNear(remembered.x, remembered.y, remembered.z, 3), { signal: ctx.signal, timeoutMs: 600000 });
  }
  const portal = bot.findBlock({ matching: portalId, maxDistance: 160 });
  if (!portal) throw new Error('附近没有下界传送门，回不去下界');
  ctx.log(`回下界：走进传送门 ${portal.position}`);
  await enterPortal(ctx, portal.position);
}

/** 走进传送门，等到了下界再返回 */
export async function enterPortal(ctx, inside) {
  const { bot, signal } = ctx;
  const dimension = () => String(bot.game.dimension);
  if (dimension().includes('nether')) return;
  ctx.log('走进传送门');
  const arrived = new Promise((resolve) => {
    const check = () => {
      if (dimension().includes('nether')) {
        bot.removeListener('spawn', check);
        resolve();
      }
    };
    bot.on('spawn', check);
  });
  if (!dimension().includes('nether')) ctx.state.overworldPortal = inside.clone(); // 记住主世界这边的门，死了好回来
  bot.pathfinder.setGoal(new goals.GoalBlock(inside.x, inside.y, inside.z));
  await Promise.race([arrived, sleep(20000, signal).then(() => { throw new Error('站进传送门 20 秒还没传送'); })]);
  bot.pathfinder.setGoal(null);
  await sleep(2000, signal); // 等下界的区块加载
  ctx.log('到下界了');
}

/** 找门框的放置位置：4 格宽的地面（脚下实心），上面 5 格不是液体、不是基岩，门前 2 格能站人 */
function findPortalSite(bot) {
  const feet = bot.entity.position.floored();
  const candidates = [];
  for (let dx = -8; dx <= 8; dx++) {
    for (let dz = -8; dz <= 8; dz++) {
      for (let dy = -2; dy <= 2; dy++) {
        const origin = feet.offset(dx, dy, dz);
        if (isGoodSite(bot, origin)) candidates.push(origin);
      }
    }
  }
  candidates.sort((a, b) => a.distanceTo(feet) - b.distanceTo(feet));
  return candidates[0] ?? null;
}

function isGoodSite(bot, origin) {
  for (let dx = 0; dx <= 3; dx++) {
    const ground = bot.blockAt(origin.offset(dx, -1, 0));
    if (ground?.boundingBox !== 'block') return false;
    for (let dy = 0; dy <= 4; dy++) {
      const block = bot.blockAt(origin.offset(dx, dy, 0));
      if (!block || ['water', 'lava', 'bedrock', 'chest', 'crafting_table', 'furnace'].includes(block.name)) return false;
    }
  }
  // 门前站人的位置：脚下实心，身体两格是空的
  const stand = origin.offset(1, 0, 2);
  return (
    bot.blockAt(stand.offset(0, -1, 0))?.boundingBox === 'block' &&
    bot.blockAt(stand)?.boundingBox === 'empty' &&
    bot.blockAt(stand.offset(0, 1, 0))?.boundingBox === 'empty'
  );
}

/** 往 target 放方块时贴在哪块上：优先下面，其次左右 */
function referenceFor(bot, target) {
  const options = [
    [new Vec3(0, -1, 0), new Vec3(0, 1, 0)],
    [new Vec3(-1, 0, 0), new Vec3(1, 0, 0)],
    [new Vec3(1, 0, 0), new Vec3(-1, 0, 0)],
  ];
  for (const [offset, face] of options) {
    const reference = bot.blockAt(target.plus(offset));
    if (reference?.boundingBox === 'block') return { reference, face };
  }
  return { reference: null, face: null };
}

function countOf(bot, name) {
  return bot.inventory.items().filter((item) => item.name === name).reduce((sum, item) => sum + item.count, 0);
}
