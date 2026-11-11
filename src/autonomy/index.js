// 自主发育：按里程碑一步步发育（见 milestones.js），每个目标交给规划器（planner.js）去倒推、执行。
//
// 运行方式：作为一个后台任务（kind = 'autonomy'），所以玩家喊“停下”能停，
// 期间照常聊天，问“你在干嘛”会说出当前阶段和步骤。
//
// 死了怎么办：每个目标都用一个“死亡即中断”的信号去执行。死了 → 当前步骤中断 → 等重生 →
// 回到死亡地点捡回掉落物 → 重新执行这个目标（规划器是看背包算缺什么的，所以能接着做）。
import pathfinderPkg from 'mineflayer-pathfinder';
import { goTo, useMovementProfile } from '../actions/helpers.js';
import { createLogger } from '../logger.js';
import { describeGoal, isGoalDone, isMilestoneDone, MILESTONES } from './milestones.js';
import { obtain } from './planner.js';
import { ensureFood } from './skills/food.js';
import { restIfNight } from './skills/sleep.js';
import { collectDrops, escapeWater, explore } from './skills/world.js';

const { goals } = pathfinderPkg;
const log = createLogger('autonomy');

const MAX_ATTEMPTS = 5;
// 氧气（满值 20）低于这个值就先别干活了，游上去换气
const LOW_OXYGEN = 10;

/**
 * 开始自主发育（已经在发育就不重复开始）
 * @param {{ bot: import('mineflayer').Bot, tasks: object, owner?: string|null, isWhisper?: boolean }} params
 */
export function startAutonomy({ bot, tasks, owner = null, isWhisper = false }) {
  if (tasks.current?.kind === 'autonomy') return `已经在自主发育了：${tasks.describe()}`;
  tasks.start({ label: '自主发育', kind: 'autonomy', owner, isWhisper, report: 'always' }, (task) => run(bot, task));
  return '开始自主发育：从砍树开始，一步步往铁器、钻石发展';
}

async function run(bot, { signal, setProgress }) {
  useMovementProfile(bot, 'free');
  const state = { unreachable: new Map(), stage: '准备' };
  const announce = (text) => {
    log.info(text);
    try {
      bot.chat(`[发育] ${text}`);
    } catch {
      // 掉线时发不出去，无所谓
    }
  };

  await escapeWater(makeContext(bot, signal, setProgress, state)).catch(() => {}); // 上线时可能泡在水里

  // 开发用：SURVIVE_FROM=下界传送门 直接从某个阶段开始（配合 /give 给装备，单独练这一段）
  const startIndex = Math.max(0, MILESTONES.findIndex((m) => m.name === process.env.SURVIVE_FROM));

  try {
    for (const milestone of MILESTONES.slice(startIndex)) {
      if (milestone.todo) {
        const message = `能做的阶段都做完了。下一阶段「${milestone.name}」还没学会（计划：${milestone.plan}）`;
        announce(message);
        return message;
      }
      if (isMilestoneDone(bot, milestone)) continue;

      state.stage = milestone.name;
      announce(`开始【${milestone.name}】`);
      try {
        for (const goal of milestone.goals) {
          if (isGoalDone(bot, goal)) continue;
          await achieve(bot, goal, { signal, setProgress, state });
        }
      } catch (err) {
        if (signal.aborted || !milestone.optional) throw err;
        announce(`【${milestone.name}】做不成，先跳过：${err.message}`);
        continue;
      }
      if (milestone.after) await milestone.after(makeContext(bot, signal, setProgress, state));
      announce(`完成【${milestone.name}】`);
    }
    return '全部阶段完成';
  } finally {
    useMovementProfile(bot, 'safe');
  }
}

