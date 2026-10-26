export type ErrorCode =
  | "network"
  | "rate-limit"
  | "login"
  | "challenge"
  | "source"
  | "schema"
  | "cursor";
export class CrawlError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CrawlError";
  }
}
export function classifyResponse(
  status: number,
  body: unknown,
  contentType = "application/json",
): void {
  const data =
    body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const message = typeof data.message === "string" ? data.message : "";
  if (
    status === 429 ||
    /rate.?limit|please wait|feedback_required/i.test(message)
  )
    throw new CrawlError(
      "rate-limit",
      "Instagram 限制請求。請稍後再續抓，勿連續重試。",
    );
  if (
    data.checkpoint_url ||
    data.challenge ||
    /challenge|checkpoint/i.test(message)
  )
    throw new CrawlError(
      "challenge",
      "請回 Instagram 完成帳號驗證，再連接同一貼文續抓。",
    );
  if (
    status === 401 ||
    status === 403 ||
    /login|logged.in/i.test(message) ||
    contentType.includes("text/html")
  )
    throw new CrawlError(
      "login",
      "登入可能已失效。請回 Instagram 確認登入與貼文權限。",
    );
  if (status >= 500)
    throw new CrawlError("network", "Instagram 暫時無法回應。");
  if (
    status < 200 ||
    status >= 300 ||
    data.status === "fail" ||
    data.errors ||
    (data.extensions as { is_final?: boolean } | undefined)?.is_final === false
  )
    throw new CrawlError(
      "schema",
      "Instagram 查詢無法使用或回應未完整。資料保留；需更新 adapter 後續抓。",
    );
}
