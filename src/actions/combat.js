// 战斗类动作：只打敌对怪物。
//
// ⚠️ 规则：永远不打玩家、不打动物（可能是别人养的）、不打中立生物
//    （末影人、猪灵等，打了会招来一群）。可以用 .env 的 NPC_ALLOW_COMBAT=false 整个关掉。
import pathfinderPkg from 'mineflayer-pathfinder';
import { distanceTo, sleep, throwIfAborted } from './helpers.js';

const { goals } = pathfinderPkg;

// minecraft-data 里算 hostile、但不该主动去打的
const DO_NOT_ATTACK = new Set([
  'enderman', 'piglin', 'piglin_brute', 'zombified_piglin', // 中立，打一个会被一群围攻
  'warden', 'wither', 'ender_dragon', 'elder_guardian', 'creaking', 'giant', // 打不过 / 打不动
]);

const MELEE_RANGE = 3;
const ATTACK_COOLDOWN_MS = 650; // 1.9 之后的攻击冷却，连点伤害很低
const MAX_FIGHT_MS = 60000;
const MAX_SEARCH_DISTANCE = 32;

// 武器从好到差
const WEAPONS = [
  'netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'golden_sword', 'wooden_sword',
  'netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'golden_axe', 'wooden_axe',
];

/** 这个实体能不能打：只有敌对怪物，排除中立和 boss */
export function isFightable(entity) {
  return entity?.type === 'hostile' && !DO_NOT_ATTACK.has(entity.name);
}

/** 拿上背包里最好的武器（没有就空手） */
export async function equipBestWeapon(bot) {
  for (const name of WEAPONS) {
    const weapon = bot.inventory.items().find((item) => item.name === name);
    if (weapon) {
      if (bot.heldItem?.name !== name) await bot.equip(weapon, 'hand');
      return name;
    }
  }
  return null;
}

/** @type {import('./index.js').Action[]} */
export const combatActions = [
  {
    name: 'attack_mob',
    description:
      '去打附近的敌对怪物（僵尸、骷髅、蜘蛛、苦力怕等）。mob 用英文 ID，不填就打最近的敌对怪物。' +
      '永远不能打玩家和动物。后台执行，打完会收到任务结果。',
    parameters: {
      type: 'object',
      properties: {
        mob: { type: 'string', description: '怪物的 Minecraft 英文 ID，例如 zombie；不填 = 最近的敌对怪物' },
        max_distance: { type: 'number', description: '最远去多远找，默认 16，最大 32' },
      },
    },
    run({ bot, tasks, player, isWhisper }, { mob, max_distance: maxDistance = 16 }) {
      const range = Math.min(Number(maxDistance) || 16, MAX_SEARCH_DISTANCE);
      const wanted = mob ? String(mob).toLowerCase().replace(/^minecraft:/, '') : null;

      if (wanted && bot.registry.entitiesByName[wanted] && !isFightable({ type: bot.registry.entitiesByName[wanted].type, name: wanted })) {
        return `${wanted} 不是我能打的目标（我只打敌对怪物，不打玩家、动物和中立生物）`;
      }

      const target = bot.nearestEntity(
        (entity) =>
          isFightable(entity) &&
          (!wanted || entity.name === wanted) &&
          entity.position.distanceTo(bot.entity.position) <= range,
      );
      if (!target) return `附近 ${range} 格内没有${wanted ?? '敌对怪物'}`;

      const label = `打 ${target.name}`;
      tasks.start({ label, kind: 'combat', owner: player, isWhisper, report: 'always' }, ({ signal }) => fight(bot, target, signal));
      return `已开始：${label}（${distanceTo(bot, target.position)} 格外）`;
    },
  },
];

/** 追上去打，直到它死掉 / 消失 / 超时 */
async function fight(bot, target, signal) {
  const weapon = await equipBestWeapon(bot);
  const startedAt = Date.now();
  let hits = 0;

  try {
    while (Date.now() - startedAt < MAX_FIGHT_MS) {
      throwIfAborted(signal);
      if (!target.isValid || !bot.entities[target.id]) {
        return `${target.name} 解决了（打了 ${hits} 下${weapon ? `，用的 ${weapon}` : '，空手'}）`;
      }

      const distance = target.position.distanceTo(bot.entity.position);
      if (distance > MAX_SEARCH_DISTANCE) throw new Error(`${target.name} 跑远了`);

      if (distance > MELEE_RANGE) {
        // 追：GoalFollow + dynamic，目标一动就重新算路
        if (!bot.pathfinder.goal) bot.pathfinder.setGoal(new goals.GoalFollow(target, 1.5), true);
      } else {
        await bot.lookAt(target.position.offset(0, target.height * 0.8, 0), true);
        bot.attack(target);
        hits += 1;
      }
      await sleep(ATTACK_COOLDOWN_MS, signal);
    }
    throw new Error(`打了 ${MAX_FIGHT_MS / 1000} 秒还没打死 ${target.name}，先撤了`);
  } finally {
    bot.pathfinder.setGoal(null);
  }
}
