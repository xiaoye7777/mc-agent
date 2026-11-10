// Agent 循环：让大模型“边想边做”。这是 NPC 从聊天机器人变成 Agent 的核心。
//
//   ┌─> 把对话 + 工具清单发给大模型
//   │      │
//   │      ├─ 它直接回了一句话 ──────────────> 结束，把这句话回给玩家
//   │      │
//   │      └─ 它说“请调用 find_block(oak_log)”
//   │             │
//   │             ▼
//   │      我们真的去执行这个动作，得到结果“oak_log 在 (12, 64, -3)，5 格”
//   │             │
//   └──── 把“它的要求”和“执行结果”都追加进对话，再问它一次
//
// 这就是经典的 ReAct 模式：想一步（Reason）→ 做一步（Act）→ 看结果 → 再想。
// 大模型自己不会动手，它只会“提要求”；真正动手的是我们的代码（actions/）。
//
// 耗时的动作（砍树、走路）会在后台跑，工具立刻返回“已开始”。干完后，
// chatHandler 会把“任务结果”作为一条新消息再跑一次这个循环，大模型就能接着做下一步。
import { createLogger } from '../logger.js';
import { chatCompletion } from './llm.js';

const log = createLogger('agent');

// 一次思考最多来回几轮，防止大模型一直调用工具停不下来（也防止烧钱）
const MAX_ROUNDS = 6;

// 大模型偶尔会“嘴上答应、手上不动”：回复“这就去”“跟着你呢”，却没调用任何工具，游戏里什么也不会发生。
// 回复里有这类“答应要做”的说法、但这次思考一个工具都没调用 → 提醒它一次（自我检查，Agent 里常见的“反思”技巧）
const PROMISE_PATTERN = /(这就|马上去|马上就|我去|跟着你|跟上|在路上|开始砍|开始挖|砍着呢|挖着呢|送过去)/;
const PROMISE_NUDGE =
  '（系统检查：你刚才的回复像是答应要去做事，但你没有调用任何工具，游戏里什么都不会发生。' +
  '如果确实要做，现在就调用对应的工具；如果其实不需要动手，就把回复原样再说一遍。）';

/**
 * @param {object} params
 * @param {object} params.llm       config.llm
 * @param {object} params.actions   createActionRegistry() 的返回值
 * @param {object[]} params.messages 已拼好的对话（system + 历史 + 本次消息）
 * @param {{ player: string, isWhisper: boolean }} params.context 谁在跟 NPC 说话
 * @returns {Promise<string>} 最终要回给玩家的话
 */
export async function runAgentLoop({ llm, actions, messages, context }) {
  // 复制一份，循环里追加的工具消息只在这一次思考中有效，不污染外面
  const conversation = [...messages];
  let usedTools = false;
  let nudged = false;

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const answer = await chatCompletion(llm, conversation, actions.toolDefinitions);

    // 没要求调用工具 = 想好了，直接回复
    if (answer.toolCalls.length === 0) {
      const text = answer.text || '嗯？';
      if (!usedTools && !nudged && PROMISE_PATTERN.test(text)) {
        nudged = true;
        log.warn(`大模型说“${text}”却没调用工具，提醒它一次`);
        conversation.push({ role: 'assistant', content: text });
        conversation.push({ role: 'user', content: PROMISE_NUDGE });
        continue;
      }
      return text;
    }
    usedTools = true;

    // 协议要求：先把“它要调用工具”的那条消息原样放回对话……
    conversation.push(answer.message);

    // ……再逐个执行，每个结果用 role: 'tool' + 对应的 tool_call_id 告诉它
    for (const call of answer.toolCalls) {
      const name = call.function.name;
      const args = parseArguments(call.function.arguments);
      const result = await actions.run(name, args, context);
      log.info(`执行动作 ${name}(${JSON.stringify(args)}) → ${result.replace(/\n/g, ' | ')}`);
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
