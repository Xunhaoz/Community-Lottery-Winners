import { defaultRules } from "../core/types";
import type { Activity, Comment, Page, Post } from "../core/types";
import type { InstagramAdapter } from "./instagram";
import { CrawlError } from "./errors";

export interface CrawlStore {
  saveActivity(a: Activity): Promise<void>;
  commitPage(a: Activity, comments: Comment[]): Promise<void>;
}
export function newActivity(post: Post, demo = false): Activity {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    post,
    createdAt: now,
    updatedAt: now,
    status: "ready",
    tasks: [
      {
        key: "comments",
        parentId: null,
        cursor: null,
        seen: [],
        done: false,
        receivedIds: [],
      },
    ],
    pages: 0,
    commentCount: 0,
    message:
      post.reportedCount === undefined
        ? "已確認貼文，可以開始擷取。"
        : `已確認貼文，Instagram 顯示共 ${post.reportedCount.toLocaleString()} 則留言（含回覆），可以開始擷取。`,
    rules: { ...defaultRules },
    prizes: [{ id: crypto.randomUUID(), name: "幸運獎", quantity: 1 }],
    demo,
  };
}
// The live first-level count once capture has seen it, else the count read when connecting.
export function reportedTotal(activity: Activity): number | undefined {
  return (
    activity.tasks.find((t) => t.parentId === null)?.expected ??
    activity.post.reportedCount
  );
}
// Flat capture has a single task, so task ratios stay at 0% until the end; use the total instead.
export function progressPercent(activity: Activity): number {
  if (activity.status === "complete") return 100;
  const total = reportedTotal(activity),
    hasReplies = activity.tasks.some((t) => t.parentId !== null);
  if (total && !hasReplies)
    return Math.min(99, Math.floor((activity.commentCount / total) * 100));
  return activity.tasks.length
    ? Math.round(
        (activity.tasks.filter((t) => t.done).length / activity.tasks.length) *
          100,
      )
    : 0;
}
export function applyPage(
  activity: Activity,
  taskKey: string,
  page: Page,
): Activity {
  const a = structuredClone(activity),
    task = a.tasks.find((t) => t.key === taskKey);
  if (!task || task.done) throw new CrawlError("schema", "擷取進度不一致。");
  const ids = new Set(task.receivedIds);
  page.comments.forEach((c) => {
    if (c.parentId !== task.parentId)
      throw new CrawlError("schema", "留言層級與分頁不符。");
    ids.add(c.id);
  });
  task.receivedIds = [...ids];
  // Preserve observed reply totals for reference; they do not determine completion.
  // The flat first-level total is the post's live count, so the latest page wins (deletions may lower it).
  task.expected =
    task.parentId === null
      ? (page.expected ?? task.expected)
      : Math.max(task.expected ?? 0, page.expected ?? 0);
  for (const parent of page.replyParents) {
    const existing = a.tasks.find((t) => t.key === `reply:${parent.id}`);
    if (!existing)
      a.tasks.push({
        key: `reply:${parent.id}`,
        parentId: parent.id,
        cursor: null,
        seen: [],
        done: false,
        receivedIds: [],
        expected: parent.expected,
      });
    else if ((parent.expected ?? 0) > (existing.expected ?? 0)) {
      existing.expected = parent.expected;
      if (existing.receivedIds.length < (parent.expected ?? 0))
        existing.done = false;
    }
  }
  a.pages++;
  a.commentCount = new Set(a.tasks.flatMap((t) => t.receivedIds)).size;
  a.updatedAt = new Date().toISOString();
  const cursorStuck =
    page.next !== null &&
    (page.next === task.cursor || task.seen.includes(page.next));
  if (cursorStuck) {
    a.status = "paused";
    a.message = "分頁游標重複，已保存本頁資料；擷取未完成。需檢查 adapter。";
    return a;
  }
  // API counts are informational. Only the pagination flags end a task.
  if (task.cursor) task.seen.push(task.cursor);
  task.cursor = page.next;
  task.done = page.next === null;
  a.status = a.tasks.every((t) => t.done) ? "complete" : "running";
  a.message =
    a.status === "complete"
      ? `可取得的留言與回覆分頁已擷取完成，實際取得 ${a.commentCount.toLocaleString()} 則留言與回覆。`
      : `已儲存 ${a.pages} 頁，${a.commentCount.toLocaleString()}${reportedTotal(a) === undefined ? "" : ` / ${reportedTotal(a)!.toLocaleString()}`} 則留言與回覆。`;
  return a;
}
export function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}
export async function withRetry<T>(
  fn: () => Promise<T>,
  signal: AbortSignal,
  sleep = wait,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof CrawlError) || e.code !== "network" || attempt >= 2)
        throw e;
      await sleep(2000 * (attempt + 1), signal);
    }
  }
}
export async function runCapture(options: {
  activity: Activity;
  adapter: InstagramAdapter;
  store: CrawlStore;
  signal: AbortSignal;
  onUpdate: (a: Activity) => void;
  intervalMs?: number;
  sleep?: typeof wait;
}): Promise<Activity> {
  const { adapter, store, signal, onUpdate } = options,
    sleep = options.sleep ?? wait;
  let a = structuredClone(options.activity);
  if (a.status === "complete" || a.status === "cancelled") return a;
  a.status = "running";
  a.message = "正在擷取；每頁完成後自動儲存。";
  await store.saveActivity(a);
  onUpdate(a);
  try {
    while (!signal.aborted) {
      const task = a.tasks.find((t) => !t.done);
      if (!task)
        throw new CrawlError("schema", "缺少擷取工作，請重新建立活動。");
      await sleep(options.intervalMs ?? 1800, signal);
      const page = await withRetry(
        () =>
          task.parentId === null
            ? adapter.readComments(a.post.shortcode, task.cursor)
            : adapter.readReplies(a.post.shortcode, task.parentId, task.cursor),
        signal,
        sleep,
      );
      // A completed in-flight page is committed atomically even when Pause was pressed.
      const next = applyPage(a, task.key, page);
      await store.commitPage(next, page.comments);
      a = next;
      onUpdate(a);
      if (a.status !== "running") return a;
    }
  } catch (e) {
    a.status = "paused";
    a.message = signal.aborted
      ? "已暫停，進度已保存。連接同一貼文即可續抓。"
      : e instanceof Error
        ? e.message
        : "擷取中斷，進度已保存。";
    a.updatedAt = new Date().toISOString();
    await store.saveActivity(a);
    onUpdate(a);
    return a;
  }
  a.status = "paused";
  a.message = "已暫停，進度已保存。";
  await store.saveActivity(a);
  onUpdate(a);
  return a;
}
