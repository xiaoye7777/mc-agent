// 射箭：算好角度、提前量，拉满弓再松手。打烈焰人（停在 12~14 格外不过来）和末影水晶都要用。
//
// 怎么瞄：Minecraft 里的箭是这样飞的（每一刻 = 1/20 秒）：
//   拉满弓射出时速度 3 格/刻 → 每刻先按速度移动，再乘 0.99（空气阻力），再往下减 0.05（重力）
// 所以不能直接对着目标射，要抬高一点。这里把这个过程模拟一遍，试不同的仰角，
// 找到“飞到目标那么远时，高度刚好等于目标高度”的角度。目标在动的话，按飞行时间算提前量。
import { Vec3 } from 'vec3';
import { countItem, sleep } from '../../actions/helpers.js';

const ARROW_SPEED = 3; // 拉满弓
const DRAG = 0.99;
const GRAVITY = 0.05;
const FULL_DRAW_MS = 1100; // 拉满要 20 刻 = 1 秒，多给一点
const MAX_TICKS = 100;

export function canShoot(bot) {
  return countItem(bot, 'bow') > 0 && countItem(bot, 'arrow') > 0;
}

/**
 * 模拟一支箭：以仰角 pitch（弧度，向上为正）射出，飞到水平距离 distance 时的高度和用了几刻。
 * 飞不到那么远返回 null。
 */
function simulate(pitch, distance) {
  let x = 0;
  let y = 0;
  let vx = Math.cos(pitch) * ARROW_SPEED;
  let vy = Math.sin(pitch) * ARROW_SPEED;
  for (let tick = 1; tick <= MAX_TICKS; tick++) {
    const nextX = x + vx;
    const nextY = y + vy;
    if (nextX >= distance) {
      const t = (distance - x) / vx; // 在这一刻里按比例插值
      return { height: y + vy * t, ticks: tick - 1 + t };
    }
    x = nextX;
    y = nextY;
    vx *= DRAG;
    vy = vy * DRAG - GRAVITY;
  }
  return null;
}

/** 算仰角：从 -60° 到 45° 一档一档试，挑落点高度最接近目标的（取低弹道，飞得快、受干扰少） */
export function solvePitch(distance, height) {
  let best = null;
  for (let degrees = -60; degrees <= 45; degrees += 0.25) {
    const pitch = (degrees * Math.PI) / 180;
    const result = simulate(pitch, distance);
    if (!result) continue;
    const error = Math.abs(result.height - height);
    if (!best || error < best.error) best = { pitch, ticks: result.ticks, error };
  }
  return best && best.error < 0.5 ? best : null;
}

/**
 * 算瞄准点：返回一个“看向它就是正确角度”的点（在目标的水平位置上，高度按仰角抬高）。
 * 目标在动就用飞行时间算提前量，迭代两次让提前量更准。
 */
export function aimPoint(bot, target) {
  const eye = bot.entity.position.offset(0, bot.entity.height ?? 1.62, 0);
  const center = target.position.offset(0, (target.height ?? 1.8) * 0.5, 0);
  const velocity = target.velocity ?? new Vec3(0, 0, 0);
  let predicted = center;
  let solution = null;
  for (let i = 0; i < 2; i++) {
    const dx = predicted.x - eye.x;
    const dz = predicted.z - eye.z;
    const distance = Math.hypot(dx, dz);
    solution = solvePitch(distance, predicted.y - eye.y);
    if (!solution) return null;
    // mineflayer 的实体速度单位是“格/刻”；烈焰人飘来飘去，提前量只算水平方向更稳
    predicted = center.offset(velocity.x * solution.ticks, 0, velocity.z * solution.ticks);
  }
  const dx = predicted.x - eye.x;
  const dz = predicted.z - eye.z;
  const distance = Math.hypot(dx, dz);
  return new Vec3(predicted.x, eye.y + Math.tan(solution.pitch) * distance, predicted.z);
}

/**
 * 视线有没有被挡住：从眼睛到目标连一条线，看中间有没有方块。
 * 要塞里到处是下界砖墙和栅栏，不检查的话箭全射在墙上（测试时 64 支箭一只烈焰人都没打死）。
 * 箭是往上抛的，所以同时检查“直线”和“抬高 1.5 格”两条线，都通才射。
 */
export function hasClearShot(bot, target, eye = bot.entity.position.offset(0, bot.entity.height ?? 1.62, 0)) {
  const center = target.position.offset(0, (target.height ?? 1.8) * 0.5, 0);
  for (const lift of [0, 1.5]) {
    const end = center.offset(0, lift, 0);
    const direction = end.minus(eye);
    const distance = direction.norm();
    const hit = bot.world.raycast(eye, direction.normalize(), distance);
    if (hit && hit.position.distanceTo(eye) < distance - 0.5) return false;
  }
  return true;
}

/**
 * 射一箭：拿弓 → 拉弓（拉的过程中一直跟着目标调整角度）→ 拉满松手。
 * @returns {Promise<boolean>} 有没有射出去（算不出角度、没箭就是 false）
 */
export async function shootAt(ctx, target) {
  const { bot, signal } = ctx;
  if (!canShoot(bot)) return false;
  if (!aimPoint(bot, target) || !hasClearShot(bot, target)) return false;

  await bot.equip(bot.inventory.items().find((item) => item.name === 'bow'), 'hand');
  bot.activateItem(); // 开始拉弓
  const startedAt = Date.now();
  try {
    while (Date.now() - startedAt < FULL_DRAW_MS) {
      const point = target.isValid ? aimPoint(bot, target) : null;
      if (point) await bot.lookAt(point, true);
      await sleep(80, signal);
    }
    const finalPoint = target.isValid ? aimPoint(bot, target) : null;
    if (finalPoint) await bot.lookAt(finalPoint, true);
    await sleep(60, signal); // 让最后一次转头先发出去（转头要等下一个物理帧）
  } finally {
    bot.deactivateItem(); // 松手
  }
  return true;
}
