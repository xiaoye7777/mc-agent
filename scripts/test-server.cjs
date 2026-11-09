// 本地测试服：用纯 Node 写的 Minecraft 服务端（flying-squid），不用装 Java、不用开游戏。
// 功能很简陋（没有生物、没有红石），但进服、聊天完全够用，适合调试 NPC 的对话。
//
// 用法：
//   终端 1：npm run test-server
//   终端 2：npm start            （.env 里 MC_HOST=localhost、MC_PORT=25565）
//   然后用游戏客户端（1.21.4 + 离线账号）连 localhost，或者跑 scripts/say.cjs 模拟玩家说话
const mcServer = require('flying-squid');

const port = Number(process.env.TEST_SERVER_PORT || 25565);

mcServer.createMCServer({
  motd: 'mc-agent 测试服',
  port,
  'max-players': 10,
  'online-mode': false, // 离线模式，NPC 用 MC_AUTH=offline 即可进
  logging: true,
  gameMode: 1,
  difficulty: 0,
  generation: { name: 'superflat', options: { worldHeight: 80 } },
  kickTimeout: 10000,
  plugins: {},
  modpe: false,
  'view-distance': 4,
  'player-list-text': { header: { text: 'mc-agent' }, footer: { text: 'test server' } },
  'everybody-op': true,
  'max-entities': 100,
  version: '1.21.4', // flying-squid 目前最高支持到 1.21.4
});
