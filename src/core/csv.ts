import { formatTime } from "./rules";
import type { Comment, DrawRecord, Evaluation } from "./types";

export function csv(rows: (string | number | boolean | null)[][]): string {
  return (
    "\uFEFF" +
    rows
      .map((row) =>
        row
          .map((value) => {
            let text = value === null ? "" : String(value);
            if (
              /^[\s\uFEFF]*[=+\-@\t\r\n]/u.test(text) ||
              /^[\t\r\n]/.test(text)
            )
              text = "'" + text;
            return '"' + text.replaceAll('"', '""') + '"';
          })
          .join(","),
      )
      .join("\r\n")
  );
}
export function commentsCsv(
  comments: Comment[],
  evaluation: Evaluation,
): string {
  const map = new Map(evaluation.decisions.map((d) => [d.commentId, d]));
  return csv([
    [
      "留言 ID",
      "作者 ID",
      "帳號",
      "留言內容",
      "台北時間",
      "UTC 時間",
      "父留言 ID",
      "符合資格",
      "增加籤數",
      "有效 Tag",
      "新朋友",
      "原因",
    ],
    ...comments.map((c) => {
      const d = map.get(c.id);
      return [
        c.id,
        c.authorId,
        c.username,
        c.text,
        formatTime(c.createdAt),
        c.createdAt,
        c.parentId,
        d?.eligible ?? false,
        d?.ticket ? 1 : 0,
        d?.tags.join(" ") ?? "",
        d?.newTags.join(" ") ?? "",
        d?.reason ?? "未判定",
      ];
    }),
  ]);
}
export function winnersCsv(draw: DrawRecord): string {
  return csv([
    [
      "紀錄 ID",
      "抽獎時間（台北）",
      "貼文",
      "順序",
      "獎項",
      "作者 ID",
      "帳號",
      "籤 ID",
      "留言 ID",
      "規則",
      "示範資料",
    ],
    ...draw.winners.map((w) => [
      draw.id,
      formatTime(draw.createdAt),
      draw.post.url,
      w.position,
      w.prizeName,
      w.authorId,
      w.username,
      w.id,
      w.commentId,
      JSON.stringify(draw.rules),
      draw.demo,
    ]),
  ]);
}
export function downloadCsv(name: string, content: string): void {
  const url = URL.createObjectURL(
    new Blob([content], { type: "text/csv;charset=utf-8" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
