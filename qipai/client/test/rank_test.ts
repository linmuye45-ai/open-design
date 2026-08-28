/**
 * 爵位荣衔制 · 玩家体验验证测试
 * 运行: npx ts-node test/rank_test.ts
 *
 * 从玩家体验角度检验：
 *  1. 新手成长曲线是否顺畅（布衣→员外→...）
 *  2. 连胜是否有正反馈（加成）
 *  3. 连败是否有保护（不至于暴跌挫败）
 *  4. 逃跑是否被严惩
 *  5. 强弱对手是否影响积分（打强者赢得多，输给强者扣得少）
 *  6. 棋圣封顶后星级无限累进
 */
import {
    RankSystem, IRankProfile, NobleTier, TIER_TABLE, IMatchOutcome,
} from "../assets/scripts/core/RankSystem";

let passed = 0, failed = 0;
function assert(cond: boolean, msg: string) {
    if (cond) { passed++; }
    else { failed++; console.log("  ❌ FAIL: " + msg); }
}

function play(profile: IRankProfile, outcome: IMatchOutcome): IRankProfile {
    return RankSystem.settle(profile, outcome).after;
}

console.log("=== 爵位荣衔制验证 ===\n");

// ---- 1. 段位表自洽：floorScore 严格递增 ----
console.log("[1] 段位阶梯自洽性");
for (let i = 1; i < TIER_TABLE.length; i++) {
    assert(TIER_TABLE[i].floorScore > TIER_TABLE[i - 1].floorScore,
        `floorScore 应递增: ${TIER_TABLE[i].name}`);
}
assert(TIER_TABLE[0].name === "布衣", "最低段应为布衣");
assert(TIER_TABLE[TIER_TABLE.length - 1].name === "棋圣", "最高段应为棋圣");

// ---- 2. 新手成长曲线 ----
console.log("[2] 新手成长曲线（连胜升段）");
let p = RankSystem.createProfile();
let d0 = RankSystem.describe(p.score);
assert(d0.tier === NobleTier.Commoner, "初始应为布衣");
assert(d0.star === 1, "初始应为一星, got " + d0.star);
console.log("    起点: " + d0.fullTitle);

// 连赢直到员外
let games = 0;
while (RankSystem.tierOfScore(p.score).tier < NobleTier.Squire && games < 50) {
    p = play(p, { win: true, multiplier: 2 });
    games++;
}
assert(RankSystem.tierOfScore(p.score).tier >= NobleTier.Squire,
    "连胜后应升至员外, 用了" + games + "局");
console.log(`    连胜 ${games} 局 → ` + RankSystem.describe(p.score).fullTitle + ` (积分 ${p.score})`);

// ---- 3. 连胜加成 ----
console.log("[3] 连胜正反馈");
let a = RankSystem.createProfile();
let r1 = RankSystem.settle(a, { win: true, multiplier: 1 });   // 第1胜 streak=0
let after1 = r1.after;
let r2 = RankSystem.settle(after1, { win: true, multiplier: 1 }); // 第2胜 streak=1
let r3 = RankSystem.settle(r2.after, { win: true, multiplier: 1 }); // 第3胜 streak=2
assert(r2.delta > r1.delta, `第2胜应比第1胜加分多 (${r2.delta} > ${r1.delta})`);
assert(r3.delta > r2.delta, `第3胜应比第2胜加分多 (${r3.delta} > ${r2.delta})`);
console.log(`    单胜积分递增: ${r1.delta} → ${r2.delta} → ${r3.delta}`);

