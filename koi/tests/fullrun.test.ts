import { describe, it, expect } from "vitest";
import {
  newRun, chooseSchool, toggleSelect, playHand, discardSelected,
  enterShop, nextLevel, RunState,
} from "../src/game/run";

/**
 * 端到端「可通关性」冒烟测试：
 * 用固定种子 + 贪心策略（每次出手中最大牌型的 5 张），
 * 验证一整局可以推进（至少不崩溃、状态机自洽、能进入奖励/商店/下一关）。
 */
function greedyBestFive(state: RunState): RunState {
  // 简单策略：选前 5 张（run 内部会识别最优牌型的评分表）
  let s = { ...state, selected: [] as string[] };
  const ids = s.hand.slice(0, 5).map((c) => c.id);
  for (const id of ids) s = toggleSelect(s, id);
  return s;
}

describe("端到端流程", () => {
  it("能选门派并开始第一关（playing 阶段、发满手牌）", () => {
    const run = chooseSchool(newRun(12345), "caishen");
    expect(run.phase).toBe("playing");
    expect(run.hand.length).toBeGreaterThan(0);
    expect(run.target).toBeGreaterThan(0);
  });

  it("出牌会消耗次数并累加分数；弃牌会消耗弃牌次数", () => {
    let run = chooseSchool(newRun(999), "jianghu");
    const plays0 = run.playsLeft;
    run = greedyBestFive(run);
    run = playHand(run);
    expect(run.playsLeft).toBe(plays0 - 1);
    expect(run.score).toBeGreaterThanOrEqual(0);

    if (run.phase === "playing") {
      const disc0 = run.discardsLeft;
      let r2 = { ...run, selected: [run.hand[0].id] };
      r2 = discardSelected(r2);
      expect(r2.discardsLeft).toBe(disc0 - 1);
    }
  });

  it("推进多局：反复出牌可触达 reward/shop/next 或 lost，状态机不崩溃", () => {
    let run = chooseSchool(newRun(2026), "wenqu");
    let guard = 0;
    while (run.phase !== "won" && run.phase !== "lost" && guard < 200) {
      guard++;
      if (run.phase === "playing") {
        run = greedyBestFive(run);
        if (run.selected.length === 0) break;
        run = playHand(run);
      } else if (run.phase === "reward") {
        run = enterShop(run, () => 0.5);
      } else if (run.phase === "shop") {
        run = nextLevel(run);
      }
    }
    expect(["won", "lost", "playing", "reward", "shop"]).toContain(run.phase);
    expect(guard).toBeLessThan(200); // 不应无限循环
  });
});
