# mc-agent

基于 [mineflayer](https://github.com/PrismarineJS/mineflayer) 的 Minecraft NPC Agent。

**当前版本（v0.2）**：NPC 进服后能用大模型和玩家聊天，还能**听指挥行动**：「阿方 过来」「阿方 跟着我」「阿方 停下」。动不动、怎么动由大模型通过工具调用（function calling）自己决定。它会记住每个玩家最近聊过的内容，知道自己正在干什么。挖矿、建造、战斗还**不会**。

> 为了不破坏公网服上的建筑，NPC 走路时**不会挖方块、不会放方块**，遇到过不去的地方会直说。

---

## 1. 全局图：它是怎么工作的

```
游戏服务器（你们的世界）
   ▲
   │  Minecraft 协议
   ▼
bot.js ──────────────── 连接 / 断线重连（mineflayer 负责“假装成一个玩家”）
   │  进服后挂上各种“能力”
   ▼
chat/chatHandler.js ─── 聊天能力：要不要回 → 排队 → 回复
   ├─ persona.js ────── 人设 + 当前环境（白天/坐标/在线玩家/正在做什么）
   ├─ memory.js ─────── 每个玩家的对话记忆（最近 N 条）
   └─ agentLoop.js ──── Agent 循环：问大模型 ⇄ 执行它要的动作，直到它给出回复
         ├─ llm.js ──────── 调大模型 API（默认 DeepSeek），附带工具清单
         └─ actions/ ────── NPC 会做的动作（过来 / 跟随 / 停下），基于 mineflayer-pathfinder
```

一条消息的流程：玩家在公屏喊「阿方 跟着我」→ `chatHandler` 判断要回 → 拼 prompt（人设 + 环境 + 历史 + 新消息）→ `agentLoop` 把对话和**工具清单**发给大模型 → 大模型回“请调用 `follow_player('dana_mac')`” → 我们真的执行，把结果“开始跟随 dana_mac”告诉它 → 它再回一句“跟上了！” → 写入记忆 → 发回公屏。

**关键点：大模型自己不会动手，它只会“提要求”；真正动手的是 `actions/` 里的代码。**

### 技术选型（以及可以替换成什么）

| 层 | 现在用的 | 作用 | 常见替代 |
|---|---|---|---|
| 游戏客户端 | mineflayer | 用代码模拟一个玩家：进服、聊天、移动、挖方块 | 写 Fabric/Forge 模组做真 NPC（要 Java）；参考项目 [mindcraft](https://github.com/kolbytn/mindcraft)、Voyager 也都基于 mineflayer |
| 大模型 | DeepSeek（OpenAI 兼容接口 + function calling） | 让 NPC 会说话、会决定做什么 | 通义千问、Kimi、OpenAI、本地 Ollama —— 改 `.env` 里 3 行即可（模型需支持工具调用） |
| 寻路 | mineflayer-pathfinder | 给个目标点或跟随对象，自动算路线、绕障碍 | mineflayer 自带的 `setControlState` 手动控制前后左右（只适合很简单的场景） |
| Agent 循环 | 手写（`agentLoop.js`，几十行） | 大模型 ⇄ 工具 的来回 | LangChain.js / Vercel AI SDK 等框架（封装好了，但看不到原理） |
| 配置 | dotenv | 从 `.env` 读配置和密钥 | Node 自带的 `--env-file` |
| 测试服 | flying-squid（开发依赖） | 纯 Node 写的简易服务端，不用装 Java | 官方服务端 / Paper（需要 Java 21） |

---

## 2. 快速开始

需要 **Node.js 22**（mineflayer 官方要求；Node 20 实测也能跑）。

```bash
git clone https://github.com/xiaoye7777/mc-agent.git
cd mc-agent
npm install
cp .env.example .env     # 然后编辑 .env，至少填上 LLM_API_KEY
```

### 方式 A：不开游戏，用本地测试服调试（最快）

```bash
npm run test-server      # 终端 1：启动测试服（localhost:25565，版本 1.21.4）
npm start                # 终端 2：启动 NPC
npm run say -- "阿方 你好" "阿方 你会干什么？"   # 终端 3：模拟一个玩家说话
```

也可以用游戏客户端（1.21.4、离线账号）直接连 `localhost` 进去聊。

> ⚠️ 测试服有个 bug：不会发送玩家列表，NPC “看不见”任何玩家，所以「过来 / 跟着我」在测试服上只会回“看不到你”。**移动功能要在真实服务器上测**；测试服只适合测聊天和工具调用是否触发。

### 方式 B：进你们真正的世界

在 `.env` 里改 `MC_HOST` / `MC_PORT`，然后 `npm start`。按服务器类型选：

| 服务器 | 怎么设置 |
|---|---|
| 单人世界「对局域网开放」 | 游戏里开放后会显示端口号，填到 `MC_PORT`。**你自己必须是离线账号登录**（HMCL 的离线模式），否则 NPC 进不去 |
| 自己开的服务端 | `server.properties` 里设 `online-mode=false`，`MC_AUTH=offline` |
| 正版服 | `MC_AUTH=microsoft`，`MC_USERNAME` 填一个正版账号邮箱，首次启动按提示在浏览器登录 |

进服后在公屏说 **「阿方 你好」** 或 **「AgentBot 你好」**，或私聊 `/msg AgentBot 你好`。

想让它动：站在它附近（能看见的范围内）说 **「阿方 过来」「阿方 跟着我」「阿方 停下」**。

---

## 3. 目录结构

```
src/
  index.js            入口：读配置 → 启动机器人 → 进服后挂上能力
  config.js           所有配置（从 .env 读）
  bot.js              连接层：创建 mineflayer 机器人、断线自动重连
  logger.js           极简日志
  chat/
    chatHandler.js    聊天能力主流程
    agentLoop.js      Agent 循环：大模型 ⇄ 工具调用
    persona.js        人设提示词 + 世界状态描述   ← 改 NPC 性格改这里
    memory.js         每个玩家的对话记忆
    llm.js            调大模型（OpenAI 兼容接口，支持 tools）
  actions/
    index.js          动作注册表：所有动作在这登记，自动变成发给大模型的工具清单
    movement.js       移动动作：come_to_player / follow_player / stop_moving
scripts/
  test-server.cjs     本地测试服
  say.cjs             模拟玩家说话
```

## 4. 配置项（`.env`）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `MC_HOST` / `MC_PORT` | `localhost` / `25565` | 服务器地址 |
| `MC_USERNAME` | `AgentBot` | NPC 的游戏 ID |
| `MC_AUTH` | `offline` | `offline` 或 `microsoft` |
| `MC_VERSION` | 自动探测 | 探测失败时手填，如 `1.21.6` |
| `NPC_NAME` | `阿方` | 人设名字，喊它也会触发回复 |
| `CHAT_TRIGGER` | `mention` | `mention`：被点名/私聊才回；`all`：每句都回 |
| `CHAT_MEMORY_SIZE` | `12` | 每个玩家记住多少条消息 |
| `LLM_BASE_URL` | `https://api.deepseek.com` | 大模型接口地址 |
| `LLM_API_KEY` | 空 | 大模型密钥；不填也能进服，但只会回一句固定的话 |
| `LLM_MODEL` | `deepseek-chat` | 模型名 |

---

## 5. 怎么加新动作（最常见的扩展）

动作 = 一个对象 `{ name, description, parameters, run }`。写好后加进 `src/actions/index.js` 的 `allActions`，**聊天和 Agent 循环一行都不用改**，大模型自动就会用。

```js
// src/actions/inventory.js（示例：让 NPC 说出背包里有什么）
export const inventoryActions = [
  {
    name: 'check_inventory',                       // 工具名（英文、下划线）
    description: '查看自己背包里有什么。玩家问“你带了啥”时使用。', // 写清楚“什么时候用”，大模型靠这个判断
    parameters: { type: 'object', properties: {} }, // 参数的 JSON Schema，没有参数就留空
    run(bot) {                                     // 真正执行的代码，返回一句给大模型看的结果
      const items = bot.inventory.items().map((item) => `${item.name}×${item.count}`);
      return items.length ? items.join('、') : '背包是空的';
    },
  },
];
```

记得同步改 `persona.js` 里的“你会 / 你还不会”，否则大模型可能不敢用新工具。

## 6. 路线图（可以分工认领）

- [x] **动起来**：接 [mineflayer-pathfinder](https://github.com/PrismarineJS/mineflayer-pathfinder)，实现“跟我走 / 过来 / 停下”
- [x] **让大模型决定做什么**：function calling + Agent 循环（v0.2）
- [ ] **更多动作**：看背包、捡东西、给玩家物品、走到指定坐标（参考第 5 节）
- [ ] **安全的“改动世界”动作**：挖 / 放方块前要不要先问玩家确认？需要两人先商量规则
- [ ] **长期记忆**：`memory.js` 改为存文件 / SQLite，重启后还记得玩家
- [ ] **更多感知**：`persona.js` 的 `describeWorld` 加上附近的方块、生物、背包
- [ ] **兼容插件服聊天格式**：有些服务器聊天带称号前缀，需要用 `bot.addChatPattern` 适配

## 7. 协作约定

- `main` 保持随时能跑；新功能开分支（如 `feat/follow`），提 PR 让对方看一眼再合并
- `.env` 永远不提交（已在 `.gitignore`），新增配置记得同步改 `.env.example` 和上面的配置表
- 代码里用中文注释说明“做什么、为什么”
- 提交前至少用 `npm run test-server` + `npm run say` 跑一遍；动了移动相关代码，再到真实服务器上试一下

## 已知限制

- 测试服只支持到 1.21.4，没有生物、红石，而且看不到玩家，只适合测聊天和工具调用
- NPC 只能看见附近的玩家（服务器的实体同步范围内），离太远「过来」会回“看不到你”
- 跟随时不挖不放方块，碰到需要搭路才能过去的地方会卡住
- 公屏聊天只认原版格式 `<玩家名> 消息`，带前缀的插件服暂时识别不到
- 对话记忆在内存里，重启就清空
