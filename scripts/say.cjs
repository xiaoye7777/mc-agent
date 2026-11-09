// 模拟一个玩家进服说几句话，用来不开游戏也能测试 NPC 回复。
// 用法：node scripts/say.cjs "阿方 你好" "阿方 你会干什么？"
const mineflayer = require('mineflayer');

const messages = process.argv.slice(2);
if (messages.length === 0) messages.push('阿方 你好');

const player = mineflayer.createBot({
  host: process.env.MC_HOST || 'localhost',
  port: Number(process.env.MC_PORT || 25565),
  username: 'Tester',
  auth: 'offline',
});

player.on('messagestr', (text) => console.log('[聊天]', text));
player.on('error', (err) => console.error('[出错]', err.message));

player.once('spawn', async () => {
  await sleep(1500);
  for (const message of messages) {
    player.chat(message);
    await sleep(10000); // 留时间等 NPC 回复
  }
  player.quit();
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
