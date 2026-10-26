import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchInInstagram } from "../src/platform/transport";

afterEach(() => vi.unstubAllGlobals());
const web = { docId: "1", name: "Comments" };

function setup(contentType: string, body: string, status = 200) {
  vi.stubGlobal("location", {
    origin: "https://www.instagram.com",
    pathname: "/p/ABC/",
  });
  vi.stubGlobal("window", { require: () => ({ token: "test-only-token" }) });
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(body, {
        status,
        headers: { "Content-Type": contentType },
      }),
    ),
  );
}

describe("Instagram 同源傳輸", () => {
  it.each([
    "application/json",
    "text/javascript; charset=utf-8",
    "application/javascript",
    "application/graphql-response+json",
  ])("將 %s 回應當作 JSON 資料解析", async (contentType) => {
    setup(contentType, '{"data":{"connection":{"edges":[]}}}');
    const result = await fetchInInstagram(web, {}, "ABC");
    expect(result).toEqual({
      status: 200,
      contentType,
      body: { data: { connection: { edges: [] } } },
    });
    expect(JSON.stringify(result)).not.toContain("test-only-token");
  });
  it("登入 HTML 交給狀態分類，不執行內容", async () => {
    setup("text/html", "<html>login</html>");
    expect(await fetchInInstagram(web, {}, "ABC")).toEqual({
      status: 200,
      contentType: "text/html",
      body: null,
    });
  });
  it("無效 JSON 回報格式錯誤，不無限重試", async () => {
    setup("text/javascript", "invalid javascript");
    expect(await fetchInInstagram(web, {}, "ABC")).toEqual({
      error: "schema",
    });
  });
  it("來源已切換時不發出請求", async () => {
    setup("application/json", "{}");
    expect(await fetchInInstagram(web, {}, "DIFFERENT")).toEqual({
      error: "source",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("平鋪 query_hash 以 GET 送出，CSRF 只用於請求不回傳", async () => {
    setup("application/json", '{"data":{"shortcode_media":{}}}');
    vi.stubGlobal("document", { cookie: "ds_user_id=1; csrftoken=test-csrf" });
    const result = await fetchInInstagram(
      { queryHash: "33ba" },
      { shortcode: "ABC", first: 50 },
      "ABC",
    );
    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    const params = new URL(url, "https://www.instagram.com").searchParams;
    expect(url.startsWith("/graphql/query/?")).toBe(true);
    expect(params.get("query_hash")).toBe("33ba");
    expect(JSON.parse(params.get("variables")!)).toEqual({
      shortcode: "ABC",
      first: 50,
    });
    expect(init.method).toBe("GET");
    expect(init.headers).toMatchObject({ "X-CSRFToken": "test-csrf" });
    expect(result).toMatchObject({ status: 200 });
    expect(JSON.stringify(result)).not.toContain("test-csrf");
  });
  it("平鋪查詢缺少 CSRF cookie 回報登入問題，不發出請求", async () => {
    setup("application/json", "{}");
    vi.stubGlobal("document", { cookie: "ds_user_id=1" });
    expect(await fetchInInstagram({ queryHash: "33ba" }, {}, "ABC")).toEqual({
      error: "login",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
