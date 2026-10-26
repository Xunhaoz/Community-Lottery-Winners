import { evaluate } from "./rules";
import type {
  Activity,
  Comment,
  DrawRecord,
  Evaluation,
  Prize,
  Rules,
  Ticket,
  Winner,
} from "./types";

export function randomIndex(
  size: number,
  fill: (a: Uint32Array) => Uint32Array = (a) => crypto.getRandomValues(a),
): number {
  if (!Number.isSafeInteger(size) || size < 1 || size > 0x100000000)
    throw new Error("籤池大小無效。");
  const limit = Math.floor(0x100000000 / size) * size;
  const a = new Uint32Array(1);
  do {
    fill(a);
  } while (a[0] >= limit);
  return a[0] % size;
}
export function drawProblem(
  e: Evaluation,
  rules: Rules,
  prizes: Prize[],
): string | null {
  if (!prizes.length) return "請新增至少一個獎項。";
  if (new Set(prizes.map((p) => p.id)).size !== prizes.length)
    return "獎項 ID 重複。";
  if (
    prizes.some(
      (p) =>
        !p.name.trim() || !Number.isSafeInteger(p.quantity) || p.quantity < 1,
    )
  )
    return "獎項名稱不可空白，數量須為正整數。";
  const needed = prizes.reduce((sum, p) => sum + p.quantity, 0);
  if (!Number.isSafeInteger(needed)) return "獎項總數過大。";
  const available = rules.repeatWinners
    ? e.tickets.length
    : new Set(e.tickets.map((t) => t.authorId)).size;
  return needed > available
    ? `名額不足：需要 ${needed}，可用${rules.repeatWinners ? "籤數" : "帳號"} ${available}，缺少 ${needed - available}。`
    : null;
}
export function selectWinners(
  tickets: Ticket[],
  prizes: Prize[],
  repeat: boolean,
  pick = randomIndex,
): Winner[] {
  const e = { tickets, decisions: [], eligibleAccounts: 0 };
  const problem = drawProblem(
    e,
    {
      text: "",
      minTags: 0,
      deadline: null,
      mode: "person",
      repeatWinners: repeat,
    },
    prizes,
  );
  if (problem) throw new Error(problem);
  let pool = [...tickets];
  const winners: Winner[] = [];
  for (const prize of prizes)
    for (let i = 0; i < prize.quantity; i++) {
      const index = pick(pool.length);
      if (!Number.isInteger(index) || index < 0 || index >= pool.length)
        throw new Error("亂數索引無效。");
      const ticket = pool[index];
      winners.push({
        ...ticket,
        prizeId: prize.id,
        prizeName: prize.name.trim(),
        position: winners.length + 1,
      });
      pool = pool.filter((t) =>
        repeat ? t.id !== ticket.id : t.authorId !== ticket.authorId,
      );
    }
  return winners;
}
export function createDraw(
  activity: Activity,
  comments: Comment[],
): DrawRecord {
  if (activity.status !== "complete" || activity.tasks.some((t) => !t.done))
    throw new Error("留言及回覆尚未全部擷取完成，不能正式抽獎。");
  const evaluation = evaluate(comments, activity.rules);
  const problem = drawProblem(evaluation, activity.rules, activity.prizes);
  if (problem) throw new Error(problem);
  return structuredClone({
    id: crypto.randomUUID(),
    activityId: activity.id,
    createdAt: new Date().toISOString(),
    post: activity.post,
    rules: activity.rules,
    prizes: activity.prizes,
    comments,
    evaluation,
    winners: selectWinners(
      evaluation.tickets,
      activity.prizes,
      activity.rules.repeatWinners,
    ),
    randomAlgorithm: "crypto-u32-rejection-v1",
    demo: activity.demo,
  });
}
