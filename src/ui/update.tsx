import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Activity, DrawRecord } from "../core/types";
import {
  editor,
  isDrawRecord,
  storeNames,
  type EditorRecord,
  type StoreName,
} from "../platform/db";
import { exclusive } from "../platform/lock";
import "./style.css";

const storeLabels: Record<StoreName, string> = {
  activities: "活動 activities",
  comments: "留言 comments",
  evaluations: "資格判定 evaluations",
  draws: "抽獎紀錄 draws",
};
const shown = 200;

function summary(name: StoreName, v: Record<string, unknown>): string {
  if (name === "activities") {
    const a = v as unknown as Activity;
    return `${a.post?.shortcode ?? "?"} · ${a.status} · ${a.createdAt}`;
  }
  if (name === "comments")
    return `@${v.username} · ${String(v.text ?? "").slice(0, 40)}`;
  if (name === "draws") {
    const d = v as unknown as DrawRecord;
    return `${d.createdAt ?? "（無建立時間）"} · ${d.winners?.length ?? 0} 位得獎者`;
  }
  return `判定 · ${String(v.at ?? "")}`;
}
function template(name: StoreName, activityId: string) {
  if (name === "comments")
    return {
      activityId,
      id: "",
      authorId: "",
      username: "",
      text: "",
      createdAt: new Date().toISOString(),
      parentId: null,
    };
  if (name === "evaluations") return { activityId };
  if (name === "draws") return { id: crypto.randomUUID(), activityId };
  return { id: crypto.randomUUID() };
}

