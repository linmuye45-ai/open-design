import { describe, it, expect, beforeEach } from "vitest";
import {
  loadProfile, saveProfile, refreshAchievements, recordHandScore,
  recordRelicsSeen, ACHIEVEMENTS, Profile,
} from "../src/game/save";

// node 环境无 localStorage，save.ts 自动降级到内存存储；
// 每个用例前重置为空档。
function fresh(): Profile {
  const p = loadProfile();
  p.bestScoreSingleHand = 0;
  p.bestRunLevel = 0;
  p.wins = 0;
  p.runs = 0;
  p.totalScore = 0;
  p.relicsSeen = [];
  p.unlocked = [];
  p.muted = false;
  saveProfile(p);
  return p;
}

describe("存档读写", () => {
  beforeEach(() => { fresh(); });

  it("初始档案字段齐全", () => {
    const p = fresh();
    expect(p.runs).toBe(0);
    expect(Array.isArray(p.unlocked)).toBe(true);
  });

  it("saveProfile / loadProfile 往返一致", () => {
    const p = fresh();
    p.wins = 2;
    p.bestScoreSingleHand = 1234;
    saveProfile(p);
    const q = loadProfile();
    expect(q.wins).toBe(2);
    expect(q.bestScoreSingleHand).toBe(1234);
  });
});

describe("记录与成就", () => {
  beforeEach(() => { fresh(); });

  it("recordHandScore 更新最高分与累计", () => {
    const p = fresh();
    recordHandScore(p, 300);
    recordHandScore(p, 100);
    expect(p.bestScoreSingleHand).toBe(300);
    expect(p.totalScore).toBe(400);
  });

  it("recordRelicsSeen 去重", () => {
    const p = fresh();
    recordRelicsSeen(p, ["a", "b"]);
    recordRelicsSeen(p, ["b", "c"]);
    expect(p.relicsSeen.sort()).toEqual(["a", "b", "c"]);
  });

  it("refreshAchievements 达成后解锁且不重复", () => {
    const p = fresh();
    p.runs = 1;
    const first = refreshAchievements(p);
    expect(first.some((a) => a.id === "first_run")).toBe(true);
    const second = refreshAchievements(p);
    expect(second.some((a) => a.id === "first_run")).toBe(false);
  });

  it("爆分成就阈值正确", () => {
    const p = fresh();
    p.bestScoreSingleHand = 2000;
    refreshAchievements(p);
    expect(p.unlocked).toContain("big_hand_500");
    expect(p.unlocked).toContain("big_hand_2000");
    expect(p.unlocked).not.toContain("big_hand_8000");
  });

  it("成就表 id 唯一", () => {
    const ids = new Set(ACHIEVEMENTS.map((a) => a.id));
    expect(ids.size).toBe(ACHIEVEMENTS.length);
  });
});
