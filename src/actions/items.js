// 物品类动作：把东西交给玩家、拿到手上、合成。
import pathfinderPkg from 'mineflayer-pathfinder';
import { countItem, findInventoryItem, findPlayerEntity, formatPosition, goTo, sleep } from './helpers.js';

const { goals } = pathfinderPkg;

const GIVE_DISTANCE = 2;
// 玩家能捡到东西的水平范围：碰撞箱半宽 0.3 + 拾取扩展 1 格
const PICKUP_RANGE = 1.3;

// 装备栏位置：盔甲穿身上，盾牌拿副手，其他拿主手
function equipDestination(itemName) {
  if (itemName.endsWith('_helmet') || itemName === 'turtle_helmet') return 'head';
  if (itemName.endsWith('_chestplate') || itemName === 'elytra') return 'torso';
  if (itemName.endsWith('_leggings')) return 'legs';
  if (itemName.endsWith('_boots')) return 'feet';
  if (itemName === 'shield') return 'off-hand';
  return 'hand';
}

/** @type {import('./index.js').Action[]} */
export const itemActions = [
  {
    name: 'give_item',
    description:
      '走到玩家身边，把背包里的物品扔给他。item 用 Minecraft 英文 ID（oak_log、apple）。' +
      'count 不填就把这种物品全给他。后台执行，给完会收到任务结果。',
    parameters: {
      type: 'object',
      properties: {
        player: { type: 'string', description: '收东西的玩家游戏 ID' },
        item: { type: 'string', description: '物品的 Minecraft 英文 ID' },
        count: { type: 'number', description: '给几个，不填 = 全部' },
      },
      required: ['player', 'item'],
    },
    run({ bot, tasks, player: requester, isWhisper }, { player, item, count }) {
      const found = findInventoryItem(bot, item);
      if (!found) return `背包里没有 ${item}`;
      if (!findPlayerEntity(bot, player)) return `看不到玩家 ${player}，没法给他`;

      const owned = countItem(bot, found.name);
      const amount = Math.max(1, Math.min(Math.round(Number(count) || owned), owned));
      const label = `把 ${found.name} x${amount} 交给 ${player}`;

      tasks.start({ label, kind: 'give', owner: requester, isWhisper, report: 'always' }, async ({ signal }) => {
        const target = findPlayerEntity(bot, player);
        if (!target) throw new Error(`看不到 ${player} 了`);
        // GoalFollow：玩家边走边等也能追上
        await goTo(bot, new goals.GoalFollow(target, GIVE_DISTANCE), { signal, timeoutMs: 60000 });
        const given = await tossWithRetry(bot, found, amount, target, signal);
        if (given === 0) throw new Error('扔东西没成功（背包和服务器没同步上），可以再叫我给一次');
        const partial = given < amount ? `（只扔出去 ${given}/${amount} 个）` : '';
        const leftAfterToss = countItem(bot, found.name);

        // 扔出去的东西 2 秒后谁离得近谁就能捡——包括 NPC 自己。所以扔完马上退开，别把东西又捡回来
        await stepAwayFrom(bot, target.position, signal);
        await sleep(1500, signal);
        if (countItem(bot, found.name) > leftAfterToss) {
          throw new Error(`扔给 ${player} 的东西又被我自己捡回来了（他可能没站在原地），可以让他站着别动再叫我给一次`);
        }

        // 看看东西落在哪：玩家捡东西的范围只有 1 格左右，落远了要告诉他
        const landed = nearestDrop(bot, found.name, target.position);
        if (landed && horizontalDistance(landed.position, target.position) > PICKUP_RANGE) {
          return `把 ${found.name} x${given} 扔出去了${partial}，但落在 ${formatPosition(landed.position)}，离 ${player} 约 ${Math.round(landed.position.distanceTo(target.position))} 格，要他自己过去捡一下`;
        }
        return `已经把 ${found.name} x${given} 扔到 ${player} 脚边了${partial}`;
      });
      return `已开始：${label}`;
    },
  },

  {
    name: 'equip_item',
    description: '把背包里的物品拿到手上，或者穿上盔甲、拿起盾牌。',
    parameters: {
      type: 'object',
      properties: {
        item: { type: 'string', description: '物品的 Minecraft 英文 ID' },
      },
      required: ['item'],
    },
    async run({ bot }, { item }) {
      const found = findInventoryItem(bot, item);
      if (!found) return `背包里没有 ${item}`;
      const destination = equipDestination(found.name);
      await bot.equip(found, destination);
      return destination === 'hand' ? `手上拿着 ${found.name} 了` : `装备上 ${found.name} 了`;
    },
  },

  {
    name: 'craft_item',
    description:
      '用背包里的材料合成物品，例如 oak_planks、stick、crafting_table、wooden_pickaxe。' +
      '需要工作台的配方（工具、武器等）必须站在工作台旁边（4 格内）；我不能自己放工作台。' +
      '材料不够时会告诉你缺什么。',
    parameters: {
      type: 'object',
      properties: {
        item: { type: 'string', description: '要合成的物品的 Minecraft 英文 ID' },
        count: { type: 'number', description: '想要几个，默认 1' },
      },
      required: ['item'],
    },
    async run({ bot }, { item, count = 1 }) {
      const wanted = Math.max(1, Math.min(Math.round(Number(count) || 1), 64));
      const candidates = resolveItemNames(bot, item);
      if (candidates.length === 0) return `不认识物品「${item}」，请用 Minecraft 英文 ID`;

      const tableId = bot.registry.blocksByName.crafting_table.id;
      const table = bot.findBlock({ matching: tableId, maxDistance: 4 });

      // 同一个说法可能对应好几种物品（planks → 各种木板），挑一个现在就能做的
      for (const name of candidates) {
        const itemId = bot.registry.itemsByName[name].id;
        const recipe = bot.recipesFor(itemId, null, wanted, table)[0];
        if (!recipe) continue;

        const times = Math.ceil(wanted / recipe.result.count);
        await bot.craft(recipe, times, table ?? undefined);
        await sleep(250); // 等背包同步，不然下面数出来的数量可能还是旧的
        return `合成好了 ${name} x${times * recipe.result.count}（背包里现在有 ${countItem(bot, name)} 个）`;
      }

      return explainWhyNotCraftable(bot, candidates[0], wanted, table);
    },
  },
];

