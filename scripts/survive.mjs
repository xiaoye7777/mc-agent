// 自主发育模式：默认连本地测试服（npm run test-server），NPC 一进服就从零开始发育。
//
// 用法：
//   终端 1：npm run test-server
//   终端 2：npm run survive
//
// 为了安全，这里强制连本地测试服，不会去连 .env 里配的公网服。
// 真想连别的服务器：SURVIVE_HOST=地址 SURVIVE_PORT=端口 npm run survive
process.env.MC_HOST = process.env.SURVIVE_HOST ?? 'localhost';
process.env.MC_PORT = process.env.SURVIVE_PORT ?? '25565';
process.env.NPC_AUTONOMY = 'auto';

await import('../src/index.js');
