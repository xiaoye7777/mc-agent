// 采集类动作：挖方块、捡掉落物。
//
// ⚠️ 安全规则（公网服是大家一起玩的，别把别人的房子拆了）：
//   1. 只有玩家明确要求才挖（由人设里的规则约束大模型）
//   2. 只挖白名单里的“天然方块”：原木、泥土、沙子、石头、矿石……
//      木板、玻璃、圆石、砖这类常见建材一律不碰
//   3. 原木还要再检查一遍“是不是长在树上”：附近必须有天然树叶（树叶有个 persistent 属性，
//      自然生成的是 false，玩家放的是 true）。这样用原木盖的房子不会被当成树砍掉
//   4. 走路时仍然不挖不搭，只挖目标方块本身
//   5. 可以用 .env 的 NPC_ALLOW_DIG=false 整个关掉
import pathfinderPkg from 'mineflayer-pathfinder';
import { createLogger } from '../logger.js';
import {
  describeGain,
  formatPosition,
  goTo,
  inventorySnapshot,
  isExposed,
  resolveBlockNames,
  sleep,
  throwIfAborted,
} from './helpers.js';

const { goals } = pathfinderPkg;
const log = createLogger('gather');

const NATURAL_BLOCKS = new Set([
  // 土和沙
  'dirt', 'grass_block', 'coarse_dirt', 'podzol', 'rooted_dirt', 'mud', 'clay',
  'sand', 'red_sand', 'gravel', 'snow_block',
  // 天然石头（注意：不含 cobblestone，圆石经常被拿来盖房子）
  'stone', 'deepslate', 'granite', 'diorite', 'andesite', 'tuff', 'calcite', 'netherrack',
  // 矿石
  'coal_ore', 'iron_ore', 'copper_ore', 'gold_ore', 'redstone_ore', 'lapis_ore', 'diamond_ore', 'emerald_ore',
  'deepslate_coal_ore', 'deepslate_iron_ore', 'deepslate_copper_ore', 'deepslate_gold_ore',
  'deepslate_redstone_ore', 'deepslate_lapis_ore', 'deepslate_diamond_ore', 'deepslate_emerald_ore',
  'nether_quartz_ore', 'nether_gold_ore',
  // 植物
  'pumpkin', 'melon', 'sugar_cane', 'cactus', 'short_grass', 'tall_grass', 'fern',
]);

const isLog = (name) => name.endsWith('_log') && !name.startsWith('stripped_');

/** 某种方块是否允许挖（原木还要额外检查是不是长在树上） */
export function isDiggableKind(name) {
  return NATURAL_BLOCKS.has(name) || isLog(name);
}

const SEARCH_DISTANCE = 32;
const MAX_COUNT = 64;
const MAX_FAILURES = 6; // 连续够不着几个方块就放弃
const PICKUP_RADIUS = 6;
const REACH = 4.5; // 生存模式的手臂长度

// 够不着的方块记 10 分钟，跨任务有效。
// 否则大模型换个说法再叫一次，NPC 又会从最近的那几个够不着的开始试，原地打转。
const UNREACHABLE_MS = 10 * 60 * 1000;
const unreachableUntil = new Map();
const isMarkedUnreachable = (position) => (unreachableUntil.get(position.toString()) ?? 0) > Date.now();
function markUnreachable(position) {
  if (unreachableUntil.size > 2000) {
    for (const [key, until] of unreachableUntil) if (until <= Date.now()) unreachableUntil.delete(key);
  }
  unreachableUntil.set(position.toString(), Date.now() + UNREACHABLE_MS);
}

