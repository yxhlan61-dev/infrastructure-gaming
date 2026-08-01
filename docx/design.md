# 《城乡基建》程序设计文档

> 来源规则文件：`docx/rules.md`  
> 文档目的：将桌游/规则描述整理为可直接指导程序实现的需求、数据结构、流程、算法与判定标准。  
> 版本：v0.1（根据 2026-08-01 当前规则整理）

---

## 1. 游戏概述

### 1.1 游戏名称

城乡基建

### 1.2 游戏类型

多人回合制、网格地图、路径建设、随机事件、经营得分游戏。

### 1.3 核心目标

玩家扮演不同建筑公司，在 6×6 的城乡居民点地图中修建道路和桥梁，使 5 位商人能够从城市到乡村或从乡村到城市完成交易。商人会沿已建道路网络中的最短路径移动，并向经过路段、桥梁的所有者支付过路费。第 5 位商人完成交易后游戏结束，累计过路费最高者获胜；若过路费相同，则已建设道路数量更多者获胜。

---

## 2. 基础定义

### 2.1 坐标系统

地图由 6×6 个居民点组成，共 36 个点，并统一采用平面直角坐标系第一象限。

- 对外显示、规则说明和交互坐标一律使用 `(x, y)`：`x` 从左到右递增，`y` 从下到上递增。
- 左下角为 `(1,1)`，右上角为 `(6,6)`；因此城市起点 `(1,1)` 显示在地图左下，乡村锚点 `(6,6)` 显示在地图右上。
- 程序内部为兼容节点 ID `r{row}c{col}`，仍保存 `row`、`col` 两个字段：
  - `row` 对应纵坐标 `y`，取值 1~6，自下向上递增；
  - `col` 对应横坐标 `x`，取值 1~6，自左向右递增；
  - 显示或输入节点坐标时必须转换为 `(col, row)`，不得以 `(row, col)` 作为界面坐标。

### 2.2 居民点 Node

每个居民点包含：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 唯一标识，建议格式：`r{row}c{col}`（内部 ID，不改变对外 `(x,y)` 坐标顺序） |
| `row` | int | 内部行字段，对应纵坐标 `y`，1~6，自下向上递增 |
| `col` | int | 内部列字段，对应横坐标 `x`，1~6，自左向右递增 |
| `diceNumber` | int | 1~6 的点数编号 |
| `region` | enum | `CITY` 或 `COUNTRYSIDE` |

### 2.3 相邻居民点

两个居民点满足以下条件之一即为相邻：

- 行号相同，列号差为 1；
- 列号相同，行号差为 1。

即仅允许上下左右四邻接，不允许斜向相邻。

6×6 网格中理论相邻边数量为：

- 横向：6 行 × 5 条 = 30；
- 纵向：5 行 × 6 条 = 30；
- 总计：60 条相邻边。

### 2.4 边 Edge

相邻居民点之间的可建设连接称为边。

边是无向的，即 `(A,B)` 与 `(B,A)` 为同一条边。

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 边唯一标识，建议按两个端点 id 排序后拼接 |
| `nodeA` | NodeId | 端点 A |
| `nodeB` | NodeId | 端点 B |
| `isRiverCrossing` | bool | 是否跨越河流 |
| `bridgeOwnerId` | PlayerId/null | 若跨河边上已有桥梁，记录桥梁所有者 |
| `roadOwnerId` | PlayerId/null | 若边上已有道路，记录道路所有者 |
| `length` | number | 路段长度，默认 1 |

### 2.5 城市、乡村与河流

地图被一条河流分为两个区域：

- 城市区域：包含 `(1,1)` 及其附近居民点；
- 乡村区域：包含 `(6,6)` 及其附近居民点；
- 两个区域均为单连通区域；
- 城市、乡村居民点数量各在 10~26 个之间；
- 河流不经过居民点，只位于相邻居民点之间；
- 河流从地图四条边中的一条流入，从另一处流出，具体位置每局随机。

程序实现上建议将河流抽象为：

> 一组 `isRiverCrossing = true` 的相邻边，这些边连接城市居民点和乡村居民点。所有城市点构成一个连通子图，所有乡村点构成一个连通子图。

即：

- 若边两端点 `region` 不同，则此边为跨河边；
- 跨河边默认不能直接修路；
- 玩家必须先在该跨河边上拥有自己的桥梁，才能在该边上修建自己的道路。

---

## 3. 玩家与资源

### 3.1 玩家 Player

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string/int | 玩家唯一标识 |
| `name` | string | 玩家名称 |
| `tollMoney` | int | 累计过路费，初始为 0 |
| `roadsBuiltCount` | int | 当前已拥有道路数量，用于平分判胜 |
| `bridgesBuiltCount` | int | 当前已拥有桥梁数量，非直接胜利条件 |
| `isAI` | bool | 是否为 AI 玩家，便于扩展 |

### 3.2 道路 Road

道路附着于一条 Edge。

规则：

- 一条边最多只能有一条道路；
- 道路有唯一所有者；
- 非跨河边可直接修路；
- 跨河边必须先存在当前玩家自己的桥梁，才能修该玩家自己的路；
- 玩家不能借用其他玩家的桥梁修路；
- 若边上已有道路，不可重复修路。

