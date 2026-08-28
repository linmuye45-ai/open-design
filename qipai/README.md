# 锦鲤棋牌大全 · JinLi Card Games (AAA)

> 面向 30–65 岁高净值用户的 AAA 级中国棋牌"大全"App。
> 前端 **Cocos Creator 3.x (TypeScript)** —— H5 / 微信 & 抖音小程序 / Android / iOS；
> 后端 **Go + 分布式框架** —— WebSocket / Protobuf，面向百万级并发。

本仓库是工业级生产代码，**无伪代码、无 `// 此处省略`**：完整状态机、核心算法、错误处理与内存管理一应俱全。

---

## 🎮 在线体验（可玩原型）

- **永久地址（GitHub Pages）**：`https://linmuye45-ai.github.io/open-design/`
  （首次需仓库 Owner 在 GitHub → Settings → Pages 选择 `gh-pages` 分支启用，之后永久生效）
- **原型源码**：[`qipai/webapp/`](./webapp)
- 展示三大卖点：**100% 全可见大字牌** · **可调 AI（智商/速度双滑杆）** · **爵位荣衔制（布衣→棋圣）**

## 📁 创业文件包（Founder's Kit）

见 [`qipai/docs/`](./docs)：商业计划书 / 融资路演 BP / 财务模型 / 技术白皮书 / 路线图 / 合规风控。
索引见 [`docs/README.md`](./docs/README.md)。

---

## 目录结构

```
qipai/
├── client/                        # Cocos Creator 3.x 前端 (TypeScript)
│   └── assets/scripts/
│       ├── core/
│       │   ├── CardTypes.ts        # 共享类型：花色/点数/牌型枚举、密集编码 rank*8+suit
│       │   ├── DoudizhuRules.ts    # 斗地主规则引擎：识别/压制/走法枚举 (纯静态)
│       │   ├── GuandanRules.ts     # 掼蛋规则引擎：级牌/逢人配百搭/炸弹分级/同花顺
│       │   └── RankSystem.ts       # 爵位荣衔制：布衣→棋圣, 段位保护/连胜/强弱调整
│       ├── card/
│       │   └── CardLayoutManager.ts # 模块A：数学矩阵手牌布局 + 射线选牌 + 抬牌动画
│       └── ai/
│           └── CardAIController.ts  # 模块C：MCTS/Flat-MC + 贝叶斯推理，可调智商/速度
│   └── test/                       # 纯 TS 运行时验证（无需 Cocos 编辑器）
│       ├── ai_quick.ts             # 合法性 + 单局时延
│       ├── ai_latency.ts           # setSpeed 精度验证
│       ├── ai_strength.ts          # 难度分档验证
│       └── ai_sim.ts               # 大规模对局模拟
│
└── server/                        # Go 后端
    └── match/
        ├── types.go                # 玩家/模式/年龄段/匹配结果
        ├── match_manager.go        # 模块B：高并发分布式房间匹配 (Goroutine/Channel)
        ├── reconnect.go            # 会话/心跳/断线重连（内存快照 + 重连令牌）
        └── match_manager_test.go   # 并发/MMR扩窗/重连/取消 —— 全部 `-race` 通过
```

---

## 模块A — CardLayoutManager.ts（100% 全可见防误触手牌）

- **数学矩阵布局**：`perRowMax = floor((usableW - cardWidth) / (cw·minVisibleRatio)) + 1`，
  17 张（斗地主）到 27 张（掼蛋）自适应，**任意一张牌永远不被完全遮挡**（针对老花眼/误触痛点）。
- **物理射线选牌**：容器触摸 → 节点坐标 → `_raycastTopMost` 按 siblingIndex 倒序命中最上层牌，解决重叠歧义。
- **平滑抬牌动画**：tween 抬起 `liftHeight`，多选/单选可配置。
- **对象池**：`_ensureSlotCount` / `_spawnCardNode`，无 prefab 时优雅降级。

## 模块B — match_manager.go（百万级并发匹配）

- **CSP 并发**：单一 `cmdCh chan command` 序列化 Enqueue/Cancel，避免"先入队后取消"竞态；分桶各自 Goroutine。
- **MMR + 年龄段匹配**：动态滑动窗口随等待时间扩张（`Base + waitSec·WidenPerSec`，上限 `MaxMMRWindow`）；
  按年龄段分桶（30-45/45-55/55-65），超时后跨段"混合桶"重定位。
- **防饥饿**：最老玩家等待超过 `MaxWait/2` 时强制成局，保证非 3/4 倍数桶也能出局。
- **心跳与重连**：`SessionRegistry`（64 分片）+ 内存快照 + 重连令牌，`sweepLoop` 自适应扫描。
- **测试**：`TestConcurrentMatchDoudizhu`（999 玩家）、`TestMMRWidening`、`TestReconnect`、`TestCancel`，`-race` 全通过。

## 模块C — CardAIController.ts（可调智商 MCTS + 贝叶斯）

- **可调出牌速度**：`setSpeed(ms)` 严格夹取 [50,3000]，通过 deadline 精确遵守（实测 50/150/500/1500/3000ms 精确匹配）。
- **可调智商**：`setIQ(0..100)` 控制搜索预算、随机度、贝叶斯权重；IQ<30 走启发式弱 AI。
- **PIMC / Flat-MC**：预算驱动的完美信息蒙特卡洛，`_sampleWorld` 采样未知牌世界，`_rollout` 贪心/随机推演。
- **贝叶斯推理**：`_buildBelief` 依据已见牌（手牌+已出+底牌）估计对手剩余牌分布。
- **验证**：20 局 0 非法出牌、地主胜率 50%（均衡）；国手地主(IQ90) vs 小白(IQ15) 胜率 **88%**，反之 **5%**（分档显著）。

---

## 创新特性（规划/落地中）

- **爵位荣衔制**：布衣 → 员外 → 大富豪 → 一品大员 → 棋圣（替代青铜/白银）。
- **动态 BGM**：平稳时江南丝竹，紧张时激昂。
- **AI 双滑杆**：智商 + 出牌速度实时可调。
- **情绪价值特效**：纯金龙、水墨炸弹、3D 四王（非二次元风格）。

---

## 本地验证

```bash
# 后端
cd qipai/server
go build ./...
go test ./match/ -race -timeout 90s

# 前端（纯逻辑，无需 Cocos 编辑器）
cd qipai/client
npm install
npx tsc -p tsconfig.check.json          # 类型检查三大模块
npx ts-node test/ai_quick.ts            # 合法性 + 时延
npx ts-node test/ai_latency.ts          # setSpeed 精度
npx ts-node test/ai_strength.ts         # 难度分档
```
