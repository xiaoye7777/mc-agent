// 游戏知识：那些“不能合成”的东西从哪来。能合成的东西直接查 minecraft-data 的配方，不用写在这里。
//
// 规划器（planner.js）拿到一个目标物品时，按这个顺序查：
//   1. 原木 → 去砍树
//   2. MINING  → 挖什么方块、至少要什么镐子
//   3. SMELTING → 用熔炉烧什么
//   4. MOB_DROPS → 打什么生物
//   5. 都不是 → 查合成配方
// 注意顺序：铁锭既能合成（用铁粒）也能烧（用粗铁），这里写了 SMELTING 就优先烧。

/** 挖矿：物品 ← 方块（至少要用什么镐子才会掉东西） */
export const MINING = {
  cobblestone: { blocks: ['stone', 'cobblestone'], tool: 'wooden_pickaxe' },
  cobbled_deepslate: { blocks: ['deepslate', 'cobbled_deepslate'], tool: 'wooden_pickaxe' },
  coal: { blocks: ['coal_ore', 'deepslate_coal_ore'], tool: 'wooden_pickaxe' },
  raw_iron: { blocks: ['iron_ore', 'deepslate_iron_ore'], tool: 'stone_pickaxe' },
  raw_copper: { blocks: ['copper_ore', 'deepslate_copper_ore'], tool: 'stone_pickaxe' },
  raw_gold: { blocks: ['gold_ore', 'deepslate_gold_ore'], tool: 'iron_pickaxe' },
  redstone: { blocks: ['redstone_ore', 'deepslate_redstone_ore'], tool: 'iron_pickaxe' },
  lapis_lazuli: { blocks: ['lapis_ore', 'deepslate_lapis_ore'], tool: 'stone_pickaxe' },
  // 钻石在 y=-58 附近最多，离地面 120 多格，所以搜索范围要大
  diamond: { blocks: ['diamond_ore', 'deepslate_diamond_ore'], tool: 'iron_pickaxe', searchDistance: 160 },
  obsidian: { blocks: ['obsidian'], tool: 'diamond_pickaxe' },
  dirt: { blocks: ['dirt', 'grass_block', 'coarse_dirt'], tool: null },
  sand: { blocks: ['sand'], tool: null },
  gravel: { blocks: ['gravel'], tool: null },
};

/** 冶炼：产物 ← 原料 */
export const SMELTING = {
  iron_ingot: 'raw_iron',
  copper_ingot: 'raw_copper',
  gold_ingot: 'raw_gold',
  cooked_beef: 'beef',
  cooked_porkchop: 'porkchop',
  cooked_mutton: 'mutton',
  cooked_chicken: 'chicken',
  cooked_rabbit: 'rabbit',
  glass: 'sand',
  stone: 'cobblestone',
};

/** 生物掉落：物品 ← 打哪些生物 */
export const MOB_DROPS = {
  beef: ['cow', 'mooshroom'],
  porkchop: ['pig'],
  mutton: ['sheep'],
  chicken: ['chicken'],
  rabbit: ['rabbit'],
  leather: ['cow'],
  feather: ['chicken'],
  string: ['spider'],
  bone: ['skeleton'],
  gunpowder: ['creeper'],
  ender_pearl: ['enderman'],
  blaze_rod: ['blaze'],
  white_wool: ['sheep'], // 打羊掉羊毛（彩色羊掉彩色羊毛，这里只认白色的，大部分羊是白的）
};

/** 食物：生肉 → 熟肉，以及每种熟肉能顶多少饱食度 */
export const MEAT = {
  cow: { raw: 'beef', cooked: 'cooked_beef' },
  mooshroom: { raw: 'beef', cooked: 'cooked_beef' },
  pig: { raw: 'porkchop', cooked: 'cooked_porkchop' },
  sheep: { raw: 'mutton', cooked: 'cooked_mutton' },
  chicken: { raw: 'chicken', cooked: 'cooked_chicken' },
  rabbit: { raw: 'rabbit', cooked: 'cooked_rabbit' },
};

/** 镐子从差到好。“至少石镐”= 石镐、铁镐、钻石镐、下界合金镐都行 */
export const PICKAXE_TIERS = ['wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe'];

/** 燃料：每个能烧几个东西 */
export const FUELS = { coal: 8, charcoal: 8, coal_block: 80, lava_bucket: 100, blaze_rod: 12 };
export const WOOD_FUEL_PER_ITEM = 1.5; // 木板、原木：每个烧 1.5 个

/**
 * 配方里同一个位置可以用好几种材料（各种木板、圆石/深板岩圆石/黑石），规划器要挑最省事的那种。
 * 这里给“不太好弄”的材料加权，权重越大越不想用。
 */
export const INGREDIENT_COST = {
  cobblestone: 1,
  cobbled_deepslate: 4, // 在地下深处才有
  blackstone: 20, // 下界才有
  bamboo_planks: 20,
  crimson_planks: 20,
  warped_planks: 20,
};