### 3.3 桥梁 Bridge

桥梁也附着于一条跨河 Edge。

规则：

- 只有跨河边可以修桥；
- 一条跨河边最多只能有一座桥梁；
- 桥梁有唯一所有者；
- 仅有桥梁不可通行；
- 必须在该桥梁所在边继续修建道路后，商人才可通行；
- 桥梁所有者和道路所有者在规则约束下应相同，因为只有拥有该桥梁的玩家可以在其上修路。

---

## 4. 地图生成设计

### 4.1 生成目标

每局开局自动生成：

1. 6×6 居民点；
2. 城市/乡村区域划分；
3. 河流跨越边集合；
4. 每个居民点的骰子点数编号。

### 4.2 地图合法性条件

地图必须满足：

1. 总居民点数为 36；
2. `(1,1)` 属于城市；
3. `(6,6)` 属于乡村；
4. 城市点数在 10~26；
5. 乡村点数在 10~26；
6. 城市区域内部按四邻接连通；
7. 乡村区域内部按四邻接连通；
8. 至少存在一条跨河边；
9. 河流不经过居民点；
10. 所有跨河边构成城市与乡村的边界。

### 4.3 推荐地图生成算法

#### 方案 A：随机区域扩张法（推荐实现简单）

1. 初始化 36 个点，全部未分配区域；
2. 将 `(1,1)` 标记为 `CITY`；
3. 将 `(6,6)` 标记为 `COUNTRYSIDE`；
4. 随机选择目标城市数量 `citySize`，范围 10~26；
5. 乡村数量自动为 `36 - citySize`，同样必然在 10~26；
6. 从 `(1,1)` 开始随机扩张城市区域，直到城市数量达到 `citySize`；
7. 其余点标记为乡村；
8. 校验乡村区域是否连通且包含 `(6,6)`；
9. 若不合法，重新生成；
10. 对所有相邻边：若两端区域不同，则标记为 `isRiverCrossing = true`。

#### 方案 A 伪代码

```pseudo
function generateMap():
    repeat:
        nodes = create6x6Nodes()
        citySize = randomInt(10, 26)
        citySet = {(1,1)}

        while size(citySet) < citySize:
            frontier = all unassigned neighbors of citySet
            if frontier is empty:
                break and retry
            chosen = randomChoice(frontier)
            add chosen to citySet

        countrysideSet = allNodes - citySet

        if (6,6) not in countrysideSet:
            continue
        if !isConnected(citySet):
            continue
        if !isConnected(countrysideSet):
            continue

        assign regions
        edges = createAllAdjacentEdges(nodes)
        for edge in edges:
            edge.isRiverCrossing = edge.nodeA.region != edge.nodeB.region

        if count(riverEdges) == 0:
            continue

        return map
```

> 注：该方案保证城市和乡村单连通，河流以跨区域边界形式存在。若未来需要视觉上更像“一条弯曲河流”，可基于 `riverEdges` 绘制连续曲线。

### 4.4 居民点点数分配

规则：

- 每个居民点分配一个 1~6 的数字；
- 每个数字恰好对应 6 个居民点；
- 总数为 36。

推荐算法：

```pseudo
numbers = [1,1,1,1,1,1,
           2,2,2,2,2,2,
           3,3,3,3,3,3,
           4,4,4,4,4,4,
           5,5,5,5,5,5,
           6,6,6,6,6,6]
shuffle(numbers)
for i in 0..35:
    nodes[i].diceNumber = numbers[i]
```

---

## 5. 游戏初始化流程

### 5.1 输入参数

| 参数 | 类型 | 说明 |
|---|---|---|
| `playerCount` | int | 玩家数量，建议支持 2~4 |
| `playerNames` | string[] | 玩家名称 |
| `randomSeed` | string/int/null | 可选，用于复现局面 |

### 5.2 初始化步骤

1. 创建玩家，所有玩家过路费为 0；
2. 生成地图；
3. 分配居民点点数；
4. 设置当前玩家为第 1 位玩家；
5. 进入“开局预建设阶段”；
6. 所有玩家按顺序各修建一条初始道路；
7. 生成并展示第 1 位商人；
8. 进入正式玩家回合循环。

### 5.3 开局预建设阶段

规则：每个玩家分别先修建一条道路。

程序判定：

- 初始阶段玩家可从所有合法可修路边中选择一条；
- 由于初始没有桥梁，跨河边通常不可选；
- 只能选择非跨河、无道路的边；
- 修建后该边 `roadOwnerId = currentPlayer.id`。

---

## 6. 回合流程设计

### 6.1 正式回合概述

每名玩家在自己回合开始时先掷第一枚骰子，得到 `die1`。随后选择以下三种行动之一：

1. 抽取一张建设卡并立即执行；
2. 根据 `die1` 选择一个对应数字的居民点作为临时施工基地，以基地为一端修建任意一条道路；
3. 根据 `die1` 选择一个对应数字的居民点作为临时施工基地，然后掷第二枚骰子，并根据结果可能修建道路/桥梁与抽卡。

### 6.2 回合状态机

建议用显式状态机实现：