/**
 * 扔东西，并确认真的扔出去了。
 * 扔 = 两下“点击背包格子”，服务器要确认才算数。刚合成完、刚捡完东西时背包状态可能还没同步，
 * 服务器会默默忽略这次点击（不报错，但东西还在）。所以扔完数一数，没少就等一下再试。
 * @returns {Promise<number>} 实际扔出去的数量
 */
async function tossWithRetry(bot, item, amount, target, signal) {
  const before = countItem(bot, item.name);
  for (let attempt = 1; attempt <= 3; attempt++) {
    await sleep(300 * attempt, signal);
    const remaining = amount - (before - countItem(bot, item.name));
    if (remaining <= 0) break;
    await bot.lookAt(aimPoint(bot, target), true);
    // 转头的数据包要等下一个物理帧（50ms）才发出去；马上扔的话，服务器会按“转头前”的方向扔
    await sleep(150, signal);
    try {
      await bot.toss(item.type, null, Math.min(remaining, countItem(bot, item.name)));
    } catch {
      // 背包状态不对时 toss 可能抛错，下一轮重试
    }
    await sleep(300, signal);
  }
  return before - countItem(bot, item.name);
}

/**
 * 扔东西瞄哪儿：玩家脚下再往后半格。
 * 扔出去的东西会往前飞一段，瞄脸会飞过头，瞄脚尖又常常差一点够不着，瞄“脚后半格”最稳。
 */
function aimPoint(bot, target) {
  const from = bot.entity.position;
  const dx = target.position.x - from.x;
  const dz = target.position.z - from.z;
  const length = Math.hypot(dx, dz) || 1;
  return target.position.offset((dx / length) * 0.5, 0.1, (dz / length) * 0.5);
}