/** @type {import('./index.js').Action[]} */
export const gatheringActions = [
  {
    name: 'collect_block',
    description:
      '挖/砍某种天然方块并捡起掉落物，比如砍树拿木头、挖泥土、挖石头、挖矿。只有玩家明确要你去挖的时候才用。' +
      'block 用 Minecraft 英文 ID（oak_log、dirt、stone、iron_ore），也可以写 log 表示任意原木。' +
      '只能挖天然方块；木板、圆石、玻璃等建材不能挖。后台执行，挖完会收到任务结果（包括背包新增了什么）。',
    parameters: {
      type: 'object',
      properties: {
        block: { type: 'string', description: '方块的 Minecraft 英文 ID' },
        count: { type: 'number', description: '要挖几个方块，默认 4，最多 64' },
      },
      required: ['block'],
    },
    run({ bot, tasks, player, isWhisper, options }, { block, count = 4 }) {
      if (!options.allowDig) return '服务器设置了不允许我挖方块（NPC_ALLOW_DIG=false）';

      const names = resolveBlockNames(bot, block).filter(isDiggableKind);
      if (names.length === 0) {
        return `「${block}」不在我能挖的天然方块名单里（为了不拆别人的建筑，我只挖原木、泥土、沙子、石头、矿石这类天然方块）`;
      }

      const target = Math.max(1, Math.min(Math.round(Number(count) || 4), MAX_COUNT));
      const label = `挖 ${target} 个 ${block}`;
      tasks.start({ label, kind: 'gather', owner: player, isWhisper, report: 'always' }, (ctx) => collect(bot, names, target, ctx));
      return `已开始：${label}`;
    },
  },

  {
    name: 'pick_up_items',
    description: '把附近地上的掉落物都捡起来。后台执行。',
    parameters: {
      type: 'object',
      properties: {
        radius: { type: 'number', description: '捡多大范围内的，默认 8 格，最大 16' },
      },
    },
    run({ bot, tasks, player, isWhisper }, { radius = 8 }) {
      const range = Math.min(Number(radius) || 8, 16);
      if (findDrops(bot, bot.entity.position, range).length === 0) return `附近 ${range} 格内地上没东西`;

      tasks.start({ label: '捡掉落物', kind: 'gather', owner: player, isWhisper, report: 'always' }, async ({ signal }) => {
        const before = inventorySnapshot(bot);
        await pickUpDrops(bot, bot.entity.position, range, signal);
        const gained = describeGain(before, inventorySnapshot(bot));
        return gained ? `捡到了：${gained}` : '没捡到东西（可能够不着，或者背包满了）';
      });
      return '已开始捡地上的东西';
    },
  },
];

/** 挖方块的主循环：找最近的 → 走过去 → 换工具 → 挖 → 捡掉落物，直到够数 */
async function collect(bot, names, target, { signal, setProgress }) {
  const ids = names.map((name) => bot.registry.blocksByName[name].id);
  const before = inventorySnapshot(bot);
  let dug = 0;
  let failures = 0;

  setProgress(`0/${target}`);
  while (dug < target) {
    throwIfAborted(signal);
    if (bot.inventory.emptySlotCount() === 0) break;

    const { block, buried } = findNextBlock(bot, ids);
    if (!block) {
      if (dug === 0 && buried > 0) {
        throw new Error(`附近有 ${names.length > 3 ? '目标方块' : names.join('/')}，但都埋在地下或被挡住了（我只挖露在外面的，不会为了它挖路）`);
      }
      break;
    }

    try {
      await digOne(bot, block, signal);
      dug += 1;
      failures = 0;
      setProgress(`${dug}/${target}`);
      await pickUpDrops(bot, block.position, PICKUP_RADIUS, signal);
    } catch (err) {
      // 被叫停时 bot.dig 会抛 “Digging aborted”，这不是“够不着”，不能记进黑名单
      if (err.name === 'AbortError' || err.fatal || signal.aborted) throw err;
      markUnreachable(block.position);
      failures += 1;
      log.warn(`放弃 ${block.name} ${formatPosition(block.position)}：${err.message}`);
      if (failures >= MAX_FAILURES) {
        if (dug === 0) {
          throw new Error(`附近最近的几个 ${names[0]} 都够不着（${err.message}）。已记下这些位置，下次会自动跳过、去找远一点的`);
        }
        break;
      }
    }
  }

  // 最后再扫一遍：树上高处的原木掉下来可能滚远了
  if (dug > 0) await pickUpDrops(bot, bot.entity.position, 8, signal);

  const gained = describeGain(before, inventorySnapshot(bot));
  if (dug === 0) {
    if (bot.inventory.emptySlotCount() === 0) throw new Error('背包满了，挖不了');
    throw new Error(`附近 ${SEARCH_DISTANCE} 格内找不到能挖的 ${names.length > 3 ? '目标方块' : names.join('/')}`);
  }
  const shortfall = dug < target ? `（只挖到 ${dug}/${target} 个，附近没有更多能挖的了或背包满了）` : '';
  return `挖了 ${dug} 个方块${shortfall}。背包新增：${gained || '没有（掉落物可能没捡到）'}`;
}

