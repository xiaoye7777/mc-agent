// 对话记忆：每个玩家一份，只保留最近 N 条，防止 prompt 越来越长。
// 现在存在内存里，进程重启就忘了。以后想“长期记住某个玩家”，
// 可以把这里换成写 JSON 文件 / SQLite / 向量库，外部调用方式不变。
export class ConversationMemory {
  /** @param {number} maxMessages 每个玩家最多保留的消息条数 */
  constructor(maxMessages) {
    this.maxMessages = maxMessages;
    /** @type {Map<string, { role: 'user' | 'assistant', content: string }[]>} */
    this.historyByPlayer = new Map();
  }

  /** 取某个玩家的历史（返回副本，外部改了不影响这里） */
  get(playerName) {
    return [...(this.historyByPlayer.get(playerName) ?? [])];
  }

  /** 追加一条消息，超出上限就丢掉最旧的 */
  add(playerName, role, content) {
    const history = this.historyByPlayer.get(playerName) ?? [];
    history.push({ role, content });
    while (history.length > this.maxMessages) history.shift();
    this.historyByPlayer.set(playerName, history);
  }
}