/** 完成一个目标：失败就换个地方重试，死了就捡回东西再来 */
async function achieve(bot, goal, { signal, setProgress, state }) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // 每次尝试一个独立的“死亡中断”信号：死了只中断这一步，不结束整个发育任务
    const step = new AbortController();
    let deathPosition = null;
    let drowning = false;
    const onDeath = () => {
      deathPosition = bot.entity.position.clone();
      step.abort('死了');
    };
    const onBreath = (oxygen) => {
      if (oxygen < LOW_OXYGEN && !drowning) {
        drowning = true;
        step.abort('快淹死了');
      }
    };
    bot.once('death', onDeath);
    bot.on('ownBreath', onBreath); // 见 survival.js 的 trackOwnOxygen：mineflayer 自带的氧气值不可靠

    const stepSignal = AbortSignal.any([signal, step.signal]);
    const ctx = makeContext(bot, stepSignal, setProgress, state);
    try {
      if (goal.run) await goal.run(ctx);
      else if (goal.food !== undefined) await ensureFood(ctx, goal.food);
      else await obtain(ctx, goal.item, goal.count ?? 1);
      return;
    } catch (err) {
      if (signal.aborted) throw err; // 玩家叫停
      if (drowning && !deathPosition) {
        log.warn('氧气不够了，先游上去换气');
        await surfaceForAir(makeContext(bot, signal, setProgress, state));
        attempt -= 1;
        continue;
      }
      if (deathPosition) {
        log.warn(`死在 ${deathPosition}，重生后回去捡东西`);
        await recoverAfterDeath(makeContext(bot, signal, setProgress, state), deathPosition);
        attempt -= 1; // 死亡不算失败次数
        continue;
      }
      log.warn(`「${describeGoal(goal)}」第 ${attempt} 次失败：${err.message}`);
      if (attempt === MAX_ATTEMPTS) throw new Error(`卡在「${describeGoal(goal)}」：${err.message}`);
      // 第一次失败原地重试（很多问题重新规划一遍就好了）；再失败就换个地方
      if (attempt >= 2) await explore(ctx).catch(() => {});
    } finally {
      bot.removeListener('death', onDeath);
      bot.removeListener('ownBreath', onBreath);
    }
  }
}

function makeContext(bot, signal, setProgress, state) {
  const ctx = {
    bot,
    signal,
    state,
    depth: 0,
    log(text) {
      log.info(`[${state.stage}] ${text}`);
      setProgress(`${state.stage}：${text}`);
    },
  };
  ctx.obtain = (item, count) => obtain(ctx, item, count);
  ctx.rest = () => restIfNight(ctx);
  return ctx;
}

/** 在水里憋不住了：停下手上的事，一直往上游，直到氧气回满（最多 20 秒） */
async function surfaceForAir(ctx) {
  const { bot } = ctx;
  bot.pathfinder.setGoal(null);
  bot.setControlState('jump', true);
  bot.setControlState('forward', true);
  const deadline = Date.now() + 20000;
  try {
    while (bot.ownOxygen < 20 && Date.now() < deadline && bot.health > 0) {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  } finally {
    bot.clearControlStates();
  }
  ctx.log(bot.ownOxygen >= 20 ? '换好气了' : '没能游上去换气');
}

/** 等重生，然后回死亡地点捡东西（太远就算了；掉落物 5 分钟后会消失） */
async function recoverAfterDeath(ctx, deathPosition) {
  const { bot, signal } = ctx;
  await new Promise((resolve) => {
    if (bot.health > 0) return setTimeout(resolve, 1500);
    bot.once('spawn', () => setTimeout(resolve, 1500));
  });
  if (deathPosition.distanceTo(bot.entity.position) > 300) {
    ctx.log('死得太远了，不回去捡了');
    return;
  }
  try {
    const { x, y, z } = deathPosition;
    await goTo(bot, new goals.GoalNear(x, y, z, 2), { signal, timeoutMs: 120000 });
    await collectDrops(ctx, deathPosition, 8);
    ctx.log('捡回了死亡时掉的东西');
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    ctx.log(`没能捡回东西：${err.message}`);
  }
}
