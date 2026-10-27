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
export type StoreName = "activities" | "comments" | "evaluations" | "draws";
export const storeNames: StoreName[] = [
  "activities",
  "comments",
  "evaluations",
  "draws",
];
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

export interface EditorRecord {
  key: IDBValidKey;
  value: Record<string, unknown>;
}
const text = (v: unknown) => typeof v === "string" && v.length > 0;
// Mirrors each store's keyPath so a hand-edited record is rejected before it reaches IndexedDB.
export function recordKey(name: StoreName, value: unknown): IDBValidKey {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("資料必須是 JSON 物件。");
  const v = value as Record<string, unknown>;
  if (name === "comments") {
    if (!text(v.activityId) || !text(v.id))
      throw new Error("留言需要非空字串的 activityId 與 id。");
    return [v.activityId as string, v.id as string];
  }
  const field = name === "evaluations" ? "activityId" : "id";
  if (!text(v[field])) throw new Error(`${name} 需要非空字串的 ${field}。`);
  if (name === "draws" && !text(v.activityId))
    throw new Error("抽獎紀錄需要非空字串的 activityId。");
  return v[field] as string;
}
const sameKey = (a: IDBValidKey, b: IDBValidKey) =>
  JSON.stringify(a) === JSON.stringify(b);
// Direct, untracked edits for maintenance. Callers hold the writer lock.
export const editor = {
  async list(name: StoreName, activityId?: string): Promise<EditorRecord[]> {
    const db = await database();
    const values: unknown[] =
      name === "activities"
        ? await db.getAll("activities")
        : !activityId
          ? []
          : name === "evaluations"
            ? [await db.get("evaluations", activityId)].filter(Boolean)
            : await db.getAllFromIndex(name, "activity", activityId);
    return values.map((value) => ({
      key: recordKey(name, value),
      value: value as Record<string, unknown>,
    }));
  },
  // Saving under a different key moves the record: the old key is removed in the same transaction.
  async put(name: StoreName, value: unknown, previousKey?: IDBValidKey) {
    const key = recordKey(name, value),
      tx = (await database()).transaction(name, "readwrite"),
      // idb's per-store generics don't accept a union name; the shape is the same for all four.
      target = tx.objectStore(name) as unknown as {
        put(value: unknown): Promise<IDBValidKey>;
        delete(key: IDBValidKey): Promise<void>;
      };
    await target.put(structuredClone(value));
    if (previousKey !== undefined && !sameKey(previousKey, key))
      await target.delete(previousKey);
    await tx.done;
    return key;
  },
  async remove(name: StoreName, key: IDBValidKey) {
    await (await database()).delete(name, key as never);
  },
  // The replacement must be a ticket from this draw's own pool, and must respect the draw's repeat rule.
  async replaceWinner(drawId: string, position: number, ticketId: string) {
    const db = await database(),
      tx = db.transaction("draws", "readwrite"),
      draw = await tx.store.get(drawId);
    if (!draw) throw new Error("找不到這筆抽獎紀錄。");
    const index = draw.winners.findIndex((w) => w.position === position),
      ticket = draw.evaluation.tickets.find((t) => t.id === ticketId);
    if (index < 0) throw new Error(`找不到第 ${position} 位得獎者。`);
    if (!ticket) throw new Error("這張籤不在該次抽獎的籤池中。");
    const others = draw.winners.filter((_, i) => i !== index);
    if (others.some((w) => w.id === ticket.id))
      throw new Error("這張籤已經是其他名次的得獎者。");
    if (
      !draw.rules.repeatWinners &&
      others.some((w) => w.authorId === ticket.authorId)
    )
      throw new Error("此次抽獎不允許同帳號重複得獎，該帳號已在其他名次。");
    const old = draw.winners[index];
    draw.winners[index] = {
      ...ticket,
      prizeId: old.prizeId,
      prizeName: old.prizeName,
      position: old.position,
    };
    await tx.store.put(draw);
    await tx.done;
    return draw.winners[index];
  },
};
