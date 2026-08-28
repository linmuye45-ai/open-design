import { describe, it, expect } from "vitest";
import {
  Card, Suit, HandType, identifyHand, buildDeck, shuffle, cardBaseChips,
} from "../src/game/rules";

function c(rank: number, suit: Suit, id = `${rank}-${suit}`): Card {
  return { id, rank, suit };
}

describe("buildDeck", () => {
  it("生成 52 张不重复的牌", () => {
    const deck = buildDeck();
    expect(deck).toHaveLength(52);
    const ids = new Set(deck.map((d) => d.id));
    expect(ids.size).toBe(52);
  });
});

describe("shuffle", () => {
  it("保留全部元素且可复现（固定随机源）", () => {
    const deck = buildDeck();
    const rng = () => 0.42;
    const a = shuffle(deck, rng);
    const b = shuffle(deck, rng);
    expect(a).toHaveLength(52);
    expect(a.map((x) => x.id)).toEqual(b.map((x) => x.id));
  });
});

describe("cardBaseChips", () => {
  it("A=11，人头=10，其余=点数", () => {
    expect(cardBaseChips(c(14, Suit.Red))).toBe(11);
    expect(cardBaseChips(c(13, Suit.Red))).toBe(10);
    expect(cardBaseChips(c(11, Suit.Red))).toBe(10);
    expect(cardBaseChips(c(7, Suit.Red))).toBe(7);
  });
});

describe("identifyHand 牌型识别", () => {
  it("孤星(高牌)", () => {
    const r = identifyHand([c(9, Suit.Black), c(4, Suit.Red)]);
    expect(r.type).toBe(HandType.HighCard);
    expect(r.scoring).toHaveLength(1);
    expect(r.scoring[0].rank).toBe(9);
  });
  it("成双(对子)", () => {
    const r = identifyHand([c(8, Suit.Black), c(8, Suit.Red)]);
    expect(r.type).toBe(HandType.Pair);
    expect(r.scoring).toHaveLength(2);
  });
  it("鸳鸯(两对)", () => {
    const r = identifyHand([c(8, Suit.Black), c(8, Suit.Red), c(5, Suit.Green), c(5, Suit.White)]);
    expect(r.type).toBe(HandType.TwoPair);
    expect(r.scoring).toHaveLength(4);
  });
  it("三合(三条)", () => {
    const r = identifyHand([c(6, Suit.Black), c(6, Suit.Red), c(6, Suit.Green)]);
    expect(r.type).toBe(HandType.Trips);
  });
  it("长龙(顺子)", () => {
    const r = identifyHand([c(4, Suit.Black), c(5, Suit.Red), c(6, Suit.Green), c(7, Suit.White), c(8, Suit.Black)]);
    expect(r.type).toBe(HandType.Straight);
    expect(r.keyRank).toBe(8);
  });
  it("长龙 A-2-3-4-5 (A 作最低)", () => {
    const r = identifyHand([c(14, Suit.Black), c(2, Suit.Red), c(3, Suit.Green), c(4, Suit.White), c(5, Suit.Black)]);
    expect(r.type).toBe(HandType.Straight);
    expect(r.keyRank).toBe(5);
  });
  it("同象(同花)", () => {
    const r = identifyHand([c(2, Suit.Red), c(5, Suit.Red), c(9, Suit.Red), c(11, Suit.Red), c(13, Suit.Red)]);
    expect(r.type).toBe(HandType.Flush);
  });
  it("满堂(葫芦)", () => {
    const r = identifyHand([c(7, Suit.Black), c(7, Suit.Red), c(7, Suit.Green), c(3, Suit.White), c(3, Suit.Black)]);
    expect(r.type).toBe(HandType.FullHouse);
  });
  it("四方(四条)", () => {
    const r = identifyHand([c(9, Suit.Black), c(9, Suit.Red), c(9, Suit.Green), c(9, Suit.White), c(2, Suit.Black)]);
    expect(r.type).toBe(HandType.Quads);
  });
  it("游龙(同花顺)", () => {
    const r = identifyHand([c(9, Suit.Red), c(10, Suit.Red), c(11, Suit.Red), c(12, Suit.Red), c(13, Suit.Red)]);
    expect(r.type).toBe(HandType.StraightFlush);
    expect(r.keyRank).toBe(13);
  });
  it("五福(五条，需要重复点数)", () => {
    const r = identifyHand([c(5, Suit.Red, "a"), c(5, Suit.Black, "b"), c(5, Suit.Green, "c"), c(5, Suit.White, "d"), c(5, Suit.Red, "e")]);
    expect(r.type).toBe(HandType.FiveKind);
  });
});
