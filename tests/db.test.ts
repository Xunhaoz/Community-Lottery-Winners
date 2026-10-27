import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { database, editor, recordKey, store } from "../src/platform/db";
import { newActivity } from "../src/crawler/runner";
import { createDraw } from "../src/core/draw";
import { evaluate } from "../src/core/rules";
import type { Comment } from "../src/core/types";

describe("本機資料保存", () => {
  it("逐頁原子提交、去重、保留原始資料、分開保存判定與多次抽獎、刪除活動", async () => {
    const a = newActivity({
      shortcode: "test",
      url: "https://www.instagram.com/p/test/",
    });
    const c: Comment = {
      id: "1",
      authorId: "2",
      username: "user",
      text: "原文",
      createdAt: "2026-10-01T00:00:00Z",
      parentId: null,
    };
    await store.commitPage(a, [c]);
    await store.commitPage(a, [{ ...c, text: "較晚出現的編輯" }]);
    expect(await store.comments(a.id)).toEqual([c]);
    a.status = "complete";
    a.tasks[0].done = true;
    await store.saveActivity(a);
    const first = createDraw(a, [c]),
      second = createDraw(a, [c]);
    await store.saveDraw(first);
    await store.saveDraw(second);
    await store.saveEvaluation(a.id, evaluate([c], a.rules));
    expect(await store.draws(a.id)).toHaveLength(2);
    expect(await store.comments(a.id)).toEqual([c]);
    await store.deleteActivity(a.id);
    expect(await store.getActivity(a.id)).toBeUndefined();
    expect(await store.comments(a.id)).toEqual([]);
    expect(await store.draws(a.id)).toEqual([]);
    expect(await (await database()).get("evaluations", a.id)).toBeUndefined();
  });
});
describe("資料維護頁", () => {
  const comments: Comment[] = ["1", "2", "3"].map((n) => ({
    id: `c${n}`,
    authorId: `a${n}`,
    username: `user${n}`,
    text: "hi",
    createdAt: "2026-10-01T00:00:00Z",
    parentId: null,
  }));
  async function seed() {
    const a = newActivity({
      shortcode: "edit",
      url: "https://www.instagram.com/p/edit/",
    });
    a.status = "complete";
    a.tasks[0].done = true;
    a.prizes = [{ id: "p1", name: "幸運獎", quantity: 2 }];
    await store.commitPage(a, comments);
    const draw = createDraw(a, comments);
    await store.saveDraw(draw);
    return { a, draw };
  }
  it("依 keyPath 驗證手動輸入的資料", () => {
    expect(recordKey("comments", { activityId: "x", id: "1" })).toEqual([
      "x",
      "1",
    ]);
    expect(recordKey("evaluations", { activityId: "x" })).toBe("x");
    expect(() => recordKey("comments", { id: "1" })).toThrow("activityId");
    expect(() => recordKey("draws", { id: "d" })).toThrow("activityId");
    expect(() => recordKey("activities", [])).toThrow("JSON 物件");
  });
  it("列出、覆寫、改 key 搬移與刪除單筆資料", async () => {
    const { a } = await seed();
    const list = await editor.list("comments", a.id);
    expect(list.map((r) => r.key)).toContainEqual([a.id, "c1"]);
    expect(await editor.list("comments")).toEqual([]);
    const edited = { ...list[0].value, text: "官方修改" };
    await editor.put("comments", edited, list[0].key);
    expect(
      (await store.comments(a.id)).find((c) => c.id === list[0].value.id)?.text,
    ).toBe("官方修改");
    const moved = await editor.put(
      "comments",
      { ...edited, id: "c9" },
      list[0].key,
    );
    expect(moved).toEqual([a.id, "c9"]);
    const ids = (await store.comments(a.id)).map((c) => c.id);
    expect(ids).toContain("c9");
    expect(ids).not.toContain(list[0].value.id);
    await editor.remove("comments", moved);
    expect(await store.comments(a.id)).toHaveLength(2);
  });
  it("替換得獎者只接受該次籤池、保留獎項與名次", async () => {
    const { draw } = await seed();
    const [first, second] = draw.winners;
    const spare = draw.evaluation.tickets.find(
      (t) => !draw.winners.some((w) => w.id === t.id),
    )!;
    await expect(
      editor.replaceWinner(draw.id, first.position, "not-a-ticket"),
    ).rejects.toThrow("籤池");
    await expect(
      editor.replaceWinner(draw.id, first.position, second.id),
    ).rejects.toThrow("其他名次");
    await expect(editor.replaceWinner(draw.id, 99, spare.id)).rejects.toThrow(
      "第 99 位",
    );
    const winner = await editor.replaceWinner(
      draw.id,
      first.position,
      spare.id,
    );
    expect(winner).toEqual({
      ...spare,
      prizeId: first.prizeId,
      prizeName: first.prizeName,
      position: first.position,
    });
    const saved = (await store.draws(draw.activityId))[0];
    expect(saved.winners[0]).toEqual(winner);
    expect(saved.winners[1]).toEqual(second);
  });
});
