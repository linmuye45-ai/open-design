/**
 * 掼蛋规则引擎验证 · 运行: npx ts-node test/guandan_test.ts
 * 重点验证：级牌、逢人配百搭、炸弹分级体系、各牌型识别与压制。
 */
import { GuandanRules } from "../assets/scripts/core/GuandanRules";
import { createCard, Rank, Suit, ComboType } from "../assets/scripts/core/CardTypes";

let passed = 0, failed = 0;
function assert(cond: boolean, msg: string) {
    if (cond) passed++; else { failed++; console.log("  ❌ FAIL: " + msg); }
}
const C = (r: Rank, s: Suit, d = 0) => createCard(r, s, d);

console.log("=== 掼蛋规则引擎验证 ===\n");
const LEVEL = Rank.Five; // 本局打5，红桃5为逢人配

// [1] 基础牌型
console.log("[1] 基础牌型识别");
assert(GuandanRules.identify([C(Rank.Nine, Suit.Spade)], LEVEL).type === ComboType.Single, "单张");
assert(GuandanRules.identify([C(Rank.Nine, Suit.Spade), C(Rank.Nine, Suit.Heart)], LEVEL).type === ComboType.Pair, "对子");
assert(GuandanRules.identify([C(Rank.Nine, Suit.Spade), C(Rank.Nine, Suit.Heart), C(Rank.Nine, Suit.Club)], LEVEL).type === ComboType.Trio, "三张");

// [2] 级牌大小：级牌 > A > K
console.log("[2] 级牌大小顺序");
const eff = GuandanRules.effRank;
assert(eff(Rank.Five, LEVEL) === 16, "级牌effRank=16");
assert(eff(Rank.Ace, LEVEL) === 14, "A effRank=14");
assert(eff(Rank.BigJoker, LEVEL) > eff(Rank.Five, LEVEL), "大王>级牌");
assert(eff(Rank.Five, LEVEL) > eff(Rank.Two, LEVEL), "级牌>2");

// [3] 逢人配：红桃级牌当百搭凑对子
console.log("[3] 逢人配百搭");
// 9 + 红桃5(百搭) => 一对9
const wildPair = GuandanRules.identify([C(Rank.Nine, Suit.Spade), C(Rank.Five, Suit.Heart)], LEVEL);
assert(wildPair.type === ComboType.Pair && wildPair.keyRank === 9, "红桃级牌+9 = 一对9, got type=" + wildPair.type + " key=" + wildPair.keyRank);
// 9 9 + 红桃5 => 三条9
const wildTrio = GuandanRules.identify([C(Rank.Nine, Suit.Spade), C(Rank.Nine, Suit.Club), C(Rank.Five, Suit.Heart)], LEVEL);
assert(wildTrio.type === ComboType.Trio && wildTrio.keyRank === 9, "两9+百搭=三条9");
// 非红桃级牌不是百搭：黑桃5仍是普通5
const spade5pair = GuandanRules.identify([C(Rank.Nine, Suit.Spade), C(Rank.Five, Suit.Spade)], LEVEL);
assert(spade5pair.type === ComboType.Invalid, "黑桃级牌不是百搭, 9+黑桃5非法对子");

// [4] 顺子（含百搭补齐）
console.log("[4] 顺子");
const straight = GuandanRules.identify([
    C(Rank.Six, Suit.Spade), C(Rank.Seven, Suit.Spade), C(Rank.Eight, Suit.Club),
    C(Rank.Nine, Suit.Diamond), C(Rank.Ten, Suit.Heart)], LEVEL);
assert(straight.type === ComboType.Straight && straight.keyRank === 10, "6789 10顺子, got " + straight.type);
// 用百搭补顺子: 6 7 _ 9 10 (红桃5补8)
const wildStraight = GuandanRules.identify([
    C(Rank.Six, Suit.Spade), C(Rank.Seven, Suit.Spade),
    C(Rank.Nine, Suit.Diamond), C(Rank.Ten, Suit.Heart), C(Rank.Five, Suit.Heart)], LEVEL);
assert(wildStraight.type === ComboType.Straight, "百搭补顺子 6 7 [8] 9 10, got " + wildStraight.type);

