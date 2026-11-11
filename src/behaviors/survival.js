// 本能反应：不用大模型思考、自动发生的行为（就像人饿了会吃东西、被打会还手）。
//   - 饿了自动吃背包里的食物
//   - 敌对怪物贴脸时自动还手（只在空闲或跟随时，不打断砍树之类的任务）
//   - 死了取消当前任务（mineflayer 会自动重生）
//
// 为什么不交给大模型？这些反应要快（几百毫秒内），而且不需要“想”。
// Agent 的常见设计：大模型负责“想做什么”，本能层负责“活下去”。
import { createLogger } from '../logger.js';
import { equipBestWeapon, isFightable } from '../actions/combat.js';

const log = createLogger('survival');

// 最近一次死亡（记 10 分钟），写进 prompt，玩家问“你怎么死了”时 NPC 才知道自己死过
const DEATH_MEMORY_MS = 10 * 60 * 1000;
const lastDeaths = new WeakMap();

/** 最近 10 分钟内的死亡信息 { time, position }，没有返回 null */
export function recentDeath(bot) {
  const death = lastDeaths.get(bot);
  return death && Date.now() - death.time < DEATH_MEMORY_MS ? death : null;
}

const EAT_WHEN_FOOD_BELOW = 15; // 饱食度满值 20
// 受伤时：饱食度 ≥ 18 才会自动回血，所以掉血了就吃到满，而不是等饿了再吃
const HURT_HEALTH = 14;
const DEFEND_RANGE = 3.5;
const DEFEND_COOLDOWN_MS = 650;

// 吃了有副作用的食物，不自动吃
const BAD_FOODS = new Set(['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'chorus_fruit', 'suspicious_stew']);

/**
 * @param {import('mineflayer').Bot} bot
 * @param {{ tasks: ReturnType<import('../actions/taskManager.js').createTaskManager>, allowCombat: boolean }} options
 */
export function setupSurvival(bot, { tasks, allowCombat }) {
  trackOwnOxygen(bot);

  // ---- 饿了就吃 ----
  let eating = false;
  bot.on('health', async () => {
    const hungry = bot.food < EAT_WHEN_FOOD_BELOW;
    const hurtAndNotFull = bot.health < HURT_HEALTH && bot.food < 20;
    if (eating || !(hungry || hurtAndNotFull)) return;
    if (bot.usingHeldItem) return; // 正在举盾 / 拉弓：这时候吃会冲突（吃也是“使用物品”），让正在打架的逻辑自己处理
    if (bot.targetDigBlock) return; // 正在挖方块，换手会打断，等下一次再吃
    const food = pickFood(bot);
    if (!food) return;

    eating = true;
    try {
      await bot.equip(food, 'hand');
      await bot.consume();
      log.info(`饿了，吃了一个 ${food.name}（饱食度 ${bot.food}）`);
    } catch (err) {
      log.warn('吃东西失败：', err.message);
    } finally {
      eating = false;
    }
  });

  // ---- 怪物贴脸自动还手 ----
  let lastSwing = 0;
  bot.on('physicsTick', () => {
    if (!allowCombat || eating) return;
    if (Date.now() - lastSwing < DEFEND_COOLDOWN_MS) return;
    const kind = tasks.current?.kind;
    if (kind && !['follow', 'move', 'autonomy'].includes(kind)) return; // 在干别的活（砍树、打指定的怪），不分心

    // 恶魂火球飞到跟前时打它一下，能把火球打回去（真人玩家也是这么挡的）
    const fireball = bot.nearestEntity(
      (entity) => entity.name === 'fireball' && entity.position.distanceTo(bot.entity.position) <= 4,
    );
    if (fireball) {
      lastSwing = Date.now();
      bot.lookAt(fireball.position, true).then(() => bot.attack(fireball)).catch(() => {});
      return;
    }

    const enemy = bot.nearestEntity(
      (entity) => isFightable(entity) && entity.position.distanceTo(bot.entity.position) <= DEFEND_RANGE,
    );
    if (!enemy) return;

    lastSwing = Date.now();
    equipBestWeapon(bot)
      .then(() => bot.lookAt(enemy.position.offset(0, enemy.height * 0.8, 0), true))
      .then(() => bot.attack(enemy))
      .catch(() => {});
  });

  // ---- 死亡 ----
  bot.on('death', () => {
    lastDeaths.set(bot, { time: Date.now(), position: bot.entity.position.clone() });
    log.warn('NPC 死了，等待重生');
    // 自主发育自己会处理死亡（重生后回去捡东西接着做），别的任务直接取消
    if (tasks.current?.kind !== 'autonomy') tasks.cancel('NPC 死了');
  });
}

/**
 * 自己的氧气值（满值 20）。不用 mineflayer 自带的 bot.oxygenLevel：
 * 它在处理实体数据时没区分是谁的，附近的鱼、鱿鱼的氧气也会写到 bot.oxygenLevel 上，
 * 结果机器人以为自己快淹死了（测试时因此死循环“上去换气”）。这里只认自己实体的 air_supply。
 */
function trackOwnOxygen(bot) {
  const airSupplyIndex = bot.registry.entitiesByName.player.metadataKeys?.indexOf('air_supply') ?? 1;
  bot.ownOxygen = 20;
  bot._client.on('entity_metadata', (packet) => {
    if (!bot.entity || packet.entityId !== bot.entity.id) return;
    for (const entry of packet.metadata) {
      if (entry.key === airSupplyIndex) {
        bot.ownOxygen = Math.round(entry.value / 15);
        bot.emit('ownBreath', bot.ownOxygen);
      }
    }
  });
}

/** 挑背包里饱食度最高、没有副作用的食物 */
function pickFood(bot) {
  const foods = bot.registry.foodsByName;
  return (
    bot.inventory
      .items()
      .filter((item) => foods[item.name] && !BAD_FOODS.has(item.name))
      .sort((a, b) => foods[b.name].foodPoints - foods[a.name].foodPoints)[0] ?? null
  );
}
