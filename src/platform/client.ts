import {
  createInstagramAdapter,
  parsePostUrl,
  type RequestSpec,
} from "../crawler/instagram";
import {
  classifyResponse,
  CrawlError,
  type ErrorCode,
} from "../crawler/errors";

export const isExtension =
  typeof chrome !== "undefined" && Boolean(chrome.runtime?.id);
export async function findSource(
  shortcode?: string,
): Promise<{ id: number; url: string }[]> {
  if (!isExtension) return [];
  const tabs = await chrome.tabs.query({ url: "https://www.instagram.com/*" });
  return tabs.flatMap((t) => {
    try {
      const p = parsePostUrl(t.url ?? "");
      return t.id !== undefined && (!shortcode || p.shortcode === shortcode)
        ? [{ id: t.id, url: p.url }]
        : [];
    } catch {
      return [];
    }
  });
}
export function liveAdapter(tabId: number) {
  return createInstagramAdapter(async (request: RequestSpec) => {
    let res;
    try {
      res = await chrome.runtime.sendMessage({
        type: "instagram-request",
        tabId,
        request,
      });
    } catch {
      throw new CrawlError(
        "source",
        "來源分頁或擴充功能已中斷，請重新連接同一貼文。",
      );
    }
    if (!res) throw new CrawlError("source", "來源分頁沒有回應。");
    if (res.error) {
      const code = res.error as ErrorCode;
      throw new CrawlError(
        code,
        code === "network"
          ? "網路請求暫時失敗。"
          : code === "login"
            ? "無法取得登入頁面的請求資訊，請在 Instagram 確認登入後重新整理貼文。"
            : code === "schema"
              ? "請求格式無效。"
              : "來源分頁已關閉或切換。請開啟同一貼文後續抓。",
      );
    }
    classifyResponse(res.status, res.body, res.contentType);
    return res.body;
  });
}
