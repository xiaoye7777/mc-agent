// 入口：读配置 → 准备各项能力 → 启动机器人，进服后把能力挂上去。
//
// 以后加新能力（跟随玩家、挖矿……）的套路：
//   1. 在 src/ 下新建一个模块，导出 attach(bot)
//   2. 在下面 onSpawn 里调用它
import { config } from './config.js';
import { startBot } from './bot.js';
import { createChatHandler } from './chat/chatHandler.js';
import { createLogger } from './logger.js';

const log = createLogger('main');

const chat = createChatHandler({ npc: config.npc, llm: config.llm });

const botHandle = startBot(config.minecraft, (bot) => {
  chat.attach(bot);
});

// Ctrl+C 时让机器人体面下线，而不是直接掉线
process.on('SIGINT', () => {
  log.info('收到退出信号，机器人下线');
  botHandle.stop();
  setTimeout(() => process.exit(0), 300);
});
