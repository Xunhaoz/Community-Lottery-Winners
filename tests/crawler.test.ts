import { describe, expect, it, vi } from "vitest";
import type { Activity, Comment, Page } from "../src/core/types";
import {
  applyPage,
  newActivity,
  progressPercent,
  reportedTotal,
  runCapture,
  withRetry,
  type CrawlStore,
} from "../src/crawler/runner";
import {
  createInstagramAdapter,
  isWebCursor,
  legacyVariables,
  parsePage,
  parseWebPage,
  parsePostUrl,
  mediaIdFromShortcode,
  webVariables,
  type InstagramAdapter,
} from "../src/crawler/instagram";
import { classifyResponse, CrawlError } from "../src/crawler/errors";

const comment = (id: string, parentId: string | null = null): Comment => ({
  id,
  parentId,
  authorId: "1",
  username: "user",
  text: "@a",
  createdAt: "2026-10-01T00:00:00.000Z",
});
const page = (
  ids: string[],
  next: string | null = null,
  parentId: string | null = null,
): Page => ({
  comments: ids.map((id) => comment(id, parentId)),
  next,
  replyParents: parentId ? [] : ids.map((id) => ({ id })),
});
const activity = () =>
  newActivity({ shortcode: "ABC", url: "https://www.instagram.com/p/ABC/" });
