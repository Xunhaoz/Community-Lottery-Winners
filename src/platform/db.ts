import { openDB, type DBSchema } from "idb";
import type { Activity, Comment, DrawRecord, Evaluation } from "../core/types";

interface Database extends DBSchema {
  activities: { key: string; value: Activity };
  comments: {
    key: [string, string];
    value: Comment & { activityId: string };
    indexes: { activity: string };
  };
  evaluations: {
    key: string;
    value: { activityId: string; at: string; evaluation: Evaluation };
  };
  draws: { key: string; value: DrawRecord; indexes: { activity: string } };
}
export const database = () =>
  openDB<Database>("community-lottery-v1", 1, {
    upgrade(db) {
      db.createObjectStore("activities", { keyPath: "id" });
      db.createObjectStore("comments", {
        keyPath: ["activityId", "id"],
      }).createIndex("activity", "activityId");
      db.createObjectStore("evaluations", { keyPath: "activityId" });
      db.createObjectStore("draws", { keyPath: "id" }).createIndex(
        "activity",
        "activityId",
      );
    },
  });
export const store = {
  async listActivities() {
    return (await (await database()).getAll("activities")).sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
  },
  async getActivity(id: string) {
    return (await database()).get("activities", id);
  },
  async saveActivity(a: Activity) {
    await (await database()).put("activities", structuredClone(a));
  },
  async commitPage(a: Activity, comments: Comment[]) {
    const db = await database(),
      tx = db.transaction(["activities", "comments"], "readwrite");
    for (const c of comments) {
      // Raw records are immutable after the first observation, including overlapping pages.
      const existing = await tx.objectStore("comments").get([a.id, c.id]);
      if (
        existing &&
        (existing.authorId !== c.authorId || existing.parentId !== c.parentId)
      ) {
        tx.abort();
        throw new Error("同一留言 ID 的作者或層級衝突，已保留原資料。");
      }
      if (!existing)
        await tx.objectStore("comments").put({ ...c, activityId: a.id });
    }
    await tx.objectStore("activities").put(structuredClone(a));
    await tx.done;
  },
  async comments(id: string): Promise<Comment[]> {
    return (
      await (await database()).getAllFromIndex("comments", "activity", id)
    ).map(({ activityId: _, ...c }) => c);
  },
  async saveEvaluation(activityId: string, evaluation: Evaluation) {
    await (
      await database()
    ).put("evaluations", {
      activityId,
      at: new Date().toISOString(),
      evaluation: structuredClone(evaluation),
    });
  },
  async saveDraw(draw: DrawRecord) {
    await (await database()).add("draws", structuredClone(draw));
  },
  async draws(id: string) {
    return (
      await (await database()).getAllFromIndex("draws", "activity", id)
    ).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },
  async deleteActivity(id: string) {
    const db = await database(),
      tx = db.transaction(
        ["activities", "comments", "evaluations", "draws"],
        "readwrite",
      );
    await tx.objectStore("activities").delete(id);
    await tx.objectStore("evaluations").delete(id);
    for (const key of await tx
      .objectStore("comments")
      .index("activity")
      .getAllKeys(id))
      await tx.objectStore("comments").delete(key);
    for (const key of await tx
      .objectStore("draws")
      .index("activity")
      .getAllKeys(id))
      await tx.objectStore("draws").delete(key);
    await tx.done;
  },
};