| 状态 | 说明 |
|---|---|
| `TURN_START` | 当前玩家回合开始 |
| `ROLL_DIE_1` | 掷第一枚骰子 |
| `CHOOSE_MAIN_ACTION` | 玩家选择三种行动之一 |
| `DRAW_AND_RESOLVE_CARD` | 抽建设卡并执行 |
| `SELECT_BASE_FOR_FREE_ROAD` | 行动 2：选择临时基地 |
| `BUILD_ROAD_FROM_BASE` | 行动 2：以基地为端点修路 |
| `SELECT_BASE_FOR_DIE_2` | 行动 3：选择临时基地 |
| `ROLL_DIE_2` | 掷第二枚骰子 |
| `RESOLVE_DIE_2_ADJACENT_BUILD` | 尝试在基地与匹配点数相邻点之间修路或桥梁 |
| `RESOLVE_DOUBLE_CARD` | 若 `die2 == die1`，抽卡执行 |
| `CHECK_MERCHANT_COMPLETION` | 检查当前商人是否可达并完成交易 |
| `TURN_END` | 回合结束，切换玩家 |
| `GAME_END` | 第 5 位商人完成交易，结算胜负 |

### 6.3 行动 1：抽建设卡

流程：

1. 当前玩家抽取一张建设卡；
2. 按卡牌类型立即执行效果；
3. 执行后检查当前商人是否可完成交易；
4. 回合结束。

### 6.4 行动 2：按第一骰修任意相邻道路

流程：

1. 玩家从所有 `diceNumber == die1` 的居民点中选择一个作为临时施工基地；
2. 玩家选择一条以该基地为端点的相邻边；
3. 若该边满足修路条件，则修建道路；
4. 若无合法边可修，应提示玩家重新选择基地或结束该行动无效果；
5. 执行后检查当前商人是否可完成交易；
6. 回合结束。

合法边条件见第 7 章。

### 6.5 行动 3：按第一骰选基地，再按第二骰限定邻点

流程：

1. 玩家从所有 `diceNumber == die1` 的居民点中选择一个作为临时施工基地 `base`；
2. 掷第二枚骰子，得到 `die2`；
3. 查找 `base` 的所有相邻居民点，筛选 `diceNumber == die2` 的居民点；
4. 若存在至少一个匹配邻点：
   - 玩家可选择其中一个邻点；
   - 若 `base` 与该邻点之间为非跨河边，可尝试修路；
   - 若为跨河边：
     - 若该边还没有桥梁，玩家可以修建桥梁；
     - 若该边已有当前玩家自己的桥梁但还没有道路，玩家可以修建道路；
     - 若该边已有其他玩家桥梁或已有道路，则不可建设；
5. 若不存在匹配邻点，则本步骤无建设效果；
6. 若 `die2 == die1`，抽取一张建设卡并立即执行；
7. 检查当前商人是否可完成交易；
8. 回合结束。

> 设计解释：原规则写作“可以在基地和该居民点之间修建一条道路或桥梁”。因此行动 3 是唯一显式允许“修桥”的常规行动。若目标边跨河且无桥，则修桥；若已有自己的桥，则可修路。非跨河边只能修路。

---

## 7. 建设合法性规则

### 7.1 通用判断函数

建议实现以下核心函数：

```pseudo
canBuildRoad(playerId, edgeId) -> boolean
canBuildBridge(playerId, edgeId) -> boolean
buildRoad(playerId, edgeId) -> BuildResult
buildBridge(playerId, edgeId) -> BuildResult
```

### 7.2 修路条件 canBuildRoad

可以修路当且仅当：

1. 边存在，且连接两个相邻居民点；
2. `edge.roadOwnerId == null`；
3. 若 `edge.isRiverCrossing == false`，允许修路；
4. 若 `edge.isRiverCrossing == true`，必须满足：
   - `edge.bridgeOwnerId == playerId`；
   - 不能使用其他玩家桥梁；
5. 满足以上条件返回 true。

伪代码：

```pseudo
function canBuildRoad(playerId, edge):
    if edge.roadOwnerId != null:
        return false
    if !edge.isRiverCrossing:
        return true
    return edge.bridgeOwnerId == playerId
```

### 7.3 修桥条件 canBuildBridge

可以修桥当且仅当：

1. 边存在，且连接两个相邻居民点；
2. `edge.isRiverCrossing == true`；
3. `edge.bridgeOwnerId == null`；
4. 通常要求 `edge.roadOwnerId == null`，因为无桥不能先有跨河道路；
5. 满足以上条件返回 true。

伪代码：

```pseudo
function canBuildBridge(playerId, edge):
    return edge.isRiverCrossing
       and edge.bridgeOwnerId == null
       and edge.roadOwnerId == null
```

### 7.4 道路拆除

拆路修桥卡会拆除当前玩家的一条路。

规则：

- 只能拆自己的道路；
- 拆除后 `edge.roadOwnerId = null`；
- 若被拆道路位于桥梁上，桥梁保留；
- 拆除道路会使该边不可通行；
- 玩家道路数量减少 1；
- 已经获得的历史过路费不回退。

---

## 8. 建设卡系统

### 8.1 卡牌类型与概率

建设卡不是实体牌堆，而是每次按概率随机抽取。

