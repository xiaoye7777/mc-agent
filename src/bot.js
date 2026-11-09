// 连接层：负责“把机器人放进服务器”，以及断线后自动重连。
// 这里不关心机器人要干什么——具体能力（聊天、以后的移动/挖矿）通过 onSpawn 回调挂上去。
import mineflayer from 'mineflayer';
import { createLogger } from './logger.js';

const log = createLogger('bot');

/**
 * 启动机器人，并在每次（重新）进入世界时调用 onSpawn(bot)。
 * @param {object} mcConfig  config.minecraft
 * @param {(bot: import('mineflayer').Bot) => void} onSpawn
 * @returns {{ stop: () => void }}  调用 stop() 可主动下线、不再重连
 */
export function startBot(mcConfig, onSpawn) {
  let currentBot = null;
  let stopped = false;

  function connect() {
    log.info(`正在连接 ${mcConfig.host}:${mcConfig.port}，用户名 ${mcConfig.username} ...`);

    const bot = mineflayer.createBot({
      host: mcConfig.host,
      port: mcConfig.port,
      username: mcConfig.username,
      auth: mcConfig.auth,
      version: mcConfig.version, // undefined 时 mineflayer 自动探测
    });
    currentBot = bot;

    // 'spawn' 在第一次进入世界和每次重生后都会触发，用 once 只挂一次能力
    bot.once('spawn', () => {
      log.info(`已进入世界（版本 ${bot.version}）`);
      onSpawn(bot);
    });

    bot.on('kicked', (reason) => log.warn('被服务器踢出：', formatReason(reason)));
    bot.on('error', (err) => log.error('连接出错：', err.message));

    // 'end' = 连接断开（被踢、服务器关闭、网络问题都会走到这里）
    bot.on('end', (reason) => {
      if (stopped) return;
      log.warn(`连接断开（${reason}），${mcConfig.reconnectDelayMs / 1000} 秒后重连`);
      setTimeout(connect, mcConfig.reconnectDelayMs);
    });
  }

  connect();

  return {
    stop() {
      stopped = true;
      currentBot?.quit();
    },
  };
}

// 踢出原因可能是字符串、聊天组件，或 1.20.3+ 的 NBT 结构，统一转成可读文本
function formatReason(reason) {
  if (typeof reason === 'string') return reason;
  // NBT 结构长这样：{ type: 'compound', value: { text: { type: 'string', value: '...' } } }
  return reason?.value?.text?.value ?? reason?.text ?? JSON.stringify(reason);
}
