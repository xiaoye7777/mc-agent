// 动作共用的小工具：可取消的等待和寻路、按名字找方块 / 物品 / 玩家。
// 所有错误信息都是中文，因为它们最后会作为“工具结果”交给大模型，再转述给玩家。
import pathfinderPkg from 'mineflayer-pathfinder';

const { pathfinder, Movements } = pathfinderPkg;

// ---------- 寻路 ----------

/** 装寻路插件。NPC 走路时绝不挖方块、不搭方块，免得破坏别人的建筑 */
export function setupPathfinder(bot) {
  bot.loadPlugin(pathfinder);
  const movements = new Movements(bot);
  movements.canDig = false;
  movements.allow1by1towers = false;
  movements.scafoldingBlocks = [];
  bot.pathfinder.setMovements(movements);
}

/** 立刻停下所有移动和挖掘（setGoal(null) 立即生效；pathfinder.stop() 要等下一帧，会误杀新目标） */
export function haltBot(bot) {
  bot.pathfinder?.setGoal(null);
  bot.stopDigging?.();
  bot.clearControlStates();
}

/**
 * 走到目标位置。可以被 signal 取消，超时会放弃；到不了就抛出中文错误。
 * @param {import('mineflayer').Bot} bot
 * @param {object} goal  mineflayer-pathfinder 的 goal
 */
export async function goTo(bot, goal, { signal, timeoutMs = 30000 } = {}) {
  throwIfAborted(signal);

  const walking = bot.pathfinder.goto(goal);
  walking.catch(() => {}); // 被我们主动打断时它也会报错，这里先接住，避免“未处理的 Promise 错误”

  let timer;
  let onAbort;
  const interrupted = new Promise((_, reject) => {
    timer = setTimeout(() => {
      bot.pathfinder.setGoal(null);
      reject(new Error(`走了 ${Math.round(timeoutMs / 1000)} 秒还没到，放弃了`));
    }, timeoutMs);
    onAbort = () => {
      bot.pathfinder.setGoal(null);
      reject(abortError(signal));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

  try {
    await Promise.race([walking, interrupted]);
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new Error(PATH_ERRORS[err.name] ?? err.message);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }

  // pathfinder 在“完全找不到路”时也会当成功返回，所以要自己确认真的到了
  if (!goal.isEnd(bot.entity.position.floored())) {
    throw new Error('找不到能走过去的路（我不会挖路、搭路）');
  }
}

const PATH_ERRORS = {
  NoPath: '找不到能走过去的路（我不会挖路、搭路）',
  Timeout: '路线太复杂，没算出来怎么走',
  GoalChanged: '走到一半被别的事打断了',
  PathStopped: '走到一半被叫停了',
};

// ---------- 取消与等待 ----------

/** 可以被取消的 sleep */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(abortError(signal));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal);
}

function abortError(signal) {
  const err = new Error(String(signal?.reason ?? '已取消'));
  err.name = 'AbortError';
  return err;
}

// ---------- 找玩家 / 方块 / 物品 ----------

/** 玩家的实体（看得见才有：太远或不在同一维度时为 null） */
export function findPlayerEntity(bot, playerName) {
  return bot.players[playerName]?.entity ?? null;
}

export function distanceTo(bot, position) {
  return Math.round(bot.entity.position.distanceTo(position));
}

export function formatPosition(position) {
  return `(${Math.floor(position.x)}, ${Math.floor(position.y)}, ${Math.floor(position.z)})`;
}

const NEIGHBORS = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
];

/** 方块至少有一面露在外面（挨着空气、草、水这类没有碰撞箱的方块）；完全埋在地下的返回 false */
export function isExposed(bot, position) {
  return NEIGHBORS.some(([dx, dy, dz]) => bot.blockAt(position.offset(dx, dy, dz))?.boundingBox === 'empty');
}

// 大模型常用的笼统说法 → 具体的方块 ID
const BLOCK_ALIASES = {
  log: (name) => name.endsWith('_log') && !name.startsWith('stripped_'),
  wood: (name) => name.endsWith('_log') && !name.startsWith('stripped_'),
  ore: (name) => name.endsWith('_ore'),
  leaves: (name) => name.endsWith('_leaves'),
};

/**
 * 把“oak_log / log / logs / 小写大写”之类的说法解析成具体的方块 ID 列表。
 * 规则：完全一致 > 别名（log = 所有原木） > 以 _名字 结尾（iron → iron_ore 不算，必须是 _ore 这种完整后缀）
 */
export function resolveBlockNames(bot, query) {
  const all = Object.keys(bot.registry.blocksByName);
  const name = normalizeName(query);
  if (bot.registry.blocksByName[name]) return [name];
  const singular = name.replace(/s$/, '');
  if (bot.registry.blocksByName[singular]) return [singular];
  const alias = BLOCK_ALIASES[name] ?? BLOCK_ALIASES[singular];
  if (alias) return all.filter(alias);
  return all.filter((blockName) => blockName.endsWith(`_${singular}`));
}

/** 在背包里按名字找物品：完全一致优先，其次以 _名字 结尾，再其次包含 */
export function findInventoryItem(bot, query) {
  const name = normalizeName(query);
  const items = bot.inventory.items();
  return (
    items.find((item) => item.name === name) ??
    items.find((item) => item.name === name.replace(/s$/, '')) ??
    items.find((item) => item.name.endsWith(`_${name.replace(/s$/, '')}`)) ??
    items.find((item) => item.name.includes(name.replace(/s$/, ''))) ??
    null
  );
}

/** 某种物品在背包里一共有几个（同名物品可能分在好几格） */
export function countItem(bot, itemName) {
  return bot.inventory
    .items()
    .filter((item) => item.name === itemName)
    .reduce((sum, item) => sum + item.count, 0);
}

/** 背包快照 { 物品名: 数量 }，用来算“干完活多了什么” */
export function inventorySnapshot(bot) {
  const counts = {};
  for (const item of bot.inventory.items()) {
    counts[item.name] = (counts[item.name] ?? 0) + item.count;
  }
  return counts;
}

/** 两次快照的差：返回“oak_log x5、apple x1”这样的文字，没有变化返回空字符串 */
export function describeGain(before, after) {
  return Object.entries(after)
    .map(([name, count]) => [name, count - (before[name] ?? 0)])
    .filter(([, gained]) => gained > 0)
    .map(([name, gained]) => `${name} x${gained}`)
    .join('、');
}

function normalizeName(query) {
  return String(query ?? '')
    .trim()
    .toLowerCase()
    .replace(/^minecraft:/, '')
    .replace(/\s+/g, '_');
}
