# 参与贡献 Contributing

感谢关注《锦鲤牌阵 Koi Fortune》！

## 开发环境

```bash
cd koi
npm install
npm run dev
npm test
```

要求 Node.js ≥ 18。

## 提交前检查

- `npm test` 全部通过（当前 44 用例）。
- `npm run build` 通过（含 `tsc --noEmit` 类型检查）。
- 遵循现有代码风格；新玩法数值请集中放在 `src/game/balance.ts`。

## 提交规范

使用约定式提交（Conventional Commits）：

```
feat(relics): 新增「XX符箓」
fix(run): 修复商店刷新价格
docs: 更新玩法说明
test: 补充牌型识别用例
```

## 内容红线（务必遵守）

任何贡献**不得**引入：真钱 / 提现 / 红包 / 房卡 / 金币输赢 / 概率抽卡 / 诱导付费，
以及「赌博 / 赢钱 / 提现 / 赚豆 / 赌神」等词汇。
本作对外统一表述为：策略牌局 / 构筑游戏 / 牌型解谜 / 国风肉鸽。

## 原创性

请勿引入任何其他商业作品的名称、UI、系统命名、图标或文案。
