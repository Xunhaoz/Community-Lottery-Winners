import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { database, store } from "../src/platform/db";
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
