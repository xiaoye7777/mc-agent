// 配置中心：所有可调参数都从环境变量（.env 文件）读取，代码里不写死。
// 新增配置时：1) 在这里加一行  2) 在 .env.example 里补上说明
import 'dotenv/config';

function readString(name, fallback) {
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? fallback : value.trim();
}

function readNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export const config = {
  // —— Minecraft 连接 ——
  minecraft: {
    host: readString('MC_HOST', 'localhost'),
    port: readNumber('MC_PORT', 25565),
    username: readString('MC_USERNAME', 'AgentBot'),
    // offline：离线/盗版服、局域网离线账号；microsoft：正版服（首次会让你在浏览器登录）
    auth: readString('MC_AUTH', 'offline'),
    // 留空 = 自动探测服务器版本
    version: readString('MC_VERSION', undefined),
    reconnectDelayMs: readNumber('MC_RECONNECT_DELAY_MS', 5000),
  },

  // —— NPC 人设与聊天规则 ——
  npc: {
    // 人设里的名字，玩家喊这个名字或游戏 ID 都会触发回复
    name: readString('NPC_NAME', '阿方'),
    // mention：被点名（或私聊）才回复；all：公屏每句都回复
    chatTrigger: readString('CHAT_TRIGGER', 'mention'),
    // 每个玩家记住最近多少条消息（一问一答算 2 条）
    memorySize: readNumber('CHAT_MEMORY_SIZE', 12),
  },

  // —— 大模型（任意 OpenAI 兼容接口，默认 DeepSeek）——
  llm: {
    baseUrl: readString('LLM_BASE_URL', 'https://api.deepseek.com'),
    apiKey: readString('LLM_API_KEY', ''),
    model: readString('LLM_MODEL', 'deepseek-chat'),
    timeoutMs: readNumber('LLM_TIMEOUT_MS', 30000),
  },
};