| 卡牌 | 概率 | 概率权重 | 效果 |
|---|---:|---:|---|
| 随机修路卡 | 2/5 | 2 | 系统随机找到两个相邻居民点，如果符合修路条件则修建道路 |
| 桥梁通路卡 | 1/5 | 1 | 将自己还未修路的一座桥梁修好路 |
| 拆路修桥卡 | 1/5 | 1 | 将自己的一条路拆掉作为原材料，在地图任意位置修建一座桥梁 |
| 资金补贴卡 | 1/5 | 1 | 直接获得 1$ 过路费 |

推荐实现：

```pseudo
function drawCard():
    r = randomInt(1, 5)
    if r in [1,2]: return RANDOM_ROAD
    if r == 3: return BRIDGE_TO_ROAD
    if r == 4: return REMOVE_ROAD_BUILD_BRIDGE
    if r == 5: return SUBSIDY
```

### 8.2 随机修路卡

效果：系统随机找到两个相邻居民点，如果符合修路条件则可以修建道路。

程序流程建议：

1. 在 60 条相邻边中等概率随机选择 1 条边；
2. 判断当前玩家是否可以在该边修路；
3. 若可以，立即修路；
4. 若不可以，卡牌无效果。

> 可选增强：为降低“空卡”体验，也可改为从所有当前可修路边中随机选择。但这会改变原规则“随机找到两个相邻居民点，如果符合”的含义。默认按“先随机边，再判定”实现。

### 8.3 桥梁通路卡

效果：将自己还未修路的一座桥梁修好路。

合法对象：

- `edge.bridgeOwnerId == currentPlayer.id`；
- `edge.roadOwnerId == null`。

流程：

1. 查找当前玩家所有“有桥无路”的边；
2. 若为空，卡牌无效果；
3. 若存在：
   - 可由玩家选择其中一座桥梁；
   - 或系统随机选择一座，需在 UI/规则中保持一致；
4. 在该边修建道路。

推荐实现：玩家选择目标桥梁，若是 AI 玩家则随机或按策略选择。

### 8.4 拆路修桥卡

效果：将自己的一条路拆掉作为原材料，在地图任意位置修建一座桥梁。

流程：

1. 查找当前玩家所有道路；
2. 查找所有可修桥边；
3. 若玩家没有道路，或地图上没有可修桥边，则卡牌无效果；
4. 玩家选择自己一条道路进行拆除；
5. 玩家选择任意一条可修桥的跨河边；
6. 执行：
   - 被拆道路 `roadOwnerId = null`；
   - 目标桥边 `bridgeOwnerId = currentPlayer.id`；
7. 若拆除的是跨河桥上道路，则原桥梁保留。

注意：

- “任意位置修建桥梁”仍应限制为跨河边；
- 不能在已有桥梁的跨河边重复修桥；
- 桥梁建成后不能立即通行，除非之后再修路。

### 8.5 资金补贴卡

效果：当前玩家 `tollMoney += 1`。

这笔钱视为过路费/收入，计入最终胜负。

---

## 9. 商人系统

### 9.1 商人数量

每局固定出现 5 位商人。

| 序号 | 类型 | 起点终点 |
|---:|---|---|
| 1 | 小商人 | 随机，一个城市点、一个乡村点 |
| 2 | 小商人 | 随机，一个城市点、一个乡村点 |
| 3 | 小商人 | 随机，一个城市点、一个乡村点 |
| 4 | 大商人 | 随机，一个城市点、一个乡村点 |
| 5 | 大商人 | 固定从 `(6,6)` 到 `(1,1)` |

### 9.2 小商人生成规则

前 3 位小商人登场时，系统随机分配并展示起点、终点：

- 起点和终点分别位于城市、乡村；
- 两点不能相同；
- 不固定方向：随机决定城市 → 乡村或乡村 → 城市；
- 再分别随机选择对应区域居民点。

### 9.3 第 4 位大商人生成规则

第 4 位为大商人，路线纯随机生成：

- 起点和终点分别位于城市、乡村；
- 不固定方向：随机决定城市 → 乡村或乡村 → 城市；
- 分别从对应区域随机选择居民点；
- 类型：`BIG`；
- 过路费为小商人的 2 倍。

因此，第 4 位大商人可能偶然抽到 `(6,6) → (1,1)`，但该路线不是固定路线。

### 9.4 第 5 位大商人生成规则

第 5 位大商人使用固定路线：

- 起点：`(6,6)`；
- 终点：`(1,1)`；
- 类型：`BIG`；
- 过路费为小商人的 2 倍。

### 9.5 商人登场与完成

流程：

1. 游戏正式开始后，第 1 位商人登场；
2. 每次玩家完成建设操作后，系统检查当前商人起终点之间是否存在可通行路径；
3. 若不存在路径，游戏继续；
4. 若存在路径：
   - 商人选择最短路径完成交易；
   - 若存在多条最短路径，随机选择一条；
   - 按路径经过的道路/桥梁支付过路费；
   - 当前商人完成并离场；
   - 若已完成第 5 位商人，游戏结束；
   - 否则生成并展示下一位商人。

### 9.6 可通行边

商人只能沿有道路的边移动。

边可通行条件：

```pseudo
edge.roadOwnerId != null
```

说明：

