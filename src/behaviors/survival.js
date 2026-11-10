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

const EAT_WHEN_FOOD_BELOW = 15; // 饱食度满值 20
const DEFEND_RANGE = 3.5;
const DEFEND_COOLDOWN_MS = 650;

// 吃了有副作用的食物，不自动吃
const BAD_FOODS = new Set(['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'chorus_fruit', 'suspicious_stew']);

/**
 * @param {import('mineflayer').Bot} bot
 * @param {{ tasks: ReturnType<import('../actions/taskManager.js').createTaskManager>, allowCombat: boolean }} options
 */
export function setupSurvival(bot, { tasks, allowCombat }) {
  // ---- 饿了就吃 ----
  let eating = false;
  bot.on('health', async () => {
    if (eating || bot.food >= EAT_WHEN_FOOD_BELOW) return;
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
    if (kind && kind !== 'follow' && kind !== 'move') return; // 在干别的活（砍树、打指定的怪），不分心

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
    log.warn('NPC 死了，等待重生');
    tasks.cancel('NPC 死了');
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
