# mc-agent

基于 [mineflayer](https://github.com/PrismarineJS/mineflayer) 的 Minecraft NPC Agent。

**当前版本（v0.3）**：NPC「阿方」能聊天，还能**听懂一句话、自己拆成几步做完**：

> 「阿方 帮我砍4个木头，砍完给我」→ 找树 → 走过去 → 砍 → 捡掉落物 → 走回来 → 把木头扔给你 → “4个橡木都给你了，收好哈”
>
> 「阿方 再砍3个木头，做一个工作台给我」→ 砍树 → 合成木板 → 合成工作台 → 送过来

干活的时候还能照常聊天（“你在干嘛？”“砍木头呢，3/10 了”），随时喊「停下」立刻停。饿了自己吃东西，僵尸贴脸会还手。

> **安全规则**（公网服是大家一起玩的）：只在玩家要求时才挖；只挖天然方块（原木、泥土、沙子、石头、矿石），木板、圆石、玻璃等建材一律不碰；原木还要确认是“长在树上的”（附近有天然树叶），用原木盖的房子不会被当成树砍；走路时不挖不搭；只打敌对怪物，不打玩家和动物。挖和打都可以在 `.env` 里一键关掉。

---

## 1. 全局图：它是怎么工作的

```
游戏服务器（你们的世界）
   ▲
   │  Minecraft 协议
   ▼
bot.js ──────────────── 连接 / 断线重连（mineflayer 负责“假装成一个玩家”）
   │  进服后挂上三层能力
   ▼
┌─ chat/  ─────────────── “大脑”：听玩家说话、收任务结果 → 问大模型 → 回复 / 下指令
│   chatHandler.js       两个触发源：玩家消息、后台任务结束
│   agentLoop.js         Agent 循环（ReAct）：大模型 ⇄ 工具，直到给出回复；还会检查“只说不做”
│   persona.js           人设 + 规矩 + 当前状态（血量、背包、在做什么）
│   memory.js / llm.js   每个玩家的对话记忆 / 调大模型 API
│
├─ actions/ ───────────── “手脚”：13 个工具，大模型通过 function calling 调用
│   taskManager.js       后台任务：耗时的动作在后台跑，聊天不卡；一次一个，可随时取消
│   perception.js        看周围、找方块、看背包（瞬间完成）
│   movement.js          过来、跟随、去坐标、停下
│   gathering.js         挖方块（白名单 + 真树检测）、捡掉落物
│   items.js             送东西、拿装备、合成
│   combat.js            打敌对怪物
│
└─ behaviors/ ─────────── “本能”：不用想就会做的反应
    survival.js          饿了吃东西、怪物贴脸还手、死了取消任务
```

### 一件多步骤的事是怎么做完的

```
玩家：「阿方 帮我砍4个木头，砍完给我」
  │
  ▼ 第 1 次思考（玩家消息触发）
大模型 → collect_block(log, 4)  ──> 后台任务开始，工具立刻返回“已开始”
大模型 → “好，这就去砍”          ──> 发到公屏
  │
  │   ……后台：找树 → 走过去 → 砍 → 捡，玩家这时说“你在干嘛”也能马上得到回复……
  │
  ▼ 第 2 次思考（任务结果触发）
【任务结果】挖了 4 个方块，背包新增 oak_log x4
大模型 → give_item(玩家, oak_log, 4) ──> 后台任务：走过去、扔给他
大模型 → “砍好了，这就给你送过去”
  │
  ▼ 第 3 次思考（任务结果触发）
【任务结果】已经把 oak_log x4 扔到玩家脚边
大模型 → “4个橡木都给你了，收好哈”
```

**关键点**：大模型自己不会动手，它只会“提要求”；真正动手的是 `actions/` 里的代码。耗时的动作在后台跑，干完把结果再喂给大模型，它就能接着规划下一步——这就是 Agent 的核心循环。

几个让它“靠谱”的小机制：

- **只说不做自检**：大模型偶尔回“这就去”却没调用工具。`agentLoop.js` 发现这种情况会提醒它一次，让它真的去做或改口
- **停下快速通道**：玩家说“停下 / 别跟了 / 算了”时，不等大模型思考（1~3 秒），先立刻停住
- **自动续做上限**：没有玩家插话时最多自动连做 6 步，防止失败后反复重试停不下来
- **够不着的方块记 10 分钟**：换个说法再叫它，也不会在同几个够不着的方块上原地打转

### 技术选型（以及可以替换成什么）

| 层 | 现在用的 | 作用 | 常见替代 |
|---|---|---|---|
| 游戏客户端 | mineflayer | 用代码模拟一个玩家：进服、聊天、移动、挖方块 | 写 Fabric/Forge 模组做真 NPC（要 Java）；参考项目 [mindcraft](https://github.com/kolbytn/mindcraft)、Voyager 也都基于 mineflayer |
| 大模型 | DeepSeek（OpenAI 兼容接口 + function calling） | 理解玩家的话、决定做什么、组织回复 | 通义千问、Kimi、OpenAI、本地 Ollama —— 改 `.env` 里 3 行即可（模型需支持工具调用） |
| 寻路 | mineflayer-pathfinder | 给个目标，自动算路线、绕障碍 | 手动 `setControlState` 控制前后左右（只适合很简单的场景） |
| Agent 循环 | 手写（`agentLoop.js` + `taskManager.js`） | 大模型 ⇄ 工具、后台任务、任务结果回流 | LangChain.js / Vercel AI SDK 等框架（封装好了，但看不到原理） |
| 配置 | dotenv | 从 `.env` 读配置和密钥 | Node 自带的 `--env-file` |
| 测试服 | Paper 1.21.6（`npm run test-server` 自动下载） | 和公网服同版本的真服务端，能测移动、砍树、打怪 | flying-squid（`npm run test-server:lite`，纯 Node，但看不见玩家、没有树） |

---

## 2. 快速开始

需要 **Node.js 22**（mineflayer 官方要求；Node 20 实测也能跑）。

```bash
git clone https://github.com/xiaoye7777/mc-agent.git
cd mc-agent
npm install
cp .env.example .env     # 然后编辑 .env，至少填上 LLM_API_KEY
```

### 方式 A：本地测试服（推荐，改了代码先在这测）

需要 Java 21 或更新（`brew install openjdk`）。

```bash
npm run test-server      # 终端 1：第一次会下载 Paper（约 50MB）并让你确认 Minecraft EULA
npm start                # 终端 2：启动 NPC（.env 里 MC_HOST=localhost、MC_PORT=25565）
```

然后用游戏客户端（1.21.6、离线账号）连 `localhost` 进去。在测试服终端里敲 `op 你的名字` 给自己管理员权限，就能用 `/time set day`、`/give`、`/summon zombie` 布置测试场景。

测试服的设置（`local-server/server.properties`，第一次启动时生成）：离线模式、简单难度、出生点不保护（NPC 能在出生点附近砍树）。存档在 `local-server/`，不进 git，删掉这个目录就是一个全新的世界。

> 只想测聊天、不想装 Java：`npm run test-server:lite` 起一个纯 Node 的简易服务端（1.21.4）。它看不见玩家、没有树和怪，只能测聊天。

### 方式 B：进你们真正的世界

在 `.env` 里改 `MC_HOST` / `MC_PORT`，然后 `npm start`。按服务器类型选：

| 服务器 | 怎么设置 |
|---|---|
| 单人世界「对局域网开放」 | 游戏里开放后会显示端口号，填到 `MC_PORT`。**你自己必须是离线账号登录**（HMCL 的离线模式），否则 NPC 进不去 |
| 自己开的服务端 | `server.properties` 里设 `online-mode=false`，`MC_AUTH=offline` |
| 正版服 | `MC_AUTH=microsoft`，`MC_USERNAME` 填一个正版账号邮箱，首次启动按提示在浏览器登录 |

## 3. 能对它说什么

在公屏说话时带上「阿方」或「AgentBot」，或者私聊 `/msg AgentBot ...`。不用背命令，正常说话就行，下面只是例子：

| 你说 | 它会 |
|---|---|
| 阿方 过来 / 跟着我 / 停下 | 走到你身边 / 一直跟着你 / 立刻停下手上所有事 |
| 阿方 去 100 64 -20 | 走到坐标 |
| 阿方 帮我砍点木头 / 挖点沙子 | 找到最近的天然方块，挖完捡起来，告诉你背包多了什么 |
| 阿方 砍5个木头给我 | 砍完自己走过来扔给你 |
| 阿方 给我做个工作台 / 做几根木棍 | 用背包里的材料合成（工具类要站在工作台旁边） |
| 阿方 有僵尸，帮我打 | 拿上最好的武器去打 |
| 阿方 把地上的东西捡起来 | 捡附近的掉落物 |
| 阿方 周围有什么 / 你背包里有啥 / 你在干嘛 | 看一眼再如实回答（干活时会说进度，比如 3/10） |

## 4. 目录结构

```
src/
  index.js              入口：读配置 → 准备三层能力 → 启动机器人
  config.js             所有配置（从 .env 读）
  bot.js                连接层：创建 mineflayer 机器人、断线自动重连
  logger.js             极简日志
  chat/
    chatHandler.js      “大脑”主流程：玩家消息 / 任务结果 → 思考 → 回复；“停下”快速通道
    agentLoop.js        Agent 循环：大模型 ⇄ 工具调用；“只说不做”自检
    persona.js          人设、做事方法、规矩 + 当前状态描述   ← 改 NPC 性格改这里
    memory.js           每个玩家的对话记忆
    llm.js              调大模型（OpenAI 兼容接口，支持 tools）
  actions/
    index.js            动作注册表：所有动作在这登记，自动变成工具清单
    taskManager.js      后台任务：开始 / 取消 / 进度 / 结果回流
    helpers.js          可取消的寻路和等待、按名字找方块/物品
    perception.js       look_around / find_block / check_inventory
    movement.js         come_to_player / follow_player / go_to / stop
    gathering.js        collect_block / pick_up_items（含安全白名单、真树检测）
    items.js            give_item / equip_item / craft_item
    combat.js           attack_mob
  behaviors/
    survival.js         本能：自动吃东西、贴脸还手、死亡处理
scripts/
  paper-server.sh       本地 Paper 测试服（npm run test-server）
  test-server.cjs       简易测试服（npm run test-server:lite）
  say.cjs               模拟玩家说话
```

## 5. 配置项（`.env`）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `MC_HOST` / `MC_PORT` | `localhost` / `25565` | 服务器地址 |
| `MC_USERNAME` | `AgentBot` | NPC 的游戏 ID |
| `MC_AUTH` | `offline` | `offline` 或 `microsoft` |
| `MC_VERSION` | 自动探测 | 探测失败时手填，如 `1.21.6` |
| `NPC_NAME` | `阿方` | 人设名字，喊它也会触发回复 |
| `CHAT_TRIGGER` | `mention` | `mention`：被点名/私聊才回；`all`：每句都回 |
| `CHAT_MEMORY_SIZE` | `12` | 每个玩家记住多少条消息 |
| `NPC_ALLOW_DIG` | `true` | 允许挖天然方块。`false` = 挖方块的工具直接不给大模型 |
| `NPC_ALLOW_COMBAT` | `true` | 允许打敌对怪物（含贴脸还手）。`false` = 完全不打 |
| `LLM_BASE_URL` | `https://api.deepseek.com` | 大模型接口地址 |
| `LLM_API_KEY` | 空 | 大模型密钥；不填也能进服，但只会回一句固定的话 |
| `LLM_MODEL` | `deepseek-chat` | 模型名 |

---

## 6. 怎么加新动作（最常见的扩展）

动作 = 一个对象 `{ name, description, parameters, run(ctx, args) }`。写好后加进 `src/actions/index.js` 的 `ACTION_GROUPS`，**聊天和 Agent 循环一行都不用改**，大模型自动就会用。

`ctx` 里有：`bot`（mineflayer 机器人）、`tasks`（后台任务）、`player`（谁让做的）、`isWhisper`、`options`（开关）。

**瞬间完成的动作**直接返回一句结果：

```js
{
  name: 'say_time',
  description: '告诉玩家现在游戏里几点。玩家问“几点了”时使用。', // 写清楚“什么时候用”，大模型靠这个判断
  parameters: { type: 'object', properties: {} },               // 参数的 JSON Schema
  run({ bot }) {
    const hour = (Math.floor(bot.time.timeOfDay / 1000) + 6) % 24;
    return `现在大约 ${hour} 点`;                                // 这句会交给大模型看
  },
}
```

**耗时的动作**放进后台任务，立刻返回“已开始”；干完的结果会自动交给大模型决定下一步：

```js
run({ bot, tasks, player, isWhisper }, { x, y, z }) {
  tasks.start({ label: `去 ${x} ${y} ${z}`, kind: 'move', owner: player, isWhisper, report: 'always' },
    async ({ signal, setProgress }) => {
      await goTo(bot, new goals.GoalNear(x, y, z, 1), { signal });  // signal：被“停下”时会中断
      return '到了';                                               // 抛错 = 失败，错误信息也会交给大模型
    });
  return '已出发';
}
```

写耗时动作的三条规矩：经常检查 `signal`（用 `helpers.js` 里的 `goTo` / `sleep` 会自动处理）；错误信息写中文、写清楚原因（大模型要拿它跟玩家解释）；会改动世界的动作先想清楚安全规则。

## 7. 路线图（可以分工认领）

- [x] **动起来**：寻路实现“过来 / 跟随 / 停下”（v0.2）
- [x] **让大模型决定做什么**：function calling + Agent 循环（v0.2）
- [x] **能干活**：后台任务、多步骤自动续做、挖方块 / 合成 / 送东西 / 打怪 / 本能反应（v0.3）
- [ ] **放方块 / 建造**：放工作台、搭简单的东西。需要两人先商量规则（比如只在玩家指定的位置放）
- [ ] **熔炉和箱子**：烧矿、把东西存进指定箱子
- [ ] **长期记忆**：`memory.js` 改为存文件 / SQLite，重启后还记得玩家和约定
- [ ] **技能库**：把常用的多步骤流程（做一套木制工具）沉淀成一个高级动作，少走几轮大模型
- [ ] **兼容插件服聊天格式**：有些服务器聊天带称号前缀，需要用 `bot.addChatPattern` 适配

## 8. 协作约定

- `main` 保持随时能跑；新功能开分支（如 `feat/furnace`），提 PR 让对方看一眼再合并
- `.env` 永远不提交（已在 `.gitignore`），新增配置记得同步改 `.env.example` 和上面的配置表
- 代码里用中文注释说明“做什么、为什么”
- 动了动作相关的代码，先在本地 Paper 测试服（`npm run test-server`）试一遍，再上公网服

## 已知限制

- NPC 只能看见附近的玩家（服务器的实体同步范围内，大约 48 格），离太远「过来」会回“看不到你”
- 走路时不挖不搭：需要搭路、挖洞才能过去的地方会说“过不去”；树太高够不着的原木会跳过
- 砍树只砍够得着的部分，高的树可能会留下树冠
- 合成工具需要附近已经有工作台（它不会自己放）
- 同一时间只做一件事；新任务会取消旧任务
- 公屏聊天只认原版格式 `<玩家名> 消息`，带前缀的插件服暂时识别不到
- 对话记忆在内存里，重启就清空
- 大模型偶尔会理解错，所有动作的结果都会如实回报；不放心的操作可以先用 `NPC_ALLOW_DIG=false` 关掉