- 非跨河边有道路即可通行；
- 跨河边必须同时存在桥梁和道路，但由于修路规则保证跨河道路只能建立在自己桥梁上，所以判定 `roadOwnerId != null` 通常足够；
- 为健壮性，也可额外校验：若 `edge.isRiverCrossing == true`，则 `bridgeOwnerId != null`。

### 9.7 最短路径算法

当前所有边长度默认为 1，因此推荐使用 BFS 查找最短路径。

若未来引入不同边长，则改用 Dijkstra。

#### 多条最短路径随机选择

需要满足：如果存在多条最短路径，应随机选一条。

推荐实现方法：

1. 用 BFS 计算从起点到所有点的最短距离 `distFromStart`；
2. 若终点不可达，则无路径；
3. 从终点反向回溯：
   - 当前点为 `current`；
   - 候选前驱为所有满足 `distFromStart[neighbor] == distFromStart[current] - 1` 且边可通行的邻点；
   - 从候选前驱中随机选择一个；
   - 重复直到回到起点；
4. 反转路径，即得到一条随机最短路径。

> 注意：该方法不会严格保证“所有最短路径等概率”。如需严格等概率，需要在 BFS 后计算每个点到终点的最短路径数量，并按路径数量加权选择下一步。初版可接受“在最短路径集合中随机产生一条”。

#### 严格等概率最短路径选择（可选）

1. BFS 计算距离；
2. 构建最短路径 DAG；
3. 动态规划计算每个节点到终点的最短路径条数；
4. 从起点开始，按子路径数量加权随机选择下一节点。

### 9.8 过路费计算

#### 小商人

小商人沿路径每经过一条边：

- 道路主人获得：`edge.length × 1$`；
- 如果该边为跨河边且有桥梁，桥梁主人额外获得：`edge.length × 4$`。

由于默认 `length = 1`：

- 普通道路：道路主人 +1；
- 桥上道路：道路主人 +1，桥梁主人额外 +4；
- 若桥梁主人与道路主人相同，则同一玩家该边合计 +5。

#### 大商人

大商人所有过路费均为小商人的 2 倍：

- 道路费：`edge.length × 2$`；
- 桥梁额外费：`edge.length × 8$`；
- 桥上道路同一玩家拥有时合计 +10。

#### 计算伪代码

```pseudo
function payTolls(merchant, pathEdges):
    multiplier = merchant.type == BIG ? 2 : 1

    for edge in pathEdges:
        roadOwner = edge.roadOwnerId
        players[roadOwner].tollMoney += edge.length * 1 * multiplier

        if edge.isRiverCrossing and edge.bridgeOwnerId != null:
            bridgeOwner = edge.bridgeOwnerId
            players[bridgeOwner].tollMoney += edge.length * 4 * multiplier
```

---

## 10. 胜负结算

### 10.1 结束条件

当第 5 位商人完成交易后，游戏立即结束。

### 10.2 排名规则

1. `tollMoney` 高者胜；
2. 若 `tollMoney` 相同，则 `roadsBuiltCount` 高者胜；
3. 若仍相同，则并列胜利。


默认推荐：并列胜利，避免引入规则未声明优势。

### 10.3 道路数量统计

用于平分判胜的“建设道路多”解释为游戏结束时仍存在的道路数量，而非历史累计建设次数。

原因：拆路修桥卡会拆除道路。如果使用历史累计次数，拆路不会影响道路数量，但“建设道路多”更自然对应当前拥有道路数。程序中使用 `roadsBuiltCount = 当前 roadOwnerId == playerId 的边数量` 最稳妥。

---

## 11. 主要数据模型建议

以下为面向 TypeScript/JavaScript 的示例接口，也可映射到其他语言。

```ts
type PlayerId = string;
type NodeId = string;
type EdgeId = string;

type Region = 'CITY' | 'COUNTRYSIDE';
type MerchantType = 'SMALL' | 'BIG';
type GamePhase =
  | 'INIT'
  | 'PRE_BUILD'
  | 'MERCHANT_ACTIVE'
  | 'PLAYER_TURN'
  | 'GAME_END';

type CardType =
  | 'RANDOM_ROAD'
  | 'BRIDGE_TO_ROAD'
  | 'REMOVE_ROAD_BUILD_BRIDGE'
  | 'SUBSIDY';

interface Node {
  id: NodeId;
  row: number;
  col: number;
  diceNumber: number;
  region: Region;
}

interface Edge {
  id: EdgeId;
  nodeA: NodeId;
  nodeB: NodeId;
  isRiverCrossing: boolean;
  bridgeOwnerId: PlayerId | null;
  roadOwnerId: PlayerId | null;
  length: number;
}

interface Player {
  id: PlayerId;
  name: string;
  tollMoney: number;
  isAI: boolean;
}

interface Merchant {
  index: number; // 1~5
  type: MerchantType;
  startNodeId: NodeId;
  endNodeId: NodeId;
  completed: boolean;
  chosenPathEdgeIds?: EdgeId[];
}

interface GameState {
  phase: GamePhase;
  nodes: Record<NodeId, Node>;
  edges: Record<EdgeId, Edge>;
  players: Record<PlayerId, Player>;
  playerOrder: PlayerId[];
  currentPlayerIndex: number;
  currentMerchant: Merchant | null;
  completedMerchants: Merchant[];
  turnNumber: number;
  randomSeed?: string | number;
  lastDie1?: number;
  lastDie2?: number;
  log: GameLogEntry[];
}

interface GameLogEntry {
  id: string;
  turnNumber: number;
  playerId?: PlayerId;
  type: string;
  message: string;
  payload?: unknown;
}
```

