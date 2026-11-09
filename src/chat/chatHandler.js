// 聊天能力：监听游戏里的聊天 → 判断要不要回 → 问大模型 → 把回复发回游戏。
//
// 一条消息的完整流程：
//   玩家发言 ──> shouldReply()  不回就结束
//            ──> 排队（同一时间只处理一条，避免刷屏和并发乱序）
//            ──> 看向玩家 + 拼 prompt（人设 + 环境 + 该玩家的历史 + 新消息）
//            ──> chatCompletion() 调大模型
//            ──> 写入记忆 ──> 切成短句发到公屏 / 私聊
import { createLogger } from '../logger.js';
import { chatCompletion } from './llm.js';
import { ConversationMemory } from './memory.js';
import { buildSystemPrompt, describeWorld } from './persona.js';

const log = createLogger('chat');

// Minecraft 单条聊天上限 256 字符，留点余量
const MAX_CHAT_LENGTH = 200;
// 连发多条之间的间隔，太快会被服务器当成刷屏踢掉
const SEND_INTERVAL_MS = 600;

/**
 * 创建聊天能力。返回的 attach(bot) 在每次（重新）进服时调用。
 * 记忆放在 attach 外面，所以断线重连后 NPC 还记得之前聊过什么。
 */
export function createChatHandler({ npc, llm }) {
  const memory = new ConversationMemory(npc.memorySize);
  const systemPrompt = buildSystemPrompt(npc.name);
  let queue = Promise.resolve(); // 简单的串行队列

  if (!llm.apiKey) {
    log.warn('没有配置 LLM_API_KEY：NPC 能进服，但只会回一句固定的话。');
  }

  function attach(bot) {
    // 公屏聊天
    bot.on('chat', (username, message) => {
      if (username === bot.username) return; // 忽略自己说的话
      if (!shouldReply(bot, message)) return;
      enqueue(bot, username, message, false);
    });

    // 私聊（/msg、/tell）：一律回复
    bot.on('whisper', (username, message) => {
      if (username === bot.username) return;
      enqueue(bot, username, message, true);
    });

    log.info(`聊天已就绪：喊「${npc.name}」或「${bot.username}」就会回复（模式：${npc.chatTrigger}）`);
  }

  function shouldReply(bot, message) {
    if (npc.chatTrigger === 'all') return true;
    const text = message.toLowerCase();
    return text.includes(npc.name.toLowerCase()) || text.includes(bot.username.toLowerCase());
  }

  function enqueue(bot, username, message, isWhisper) {
    queue = queue
      .then(() => handleMessage(bot, username, message, isWhisper))
      .catch((err) => log.error('处理消息失败：', err.message));
  }

  async function handleMessage(bot, username, message, isWhisper) {
    log.info(`${isWhisper ? '[私聊] ' : ''}${username}: ${message}`);
    lookAtPlayer(bot, username);

    const reply = await think(bot, username, message);
    log.info(`→ 回复 ${username}: ${reply}`);

    for (const line of splitForChat(reply)) {
      if (isWhisper) bot.whisper(username, line);
      else bot.chat(line);
      await sleep(SEND_INTERVAL_MS);
    }
  }

  async function think(bot, username, message) {
    if (!llm.apiKey) {
      return `${username}，我的大脑还没接上（缺 LLM_API_KEY），暂时只会说这句。`;
    }

    const messages = [
      { role: 'system', content: `${systemPrompt}\n\n${describeWorld(bot)}` },
      ...memory.get(username),
      { role: 'user', content: `${username} 说：${message}` },
    ];

    try {
      const reply = await chatCompletion(llm, messages);
      // 调用成功才写入记忆，失败的那轮不留痕迹
      memory.add(username, 'user', `${username} 说：${message}`);
      memory.add(username, 'assistant', reply);
      return reply;
    } catch (err) {
      log.error(err.message);
      return '我脑子卡了一下，你再说一遍？';
    }
  }

  return { attach };
}

// 说话时转头看着对方，更像个 NPC（对方不在视野内就算了）
function lookAtPlayer(bot, username) {
  const entity = bot.players[username]?.entity;
  if (!entity) return;
  bot.lookAt(entity.position.offset(0, entity.height, 0)).catch(() => {});
}

// 去掉换行，并把长回复按长度切成多条
function splitForChat(text) {
  const flat = text.replace(/\s*\n+\s*/g, ' ').trim();
  const lines = [];
  for (let i = 0; i < flat.length; i += MAX_CHAT_LENGTH) {
    lines.push(flat.slice(i, i + MAX_CHAT_LENGTH));
  }
  return lines;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
