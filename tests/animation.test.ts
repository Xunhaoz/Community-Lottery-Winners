import { describe, expect, it } from "vitest";
import { animationPlan } from "../src/ui/drawAnimation";
import type { DrawRecord, Winner } from "../src/core/types";

function draw(winnerCount: number, id = "draw-1"): DrawRecord {
  const tickets = Array.from({ length: 30 }, (_, i) => ({
    id: `t${i}`,
    commentId: `c${i}`,
    authorId: `a${i}`,
    username: `user${i}`,
  }));
  const winners: Winner[] = tickets
    .slice(0, winnerCount)
    .map((t, i) => ({
      ...t,
      prizeId: "p",
      prizeName: "幸運獎",
      position: i + 1,
    }))
    .reverse();
  return {
    id,
    activityId: "a",
    createdAt: "2026-10-27T00:00:00.000Z",
    post: { shortcode: "ABC", url: "https://www.instagram.com/p/ABC/" },
    rules: {
      text: "",
      minTags: 0,
      deadline: null,
      mode: "person",
      repeatWinners: false,
    },
    prizes: [{ id: "p", name: "幸運獎", quantity: winnerCount }],
    comments: [],
    evaluation: { decisions: [], tickets, eligibleAccounts: 30 },
    winners,
    randomAlgorithm: "crypto-u32-rejection-v1",
    demo: false,
  };
}

describe("抽獎動畫時間軸", () => {
  it.each([0, 1, 3, 5, 30])("%i 位得獎者時長落在 5–10 秒", (n) => {
    const plan = animationPlan(draw(n));
    expect(plan.duration).toBeGreaterThanOrEqual(5000);
    expect(plan.duration).toBeLessThanOrEqual(10000);
    expect(plan.reveals).toHaveLength(n);
  });
  it("依名次揭曉，每段不重疊且都停在真正的得獎者", () => {
    const plan = animationPlan(draw(4));
    expect(plan.reveals.map((r) => r.winner.position)).toEqual([1, 2, 3, 4]);
    plan.reveals.forEach((r, i) => {
      expect(r.names.at(-1)).toBe(r.winner.username);
      expect(r.end).toBeGreaterThan(r.start);
      if (i) expect(r.start).toBe(plan.reveals[i - 1].end);
    });
    expect(plan.reveals.at(-1)!.end).toBeLessThan(plan.duration);
  });
  it("同一筆抽獎紀錄每次產生相同畫面，供重播與下載一致", () => {
    expect(animationPlan(draw(3))).toEqual(animationPlan(draw(3)));
    expect(animationPlan(draw(3, "other")).reveals[0].names).not.toEqual(
      animationPlan(draw(3)).reveals[0].names,
    );
  });
});