### 11.1 派生统计函数

不要长期手动维护易错统计值，建议使用函数从 `edges` 派生：

```ts
function getPlayerRoadCount(state, playerId): number {
  return Object.values(state.edges).filter(e => e.roadOwnerId === playerId).length;
}

function getPlayerBridgeCount(state, playerId): number {
  return Object.values(state.edges).filter(e => e.bridgeOwnerId === playerId).length;
}
```

---

## 12. 核心服务/模块划分

### 12.1 `RandomService`

职责：

- 掷骰子；
- 洗牌/随机选择；
- 抽建设卡；
- 支持随机种子以复现游戏。

接口示例：

```ts
rollDie(): number // 1~6
choice<T>(items: T[]): T
shuffle<T>(items: T[]): T[]
weightedChoice<T>(items: { value: T; weight: number }[]): T
```

### 12.2 `MapGenerator`

职责：

- 创建 6×6 节点；
- 生成城市/乡村区域；
- 标记河流跨越边；
- 分配点数；
- 校验地图合法性。

### 12.3 `BuildService`

职责：

- 判断能否修路/修桥；
- 执行修路/修桥/拆路；
- 提供当前可建设目标列表。

关键接口：

```ts
getBuildableRoadEdges(state, playerId): Edge[]
getBuildableBridgeEdges(state, playerId): Edge[]
getBuildableRoadEdgesFromBase(state, playerId, baseNodeId): Edge[]
canBuildRoad(state, playerId, edgeId): boolean
canBuildBridge(state, playerId, edgeId): boolean
buildRoad(state, playerId, edgeId): GameState
buildBridge(state, playerId, edgeId): GameState
removeRoad(state, playerId, edgeId): GameState
```

### 12.4 `CardService`

职责：

- 抽卡；
- 执行卡牌效果；
- 返回卡牌执行结果。

### 12.5 `MerchantService`

职责：

- 生成商人；
- 查找当前可通行最短路径；
- 随机选择最短路径；
- 计算并发放过路费；
- 推进到下一位商人或结束游戏。

### 12.6 `TurnService`

职责：

- 管理玩家回合状态；
- 掷骰；
- 处理玩家行动选择；
- 调用建设、卡牌、商人模块；
- 切换当前玩家。

### 12.7 `GameController` / `GameEngine`

职责：

- 对 UI 或 API 暴露统一操作入口；
- 保证所有操作遵守当前阶段和状态机；
- 记录日志；
- 返回可供前端渲染的状态快照。

---

## 13. 用户交互与 UI 需求

### 13.1 地图显示

需要显示：

- 6×6 居民点；
- 每个居民点的点数编号；
- 城市/乡村区域差异；
- 河流位置；
- 道路归属；
- 桥梁归属；
- 当前商人起点、终点；
- 当前玩家。

### 13.2 玩家行动 UI

在玩家回合中：

1. 显示第一骰结果；
2. 显示三种可选行动；
3. 对于行动 2/3：
   - 高亮可选基地，即 `diceNumber == die1` 的点；
   - 选中基地后，高亮可建设或可尝试建设的边；
4. 对于行动 3：
   - 显示第二骰结果；
   - 高亮满足第二骰点数的相邻点；
5. 抽卡时显示卡牌类型与执行结果；
6. 商人完成交易时显示路径与收益明细。

### 13.3 颜色建议

- 城市区域：浅蓝/灰蓝；
- 乡村区域：浅绿；
- 河流：蓝色曲线或蓝色边界；
- 玩家道路：按玩家颜色绘制实线；
- 桥梁：按玩家颜色绘制粗短线或桥形图标；
- 当前商人起点：黄色标记；
- 当前商人终点：橙色标记；
- 商人路径：发光或动画高亮。

---

## 14. API/操作设计示例

若实现为前后端分离或本地状态机，可暴露以下操作。

### 14.1 创建游戏

```ts
createGame(input: {
  players: { name: string; isAI?: boolean }[];
  seed?: string | number;
}): GameState
```

### 14.2 开局修路

```ts
preBuildRoad(input: {
  playerId: PlayerId;
  edgeId: EdgeId;
}): GameState
```

校验：

- 当前阶段必须为 `PRE_BUILD`；
- 必须轮到该玩家；
- 目标边必须可修路；
- 初始无桥时跨河边通常不可修。

### 14.3 开始正式回合 / 掷第一骰

```ts
startTurn(): {
  state: GameState;
  die1: number;
  selectableBaseNodeIds: NodeId[];
}
```

### 14.4 行动 1：抽卡

```ts
chooseDrawCardAction(input: {
  playerId: PlayerId;
  cardChoices?: unknown;
}): GameState
```

### 14.5 行动 2：从基地修路

```ts
chooseBuildFromBaseAction(input: {
  playerId: PlayerId;
  baseNodeId: NodeId;
  edgeId: EdgeId;
}): GameState
```

