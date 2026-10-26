import { fetchInInstagram } from "./transport";
import {
  QUERY,
  WEB_QUERY,
  isWebCursor,
  legacyVariables,
  webVariables,
  parsePostUrl,
  type RequestSpec,
} from "../crawler/instagram";

chrome.action.onClicked.addListener(async (tab) => {
  const base = chrome.runtime.getURL("index.html");
  const url = `${base}?source=${tab.id ?? ""}`;
  const existing = (await chrome.tabs.query({ url: `${base}*` }))[0];
  if (existing?.id)
    await chrome.tabs.update(existing.id, { active: true, url });
  else await chrome.tabs.create({ url });
});

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (
    sender.id !== chrome.runtime.id ||
    !sender.url?.startsWith(chrome.runtime.getURL("index.html"))
  )
    return false;
  if (message?.type !== "instagram-request") return false;
  (async () => {
    const request = message.request as RequestSpec,
      tabId = message.tabId;
    if (
      !Number.isSafeInteger(tabId) ||
      !request ||
      !["post", "comments", "replies"].includes(request.kind) ||
      !/^[A-Za-z0-9_-]+$/.test(request.shortcode) ||
      (request.cursor != null &&
        (typeof request.cursor !== "string" ||
          request.cursor.length > 10000)) ||
      (request.kind === "replies" && !/^\d+$/.test(request.parentId ?? ""))
    )
      return { error: "schema" };
    const tab = await chrome.tabs.get(tabId);
    if (!tab.url || parsePostUrl(tab.url).shortcode !== request.shortcode)
      return { error: "source" };
    // First-level capture uses the flat legacy list (replies included). Web cursors saved by
    // activities started before the switch, and their reply tasks, stay on the web query.
    const legacy = request.kind !== "replies" && !isWebCursor(request.cursor);
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: fetchInInstagram,
      args: legacy
        ? [
            { queryHash: QUERY.comments },
            legacyVariables(request),
            request.shortcode,
          ]
        : [
            request.kind === "replies" ? WEB_QUERY.replies : WEB_QUERY.comments,
            webVariables(request),
            request.shortcode,
          ],
    });
    const current = await chrome.tabs.get(tabId);
    if (
      !current.url ||
      parsePostUrl(current.url).shortcode !== request.shortcode
    )
      return { error: "source" };
    return result[0]?.result ?? { error: "source" };
  })()
    .then(respond)
    .catch(() => respond({ error: "source" }));
  return true;
});
