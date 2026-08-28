import { describe, it, expect } from "vitest";
import {
  newRun, chooseSchool, toggleSelect, playHand, discardSelected,
  previewHand, enterShop, buyItem, nextLevel, makeRng, SCHOOLS,
} from "../src/game/run";
import { RUN_RULES, LEVEL_TARGETS } from "../src/game/balance";

describe("makeRng 可复现随机源", () => {
  it("相同种子产生相同序列", () => {
    const a = makeRng(123);
    const b = makeRng(123);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
  it("输出落在 [0,1)", () => {
    const r = makeRng(999);
    for (let i = 0; i < 50; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe("开局与门派", () => {
  it("newRun 处于 school 阶段，无门派", () => {
    const s = newRun(42);
    expect(s.phase).toBe("school");
    expect(s.school).toBeNull();
  });
  it("chooseSchool 后进入 playing 并发满手牌", () => {
    const s = chooseSchool(newRun(42), "caishen");
    expect(s.phase).toBe("playing");
    expect(s.school).toBe("caishen");
    expect(s.hand.length).toBe(RUN_RULES.handSize);
    expect(s.relics.length).toBeGreaterThan(0);
    expect(s.target).toBe(LEVEL_TARGETS[0]);
  });
  it("三个门派均可开局", () => {
    for (const sc of SCHOOLS) {
      const s = chooseSchool(newRun(7), sc.id);
      expect(s.phase).toBe("playing");
    }
  });
});

describe("选牌 / 预览 / 出牌 / 弃牌", () => {
  it("toggleSelect 选中/取消，且不超过上限", () => {
    let s = chooseSchool(newRun(42), "caishen");
    const ids = s.hand.map((c) => c.id);
    for (let i = 0; i < 7; i++) s = toggleSelect(s, ids[i]);
    expect(s.selected.length).toBeLessThanOrEqual(RUN_RULES.maxSelect);
    s = toggleSelect(s, s.selected[0]); // 取消一张
    expect(s.selected.length).toBe(RUN_RULES.maxSelect - 1);
  });

  it("previewHand 反映选中牌型", () => {
    let s = chooseSchool(newRun(42), "caishen");
    s = toggleSelect(s, s.hand[0].id);
    const p = previewHand(s);
    expect(p).not.toBeNull();
  });

  it("playHand 消耗一次出牌并累计得分", () => {
    let s = chooseSchool(newRun(42), "caishen");
    s = toggleSelect(s, s.hand[0].id);
    s = toggleSelect(s, s.hand[1].id);
    const before = s.playsLeft;
    s = playHand(s);
    expect(s.playsLeft).toBe(before - 1);
    expect(s.score).toBeGreaterThan(0);
    expect(s.lastScore).not.toBeNull();
  });

  it("discardSelected 消耗一次弃牌并补满手牌", () => {
    let s = chooseSchool(newRun(42), "caishen");
    s = toggleSelect(s, s.hand[0].id);
    const before = s.discardsLeft;
    s = discardSelected(s);
    expect(s.discardsLeft).toBe(before - 1);
    expect(s.hand.length).toBe(RUN_RULES.handSize);
  });
});

describe("完整循环：开始→出牌→过关→商店→下一关", () => {
  it("可以走通一整个关卡直到进入 reward 或 lost", () => {
    let s = chooseSchool(newRun(1), "caishen");
    let guard = 0;
    while (s.phase === "playing" && guard++ < 20) {
      // 简单策略：全选前 5 张出牌
      s = { ...s, selected: [] };
      for (const card of s.hand.slice(0, RUN_RULES.maxSelect)) s = toggleSelect(s, card.id);
      s = playHand(s);
    }
    expect(["reward", "lost"]).toContain(s.phase);
  });

  it("reward → shop → nextLevel 流程连贯", () => {
    // 构造一个必然过关的场景：反复出牌直到 reward
    let s = chooseSchool(newRun(1), "caishen");
    let guard = 0;
    while (s.phase === "playing" && guard++ < 20) {
      s = { ...s, selected: [] };
      for (const card of s.hand.slice(0, RUN_RULES.maxSelect)) s = toggleSelect(s, card.id);
      s = playHand(s);
    }
    if (s.phase === "reward") {
      s = enterShop(s, makeRng(5));
      expect(s.phase).toBe("shop");
      expect(s.shop.length).toBeGreaterThan(0);
      const lvl = s.level;
      s = nextLevel(s);
      expect(["playing", "won"]).toContain(s.phase);
      if (s.phase === "playing") expect(s.level).toBe(lvl + 1);
    }
  });
});

describe("商店购买", () => {
  it("买符箓会扣铜钱并加入携带", () => {
    let s = chooseSchool(newRun(3), "caishen");
    s.gold = 50;
    s = enterShop(s, makeRng(9));
    const relicItem = s.shop.findIndex((i) => i.kind === "relic");
    if (relicItem >= 0 && s.relics.length < RUN_RULES.relicSlots) {
      const beforeGold = s.gold;
      const beforeRelics = s.relics.length;
      s = buyItem(s, relicItem, makeRng(9));
      expect(s.gold).toBeLessThan(beforeGold);
      expect(s.relics.length).toBe(beforeRelics + 1);
    }
  });
  it("铜钱不足无法购买", () => {
    let s = chooseSchool(newRun(3), "caishen");
    s.gold = 0;
    s = enterShop(s, makeRng(9));
    const before = { ...s, relics: [...s.relics] };
    s = buyItem(s, 0, makeRng(9));
    expect(s.gold).toBe(0);
    expect(s.relics.length).toBe(before.relics.length);
  });
});
