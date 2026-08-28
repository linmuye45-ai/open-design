# 锦鲤棋牌大全 · 创业文件索引 (Founder's Kit)

> 一份给创始人与投资人的"开箱即用"资料包。所有文件均在 `qipai/docs/`。

| 文件 | 用途 | 读者 |
|---|---|---|
| [`BUSINESS_PLAN.md`](./BUSINESS_PLAN.md) | 商业计划书：定位/市场/产品/模式/竞争 | 投资人 · 创始团队 |
| [`PITCH_DECK.md`](./PITCH_DECK.md) | 15 页融资路演幻灯（可导入 PPT） | 路演 |
| [`FINANCIAL_MODEL.md`](./FINANCIAL_MODEL.md) | 财务模型框架与关键假设 | 投资人 · CFO |
| [`TECH_WHITEPAPER.md`](./TECH_WHITEPAPER.md) | 技术白皮书（架构/三大护城河/质量门禁） | 技术尽调 · 研发 |
| [`ROADMAP.md`](./ROADMAP.md) | 产品路线图（M0→M3，含完成状态） | 全员 |
| [`COMPLIANCE.md`](./COMPLIANCE.md) | 合规与风控红线、资质、风险登记册 | 法务 · 运营 |

---

## 快速导览

- **想 3 分钟看懂项目** → `PITCH_DECK.md`
- **想做投资决策** → `BUSINESS_PLAN.md` + `FINANCIAL_MODEL.md`
- **想做技术尽调** → `TECH_WHITEPAPER.md` +（源码 `qipai/client`、`qipai/server`）
- **想评估合规风险** → `COMPLIANCE.md`
- **想立即试玩** → 见项目根 `qipai/README.md` 顶部"在线体验"链接

---

## 已交付的硬核证据（非 PPT，可直接验证）

- **可玩在线原型**：斗地主 H5（100% 全可见牌 / 可调 AI 双滑杆 / 爵位荣衔）。
- **三大核心模块工业级代码**：`CardLayoutManager` / `MatchManager` / `CardAIController`。
- **可复现测试**：Go `-race` 全通过；AI 20 局 0 非法、难度分档 88%:5%、setSpeed 精确；
  掼蛋 27/27、荣衔 24/24 断言通过。

> 我们用"能跑、能测、能玩"的东西说话，而不是空谈。
