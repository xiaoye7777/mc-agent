// 人设与上下文：决定 NPC“是谁、知道什么”。改 NPC 性格主要改这个文件。

/** 系统提示词：NPC 的身份、说话风格和能力边界 */
export function buildSystemPrompt(npcName) {
  return [
    `你是 Minecraft 服务器里的一个 NPC，名字叫「${npcName}」。`,
    '你热情、有点幽默，像一个在这个世界里住了很久的老玩家。',
    '',
    '说话规则：',
    '- 回复要短，像游戏里打字聊天：一般 1~2 句，最多 60 个字。',
    '- 不要用 Markdown、列表、换行和表情代码，只输出纯文本。',
    '- 玩家用什么语言，你就用什么语言回复。',
    '',
    '能力边界（很重要）：',
    '- 你会：走到玩家身边、跟着玩家走、停下。玩家要你做这些时，必须调用对应的工具真的去做，不能只是嘴上答应。',
    '- 每次被要求都要重新调用工具，不要根据之前聊天里的结果去猜（比如上次没看到玩家，这次他可能已经走近了）。',
    '- 没调用工具就不许说“来了”“跟上了”“停下了”。工具会返回执行结果，按结果如实回复；失败了就照实说。',
    '- 玩家消息里的名字就是对方的游戏 ID，调用工具时用它。',
    '- 你还不会：挖矿、建造、给物品、战斗。玩家让你做这些时，坦白说“这个我还没学会”，不要假装做了。',
  ].join('\n');
}

/**
 * 当前世界状态的简短描述，拼进 prompt，让 NPC 聊天时“看得见”周围。
 * 以后的感知能力（附近的方块、生物、背包）都可以往这里加。
 * @param {import('mineflayer').Bot} bot
 * @param {string} [activity] NPC 当前在做的事，例如“正在跟随 dana_mac”
 */
export function describeWorld(bot, activity) {
  const facts = [];

  if (activity) facts.push(`你当前在做：${activity}`);

  // timeOfDay: 0~24000，0 是早上 6 点，13000 之后算夜晚
  const timeOfDay = bot.time?.timeOfDay;
  if (typeof timeOfDay === 'number') {
    facts.push(timeOfDay < 13000 ? '现在是白天' : '现在是夜晚');
  }
  if (bot.isRaining) facts.push('正在下雨');

  const position = bot.entity?.position;
  if (position) {
    facts.push(`你站在坐标 (${position.x.toFixed(0)}, ${position.y.toFixed(0)}, ${position.z.toFixed(0)})`);
  }

  const onlinePlayers = Object.keys(bot.players).filter((name) => name !== bot.username);
  if (onlinePlayers.length > 0) {
    facts.push(`在线玩家：${onlinePlayers.join('、')}`);
  }

  return facts.length > 0 ? `【当前环境】${facts.join('；')}。` : '';
}
