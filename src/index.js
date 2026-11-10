// 入口：读配置 → 准备各项能力 → 启动机器人，进服后把能力挂上去。
//
// 三层能力：
//   - 动作（actions/）：NPC 能做的事（走路、砍树、送东西、打怪……），由大模型通过工具调用来触发。
//     耗时的动作在后台以“任务”形式运行，新增动作见 src/actions/index.js。
//   - 本能（behaviors/）：不用思考自动发生的反应：饿了吃东西、怪物贴脸还手。
//   - 聊天（chat/）：听玩家说话、收任务结果，交给大模型思考、回复、决定下一步。
import { config } from './config.js';
import { startBot } from './bot.js';
import { createActionRegistry } from './actions/index.js';
import { createChatHandler } from './chat/chatHandler.js';
import { createLogger } from './logger.js';

const log = createLogger('main');

const actions = createActionRegistry({ allowDig: config.npc.allowDig, allowCombat: config.npc.allowCombat });
const chat = createChatHandler({ npc: config.npc, llm: config.llm, actions });

log.info(`能力开关：挖方块 ${config.npc.allowDig ? '开' : '关'}，打怪 ${config.npc.allowCombat ? '开' : '关'}`);

const botHandle = startBot(config.minecraft, (bot) => {
  actions.attach(bot); // 先装好动作（寻路插件、本能反应），聊天里才能调用
  chat.attach(bot);
});

// Ctrl+C 时让机器人体面下线，而不是直接掉线
process.on('SIGINT', () => {
  log.info('收到退出信号，机器人下线');
  botHandle.stop();
  setTimeout(() => process.exit(0), 300);
});
