import type { Comment } from "../core/types";
import { newActivity } from "../crawler/runner";
export function demoData() {
  const activity = newActivity(
    {
      shortcode: "DEMO",
      url: "https://www.instagram.com/p/DEMO/",
      owner: "community_studio",
      reportedCount: 240,
    },
    true,
  );
  const users = [
    "lin.studio",
    "mei_daily",
    "travel.chen",
    "coffee_jun",
    "yuki_life",
    "hao.design",
    "iris.tw",
    "alex_notes",
  ];
  const comments: Comment[] = Array.from({ length: 240 }, (_, i) => ({
    id: String(10000 + i),
    authorId: String(100 + (i % 32)),
    username: users[i % users.length] + (i % 32 < 8 ? "" : i % 32),
    text:
      i % 7 === 0
        ? "期待下一次活動 ✨"
        : `一起來抽獎！ @friend_${Math.floor(i / 32) * 2} @friend_${Math.floor(i / 32) * 2 + 1} ${i % 3 === 0 ? "謝謝你們的用心 ☀" : "好喜歡這份禮物"}`,
    createdAt: new Date(Date.UTC(2026, 8, 29, 3, i)).toISOString(),
    parentId: i > 0 && i % 5 === 0 ? "10000" : null,
  }));
  activity.status = "complete";
  activity.commentCount = comments.length;
  activity.pages = 8;
  activity.tasks = [
    {
      key: "comments",
      parentId: null,
      cursor: null,
      seen: [],
      done: true,
      receivedIds: comments.map((c) => c.id),
    },
  ];
  activity.message =
    "這是本機示範資料，可體驗完整流程；不代表 Instagram 擷取已驗證。";
  activity.rules = {
    text: "抽獎",
    minTags: 2,
    deadline: null,
    mode: "person",
    repeatWinners: false,
  };
  activity.prizes = [
    { id: crypto.randomUUID(), name: "好運禮物盒", quantity: 3 },
    { id: crypto.randomUUID(), name: "暖心咖啡券", quantity: 5 },
  ];
  return { activity, comments };
}
