import type { Comment, Evaluation, Rules } from "./types";

export function validateRules(rules: Rules): void {
  if (!["person", "friends"].includes(rules.mode))
    throw new Error("請選擇參加方式。");
  if (
    !Number.isSafeInteger(rules.minTags) ||
    rules.minTags < (rules.mode === "friends" ? 1 : 0)
  )
    throw new Error("Tag 人數須為整數；新朋友模式至少 1 人。");
  if (rules.deadline !== null && !Number.isFinite(Date.parse(rules.deadline)))
    throw new Error("截止時間無效。");
}

export function parseTags(text: string, username: string): string[] {
  // Exclude email/URL fragments; accept punctuation between real mentions.
  const tags = [
    ...text.matchAll(
      /(?<![\p{L}\p{N}_.\/@])@([a-zA-Z0-9_](?:[a-zA-Z0-9_.]{0,28}[a-zA-Z0-9_])?)(?![a-zA-Z0-9_])/gu,
    ),
  ]
    .map((m) => m[1].toLowerCase())
    .filter((tag) => !tag.includes("..") && tag !== username.toLowerCase());
  return [...new Set(tags)];
}

export function compareComments(a: Comment, b: Comment): number {
  return (
    Date.parse(a.createdAt) - Date.parse(b.createdAt) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

export function evaluate(comments: Comment[], rules: Rules): Evaluation {
  validateRules(rules);
  const decisions: Evaluation["decisions"] = [],
    tickets: Evaluation["tickets"] = [];
  const used = new Map<string, Set<string>>(),
    eligible = new Set<string>(),
    ticketed = new Set<string>();
  const unique = new Map(comments.map((c) => [c.id, c]));
  for (const c of [...unique.values()].sort(compareComments)) {
    const tags = parseTags(c.text, c.username),
      consumed = used.get(c.authorId) ?? new Set<string>();
    const newTags = tags.filter((t) => !consumed.has(t));
    const failures: string[] = [];
    if (!c.authorId || !Number.isFinite(Date.parse(c.createdAt)))
      failures.push("留言識別或時間無效");
    if (!c.text.includes(rules.text)) failures.push("未包含指定文字");
    if (tags.length < rules.minTags)
      failures.push(`有效 Tag ${tags.length} 人，未達 ${rules.minTags} 人`);
    if (rules.deadline && Date.parse(c.createdAt) > Date.parse(rules.deadline))
      failures.push("超過截止時間");
    let ticket = false,
      reason = failures.join("；");
    if (!failures.length) {
      eligible.add(c.authorId);
      if (rules.mode === "person") {
        ticket = !ticketed.has(c.authorId);
        reason = ticket
          ? "符合資格，取得一張籤"
          : "符合資格；此帳號已取得一張籤";
      } else {
        ticket = newTags.length >= rules.minTags;
        reason = ticket
          ? `新增 ${newTags.length} 位朋友，取得一張籤`
          : `符合資格；新朋友僅 ${newTags.length} 人，未達 ${rules.minTags} 人`;
      }
      if (ticket) {
        tickets.push({
          id: c.id,
          commentId: c.id,
          authorId: c.authorId,
          username: c.username,
        });
        ticketed.add(c.authorId);
        tags.forEach((t) => consumed.add(t));
        used.set(c.authorId, consumed);
      }
    }
    decisions.push({
      commentId: c.id,
      authorId: c.authorId,
      username: c.username,
      eligible: failures.length === 0,
      ticket,
      tags,
      newTags,
      reason,
    });
  }
  return { decisions, tickets, eligibleAccounts: eligible.size };
}

export function taipeiToUtc(input: string): string | null {
  if (!input) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(input))
    throw new Error("請輸入完整的台北時間。");
  const date = new Date(`${input}+08:00`);
  if (
    !Number.isFinite(date.getTime()) ||
    utcToTaipeiInput(date.toISOString()).slice(0, input.length) !== input
  )
    throw new Error("截止日期無效。");
  return date.toISOString();
}
export function utcToTaipeiInput(utc: string | null): string {
  return utc
    ? new Date(Date.parse(utc) + 8 * 3600000).toISOString().slice(0, 19)
    : "";
}
export function formatTime(utc: string): string {
  return new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei",
    dateStyle: "short",
    timeStyle: "medium",
    hour12: false,
  }).format(new Date(utc));
}
