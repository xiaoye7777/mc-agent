// 入口：读配置 → 准备各项能力 → 启动机器人，进服后把能力挂上去。
//
// 两种“能力”：
//   - 动作（actions/）：NPC 能做的事，比如跟随、停下。由大模型通过工具调用来触发。
//     新增动作见 src/actions/index.js。
//   - 聊天（chat/）：听玩家说话、交给大模型思考、回复。
import { config } from './config.js';
import { startBot } from './bot.js';
import { createActionRegistry } from './actions/index.js';
import { createChatHandler } from './chat/chatHandler.js';
import { createLogger } from './logger.js';

const log = createLogger('main');

const actions = createActionRegistry();
const chat = createChatHandler({ npc: config.npc, llm: config.llm, actions });

const botHandle = startBot(config.minecraft, (bot) => {
  actions.attach(bot); // 先装好动作（寻路插件），聊天里才能调用
  chat.attach(bot);
});

// Ctrl+C 时让机器人体面下线，而不是直接掉线
process.on('SIGINT', () => {
  log.info('收到退出信号，机器人下线');
  botHandle.stop();
  setTimeout(() => process.exit(0), 300);
});
