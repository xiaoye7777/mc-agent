// Agent 循环：让大模型“边想边做”。这是 NPC 从聊天机器人变成 Agent 的核心。
//
//   ┌─> 把对话 + 工具清单发给大模型
//   │      │
//   │      ├─ 它直接回了一句话 ──────────────> 结束，把这句话回给玩家
//   │      │
//   │      └─ 它说“请调用 follow_player(dana_mac)”
//   │             │
//   │             ▼
//   │      我们真的去执行这个动作，得到结果“开始跟随 dana_mac”
//   │             │
//   └──── 把“它的要求”和“执行结果”都追加进对话，再问它一次
//
// 大模型自己不会动手，它只会“提要求”；真正动手的是我们的代码（actions/）。
import { createLogger } from '../logger.js';
import { chatCompletion } from './llm.js';

const log = createLogger('agent');

// 一条消息最多来回几轮，防止大模型一直调用工具停不下来（也防止烧钱）
const MAX_ROUNDS = 4;

/**
 * @param {object} params
 * @param {import('mineflayer').Bot} params.bot
 * @param {object} params.llm       config.llm
 * @param {object} params.actions   createActionRegistry() 的返回值
 * @param {object[]} params.messages 已拼好的对话（system + 历史 + 本次用户消息）
 * @returns {Promise<string>} 最终要回给玩家的话
 */
export async function runAgentLoop({ bot, llm, actions, messages }) {
  // 复制一份，循环里追加的工具消息只在这一次思考中有效，不污染外面
  const conversation = [...messages];

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const answer = await chatCompletion(llm, conversation, actions.toolDefinitions);

    // 没要求调用工具 = 想好了，直接回复
    if (answer.toolCalls.length === 0) {
      return answer.text || '嗯？';
    }

    // 协议要求：先把“它要调用工具”的那条消息原样放回对话……
    conversation.push(answer.message);

    // ……再逐个执行，每个结果用 role: 'tool' + 对应的 tool_call_id 告诉它
    for (const call of answer.toolCalls) {
      const name = call.function.name;
      const args = parseArguments(call.function.arguments);
      const result = await actions.run(bot, name, args);
      log.info(`执行动作 ${name}(${JSON.stringify(args)}) → ${result}`);
      conversation.push({ role: 'tool', tool_call_id: call.id, content: result });
    }
  }

  log.warn(`超过 ${MAX_ROUNDS} 轮还没给出回复，强制结束`);
  return '我有点手忙脚乱，你再说一遍？';
}

// 大模型给的参数是 JSON 字符串，偶尔格式不对，解析失败就当没参数
function parseArguments(rawArguments) {
  try {
    return JSON.parse(rawArguments || '{}');
  } catch {
    return {};
  }
}