校验：

- `baseNodeId.diceNumber == lastDie1`；
- `edgeId` 必须以 `baseNodeId` 为端点；
- `canBuildRoad(playerId, edgeId) == true`。

### 14.6 行动 3：第二骰建设

```ts
chooseSecondDieAction(input: {
  playerId: PlayerId;
  baseNodeId: NodeId;
}): {
  state: GameState;
  die2: number;
  candidateNeighborNodeIds: NodeId[];
}

resolveSecondDieBuild(input: {
  playerId: PlayerId;
  baseNodeId: NodeId;
  targetNodeId?: NodeId;
  buildType?: 'ROAD' | 'BRIDGE';
}): GameState
```

校验：

- `baseNodeId.diceNumber == lastDie1`；
- `targetNodeId` 必须与 `baseNodeId` 相邻；
- `targetNodeId.diceNumber == lastDie2`；
- 若 `buildType == ROAD`，必须满足 `canBuildRoad`；
- 若 `buildType == BRIDGE`，必须满足 `canBuildBridge`。

### 14.7 卡牌补充选择

部分卡牌需要玩家选择目标，例如“桥梁通路卡”“拆路修桥卡”。可设计为两阶段：

```ts
resolveCard(input: {
  playerId: PlayerId;
  cardType: CardType;
  selectedRoadToRemove?: EdgeId;
  selectedBridgeEdge?: EdgeId;
  selectedBridgeToRoadEdge?: EdgeId;
}): GameState
```

---

## 15. 关键规则边界情况

### 15.1 没有合法操作

可能出现：

- 行动 2 中某个基地周围没有可修路边；
- 行动 3 中没有匹配第二骰的相邻点；
- 抽到卡牌但没有合法目标。

处理建议：

- 若玩家尚可重新选择基地，应允许重新选择；
- 若该行动已不可产生效果，则记录日志“无合法目标，行动无效果”；
- 回合照常结束。

### 15.2 已有桥但无路

- 商人不能通行；
- 桥梁通路卡可以将其修成道路；
- 当前桥梁所有者也可通过普通修路规则在该边修路；
- 其他玩家不能使用该桥梁修路。

### 15.3 跨河边已有他人桥梁

- 其他玩家不能在此边修路；
- 其他玩家也不能再修桥；
- 此边被该桥梁所有者控制，直到其修路或规则扩展允许拆桥。

当前规则没有拆桥机制。

### 15.4 随机修路卡抽到跨河边

- 若当前玩家已在该跨河边拥有桥梁且该边无道路，则可以修路；
- 否则无效果。

### 15.5 拆除桥上道路

- 桥梁保留；
- 道路消失；
- 商人不可通行该边；
- 桥梁所有者之后仍可重新修路。

### 15.6 商人路径经过不同玩家道路

逐边结算，不要求路径全属于同一玩家。

### 15.7 商人完成后是否立即检查下一个商人

新商人登场后不立即自动连锁完成，而是在下一次玩家行动结束后检查。


---

## 16. 游戏日志需求

建议记录所有影响状态的事件，以便调试、回放和 UI 展示。

日志类型示例：

- `GAME_CREATED`
- `MAP_GENERATED`
- `DICE_ROLLED`
- `ACTION_SELECTED`
- `ROAD_BUILT`
- `BRIDGE_BUILT`
- `ROAD_REMOVED`
- `CARD_DRAWN`
- `CARD_RESOLVED`
- `MERCHANT_SPAWNED`
- `MERCHANT_COMPLETED`
- `TOLL_PAID`
- `TURN_ENDED`
- `GAME_ENDED`

日志示例：

```json
{
  "type": "ROAD_BUILT",
  "turnNumber": 7,
  "playerId": "P1",
  "message": "玩家 P1 在 r2c3-r2c4 修建道路",
  "payload": {
    "edgeId": "r2c3__r2c4"
  }
}
```

---

## 17. 测试用例建议

### 17.1 地图生成测试

1. 生成 10000 张地图，均满足：
   - 城市点数 10~26；
   - 乡村点数 10~26；
   - `(1,1)` 城市；
   - `(6,6)` 乡村；
   - 双区域连通；
   - 存在跨河边。
2. 每个点数 1~6 恰好出现 6 次。

### 17.2 建设规则测试

1. 非跨河空边可修路；
2. 已有道路的边不可再修路；
3. 跨河无桥不可修路；
4. 跨河有自己桥可修路；
5. 跨河有他人桥不可修路；
6. 非跨河边不可修桥；
7. 跨河已有桥不可重复修桥。

### 17.3 卡牌测试

1. 随机修路卡抽到合法边时修路成功；
2. 随机修路卡抽到非法边时无效果；
3. 桥梁通路卡只能作用于自己的有桥无路边；
4. 拆路修桥卡在无自有道路时无效果；
5. 拆路修桥卡不能在非跨河边修桥；
6. 资金补贴卡增加 1$。

### 17.4 商人路径测试

1. 无道路连接时商人不完成；
2. 有道路连接时商人完成；
3. 商人选择最短路径；
4. 多条最短路径时能随机选取；
5. 桥梁无路时不可通行；
6. 桥上道路正确支付道路费和桥梁费；
7. 大商人费用为小商人 2 倍。