// ---- 4. 段位保护：连败不暴跌 ----
console.log("[4] 段位保护（连败防暴跌）");
// 把玩家推到乡绅（有保护）刚升段处
let g = RankSystem.createProfile();
let safety = 0;
while (RankSystem.tierOfScore(g.score).tier < NobleTier.Gentry && safety < 200) {
    g = play(g, { win: true, multiplier: 3 });
    safety++;
}
const gentryTier = RankSystem.tierOfScore(g.score).tier;
assert(gentryTier === NobleTier.Gentry, "应升至乡绅, got tier " + gentryTier);
// 刚升段应有保护局数
assert(g.protectGames > 0, "升段后应获得保护局数, got " + g.protectGames);
console.log(`    升至乡绅, 保护局数=${g.protectGames}`);
// 连败几局，验证保护期内不跌段
let stillGentry = true;
let anyProtected = false;
for (let i = 0; i < 3; i++) {
    const rr = RankSystem.settle(g, { win: false, multiplier: 3 });
    if (rr.protectedFromDemotion) anyProtected = true;
    g = rr.after;
    if (RankSystem.tierOfScore(g.score).tier < NobleTier.Gentry) stillGentry = false;
}
assert(stillGentry, "保护期内连败不应跌出乡绅");
assert(anyProtected, "应至少触发一次跌段保护");
console.log(`    保护期内连败3局仍为: ` + RankSystem.describe(g.score).fullTitle);

// ---- 5. 逃跑严惩 ----
console.log("[5] 逃跑惩罚");
let e = RankSystem.createProfile();
e.score = 500; e.protectGames = 3;
const normalLose = RankSystem.settle(e, { win: false, multiplier: 1 });
const escapeLose = RankSystem.settle(e, { win: false, multiplier: 1, escaped: true });
assert(escapeLose.delta < normalLose.delta,
    `逃跑扣分应多于普通失败 (${escapeLose.delta} < ${normalLose.delta})`);
// 逃跑不享受保护
console.log(`    普通失败 ${normalLose.delta} vs 逃跑 ${escapeLose.delta}`);

// ---- 6. 强弱对手影响 ----
console.log("[6] 强弱对手积分调整");
let m = RankSystem.createProfile(); m.score = 1000;
const beatStrong = RankSystem.settle(m, { win: true, opponentEdge: 3 });   // 打赢强者
const beatWeak = RankSystem.settle(m, { win: true, opponentEdge: -3 });    // 打赢弱者
assert(beatStrong.delta > beatWeak.delta,
    `赢强者应加分更多 (${beatStrong.delta} > ${beatWeak.delta})`);
const loseStrong = RankSystem.settle(m, { win: false, opponentEdge: 3 });  // 输给强者
const loseWeak = RankSystem.settle(m, { win: false, opponentEdge: -3 });   // 输给弱者
assert(loseStrong.delta > loseWeak.delta,
    `输给强者应扣分更少 (${loseStrong.delta} > ${loseWeak.delta})`);
console.log(`    赢强者+${beatStrong.delta} / 赢弱者+${beatWeak.delta}`);
console.log(`    输强者${loseStrong.delta} / 输弱者${loseWeak.delta}`);

// ---- 7. 棋圣封顶星级无限 ----
console.log("[7] 棋圣无限星级");
const gmFloor = TIER_TABLE[TIER_TABLE.length - 1].floorScore;
const d1 = RankSystem.describe(gmFloor);
const d2 = RankSystem.describe(gmFloor + 300 * 5);
assert(d1.tier === NobleTier.GrandMaster, "应为棋圣");
assert(d2.star > d1.star, `棋圣星级应可累进 (${d2.star} > ${d1.star})`);
assert(d1.starMax === Infinity, "棋圣星级上限应为无限");
console.log(`    ${d1.fullTitle} → ${d2.fullTitle}`);

// ---- 8. 鲁棒性：脏数据不崩溃 ----
console.log("[8] 脏数据鲁棒性");
const dirty: any = { score: -999, winStreak: NaN, protectGames: "x", peakScore: undefined, totalGames: -5, totalWins: 3.7 };
const rd = RankSystem.settle(dirty, { win: true, multiplier: 999 as any, opponentEdge: 100 as any });
assert(rd.after.score >= 0 && Number.isFinite(rd.after.score), "脏数据结算后积分应有效");
assert(rd.after.winStreak >= 0, "脏数据 winStreak 应被清洗");
console.log(`    脏数据清洗后: 积分=${rd.after.score}, ` + rd.display.fullTitle);

// ---- 汇总 ----
console.log(`\n=== 结果: ${passed} 通过, ${failed} 失败 ===`);
if (failed > 0) process.exit(1);
console.log("✅ 爵位荣衔制全部验证通过（成长顺畅/连胜正反馈/连败有保护/逃跑严惩/强弱调整/棋圣无限）");
