import { describe, expect, it } from "vitest";
import { evaluate, parseTags, taipeiToUtc } from "../src/core/rules";
import {
  createDraw,
  drawProblem,
  randomIndex,
  selectWinners,
} from "../src/core/draw";
import { commentsCsv, csv, winnersCsv } from "../src/core/csv";
import { defaultRules, type Comment, type Rules } from "../src/core/types";
import { newActivity } from "../src/crawler/runner";

const c = (
  id: string,
  text: string,
  extra: Partial<Comment> = {},
): Comment => ({
  id,
  authorId: "100",
  username: "owner",
  text,
  createdAt: "2026-10-01T00:00:00.000Z",
  parentId: null,
  ...extra,
});
const weighted: Rules = { ...defaultRules, mode: "friends", minTags: 2 };
describe("資格與籤數", () => {
  it("Tag 不分大小寫、排除自我與重複 Tag，支援標點", () => {
    expect(
      parseTags("@A @a @OWNER，@b.c！ mail@user.com /@url @D", "Owner"),
    ).toEqual(["a", "b.c", "d"]);
  });
  it.each(["person", "friends"] as const)(
    "%s 模式可切換自己是否計入 Tag，且不分大小寫",
    (mode) => {
      const comments = [
        c("1", "@Me @friend", { username: "me" }),
        c("2", "@me @other", { username: "me" }),
      ];
      const rules = { ...defaultRules, mode, minTags: 2 };
      const excluded = evaluate(comments, rules);
      expect(excluded.tickets).toHaveLength(0);
      expect(excluded.decisions[0].tags).toEqual(["friend"]);
      const allowed = evaluate(comments, { ...rules, excludeSelfTags: false });
      expect(allowed.tickets).toHaveLength(1);
      expect(allowed.decisions[0].tags).toEqual(["me", "friend"]);
      expect(
        evaluate(comments, { ...rules, excludeSelfTags: undefined }).tickets,
      ).toHaveLength(0);
    },
  );
  it("只從本文取得 Tag，不從回覆對象或其他欄位推測", () =>
    expect(
      evaluate([c("1", "沒有標註", { parentId: "200" })], weighted).tickets,
    ).toHaveLength(0));
  it("指定文字為字面包含，保留大小寫", () => {
    const result = evaluate(
      [c("1", "參加[a.b]"), c("2", "參加aXb", { authorId: "200" })],
      { ...defaultRules, text: "[a.b]" },
    );
    expect(result.tickets.map((t) => t.id)).toEqual(["1"]);
  });
  it("台北輸入轉 UTC，截止當下納入、晚一毫秒排除", () => {
    const deadline = taipeiToUtc("2026-10-01T08:00:00");
    expect(deadline).toBe("2026-10-01T00:00:00.000Z");
    expect(
      evaluate(
        [c("1", ""), c("2", "", { createdAt: "2026-10-01T00:00:00.001Z" })],
        { ...defaultRules, deadline },
      ).decisions.map((d) => d.eligible),
    ).toEqual([true, false]);
    expect(() => taipeiToUtc("2026-02-30T00:00")).toThrow();
  });
  it("一般模式不要求 Tag，至少一則合格即可一人一籤", () => {
    const result = evaluate(
      [c("1", "不符"), c("2", "合格"), c("3", "合格", { parentId: "1" })],
      { ...defaultRules, text: "合格" },
    );
    expect(result.eligibleAccounts).toBe(1);
    expect(result.tickets.map((t) => t.id)).toEqual(["2"]);
    expect(result.decisions[2].eligible).toBe(true);
    expect(result.decisions[2].ticket).toBe(false);
  });
  it("新朋友範例 AB / AC / CD = 1 / 0 / 1，未達門檻不消耗朋友", () => {
    const result = evaluate(
      [c("1", "@A @B"), c("2", "@A @C"), c("3", "@C @D", { parentId: "1" })],
      weighted,
    );
    expect(result.decisions.map((d) => d.ticket)).toEqual([true, false, true]);
    expect(result.decisions[2].newTags).toEqual(["c", "d"]);
  });
  it("取得籤的留言消耗全部有效 Tag，非只消耗最低門檻", () => {
    expect(
      evaluate(
        [c("1", "@a @b @c"), c("2", "@c @d"), c("3", "@d @e")],
        weighted,
      ).tickets.map((t) => t.id),
    ).toEqual(["1", "3"]);
  });
  it("資格不合格不消耗朋友；帳號 ID 相同，即使更名仍共用籤", () => {
    const result = evaluate(
      [
        c("1", "@a @b"),
        c("2", "yes @a @b", { username: "renamed" }),
        c("3", "yes @a @b"),
      ],
      { ...weighted, text: "yes" },
    );
    expect(result.tickets.map((t) => t.id)).toEqual(["2"]);
  });
  it("依時間、同時間 ID 排序，資料取得順序不影響結果", () => {
    const items = [c("3", "@c @d"), c("1", "@a @b"), c("2", "@a @c")];
    expect(evaluate(items, weighted)).toEqual(
      evaluate([...items].reverse(), weighted),
    );
    expect(evaluate(items, weighted).tickets.map((t) => t.id)).toEqual([
      "1",
      "3",
    ]);
  });
  it("跨頁重複留言 ID 不重複出票", () =>
    expect(
      evaluate([c("1", "@a @b"), c("1", "@a @b")], weighted).tickets,
    ).toHaveLength(1));
  it.each([-1, 0.5, NaN])("拒絕無效 Tag 數 %s", (minTags) =>
    expect(() => evaluate([], { ...defaultRules, minTags })).toThrow(),
  );
  it("新朋友模式不可設定零門檻", () =>
    expect(() => evaluate([], { ...weighted, minTags: 0 })).toThrow());
});
describe("抽獎", () => {
  const tickets = evaluate(
    [c("1", "@a @b"), c("2", "@c @d"), c("3", "@a @b", { authorId: "200" })],
    weighted,
  ).tickets;
  const prizes = [
    { id: "a", name: "頭獎", quantity: 1 },
    { id: "b", name: "二獎", quantity: 1 },
  ];
  it("獎項依序抽取，單次得獎移除該帳號全部籤", () => {
    const seen: number[] = [];
    const winners = selectWinners(tickets, prizes, false, (n) => {
      seen.push(n);
      return 0;
    });
    expect(seen).toEqual([3, 1]);
    expect(winners.map((w) => w.authorId)).toEqual(["100", "200"]);
    expect(winners.map((w) => w.prizeName)).toEqual(["頭獎", "二獎"]);
    expect(tickets).toHaveLength(3);
  });
  it("允許重複得獎時每張籤僅使用一次", () => {
    const winners = selectWinners(
      tickets,
      [{ id: "a", name: "獎品", quantity: 3 }],
      true,
      () => 0,
    );
    expect(new Set(winners.map((w) => w.id)).size).toBe(3);
    expect(winners.filter((w) => w.authorId === "100")).toHaveLength(2);
  });
  it("缺額以可用帳號或籤數計算", () => {
    const evaluation = { ...evaluate([], defaultRules), tickets };
    const p = [{ id: "a", name: "獎", quantity: 4 }];
    expect(drawProblem(evaluation, defaultRules, p)).toContain("缺少 2");
    expect(
      drawProblem(evaluation, { ...defaultRules, repeatWinners: true }, p),
    ).toContain("缺少 1");
  });
  it.each([0, -1, 1.5, NaN, Infinity])("拒絕不合法獎項數量 %s", (quantity) =>
    expect(() =>
      selectWinners(tickets, [{ id: "a", name: "獎", quantity }], true),
    ).toThrow(),
  );
  it("拒絕空白獎名與沒有獎項", () => {
    expect(() => selectWinners(tickets, [], false)).toThrow();
    expect(() =>
      selectWinners(tickets, [{ id: "a", name: " ", quantity: 1 }], false),
    ).toThrow();
  });
  it("拒絕取樣排除模除偏差", () => {
    const values = [0xffffffff, 5];
    let calls = 0;
    expect(
      randomIndex(3, (a) => {
        a[0] = values[calls++];
        return a;
      }),
    ).toBe(2);
    expect(calls).toBe(2);
    expect(randomIndex(1)).toBe(0);
    expect(() => randomIndex(0)).toThrow();
  });
  it("未完整擷取不可抽獎，結果深拷貝且重抽建立新紀錄", () => {
    const a = newActivity({
      shortcode: "abc",
      url: "https://www.instagram.com/p/abc/",
    });
    const raw = [c("1", "原始內容")];
    expect(() => createDraw(a, raw)).toThrow();
    a.status = "complete";
    a.tasks[0].done = true;
    const first = createDraw(a, raw),
      second = createDraw(a, raw);
    a.rules.text = "已修改";
    raw[0].text = "已修改";
    expect(first.rules.text).toBe("");
    expect(first.comments[0].text).toBe("原始內容");
    expect(second.id).not.toBe(first.id);
  });
});
describe("CSV", () => {
  it("UTF-8 BOM、CRLF、引號與換行逸出", () =>
    expect(csv([["a,b", '"quoted"', "line1\nline2"]])).toBe(
      '\uFEFF"a,b","""quoted""","line1\nline2"',
    ));
  it.each(["=SUM(1)", "+1", "-1", "@user", "  =1", "\tcmd", "\rfoo", "\nfoo"])(
    "防止公式注入 %s",
    (value) => expect(csv([[value]])).toContain("\"'"),
  );
  it("留言匯出包含判定；得獎名單含規則快照", () => {
    const raw = [c("1", "hello")],
      a = newActivity({
        shortcode: "abc",
        url: "https://www.instagram.com/p/abc/",
      });
    a.status = "complete";
    a.tasks[0].done = true;
    expect(commentsCsv(raw, evaluate(raw, defaultRules))).toContain(
      "符合資格，取得一張籤",
    );
    expect(winnersCsv(createDraw(a, raw))).toContain("repeatWinners");
  });
});