### 17.5 胜负测试

1. 第 5 位商人完成后游戏结束；
2. 过路费高者胜；
3. 过路费相同，道路数高者胜；
4. 过路费和道路数均相同，并列胜利。

---

## 18. 当前规则中的未明确点与默认实现约定

以下内容原规则未完全明确，为保证程序可实现，本文给出默认约定。若后续规则更新，应同步修改此章节和代码。

| 问题 | 默认约定 |
|---|---|
| 玩家数量 | 支持 2~4 人，具体由创建游戏输入决定 |
| 坐标方向 | `(1,1)` 左下，`(6,6)` 右上 |
| 初始道路是否可跨河 | 不可，因为初始无桥 |
| 行动 2 是否能修桥 | 不能，只能修道路 |
| 行动 3 跨河无桥时 | 可修桥 |
| 行动 3 跨河已有自己桥时 | 可修路 |
| 行动 3 跨河已有他人桥时 | 不可操作 |
| 随机修路卡非法时 | 卡牌无效果 |
| 桥梁通路卡目标 | 玩家从自己的有桥无路边中选择 |
| 拆路修桥卡目标 | 拆自己的任一道路，在任一无桥跨河边建桥 |
| 拆除桥上道路是否拆桥 | 不拆桥，桥保留 |
| 新商人登场后是否立即连锁完成 | 不立即连锁，下一次玩家行动结束后检查 |
| 最终仍平局 | 并列胜利 |
| 边长度 | 全部为 1 |

---

## 19. 最小可行版本（MVP）范围

为了尽快完成可玩程序，建议 MVP 包含：

1. 2~4 名本地玩家；
2. 自动随机地图生成；
3. 6×6 网格可视化；
4. 骰子、三种行动；
5. 道路、桥梁建设；
6. 四种建设卡；
7. 5 位商人生成与最短路径结算；
8. 过路费统计与胜负结算；
9. 游戏日志；
10. 随机种子可选。

暂不要求：

- 网络联机；
- 复杂 AI；
- 动画特效；
- 存档/读档；
- 严格等概率的多最短路径采样；
- 高拟真河流曲线生成。

---

## 20. 推荐实现顺序

1. 定义数据模型；
2. 实现随机数服务；
3. 实现地图生成与合法性校验；
4. 实现边、道路、桥梁建设规则；
5. 实现玩家与开局预建设；
6. 实现骰子与回合状态机；
7. 实现建设卡；
8. 实现商人生成、路径查找、过路费结算；
9. 实现胜负结算；
10. 实现 UI；
11. 添加日志、测试、调试工具；
12. 平衡和视觉优化。

---

## 21. 核心伪代码总览

### 21.1 玩家回合

```pseudo
function runPlayerTurn(player):
    die1 = rollDie()
    action = player.chooseAction([DRAW_CARD, BUILD_FROM_BASE, SECOND_DIE])

    if action == DRAW_CARD:
        card = drawCard()
        resolveCard(player, card)

    if action == BUILD_FROM_BASE:
        base = player.chooseNode(nodes where diceNumber == die1)
        edge = player.chooseEdge(adjacentEdges(base))
        if canBuildRoad(player, edge):
            buildRoad(player, edge)
        else:
            noEffect()

    if action == SECOND_DIE:
        base = player.chooseNode(nodes where diceNumber == die1)
        die2 = rollDie()
        candidates = neighbors(base) where diceNumber == die2
        if candidates not empty:
            target = player.chooseNode(candidates)
            edge = getEdge(base, target)
            if edge.isRiverCrossing and canBuildBridge(player, edge):
                buildBridge(player, edge)
            else if canBuildRoad(player, edge):
                buildRoad(player, edge)
            else:
                noEffect()
        if die2 == die1:
            card = drawCard()
            resolveCard(player, card)

    checkMerchantCompletion()
    if game not ended:
        advanceToNextPlayer()
```

### 21.2 商人检查

```pseudo
function checkMerchantCompletion():
    merchant = currentMerchant
    path = findRandomShortestPassablePath(merchant.start, merchant.end)

    if path == null:
        return

    payTolls(merchant, path.edges)
    merchant.completed = true
    completedMerchants.add(merchant)

    if merchant.index == 5:
        endGame()
    else:
        currentMerchant = spawnMerchant(merchant.index + 1)
```

### 21.3 结束游戏

```pseudo
function endGame():
    phase = GAME_END
    rankings = players sorted by:
        tollMoney descending,
        currentRoadCount descending

    winners = all players tied with rankings[0] on tollMoney and currentRoadCount
    return GameResult(rankings, winners)
```

---

## 22. 验收标准

程序完成后应满足：

1. 任意新局均生成合法地图；
2. 每个数字 1~6 正好分配给 6 个居民点；
3. 玩家不能违反桥路建设条件；
4. 商人只走有道路的边；
5. 商人始终选择最短路径；
6. 过路费按道路和桥梁分别正确归属；
7. 第 5 位商人完成后立即结算；
8. 胜负排序符合规则；
9. 所有关键事件可在日志中追踪；
10. 使用固定随机种子时，可复现地图、点数、骰子和卡牌结果。