function App() {
  const [activities, setActivities] = useState<Activity[]>([]);
  const [activityId, setActivityId] = useState("");
  const [name, setName] = useState<StoreName>("draws");
  const [records, setRecords] = useState<EditorRecord[]>([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<EditorRecord | null>(null);
  const [draft, setDraft] = useState("");
  const [position, setPosition] = useState(0);
  const [ticketQuery, setTicketQuery] = useState("");
  const [ticketId, setTicketId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function run(task: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await task();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  async function reload(keepKey?: IDBValidKey) {
    const all = (await editor.list("activities")).map(
      (r) => r.value as unknown as Activity,
    );
    all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    setActivities(all);
    const id = activityId || all[0]?.id || "";
    if (id !== activityId) setActivityId(id);
    const list = await editor.list(name, id);
    setRecords(list);
    const match =
      keepKey === undefined
        ? null
        : (list.find(
            (r) => JSON.stringify(r.key) === JSON.stringify(keepKey),
          ) ?? null);
    choose(match);
  }
  function choose(record: EditorRecord | null) {
    setSelected(record);
    setDraft(record ? JSON.stringify(record.value, null, 2) : "");
    setPosition(0);
    setTicketId("");
    setTicketQuery("");
  }
  useEffect(() => {
    void run(() => reload());
  }, [name, activityId]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q
      ? records.filter((r) => JSON.stringify(r.value).toLowerCase().includes(q))
      : records;
  }, [records, query]);
  // Hand-edited or newly added draws may lack rules, pool or winners; only a complete one gets the replace panel.
  const draw =
    name === "draws" && selected && isDrawRecord(selected.value)
      ? selected.value
      : null;
  const incompleteDraw = name === "draws" && selected !== null && !draw;
  const tickets = useMemo(() => {
    if (!draw) return [];
    const q = ticketQuery.trim().toLowerCase();
    return draw.evaluation.tickets
      .filter(
        (t) =>
          !q ||
          t.username.toLowerCase().includes(q) ||
          t.authorId.includes(q) ||
          t.commentId.includes(q),
      )
      .slice(0, shown);
  }, [draw, ticketQuery]);

  return (
    <main className="main-content editor-page">
      <div className="heading">
        <div>
          <div className="eyebrow">MAINTENANCE</div>
          <h1>資料維護</h1>
          <p>
            直接修改本機
            IndexedDB（community-lottery-v1），不留修改紀錄。請先暫停擷取；改完後重新整理工作室分頁才會看到新資料。
          </p>
        </div>
      </div>
      {error && (
        <div role="alert" className="alert error">
          {error}
        </div>
      )}
      {notice && (
        <div role="status" className="alert">
          {notice}
        </div>
      )}
      <section className="panel editor-filters">
        <label className="field-label">
          資料表
          <select
            value={name}
            disabled={busy}
            onChange={(e) => {
              // Drop the selection now: a record from the previous table must never render as this one.
              choose(null);
              setName(e.target.value as StoreName);
              setQuery("");
            }}
          >
            {storeNames.map((s) => (
              <option key={s} value={s}>
                {storeLabels[s]}
              </option>
            ))}
          </select>
        </label>
        <label className="field-label">
          活動
          <select
            value={activityId}
            disabled={busy || name === "activities"}
            onChange={(e) => {
              choose(null);
              setActivityId(e.target.value);
            }}
          >
            {activities.map((a) => (
              <option key={a.id} value={a.id}>
                {a.post.shortcode} · {a.createdAt.slice(0, 10)} · {a.id}
              </option>
            ))}
          </select>
        </label>
      </section>
      <div className="editor-grid">
        <section className="panel">
          <div className="section-title spread">
            <h2>
              {storeLabels[name]}（{records.length.toLocaleString()} 筆）
            </h2>
            <button
              disabled={busy || (name !== "activities" && !activityId)}
              onClick={() => {
                setSelected(null);
                setDraft(JSON.stringify(template(name, activityId), null, 2));
              }}
            >
              ＋ 新增
            </button>
          </div>
          <input
            className="editor-search"
            placeholder="搜尋任何欄位，例如帳號、留言 ID"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <ul className="editor-list">
            {filtered.slice(0, shown).map((r) => (
              <li key={JSON.stringify(r.key)}>
                <button
                  className={
                    selected &&
                    JSON.stringify(selected.key) === JSON.stringify(r.key)
                      ? "chosen"
                      : ""
                  }
                  onClick={() => choose(r)}
                >
                  <span>{summary(name, r.value)}</span>
                  <small>{JSON.stringify(r.key)}</small>
                </button>
              </li>
            ))}
          </ul>
          {filtered.length > shown && (
            <p className="helper">
              只列出前 {shown} 筆，共 {filtered.length.toLocaleString()}{" "}
              筆符合；請用搜尋縮小範圍。
            </p>
          )}
        </section>
        <section className="panel">
          <div className="section-title spread">
            <h2>{selected ? "編輯" : draft ? "新增" : "未選擇資料"}</h2>
            {selected && <small>{JSON.stringify(selected.key)}</small>}
          </div>
          <textarea
            className="editor-json"
            spellCheck={false}
            value={draft}
            disabled={!draft && !selected}
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className="button-row">
            <button
              className="primary"
              disabled={busy || !draft}
              onClick={() =>
                void run(async () => {
                  let value: unknown;
                  try {
                    value = JSON.parse(draft);
                  } catch {
                    throw new Error("JSON 格式錯誤，未儲存。");
                  }
                  const key = await exclusive(() =>
                    editor.put(name, value, selected?.key),
                  );
                  await reload(key);
                  setNotice(`已儲存 ${JSON.stringify(key)}。`);
                })
              }
            >
              儲存
            </button>
            <button
              disabled={busy || !selected}
              onClick={() => choose(selected)}
            >
              還原
            </button>
            <button
              disabled={busy || !selected}
              onClick={() =>
                void run(async () => {
                  if (
                    !selected ||
                    !confirm(
                      `刪除 ${JSON.stringify(selected.key)}？只會刪除這一筆，無法復原。要刪除整個活動請用工作室頁尾的「刪除此活動資料」。`,
                    )
                  )
                    return;
                  await exclusive(() => editor.remove(name, selected.key));
                  await reload();
                  setNotice(`已刪除 ${JSON.stringify(selected.key)}。`);
                })
              }
            >
              刪除
            </button>
          </div>
        </section>
      </div>
      {incompleteDraw && (
        <div role="status" className="alert">
          這筆抽獎紀錄缺少 rules、evaluation.tickets 或
          winners，無法使用「替換得獎者」。仍可在上方用 JSON 直接編輯。
        </div>
      )}
      {draw && (
        <section className="panel">
          <div className="section-title">
            <div>
              <h2>替換得獎者</h2>
              <p>
                新得獎者只能從這次抽獎的籤池挑選；獎項與名次保留原值。
                {draw.rules.repeatWinners
                  ? "此次允許同帳號重複得獎。"
                  : "此次不允許同帳號重複得獎。"}
              </p>
            </div>
          </div>
          <div className="editor-winners">
            {draw.winners.map((w) => (
              <label
                key={w.position}
                className={`mode-card ${position === w.position ? "selected" : ""}`}
              >
                <input
                  type="radio"
                  name="position"
                  checked={position === w.position}
                  onChange={() => setPosition(w.position)}
                />
                <span>
                  <strong>
                    #{w.position} · {w.prizeName}
                  </strong>
                  @{w.username} · 作者 {w.authorId} · 留言 {w.commentId}
                </span>
              </label>
            ))}
          </div>
          {position > 0 && (
            <>
              <input
                className="editor-search"
                placeholder="搜尋籤池：帳號、作者 ID 或留言 ID"
                value={ticketQuery}
                onChange={(e) => setTicketQuery(e.target.value)}
              />
              <select
                className="editor-tickets"
                size={8}
                value={ticketId}
                onChange={(e) => setTicketId(e.target.value)}
              >
                {tickets.map((t) => (
                  <option key={t.id} value={t.id}>
                    @{t.username} · 作者 {t.authorId} · 留言 {t.commentId}
                  </option>
                ))}
              </select>
              <div className="button-row">
                <button
                  className="primary"
                  disabled={busy || !ticketId}
                  onClick={() =>
                    void run(async () => {
                      const key = selected!.key;
                      const winner = await exclusive(() =>
                        editor.replaceWinner(String(key), position, ticketId),
                      );
                      await reload(key);
                      setNotice(
                        `第 ${winner.position} 位（${winner.prizeName}）已改為 @${winner.username}。`,
                      );
                    })
                  }
                >
                  替換第 {position} 位
                </button>
              </div>
            </>
          )}
        </section>
      )}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
