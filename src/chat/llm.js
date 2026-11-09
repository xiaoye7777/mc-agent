// 大模型调用层：只做一件事——把 messages 发给大模型，拿回一段文字。
// 用的是 OpenAI 兼容的 /chat/completions 接口，所以 DeepSeek、通义千问、Kimi、
// OpenAI、本地 Ollama 等都能直接换，只要改 .env 里的 LLM_BASE_URL / LLM_MODEL。
import { createLogger } from '../logger.js';

const log = createLogger('llm');

/**
 * @param {object} llmConfig  config.llm
 * @param {{ role: 'system' | 'user' | 'assistant', content: string }[]} messages
 * @returns {Promise<string>} 大模型回复的文本
 */
export async function chatCompletion(llmConfig, messages) {
  const url = `${llmConfig.baseUrl.replace(/\/$/, '')}/chat/completions`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${llmConfig.apiKey}`,
    },
    body: JSON.stringify({
      model: llmConfig.model,
      messages,
      temperature: 0.8, // 稍高一点，聊天更有“人味”
      max_tokens: 200, // NPC 说话要短，也省钱
    }),
    signal: AbortSignal.timeout(llmConfig.timeoutMs),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`大模型接口返回 ${response.status}：${detail.slice(0, 200)}`);
  }

  const data = await response.json();
  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) {
    log.warn('大模型返回了空内容：', JSON.stringify(data).slice(0, 200));
    return '……（发呆中）';
  }
  return text;
}
