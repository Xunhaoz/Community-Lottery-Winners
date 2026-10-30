import type { Comment, Page, Post } from "../core/types";
import { CrawlError } from "./errors";

export const QUERY = {
  comments: "33ba35852cb50da46f5b5e889df7d159",
  replies: "51fdd02b67508306ad4484ff574a0b62",
} as const;
// Observed in the logged-in Instagram web UI on 2026-10-02. Keep these versioned here.
export const WEB_QUERY = {
  comments: {
    docId: "28169471862682868",
    name: "PolarisPostCommentsPaginationQuery",
  },
  replies: {
    docId: "28027289793632076",
    name: "PolarisPostChildCommentsQuery",
  },
} as const;
const COMMENTS_CONNECTION =
  "xdt_api__v1__media__media_id__comments__connection";
const REPLIES_CONNECTION =
  "xdt_api__v1__media__media_id__comments__parent_comment_id__child_comments__connection";
export function mediaIdFromShortcode(shortcode: string): string {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  if (!/^[A-Za-z0-9_-]{1,20}$/.test(shortcode))
    throw new CrawlError("source", "貼文代碼無效。");
  let value = 0n;
  for (const char of shortcode)
    value = value * 64n + BigInt(alphabet.indexOf(char));
  return value.toString();
}
// Wrapped `{direction, value}` cursors only come from the web query; legacy cursors are passed through as-is.
export function isWebCursor(cursor: string | null | undefined): boolean {
  if (!cursor) return false;
  try {
    const parsed = JSON.parse(cursor);
    return parsed?.direction === "after" || parsed?.direction === "before";
  } catch {
    return false;
  }
}
export function legacyVariables(request: RequestSpec): Record<string, unknown> {
  return {
    shortcode: request.shortcode,
    first: 50,
    ...(request.cursor ? { after: request.cursor } : {}),
  };
}
export function webVariables(request: RequestSpec): Record<string, unknown> {
  let after: string | null = null,
    before: string | null = null;
  if (request.cursor) {
    let cursor;
    try {
      cursor = JSON.parse(request.cursor);
    } catch {
      throw new CrawlError("cursor", "分頁游標格式無效。");
    }
    if (
      !cursor ||
      !["after", "before"].includes(cursor.direction) ||
      typeof cursor.value !== "string" ||
      !cursor.value
    )
      throw new CrawlError("cursor", "分頁游標格式無效。");
    if (cursor.direction === "after") after = cursor.value;
    else before = cursor.value;
  }
  return {
    after,
    before,
    first: before ? null : 50,
    last: before ? 50 : null,
    media_id: mediaIdFromShortcode(request.shortcode),
    ...(request.kind === "replies"
      ? { parent_comment_id: request.parentId, is_chronological: null }
      : { sort_order: "popular" }),
    __relay_internal__pv__PolarisIsLoggedInrelayprovider: true,
  };
}
export interface RequestSpec {
  kind: "post" | "comments" | "replies";
  shortcode: string;
  parentId?: string;
  cursor?: string | null;
}
export type Transport = (request: RequestSpec) => Promise<unknown>;
export interface InstagramAdapter {
  readPost(shortcode: string): Promise<Post>;
  readComments(shortcode: string, cursor: string | null): Promise<Page>;
  readReplies(
    shortcode: string,
    parentId: string,
    cursor: string | null,
  ): Promise<Page>;
}
type Obj = Record<string, unknown>;
function object(value: unknown): Obj {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new CrawlError("schema", "Instagram 資料格式異常，無法確認完整性。");
  return value as Obj;
}
function id(value: unknown): string {
  if (typeof value === "string" && /^\d+$/.test(value)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
    return String(value);
  throw new CrawlError("schema", "留言或作者 ID 缺失，已停止擷取。");
}
function count(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new CrawlError("schema", "留言數量格式異常。");
  return value;
}
function normalize(value: unknown, parentId: string | null): Comment {
  const n = object(value),
    owner = object(n.owner);
  if (
    typeof n.text !== "string" ||
    typeof owner.username !== "string" ||
    !owner.username ||
    typeof n.created_at !== "number" ||
    !Number.isFinite(n.created_at) ||
    n.created_at < 0 ||
    !Number.isFinite(new Date(n.created_at * 1000).getTime())
  )
    throw new CrawlError(
      "schema",
      "留言本文、作者或時間格式異常，資料尚未完成。",
    );
  return {
    id: id(n.id),
    authorId: id(owner.id),
    username: owner.username,
    text: n.text,
    createdAt: new Date(n.created_at * 1000).toISOString(),
    parentId,
  };
}
// `threaded: false` is the flat `edge_media_to_comment` list: replies are already in it and `count` is the whole total.
export function parsePage(
  value: unknown,
  parentId: string | null,
  threaded = true,
): Page {
  const edge = object(value),
    info = object(edge.page_info);
  if (!Array.isArray(edge.edges) || typeof info.has_next_page !== "boolean")
    throw new CrawlError("schema", "缺少留言分頁資訊，不能視為擷取完成。");
  let next: string | null = null;
  // The explicit pagination flag is authoritative, not count or end_cursor alone.
  if (info.has_next_page === true) {
    if (typeof info.end_cursor !== "string" || !info.end_cursor)
      throw new CrawlError("cursor", "下一頁游標缺失，擷取未完成。");
    next = info.end_cursor;
  }
  const comments: Comment[] = [],
    replyParents: Page["replyParents"] = [];
  for (const entry of edge.edges) {
    const node = object(object(entry).node),
      comment = normalize(node, parentId);
    comments.push(comment);
    if (parentId === null && threaded) {
      const replies =
        node.edge_threaded_comments === undefined
          ? undefined
          : object(node.edge_threaded_comments);
      // Query every parent even without reply metadata; never assume a preview is complete.
      replyParents.push({
        id: comment.id,
        expected: replies ? count(replies.count) : undefined,
      });
    }
  }
  return {
    comments,
    next,
    replyParents,
    // A threaded first-level count may include replies, so it is not a completeness target.
    expected: parentId === null && threaded ? undefined : count(edge.count),
  };
}
export function parseWebPage(
  value: unknown,
  parentId: string | null,
  requestedCursor: string | null = null,
): Page {
  const edge = object(value),
    info = object(edge.page_info);
  if (
    !Array.isArray(edge.edges) ||
    typeof info.has_next_page !== "boolean" ||
    typeof info.has_previous_page !== "boolean"
  )
    throw new CrawlError("schema", "Instagram 缺少完整分頁旗標。");
  let direction: "after" | "before" | null = null;
  if (requestedCursor) {
    try {
      direction = JSON.parse(requestedCursor).direction;
    } catch {
      throw new CrawlError("cursor", "分頁方向格式無效。");
    }
    if (direction !== "after" && direction !== "before")
      throw new CrawlError("cursor", "分頁方向格式無效。");
  }
  if (!direction && info.has_next_page && info.has_previous_page)
    throw new CrawlError(
      "cursor",
      "初始頁同時回傳雙向待抓分頁，需更新 adapter，不能視為完整。",
    );
  const forward = direction !== "before" && info.has_next_page,
    backward = direction !== "after" && info.has_previous_page;
  const cursor = forward
    ? info.end_cursor
    : backward
      ? info.start_cursor
      : null;
  if ((forward || backward) && (typeof cursor !== "string" || !cursor))
    throw new CrawlError("cursor", "Instagram 缺少下一頁游標。");
  const comments: Comment[] = [],
    replyParents: Page["replyParents"] = [];
  for (const entry of edge.edges) {
    const node = object(object(entry).node),
      user = object(node.user);
    if (
      node.parent_comment_id != null &&
      id(node.parent_comment_id) !== parentId
    )
      throw new CrawlError("schema", "回覆的父留言 ID 不符。");
    const comment = normalize(
      {
        id: node.pk,
        text: node.text,
        created_at: node.created_at,
        owner: { id: user.pk ?? user.id, username: user.username },
      },
      parentId,
    );
    comments.push(comment);
    if (parentId === null) {
      const expected =
        node.child_comment_count == null
          ? undefined
          : count(node.child_comment_count);
      // An explicit zero is authoritative; a missing count is not.
      if (expected !== 0) replyParents.push({ id: comment.id, expected });
    }
  }
  return {
    comments,
    replyParents,
    next:
      cursor === null
        ? null
        : JSON.stringify({
            direction: forward ? "after" : "before",
            value: cursor,
          }),
  };
}
export function parsePostUrl(input: string): Post {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("請輸入完整的 Instagram 貼文網址。");
  }
  const match = url.pathname.match(/^\/(p|reel|tv)\/([A-Za-z0-9_-]+)\/?$/);
  if (
    url.protocol !== "https:" ||
    !["www.instagram.com", "instagram.com"].includes(url.hostname) ||
    url.port ||
    url.username ||
    url.password ||
    !match
  )
    throw new Error(
      "請使用 https://www.instagram.com/p/… 或 /reel/… 貼文網址。",
    );
  return {
    shortcode: match[2],
    url: `https://www.instagram.com/${match[1]}/${match[2]}/`,
  };
}
export function createInstagramAdapter(transport: Transport): InstagramAdapter {
  const media = (raw: unknown) =>
    object(object(object(raw).data).shortcode_media);
  const threaded = (m: Obj) => m.edge_media_to_parent_comment != null;
  const topLevel = (m: Obj) =>
    threaded(m) ? m.edge_media_to_parent_comment : m.edge_media_to_comment;
  return {
    async readPost(shortcode) {
      const raw = await transport({ kind: "post", shortcode });
      const data = object(object(raw).data);
      if (data[COMMENTS_CONNECTION] !== undefined) {
        parseWebPage(data[COMMENTS_CONNECTION], null);
        return {
          shortcode,
          id: mediaIdFromShortcode(shortcode),
          url: `https://www.instagram.com/p/${shortcode}/`,
        };
      }
      const m = media(raw);
      const edge = object(topLevel(m));
      parsePage(edge, null, threaded(m));
      if (m.shortcode !== undefined && m.shortcode !== shortcode)
        throw new CrawlError("source", "回傳貼文與來源不符。");
      const owner = m.owner ? object(m.owner) : undefined;
      return {
        shortcode,
        url: `https://www.instagram.com/p/${shortcode}/`,
        id: m.id === undefined ? undefined : id(m.id),
        owner: typeof owner?.username === "string" ? owner.username : undefined,
        reportedCount: count(edge.count),
      };
    },
    async readComments(shortcode, cursor) {
      const raw = await transport({ kind: "comments", shortcode, cursor });
      const data = object(object(raw).data);
      if (data[COMMENTS_CONNECTION] !== undefined)
        return parseWebPage(data[COMMENTS_CONNECTION], null, cursor);
      const m = media(raw);
      if (m.shortcode !== undefined && m.shortcode !== shortcode)
        throw new CrawlError("source", "回傳貼文與來源不符。");
      return parsePage(topLevel(m), null, threaded(m));
    },
    async readReplies(shortcode, parentId, cursor) {
      const raw = await transport({
        kind: "replies",
        shortcode,
        parentId,
        cursor,
      });
      const data = object(object(raw).data);
      if (data[REPLIES_CONNECTION] !== undefined)
        return parseWebPage(data[REPLIES_CONNECTION], parentId, cursor);
      const c = object(object(object(raw).data).comment);
      if (c.id !== undefined && id(c.id) !== parentId)
        throw new CrawlError("source", "回覆與父留言不符。");
      return parsePage(c.edge_threaded_comments, parentId);
    },
  };
}