/**
 * 挑下一个要挖的方块：在允许挖的方块里，选“距离 + 高度惩罚”最小的。
 * 高度惩罚：离地面越高越难够着（砍掉树干下半截后，上半截就悬空了），优先挖低处的。
 * 返回 { block: 选中的方块或 null, buried: 因为埋在地下而跳过的个数 }
 */
function findNextBlock(bot, ids) {
  const positions = bot.findBlocks({ matching: ids, maxDistance: SEARCH_DISTANCE, count: 128 });
  let best = null;
  let bestScore = Infinity;
  let buried = 0;
  for (const position of positions) {
    if (isMarkedUnreachable(position)) continue;
    const block = bot.blockAt(position);
    if (!block) continue;
    if (!isExposed(bot, position)) {
      buried += 1; // 埋在地下的够不着（也不该为了它去挖路）
      continue;
    }
    if (isLog(block.name) && !isNaturalTree(bot, position)) {
      markUnreachable(position); // 像是玩家建筑里的原木，跳过
      continue;
    }
    const score = bot.entity.position.distanceTo(position) + 4 * Math.max(0, heightAboveGround(bot, position) - 2);
    if (score < bestScore) {
      best = block;
      bestScore = score;
    }
  }
  return { block: best, buried };
}

/** 方块离下面的实心地面有多高（0 = 直接放在地上） */
function heightAboveGround(bot, position) {
  for (let dy = 1; dy <= 8; dy++) {
    const below = bot.blockAt(position.offset(0, -dy, 0));
    if (below?.boundingBox === 'block' && !isLog(below.name) && !below.name.endsWith('_leaves')) return dy - 1;
  }
  return 8;
}

/** 原木附近（横向 4 格、往上 8 格）有没有天然树叶 → 判断是不是一棵真树 */
export function isNaturalTree(bot, logPosition) {
  for (let dy = -1; dy <= 8; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      for (let dz = -4; dz <= 4; dz++) {
        const block = bot.blockAt(logPosition.offset(dx, dy, dz));
        if (block?.name.endsWith('_leaves') && block.getProperties().persistent === false) return true;
      }
    }
  }
  return false;
}

async function digOne(bot, block, signal) {
  // 走到能看见、够得着这个方块的位置
  await goTo(bot, new goals.GoalLookAtBlock(block.position, bot.world, { reach: REACH }), { signal, timeoutMs: 20000 });
  throwIfAborted(signal);

  const current = bot.blockAt(block.position);
  if (!current || current.type !== block.type) throw new Error('方块已经不在了');

  // 换上挖得最快的工具；有些方块（石头、矿）没有合适的镐子挖了也不掉东西
  const tool = bot.pathfinder.bestHarvestTool(current);
  if (tool) await bot.equip(tool, 'hand');
  if (!current.canHarvest(bot.heldItem?.type ?? null)) {
    const err = new Error(`挖 ${current.name} 需要合适的镐子（挖了也不掉东西），我背包里没有`);
    err.fatal = true; // 换哪个方块都一样，直接结束任务
    throw err;
  }

  const onAbort = () => bot.stopDigging();
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    await bot.dig(current, true);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
  throwIfAborted(signal);
}

/** 走过去把某个位置附近的掉落物捡起来 */
async function pickUpDrops(bot, center, radius, signal) {
  await sleep(400, signal); // 等掉落物生成并落地
  for (let round = 0; round < 8; round++) {
    const drops = findDrops(bot, center, radius);
    if (drops.length === 0) return;
    if (bot.inventory.emptySlotCount() === 0) return;
    const nearest = drops.sort(
      (a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position),
    )[0];
    const { x, y, z } = nearest.position;
    try {
      await goTo(bot, new goals.GoalNear(x, y, z, 1), { signal, timeoutMs: 6000 });
      await sleep(250, signal);
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      return; // 够不着就算了，不影响主任务
    }
  }
}

function findDrops(bot, center, radius) {
  return Object.values(bot.entities).filter(
    (entity) => entity.name === 'item' && entity.position.distanceTo(center) <= radius,
  );
}
