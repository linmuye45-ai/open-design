import { describe, it, expect } from "vitest";
import { Card, Suit, HandType, identifyHand } from "../src/game/rules";
import { RELICS, getRelic, computeScore, Relic } from "../src/game/relics";
import { HAND_SCORES } from "../src/game/balance";

function c(rank: number, suit: Suit, id = `${rank}-${suit}`): Card {
  return { id, rank, suit };
}

const META = { level: 0, playsLeft: 3, discardsLeft: 3, gold: 4, handsPlayedThisLevel: 0, deckSize: 52 };

describe("符箓库完整性", () => {
  it("至少 30 种符箓", () => {
    expect(RELICS.length).toBeGreaterThanOrEqual(30);
  });
  it("每个符箓 id 唯一且字段完整", () => {
    const ids = new Set<string>();
    for (const r of RELICS) {
      expect(r.id).toBeTruthy();
      expect(r.name).toBeTruthy();
      expect(r.desc).toBeTruthy();
      expect(["common", "rare", "epic"]).toContain(r.rarity);
      expect(ids.has(r.id)).toBe(false);
      ids.add(r.id);
    }
  });
  it("getRelic 可按 id 取到", () => {
    expect(getRelic("zhaocai")?.name).toBe("招财进宝");
    expect(getRelic("不存在")).toBeUndefined();
  });
});

describe("computeScore 计分管线", () => {
  it("无符箓：底分 = 牌型底分 + 每张牌底分，倍率 = 牌型倍率", () => {
    const cards = [c(8, Suit.Black), c(8, Suit.Red)];
    const hand = identifyHand(cards, HAND_SCORES);
    const r = computeScore(hand, cards, [], META);
    // 成双底分 12 + 两张 8 = 12 + 16 = 28；倍率 2
    expect(r.chips).toBe(28);
    expect(r.mult).toBe(2);
    expect(r.total).toBe(56);
  });

  it("玉如意(+40 底分) 生效", () => {
    const cards = [c(8, Suit.Black), c(8, Suit.Red)];
    const hand = identifyHand(cards, HAND_SCORES);
    const r = computeScore(hand, cards, [getRelic("yuru")!], META);
    expect(r.chips).toBe(68); // 28 + 40
    expect(r.total).toBe(136);
  });

  it("招财进宝：每张红牌 +4 底分", () => {
    const cards = [c(8, Suit.Red), c(8, Suit.Red, "8-1b")];
    const hand = identifyHand(cards, HAND_SCORES);
    const r = computeScore(hand, cards, [getRelic("zhaocai")!], META);
    // 28 + 4*2 = 36
    expect(r.chips).toBe(36);
  });

  it("金鳞化龙：长龙倍率 ×3", () => {
    const cards = [c(4, Suit.Black), c(5, Suit.Red), c(6, Suit.Green), c(7, Suit.White), c(8, Suit.Black)];
    const hand = identifyHand(cards, HAND_SCORES);
    const noRelic = computeScore(hand, cards, [], META);
    const withRelic = computeScore(hand, cards, [getRelic("jinlong")!], META);
    expect(withRelic.mult).toBe(noRelic.mult * 3);
  });

  it("符箓可叠加：琥珀凝光(+3倍) + 青龙偃月(每张♣+1倍)", () => {
    const cards = [c(6, Suit.Green), c(6, Suit.Green, "6-2b")];
    const hand = identifyHand(cards, HAND_SCORES);
    const r = computeScore(hand, cards, [getRelic("hupo")!, getRelic("qinglong")!], META);
    // 基础倍率 2 + 琥珀 3 + 青龙 每张+1 *2 = 2+3+2 = 7
    expect(r.mult).toBe(7);
  });

  it("得分永不为负", () => {
    const cards = [c(2, Suit.Black)];
    const hand = identifyHand(cards, HAND_SCORES);
    const r = computeScore(hand, cards, [], META);
    expect(r.total).toBeGreaterThanOrEqual(0);
  });

  it("每个符箓都能在不抛错的情况下参与计分", () => {
    const cards = [c(7, Suit.Red), c(7, Suit.Green), c(7, Suit.Black), c(3, Suit.White), c(3, Suit.Red)];
    const hand = identifyHand(cards, HAND_SCORES);
    for (const r of RELICS) {
      expect(() => computeScore(hand, cards, [r as Relic], META)).not.toThrow();
    }
  });
});
