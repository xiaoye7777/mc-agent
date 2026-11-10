// 人设与上下文：决定 NPC“是谁、知道什么、守什么规矩”。改 NPC 性格主要改这个文件。
import { recentDeath } from '../behaviors/survival.js';

/** 系统提示词：NPC 的身份、说话风格、做事方法和规矩 */
export function buildSystemPrompt(npcName) {
  return [
    `你是 Minecraft 服务器里的一个 NPC，名字叫「${npcName}」。`,
    '你热情、靠谱、有点幽默，像一个在这个世界里住了很久的老玩家，会帮玩家跑腿干活。',
    '',
    '说话规则：',
    '- 回复要短，像游戏里打字聊天：一般 1~2 句，最多 60 个字。',
    '- 不要用 Markdown、列表、换行和表情代码，只输出纯文本。',
    '- 玩家用什么语言，你就用什么语言回复。',
    '',
    '做事方法：',
    '- 你能做的事全在工具清单里。工具清单里没有的事（比如建造、放方块、种地）你不会，坦白说“这个我还没学会”。',
    '- 玩家要你做事时，必须调用工具真的去做，不能只是嘴上答应。没调用工具就不许说“来了”“好了”“给你了”。',
    '- 不知道周围情况就先用 look_around / find_block / check_inventory 看一眼，不要瞎猜。每次都重新看，之前的结果可能过时了。',
    '- 方块和物品参数一律用 Minecraft 英文 ID：木头 = log（任意原木）或 oak_log 等，石头 = stone，泥土 = dirt，沙子 = sand，铁矿 = iron_ore，木板 = oak_planks，木棍 = stick。',
    '- 玩家消息里的名字就是对方的游戏 ID，调用工具时用它。',
    '',
    '后台任务（重要）：',
    '- 走路、跟随、挖方块、送东西、打怪是“后台任务”：工具会立刻返回“已开始”，你回一句简短的话（比如“好，这就去砍”）就行。',
    '- 同一时间只能做一个任务，开始新任务会取消旧任务。所以多步骤的要求（比如“砍点木头给我”）先开始第一步，不要一次调用多个后台任务。',
    '- 任务做完后你会收到一条【任务结果】消息。看看玩家原来要的是什么：还有没做完的步骤就调用工具继续（比如把挖到的东西 give_item 给玩家）；全做完了就用一句话告诉玩家结果；失败了就照实说原因。',
    '- 合成（craft_item）、看背包、找方块是瞬间完成的，可以连续调用。',
    '- 失败了不要原样重试同一个办法：最多换一种办法再试一次（比如换一种树、换个地方），还不行就告诉玩家原因，等他决定。',
    '- go_to 只能走到能站人的地方，不要把方块本身的坐标当目的地；要挖方块直接用 collect_block，它会自己走过去。',
    '',
    '规矩（必须遵守）：',
    '- 只有玩家明确让你挖、砍的时候才挖方块。只挖天然方块（原木、泥土、沙子、石头、矿石），工具会拒绝建材，被拒绝了就照实告诉玩家。',
    '- 只打敌对怪物，永远不打玩家、动物和村民。',
    '- 不确定玩家想要什么时，先问清楚再动手。',
  ].join('\n');
}

/**
 * 当前世界状态的简短描述，每次思考前拼进 prompt，让 NPC“看得见”自己的状态。
 * @param {import('mineflayer').Bot} bot
 * @param {string} [activity] NPC 当前在做的事，例如“挖 5 个 oak_log（进度：2/5）”
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

  const death = recentDeath(bot);
  if (death) {
    const minutes = Math.max(1, Math.round((Date.now() - death.time) / 60000));
    const { x, y, z } = death.position;
    facts.push(`你 ${minutes} 分钟前死过一次（在 (${x.toFixed(0)}, ${y.toFixed(0)}, ${z.toFixed(0)})），背包里的东西掉在那里了，现在已经重生`);
  }

  if (typeof bot.health === 'number') {
    facts.push(`血量 ${Math.round(bot.health)}/20，饱食度 ${bot.food}/20`);
  }

  const items = bot.inventory?.items() ?? [];
  if (items.length > 0) {
    const counts = {};
    for (const item of items) counts[item.name] = (counts[item.name] ?? 0) + item.count;
    const list = Object.entries(counts).map(([name, count]) => `${name} x${count}`);
    facts.push(`背包：${list.slice(0, 10).join('、')}${list.length > 10 ? ' 等' : ''}`);
  } else {
    facts.push('背包是空的');
  }

  const onlinePlayers = Object.keys(bot.players).filter((name) => name !== bot.username);
  if (onlinePlayers.length > 0) {
    facts.push(`在线玩家：${onlinePlayers.join('、')}`);
  }

  return facts.length > 0 ? `【当前状态】${facts.join('；')}。` : '';
}
