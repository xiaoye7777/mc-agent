// 聊天能力：听玩家说话 / 收到任务结果 → 交给 Agent 循环思考（必要时执行动作）→ 把回复发回游戏。
//
// NPC 的“思考”有两个触发来源：
//   1. 玩家说话：「阿方 帮我砍点木头」
//   2. 后台任务结束：【任务结果】「挖 4 个 log」完成：背包新增 oak_log x4
//      —— 大模型看到结果，会接着做下一步（比如把木头交给玩家），这样多步骤的事就能自己做完
//
// 一次思考的流程：
//   触发 ──> 排队（同一时间只想一件事，避免刷屏和乱序）
//        ──> 拼 prompt（人设 + 当前状态 + 该玩家的历史 + 新消息）
//        ──> runAgentLoop()：问大模型，它要动手就执行动作，直到它给出回复
//        ──> 写入记忆 ──> 切成短句发到公屏 / 私聊
import { createLogger } from '../logger.js';
import { runAgentLoop } from './agentLoop.js';
import { ConversationMemory } from './memory.js';
import { buildSystemPrompt, describeWorld } from './persona.js';

const log = createLogger('chat');

// Minecraft 单条聊天上限 256 字符，留点余量
const MAX_CHAT_LENGTH = 200;
// 连发多条之间的间隔，太快会被服务器当成刷屏踢掉
const SEND_INTERVAL_MS = 600;
// 没有玩家插话时，最多连续自动做几步（防止大模型失败了反复重试、停不下来）
const MAX_AUTO_STEPS = 6;
// “停下”类的话不用等大模型思考（要 1~3 秒），先立刻停住
const STOP_PATTERN = /(停下|停止|别动|站住|别跟|不要跟|不用跟|算了|不用了|别挖|别砍|别打|\bstop\b)|^停/i;

/**
 * 创建聊天能力。返回的 attach(bot) 在每次（重新）进服时调用。
 * 记忆放在 attach 外面，所以断线重连后 NPC 还记得之前聊过什么。
 */
export function createChatHandler({ npc, llm, actions }) {
  const memory = new ConversationMemory(npc.memorySize);
  const systemPrompt = buildSystemPrompt(npc.name);
  let bot = null;
  let queue = Promise.resolve(); // 简单的串行队列
  let autoSteps = 0; // 连续几次思考是由任务结果自动触发的

  if (!llm.apiKey) {
    log.warn('没有配置 LLM_API_KEY：NPC 能进服，但只会回一句固定的话。');
  }

  // 后台任务干完了 → 让大模型看结果、决定下一步
  actions.tasks.onFinish((outcome) => enqueue(() => handleTaskResult(outcome)));

  function attach(newBot) {
    bot = newBot;

    // 公屏聊天
    bot.on('chat', (username, message) => {
      if (username === bot.username) return; // 忽略自己说的话
      if (!shouldReply(message)) return;
      onPlayerMessage(username, message, false);
    });

    // 私聊（/msg、/tell）：一律回复
    bot.on('whisper', (username, message) => {
      if (username === bot.username) return;
      onPlayerMessage(username, message, true);
    });

    log.info(`聊天已就绪：喊「${npc.name}」或「${bot.username}」就会回复（模式：${npc.chatTrigger}）`);
  }

  function shouldReply(message) {
    if (npc.chatTrigger === 'all') return true;
    const text = message.toLowerCase();
    return text.includes(npc.name.toLowerCase()) || text.includes(bot.username.toLowerCase());
  }

  function onPlayerMessage(username, message, isWhisper) {
    autoSteps = 0; // 玩家说话了，自动步数重新计
    const withoutName = message.split(npc.name).join('').split(bot.username).join('').trim();
    if (STOP_PATTERN.test(withoutName) && actions.interrupt()) {
      log.info(`${username} 叫停，已立刻停下`);
    }
    enqueue(() => handlePlayerMessage(username, message, isWhisper));
  }

  function enqueue(job) {
    queue = queue.then(job).catch((err) => log.error('处理消息失败：', err.message));
  }

  async function handlePlayerMessage(username, message, isWhisper) {
    log.info(`${isWhisper ? '[私聊] ' : ''}${username}: ${message}`);
    if (!actions.tasks.current) lookAtPlayer(bot, username); // 忙着干活时不转头，免得打断

    const reply = await think(username, `${username} 说：${message}`, { player: username, isWhisper });
    await send(reply, username, isWhisper);
  }

  async function handleTaskResult({ task, ok, result }) {
    if (!task.owner || !bot) return;
    const report = `【任务结果】「${task.label}」${ok ? '完成' : '失败'}：${result}`;
    log.info(report);

    autoSteps += 1;
    if (autoSteps > MAX_AUTO_STEPS) {
      // 自动做了太多步还没停：不再让大模型继续，直接把结果说出来，等玩家发话
      log.warn(`已连续自动执行 ${MAX_AUTO_STEPS} 步，暂停自动续做`);
      await send(`${task.label}${ok ? '完成了' : '没成功'}：${result}`, task.owner, task.isWhisper);
      return;
    }

    // 任务结果不是玩家说的话，要明确告诉大模型“该你决定下一步了”，
    // 否则它常常只回一句“这就给你”却忘了真的调用工具
    const prompt =
      `${report}\n` +
      `（系统消息，不是玩家说的话。对照 ${task.owner} 最初的要求：如果还有没做完的步骤，现在就调用对应的工具去做，` +
      `只说不做是不行的；全部做完了就用一句话告诉 ${task.owner} 结果；失败了就照实说原因。）`;
    const reply = await think(task.owner, prompt, { player: task.owner, isWhisper: task.isWhisper }, report);
    await send(reply, task.owner, task.isWhisper);
  }

  /**
   * 问大模型（带工具），成功的话把这一问一答写进该玩家的记忆
   * @param {string} [memoryContent] 写进记忆的版本（默认和 content 一样；任务结果只记结果，不记那段系统提示）
   */
  async function think(player, content, context, memoryContent = content) {
    if (!llm.apiKey) {
      return `${player}，我的大脑还没接上（缺 LLM_API_KEY），暂时只会说这句。`;
    }

    const messages = [
      { role: 'system', content: `${systemPrompt}\n\n${describeWorld(bot, actions.describeActivity())}` },
      ...memory.get(player),
      { role: 'user', content },
    ];

    try {
      const reply = await runAgentLoop({ llm, actions, messages, context });
      // 调用成功才写入记忆，失败的那轮不留痕迹。
      // 只记“发生了什么、NPC 回了什么”，中间的工具调用不进记忆——
      // NPC 正在做什么、背包里有什么，每次都会通过 describeWorld 重新告诉它。
      memory.add(player, 'user', memoryContent);
      memory.add(player, 'assistant', reply);
      return reply;
    } catch (err) {
      log.error(err.message);
      return '我脑子卡了一下，你再说一遍？';
    }
  }

  async function send(reply, player, isWhisper) {
    log.info(`→ 回复 ${player}: ${reply}`);
    for (const line of splitForChat(reply)) {
      try {
        if (isWhisper) bot.whisper(player, line);
        else bot.chat(line);
      } catch (err) {
        log.warn('发送失败（可能掉线了）：', err.message);
        return;
      }
      await sleep(SEND_INTERVAL_MS);
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