// [5] 炸弹分级体系
console.log("[5] 炸弹分级");
const bomb4 = GuandanRules.identify([C(Rank.Nine, Suit.Spade), C(Rank.Nine, Suit.Heart), C(Rank.Nine, Suit.Club), C(Rank.Nine, Suit.Diamond)], LEVEL);
const bomb5 = GuandanRules.identify([C(Rank.Nine, Suit.Spade), C(Rank.Nine, Suit.Heart), C(Rank.Nine, Suit.Club), C(Rank.Nine, Suit.Diamond), C(Rank.Nine, Suit.Spade, 1)], LEVEL);
assert(bomb4.type === ComboType.Bomb && bomb4.bombLevel === 10, "4炸 level10");
assert(bomb5.type === ComboType.GuandanBomb5 && bomb5.bombLevel === 20, "5炸 level20, got " + bomb5.bombLevel);
// 6炸
const bomb6 = GuandanRules.identify(new Array(6).fill(0).map((_, i) => C(Rank.Nine, i % 4 as Suit, i >= 4 ? 1 : 0)), LEVEL);
assert(bomb6.type === ComboType.GuandanBomb6 && bomb6.bombLevel === 30, "6炸 level30, got " + bomb6.type + "/" + bomb6.bombLevel);
// 天王炸：四大王
const heavenBomb = GuandanRules.identify([
    C(Rank.LittleJoker, Suit.Joker), C(Rank.LittleJoker, Suit.Joker, 1),
    C(Rank.BigJoker, Suit.Joker), C(Rank.BigJoker, Suit.Joker, 1)], LEVEL);
assert(heavenBomb.type === ComboType.GuandanBomb8 && heavenBomb.bombLevel === 100, "四大王=天王炸 level100, got " + heavenBomb.bombLevel);

// [6] 同花顺
console.log("[6] 同花顺");
const sf = GuandanRules.identify([
    C(Rank.Six, Suit.Spade), C(Rank.Seven, Suit.Spade), C(Rank.Eight, Suit.Spade),
    C(Rank.Nine, Suit.Spade), C(Rank.Ten, Suit.Spade)], LEVEL);
assert(sf.type === ComboType.StraightFlush && sf.bombLevel === 25, "同花顺 level25, got " + sf.type + "/" + sf.bombLevel);

// [7] 压制关系
console.log("[7] 炸弹压制");
assert(GuandanRules.canBeat(bomb5, bomb4), "5炸压4炸");
assert(GuandanRules.canBeat(sf, bomb5), "同花顺压5炸");
assert(GuandanRules.canBeat(bomb6, sf), "6炸压同花顺");
assert(GuandanRules.canBeat(heavenBomb, bomb6), "天王炸压6炸");
assert(!GuandanRules.canBeat(bomb4, bomb5), "4炸压不过5炸");
// 炸弹压普通牌
const pair9 = GuandanRules.identify([C(Rank.Nine, Suit.Spade), C(Rank.Nine, Suit.Heart)], LEVEL);
assert(GuandanRules.canBeat(bomb4, pair9), "炸弹压对子");
assert(!GuandanRules.canBeat(pair9, bomb4), "对子压不过炸弹");

// [8] 同型比大小
console.log("[8] 同型比较");
const pairK = GuandanRules.identify([C(Rank.King, Suit.Spade), C(Rank.King, Suit.Heart)], LEVEL);
assert(GuandanRules.canBeat(pairK, pair9), "KK压99");
const pairLevel = GuandanRules.identify([C(Rank.Five, Suit.Spade), C(Rank.Five, Suit.Club)], LEVEL);
assert(GuandanRules.canBeat(pairLevel, pairK), "级牌对压KK(级牌>A>K)");

// [9] 三带二葫芦
console.log("[9] 三带二");
const fh = GuandanRules.identify([
    C(Rank.Nine, Suit.Spade), C(Rank.Nine, Suit.Heart), C(Rank.Nine, Suit.Club),
    C(Rank.King, Suit.Spade), C(Rank.King, Suit.Heart)], LEVEL);
assert(fh.type === ComboType.TrioPair && fh.keyRank === 9, "999KK 葫芦keyRank=9, got " + fh.type + "/" + fh.keyRank);

console.log(`\n=== 结果: ${passed} 通过, ${failed} 失败 ===`);
if (failed > 0) process.exit(1);
console.log("✅ 掼蛋规则引擎验证通过（级牌/逢人配/炸弹分级/同花顺/压制/葫芦）");