/** 退到离某个位置 3 格以外（用寻路退，不会退下悬崖）；退不开也没关系 */
async function stepAwayFrom(bot, position, signal) {
  const goal = new goals.GoalInvert(new goals.GoalNear(position.x, position.y, position.z, 3));
  try {
    await goTo(bot, goal, { signal, timeoutMs: 3000 });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
  }
}

function horizontalDistance(a, b) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/** 离某个位置最近的、某种物品的掉落物 */
function nearestDrop(bot, itemName, position) {
  const drops = Object.values(bot.entities).filter(
    (entity) => entity.name === 'item' && entity.getDroppedItem()?.name === itemName && entity.position.distanceTo(position) < 8,
  );
  return drops.sort((a, b) => a.position.distanceTo(position) - b.position.distanceTo(position))[0] ?? null;
}

/** 物品名解析：完全一致优先，否则找以 _名字 结尾的（planks → oak_planks、birch_planks…） */
function resolveItemNames(bot, query) {
  const name = String(query ?? '').trim().toLowerCase().replace(/^minecraft:/, '').replace(/\s+/g, '_');
  if (bot.registry.itemsByName[name]) return [name];
  const singular = name.replace(/s$/, '');
  if (bot.registry.itemsByName[singular]) return [singular];
  return Object.keys(bot.registry.itemsByName).filter((itemName) => itemName.endsWith(`_${singular}`) || itemName.endsWith(`_${name}`));
}

/** 做不了的时候，告诉大模型具体原因：缺工作台，还是缺材料（缺什么、缺多少） */
function explainWhyNotCraftable(bot, name, wanted, table) {
  const itemId = bot.registry.itemsByName[name].id;
  const recipes = bot.recipesAll(itemId, null, true);
  if (recipes.length === 0) return `${name} 没法合成（可能要熔炉烧、或者只能挖/打怪获得）`;

  const needsTable = recipes.every((recipe) => recipe.requiresTable);
  if (needsTable && !table) {
    const tableId = bot.registry.blocksByName.crafting_table.id;
    const nearby = bot.findBlock({ matching: tableId, maxDistance: 32 });
    return nearby
      ? `做 ${name} 需要工作台。最近的工作台在 ${formatPosition(nearby.position)}，先 go_to 过去再合成`
      : `做 ${name} 需要工作台，附近 32 格内没有，我也不能自己放。可以请玩家放一个，或者先合成 crafting_table 交给玩家`;
  }

  // 同一个东西常有好几种配方（工作台可以用任意一种木板），挑“缺得最少”的那个来解释。
  // delta 里负数 = 要消耗的材料
  const missingFor = (recipe) => {
    const times = Math.ceil(wanted / recipe.result.count);
    return recipe.delta
      .filter((entry) => entry.count < 0)
      .map((entry) => {
        const ingredient = bot.registry.items[entry.id]?.name ?? `#${entry.id}`;
        const need = -entry.count * times;
        const have = countItem(bot, ingredient);
        // 缺的是木板、但背包里有同种原木 → 这个配方最容易做到
        const fromLog = ingredient.endsWith('_planks') && countItem(bot, ingredient.replace(/_planks$/, '_log')) > 0;
        return have < need ? { text: `${ingredient} 需要 ${need} 个（有 ${have}）`, short: need - have, fromLog } : null;
      })
      .filter(Boolean);
  };
  const cost = (list) => list.reduce((sum, m) => sum + m.short - (m.fromLog ? 0.5 : 0), 0);
  const missing = recipes
    .map(missingFor)
    .sort((a, b) => cost(a) - cost(b))[0]
    .map((m) => m.text);
  return missing.length
    ? `材料不够，做 ${name} x${wanted} 还缺：${missing.join('、')}（木板可以用对应的原木先合成）`
    : `${name} 现在合成不了（可能要用另一种木头的配方）`;
}