function memoryStore() {
  let saved: Activity | undefined;
  const raw = new Map<string, Comment>();
  const store: CrawlStore = {
    saveActivity: async (a) => {
      saved = structuredClone(a);
    },
    commitPage: async (a, comments) => {
      comments.forEach((c) => raw.set(c.id, c));
      saved = structuredClone(a);
    },
  };
  return {
    store,
    raw,
    get saved() {
      return saved!;
    },
  };
}
const noWait = async () => {};
const adapter = (
  readComments: InstagramAdapter["readComments"],
  readReplies: InstagramAdapter["readReplies"] = async (_, parent) =>
    page([], null, parent),
): InstagramAdapter => ({
  readPost: async () => activity().post,
  readComments,
  readReplies,
});
describe("爬蟲排程", () => {
  it("空留言正確完成", async () => {
    const m = memoryStore();
    const a = await runCapture({
      activity: activity(),
      adapter: adapter(async () => page([])),
      store: m.store,
      signal: new AbortController().signal,
      onUpdate: () => {},
      sleep: noWait,
    });
    expect(a.status).toBe("complete");
    expect(a.commentCount).toBe(0);
  });
  it("多頁留言、多頁回覆、跨頁重複去重，最後一個回覆完成才完成", async () => {
    const m = memoryStore(),
      updates: string[] = [];
    const a = await runCapture({
      activity: activity(),
      adapter: adapter(
        async (_, cursor) =>
          cursor ? page(["2", "3"]) : page(["1", "2"], "next"),
        async (_, parent, cursor) =>
          parent === "1"
            ? cursor
              ? page(["11", "12"], null, parent)
              : page(["11"], "r2", parent)
            : page([], null, parent),
      ),
      store: m.store,
      signal: new AbortController().signal,
      onUpdate: (a) => updates.push(a.status),
      sleep: noWait,
    });
    expect(a.status).toBe("complete");
    expect(a.commentCount).toBe(5);
    expect(m.raw.size).toBe(5);
    expect(a.pages).toBe(6);
    expect(updates.filter((x) => x === "complete")).toHaveLength(1);
  });
  it("暫停後從已提交游標續抓", async () => {
    const m = memoryStore(),
      controller = new AbortController(),
      reads: (string | null)[] = [];
    const mock = adapter(async (_, cursor) => {
      reads.push(cursor);
      return cursor ? page(["2"]) : page(["1"], "next");
    });
    const first = await runCapture({
      activity: activity(),
      adapter: mock,
      store: m.store,
      signal: controller.signal,
      onUpdate: (a) => {
        if (a.pages === 1) controller.abort();
      },
      sleep: noWait,
    });
    expect(first.status).toBe("paused");
    expect(m.saved.tasks[0].cursor).toBe("next");
    const last = await runCapture({
      activity: m.saved,
      adapter: mock,
      store: m.store,
      signal: new AbortController().signal,
      onUpdate: () => {},
      sleep: noWait,
    });
    expect(last.status).toBe("complete");
    expect(reads).toEqual([null, "next"]);
  });
  it("游標卡住仍保存該頁，但標示未完成", () => {
    const a = applyPage(activity(), "comments", page(["1"], "next"));
    const stopped = applyPage(a, "comments", page(["2"], "next"));
    expect(stopped.status).toBe("paused");
    expect(stopped.commentCount).toBe(2);
    expect(stopped.tasks[0].done).toBe(false);
  });
  it("辨識非相鄰重複游標", () => {
    let a = applyPage(activity(), "comments", page(["1"], "a"));
    a = applyPage(a, "comments", page(["2"], "b"));
    expect(applyPage(a, "comments", page(["3"], "a")).status).toBe("paused");
  });
  it("回覆數不足不能完成", () => {
    const p = page(["1"]);
    p.replyParents[0].expected = 3;
    const a = applyPage(activity(), "comments", p),
      stopped = applyPage(a, "reply:1", page(["11"], null, "1"));
    expect(stopped.status).toBe("paused");
    expect(stopped.message).toContain("回覆數不足");
  });
  const flat = (ids: string[], next: string | null, expected: number) => ({
    ...page(ids, next),
    replyParents: [],
    expected,
  });
  it("平鋪留言數達到 count 才完成，且不建立回覆工作", () => {
    let a = applyPage(activity(), "comments", flat(["1", "2"], "c1", 3));
    a = applyPage(a, "comments", flat(["3"], null, 3));
    expect(a.status).toBe("complete");
    expect(a.tasks).toHaveLength(1);
  });
  it("平鋪留言數不足時暫停，續抓從第一頁重新核對", () => {
    let a = applyPage(activity(), "comments", flat(["1", "2"], "c1", 4));
    a = applyPage(a, "comments", flat(["3"], null, 4));
    expect(a.status).toBe("paused");
    expect(a.message).toContain("留言數不足（3/4）");
    expect(a.tasks[0]).toMatchObject({ cursor: null, seen: [], done: false });
    // A comment that landed behind the cursor shows up on the second pass.
    a = applyPage(a, "comments", flat(["1", "4"], "c1", 4));
    a = applyPage(a, "comments", flat(["3"], null, 4));
    expect(a.status).toBe("complete");
    expect(a.commentCount).toBe(4);
  });
  it("平鋪 count 以最新一頁為準，刪除留言不會卡住", () => {
    let a = applyPage(activity(), "comments", flat(["1"], "c1", 3));
    a = applyPage(a, "comments", flat(["2"], null, 2));
    expect(a.status).toBe("complete");
  });
  it("連接時即顯示 IG 總留言數，擷取中顯示進度比例", () => {
    const a = newActivity({
      shortcode: "ABC",
      url: "https://www.instagram.com/p/ABC/",
      reportedCount: 1578,
    });
    expect(a.message).toContain("共 1,578 則留言");
    expect(reportedTotal(a)).toBe(1578);
    expect(progressPercent(a)).toBe(0);
    const next = applyPage(a, "comments", flat(["1", "2"], "c1", 4));
    expect(next.message).toContain("2 / 4 則");
    expect(reportedTotal(next)).toBe(4);
    expect(progressPercent(next)).toBe(50);
    expect(newActivity(activity().post).message).not.toContain("共");
  });
  it("平鋪查詢經 runCapture 走完全部分頁", async () => {
    const m = memoryStore(),
      reads: (string | null)[] = [];
    const a = await runCapture({
      activity: activity(),
      adapter: adapter(async (_, cursor) => {
        reads.push(cursor);
        return cursor ? flat(["3"], null, 3) : flat(["1", "2"], "c1", 3);
      }),
      store: m.store,
      signal: new AbortController().signal,
      onUpdate: () => {},
      sleep: noWait,
    });
    expect(a.status).toBe("complete");
    expect(reads).toEqual([null, "c1"]);
    expect(m.raw.size).toBe(3);
  });
  it.each(["rate-limit", "login", "challenge", "source", "schema"] as const)(
    "%s 暫停、不反覆重試，保留已提交資料",
    async (code) => {
      const m = memoryStore(),
        reply = vi.fn(async () => {
          throw new CrawlError(code, code);
        });
      const a = await runCapture({
        activity: activity(),
        adapter: adapter(async () => page(["1"]), reply),
        store: m.store,
        signal: new AbortController().signal,
        onUpdate: () => {},
        sleep: noWait,
      });
      expect(a.status).toBe("paused");
      expect(m.raw.size).toBe(1);
      expect(reply).toHaveBeenCalledTimes(1);
      expect(a.tasks.some((t) => !t.done)).toBe(true);
    },
  );
  it("網路錯誤最多三次，成功可續抓", async () => {
    let attempts = 0;
    const fn = async () => {
      if (++attempts < 3) throw new CrawlError("network", "暫時失敗");
      return 42;
    };
    expect(await withRetry(fn, new AbortController().signal, noWait)).toBe(42);
    expect(attempts).toBe(3);
    const failed = vi.fn(async () => {
      throw new CrawlError("network", "失敗");
    });
    await expect(
      withRetry(failed, new AbortController().signal, noWait),
    ).rejects.toThrow();
    expect(failed).toHaveBeenCalledTimes(3);
  });
  it("已取消工作不再發出請求", async () => {
    const a = activity();
    a.status = "cancelled";
    const read = vi.fn();
    const m = memoryStore();
    await runCapture({
      activity: a,
      adapter: adapter(read),
      store: m.store,
      signal: new AbortController().signal,
      onUpdate: () => {},
    });
    expect(read).not.toHaveBeenCalled();
  });
  it("儲存失敗不推進游標，不會略過尚未落盤的資料", async () => {
    const m = memoryStore();
    const fail = {
      ...m.store,
      commitPage: async () => {
        throw new Error("儲存空間不足");
      },
    };
    const a = await runCapture({
      activity: activity(),
      adapter: adapter(async () => page(["1"], "next")),
      store: fail,
      signal: new AbortController().signal,
      onUpdate: () => {},
      sleep: noWait,
    });
    expect(a.status).toBe("paused");
    expect(a.pages).toBe(0);
    expect(a.tasks[0].cursor).toBeNull();
    expect(m.raw.size).toBe(0);
  });
});
describe("2026 Instagram 網頁 GraphQL", () => {
  const node = {
    pk: "123",
    user: { pk: "456", username: "test" },
    text: "hello",
    created_at: 1790812800,
    child_comment_count: 2,
  };
  const connection = {
    edges: [{ node }],
    page_info: {
      has_next_page: true,
      end_cursor: "opaque",
      has_previous_page: false,
      start_cursor: null,
    },
  };
  it("使用 BigInt 精確轉换測試貼文的 media ID", () =>
    expect(mediaIdFromShortcode("DWqsPa7D2RL")).toBe("3867097803797783627"));
  it("第一層與回覆每頁要求 50 筆；游標保留不解析 IG 內容", () => {
    expect(
      webVariables({
        kind: "comments",
        shortcode: "DWqsPa7D2RL",
        cursor: '{"direction":"after","value":"opaque"}',
      }),
    ).toMatchObject({
      first: 50,
      media_id: "3867097803797783627",
      after: "opaque",
      before: null,
      sort_order: "popular",
    });
    expect(
      webVariables({
        kind: "replies",
        shortcode: "DWqsPa7D2RL",
        parentId: "123",
        cursor: '{"direction":"before","value":"older"}',
      }),
    ).toMatchObject({
      first: null,
      last: 50,
      parent_comment_id: "123",
      before: "older",
    });
  });
  it("正規化現行欄位與回覆工作", () => {
    const p = parseWebPage(connection, null);
    expect(p.comments[0]).toMatchObject({
      id: "123",
      authorId: "456",
      username: "test",
    });
    expect(p.next).toBe('{"direction":"after","value":"opaque"}');
    expect(p.replyParents).toEqual([{ id: "123", expected: 2 }]);
  });
  it("明確零回覆跳過、缺少回覆數仍建立工作", () => {
    expect(
      parseWebPage(
        {
          ...connection,
          edges: [{ node: { ...node, child_comment_count: 0 } }],
        },
        null,
      ).replyParents,
    ).toEqual([]);
    expect(
      parseWebPage(
        {
          ...connection,
          edges: [{ node: { ...node, child_comment_count: null } }],
        },
        null,
      ).replyParents,
    ).toHaveLength(1);
  });
  it("支援向前與向後游標，雙向未完成時拒絕誤判完整", () => {
    expect(
      parseWebPage(
        {
          ...connection,
          page_info: {
            has_next_page: false,
            has_previous_page: true,
            start_cursor: "older",
          },
        },
        "1",
      ).next,
    ).toBe('{"direction":"before","value":"older"}');
    expect(() =>
      parseWebPage(
        {
          ...connection,
          page_info: { ...connection.page_info, has_previous_page: true },
        },
        "1",
      ),
    ).toThrow();
    expect(() =>
      parseWebPage({ ...connection, page_info: { has_next_page: false } }, "1"),
    ).toThrow();
  });
  it("回覆父留言不相符則停止", () =>
    expect(() =>
      parseWebPage(
        {
          ...connection,
          edges: [{ node: { ...node, parent_comment_id: "999" } }],
        },
        "123",
      ),
    ).toThrow());
  it("續抓時忽略已走過方向的分頁旗標，不誤判卡住", () => {
    const both = {
      ...connection,
      page_info: {
        ...connection.page_info,
        has_previous_page: true,
        start_cursor: "previous",
      },
    };
    expect(
      parseWebPage(both, null, '{"direction":"after","value":"first"}').next,
    ).toContain("after");
    expect(
      parseWebPage(both, "1", '{"direction":"before","value":"last"}').next,
    ).toContain("before");
    expect(
      parseWebPage(
        { ...both, page_info: { ...both.page_info, has_next_page: false } },
        null,
        '{"direction":"after","value":"first"}',
      ).next,
    ).toBeNull();
  });
  it("adapter 讀取現行第一層與回覆 connection", async () => {
    const transport = vi.fn(async (req) => ({
      data: {
        [req.kind === "replies"
          ? "xdt_api__v1__media__media_id__comments__parent_comment_id__child_comments__connection"
          : "xdt_api__v1__media__media_id__comments__connection"]: connection,
      },
    }));
    const ig = createInstagramAdapter(transport);
    expect((await ig.readPost("DWqsPa7D2RL")).id).toBe("3867097803797783627");
    expect((await ig.readComments("DWqsPa7D2RL", null)).comments).toHaveLength(
      1,
    );
    expect(
      (await ig.readReplies("DWqsPa7D2RL", "1", null)).comments[0].parentId,
    ).toBe("1");
  });
});
describe("Instagram adapter", () => {
  const node = {
    id: "123",
    text: "hello",
    created_at: 1790812800,
    owner: { id: "456", username: "user" },
    edge_threaded_comments: { count: 2, edges: [] },
  };
  const connection = {
    edges: [{ node }],
    count: 1,
    page_info: { has_next_page: true, end_cursor: "next" },
  };
  it("正規化留言、父留言與回覆待辦，未假設 preview 完整", () => {
    const p = parsePage(connection, null);
    expect(p.next).toBe("next");
    expect(p.comments[0].authorId).toBe("456");
    expect(p.replyParents).toEqual([{ id: "123", expected: 2 }]);
    expect(parsePage(connection, "999").comments[0].parentId).toBe("999");
    const noReplyMetadata = { ...node, edge_threaded_comments: undefined };
    expect(
      parsePage({ ...connection, edges: [{ node: noReplyMetadata }] }, null)
        .replyParents,
    ).toEqual([{ id: "123", expected: undefined }]);
  });
  it("缺少分頁資訊、缺少下一頁游標或不精確 ID 即停止", () => {
    expect(() => parsePage({ edges: [] }, null)).toThrow();
    expect(() =>
      parsePage(
        { ...connection, page_info: { has_next_page: true, end_cursor: null } },
        null,
      ),
    ).toThrow();
    expect(() =>
      parsePage(
        {
          ...connection,
          edges: [{ node: { ...node, id: 99999999999999999 } }],
        },
        null,
      ),
    ).toThrow();
  });
  it("三個隔離介面傳入正確貼文、父留言與游標", async () => {
    const transport = vi.fn(async (request) =>
      request.kind === "replies"
        ? {
            data: {
              comment: { id: "123", edge_threaded_comments: connection },
            },
          }
        : {
            data: {
              shortcode_media: {
                id: "789",
                shortcode: "ABC",
                edge_media_to_comment: connection,
              },
            },
          },
    );
    const ig = createInstagramAdapter(transport);
    expect((await ig.readPost("ABC")).id).toBe("789");
    await ig.readComments("ABC", "next");
    await ig.readReplies("ABC", "123", "replyNext");
    expect(transport.mock.calls[2][0]).toEqual({
      kind: "replies",
      shortcode: "ABC",
      parentId: "123",
      cursor: "replyNext",
    });
  });
  it("平鋪 edge_media_to_comment 不建立回覆工作，count 作為完整性目標", () => {
    const p = parsePage({ ...connection, count: 1578 }, null, false);
    expect(p.replyParents).toEqual([]);
    expect(p.expected).toBe(1578);
    expect(parsePage({ ...connection, count: 1578 }, null).expected).toBe(
      undefined,
    );
  });
  it("adapter 讀取平鋪查詢與 parent 階層查詢", async () => {
    const flatIg = createInstagramAdapter(async () => ({
      data: {
        shortcode_media: {
          edge_media_to_comment: { ...connection, count: 1578 },
        },
      },
    }));
    expect((await flatIg.readPost("ABC")).reportedCount).toBe(1578);
    const flatPage = await flatIg.readComments("ABC", null);
    expect(flatPage).toMatchObject({ replyParents: [], expected: 1578 });
    const threadedIg = createInstagramAdapter(async () => ({
      data: { shortcode_media: { edge_media_to_parent_comment: connection } },
    }));
    expect(
      (await threadedIg.readComments("ABC", null)).replyParents,
    ).toHaveLength(1);
  });
  it("平鋪查詢變數：每頁 50 筆，第一頁不帶 after", () => {
    expect(legacyVariables({ kind: "comments", shortcode: "ABC" })).toEqual({
      shortcode: "ABC",
      first: 50,
    });
    expect(
      legacyVariables({ kind: "comments", shortcode: "ABC", cursor: "opaque" }),
    ).toEqual({ shortcode: "ABC", first: 50, after: "opaque" });
  });
  it("只把包裝過的 web 游標導向舊查詢，IG 原生 JSON 游標仍走平鋪", () => {
    expect(isWebCursor('{"direction":"after","value":"x"}')).toBe(true);
    expect(
      isWebCursor('{"cached_comments_cursor":"1","bifilter_token":"a"}'),
    ).toBe(false);
    expect(isWebCursor("QVFC")).toBe(false);
    expect(isWebCursor(null)).toBe(false);
  });
  it("來源貼文切換停止", async () => {
    const ig = createInstagramAdapter(async () => ({
      data: {
        shortcode_media: {
          shortcode: "OTHER",
          edge_media_to_comment: connection,
        },
      },
    }));
    await expect(ig.readPost("ABC")).rejects.toThrow("來源不符");
  });
  it.each([
    "https://evil.com/p/ABC/",
    "https://www.instagram.com.evil.com/p/ABC/",
    "javascript:alert(1)",
    "https://www.instagram.com/direct/inbox/",
    "https://u:p@www.instagram.com/p/ABC/",
  ])("拒絕非貼文來源 %s", (url) => expect(() => parsePostUrl(url)).toThrow());
  it("正規化貼文連結且移除追蹤參數", () =>
    expect(
      parsePostUrl("https://instagram.com/reel/ABC/?igsh=secret").url,
    ).toBe("https://www.instagram.com/reel/ABC/"));
  it.each([
    [429, {}, "rate-limit"],
    [401, {}, "login"],
    [403, {}, "login"],
    [200, { challenge: {} }, "challenge"],
    [200, { errors: [{}] }, "schema"],
    [500, {}, "network"],
  ])("HTTP/GraphQL 錯誤分類 %s", (status, body, code) => {
    try {
      classifyResponse(status as number, body);
      throw new Error("未停止");
    } catch (e) {
      expect((e as CrawlError).code).toBe(code);
    }
  });
});
