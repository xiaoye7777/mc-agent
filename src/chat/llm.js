// 大模型调用层：只做一件事——把 messages（和可选的工具清单）发给大模型，拿回它的回答。
// 用的是 OpenAI 兼容的 /chat/completions 接口，所以 DeepSeek、通义千问、Kimi、
// OpenAI、本地 Ollama 等都能直接换，只要改 .env 里的 LLM_BASE_URL / LLM_MODEL。
import { createLogger } from '../logger.js';

const log = createLogger('llm');

/**
 * @param {object} llmConfig  config.llm
 * @param {object[]} messages 对话消息（system / user / assistant / tool）
 * @param {object[]} [tools]  可选：工具清单。带上它，大模型就可能不直接说话，而是要求“调用某个工具”
 * @returns {Promise<{ text: string, toolCalls: object[], message: object }>}
 *   text：大模型说的话；toolCalls：它要求调用的工具（没有就是空数组）；
 *   message：原始的 assistant 消息，Agent 循环需要把它原样放回对话里
 */
export async function chatCompletion(llmConfig, messages, tools) {
  const url = `${llmConfig.baseUrl.replace(/\/$/, '')}/chat/completions`;

  const body = {
    model: llmConfig.model,
    messages,
    temperature: 0.8, // 稍高一点，聊天更有“人味”
    max_tokens: 300, // NPC 说话要短，也省钱
  };
  if (tools?.length) body.tools = tools;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${llmConfig.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(llmConfig.timeoutMs),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`大模型接口返回 ${response.status}：${detail.slice(0, 200)}`);
  }

  const data = await response.json();
  const message = data.choices?.[0]?.message;
  if (!message) {
    log.warn('大模型返回格式不对：', JSON.stringify(data).slice(0, 200));
    return { text: '……（发呆中）', toolCalls: [], message: { role: 'assistant', content: '' } };
  }

  return {
    text: message.content?.trim() ?? '',
    toolCalls: message.tool_calls ?? [],
    message,
  };
}
