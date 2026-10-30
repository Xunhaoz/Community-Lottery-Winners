import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  Activity,
  Comment,
  DrawRecord,
  Evaluation,
  Prize,
  Rules,
} from "../core/types";
import {
  evaluate,
  formatTime,
  taipeiToUtc,
  utcToTaipeiInput,
} from "../core/rules";
import { createDraw, drawProblem } from "../core/draw";
import {
  commentsCsv,
  downloadBlob,
  downloadCsv,
  winnersCsv,
} from "../core/csv";
import { parsePostUrl } from "../crawler/instagram";
import {
  newActivity,
  progressPercent,
  reportedTotal,
  runCapture,
} from "../crawler/runner";
import { findSource, isExtension, liveAdapter } from "../platform/client";
import { store } from "../platform/db";
import { exclusive } from "../platform/lock";
import { demoData } from "./demo";
import { HEIGHT, WIDTH, play, recordAnimation } from "./drawAnimation";
import "./style.css";

const stages = ["擷取留言", "設定規則", "確認抽獎", "抽獎結果"];
const statusNames: Record<Activity["status"], string> = {
  ready: "準備擷取",
  running: "擷取中",
  paused: "已暫停 · 未完成",
  cancelled: "已取消 · 未完成",
  complete: "擷取完成",
};
const empty: Evaluation = { decisions: [], tickets: [], eligibleAccounts: 0 };
function DrawAnimation({
  draw,
  onDone,
}: {
  draw: DrawRecord;
  onDone: () => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let live = true;
    const run = play(canvas.current!, draw);
    void run.done.then(() => {
      if (live) setTimeout(() => live && onDone(), 800);
    });
    return () => {
      live = false;
      run.stop();
    };
  }, [draw.id]);
  return (
    <div className="modal-overlay">
      <section
        className="animation-stage"
        role="dialog"
        aria-modal="true"
        aria-label="抽獎動畫"
      >
        <canvas ref={canvas} width={WIDTH} height={HEIGHT} />
        <div className="button-row">
          <button autoFocus onClick={onDone}>
            略過動畫 →
          </button>
        </div>
      </section>
    </div>
  );
}

function VirtualList<T>({
  items,
  render,
  label,
  height = 78,
}: {
  items: T[];
  render: (item: T, index: number) => React.ReactNode;
  label: string;
  height?: number;
}) {
  const [top, setTop] = useState(0),
    viewport = 390;
  const start = Math.max(
    0,
    Math.min(Math.floor(top / height) - 3, Math.max(0, items.length - 1)),
  );
  const visible = items.slice(start, start + Math.ceil(viewport / height) + 7);
  return (
    <div
      className="virtual"
      role="region"
      aria-label={label}
      tabIndex={0}
      style={{ height: viewport }}
      onScroll={(e) => setTop(e.currentTarget.scrollTop)}
    >
      {!items.length ? (
        <div className="empty-small">目前沒有符合的資料</div>
      ) : (
        <div style={{ height: items.length * height, position: "relative" }}>
          <div
            style={{ position: "absolute", top: start * height, width: "100%" }}
          >
            {visible.map((item, i) => (
              <div key={start + i} style={{ height }}>
                {render(item, start + i)}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
function App() {
  const [activities, setActivities] = useState<Activity[]>([]),
    [activity, setActivity] = useState<Activity | null>(null);
  const [comments, setComments] = useState<Comment[]>([]),
    [draws, setDraws] = useState<DrawRecord[]>([]),
    [drawId, setDrawId] = useState(""),
    [playing, setPlaying] = useState<DrawRecord | null>(null),
    [recording, setRecording] = useState<number | null>(null);
  const [step, setStep] = useState(0),
    [url, setUrl] = useState(""),
    [sourceId, setSourceId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [query, setQuery] = useState(""),
    [filter, setFilter] = useState("all"),
    [table, setTable] = useState("comments");
  const [detail, setDetail] = useState<Comment | null>(null),
    [deleting, setDeleting] = useState(false),
    [deadlineError, setDeadlineError] = useState("");
  const controller = useRef<AbortController | null>(null),
    ready = useRef(false);
  const result = useMemo(() => {
    try {
      return {
        evaluation: activity ? evaluate(comments, activity.rules) : empty,
        error: "",
      };
    } catch (e) {
      return { evaluation: empty, error: (e as Error).message };
    }
  }, [comments, activity?.rules]);
  const evaluation = result.evaluation;
  const selectedDraw = draws.find((d) => d.id === drawId) ?? draws[0];
  const problem = activity
    ? deadlineError ||
      result.error ||
      drawProblem(evaluation, activity.rules, activity.prizes)
    : "";
  const decisionMap = useMemo(
    () => new Map(evaluation.decisions.map((d) => [d.commentId, d])),
    [evaluation],
  );
  const shownComments = useMemo(
    () =>
      comments.filter((c) => {
        const d = decisionMap.get(c.id);
        return (
          (!query ||
            `${c.username} ${c.text}`
              .toLowerCase()
              .includes(query.toLowerCase())) &&
          (filter === "all" ||
            (filter === "tickets" ? d?.ticket : !d?.eligible))
        );
      }),
    [comments, decisionMap, query, filter],
  );
  const accounts = useMemo(() => {
    const map = new Map<
      string,
      { id: string; username: string; comments: number; tickets: number }
    >();
    for (const c of comments) {
      const a = map.get(c.authorId) ?? {
        id: c.authorId,
        username: c.username,
        comments: 0,
        tickets: 0,
      };
      a.comments++;
      if (decisionMap.get(c.id)?.ticket) a.tickets++;
      map.set(c.authorId, a);
    }
    return [...map.values()]
      .filter((a) => a.username.toLowerCase().includes(query.toLowerCase()))
      .sort((a, b) => b.tickets - a.tickets || a.id.localeCompare(b.id));
  }, [comments, decisionMap, query]);

  async function refreshList() {
    setActivities(await store.listActivities());
  }
  async function load(a: Activity) {
    setActivity(a);
    setComments(await store.comments(a.id));
    setDraws(await store.draws(a.id));
    setDrawId("");
    setStep(a.status === "complete" ? 1 : 0);
    setQuery("");
    setFilter("all");
    setError("");
    setDeadlineError("");
    setDeleting(false);
  }
  async function action(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失敗，請再試一次。");
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (ready.current) return;
    ready.current = true;
    void action(async () => {
      const list = await store.listActivities();
      setActivities(list);
      if (list[0]) {
        let a = list[0];
        if (a.status === "running") {
          try {
            await exclusive(async () => {
              const current = await store.getActivity(a.id);
              if (current?.status === "running") {
                a = {
                  ...current,
                  status: "paused",
                  message:
                    "上次工作分頁已關閉，進度已保存。請連接同一貼文後續抓。",
                };
                await store.saveActivity(a);
              }
            });
          } catch {
            setNotice("另一個工作分頁正在擷取。");
          }
        }
        await load(a);
      }
      if (isExtension) {
        const initial = Number(
          new URLSearchParams(location.search).get("source"),
        );
        const sources = await findSource();
        const source = sources.find((s) => s.id === initial) ?? sources[0];
        if (source) {
          setSourceId(source.id);
          setUrl(source.url);
        }
      }
    });
    const stop = () => controller.current?.abort();
    window.addEventListener("pagehide", stop);
    return () => {
      window.removeEventListener("pagehide", stop);
      stop();
    };
  }, []);

  async function saveDraft(): Promise<Activity> {
    if (!activity) throw new Error("請先建立活動。");
    const current = await store.getActivity(activity.id);
    if (!current) throw new Error("活動已被刪除，請重新整理。");
    const next = {
      ...current,
      rules: activity.rules,
      prizes: activity.prizes,
      updatedAt: new Date().toISOString(),
    };
    await store.saveActivity(next);
    await store.saveEvaluation(next.id, evaluation);
    setActivity(next);
    await refreshList();
    return next;
  }
  function updateRules(patch: Partial<Rules>) {
    if (activity)
      setActivity({ ...activity, rules: { ...activity.rules, ...patch } });
  }
  function updatePrize(id: string, patch: Partial<Prize>) {
    if (activity)
      setActivity({
        ...activity,
        prizes: activity.prizes.map((p) =>
          p.id === id ? { ...p, ...patch } : p,
        ),
      });
  }
  async function connect() {
    const post = parsePostUrl(url);
    const sources = await findSource(post.shortcode);
    const source = sources.find((s) => s.id === sourceId) ?? sources[0];
    if (!source)
      throw new Error(
        "請在 Chrome 開啟並登入這篇 Instagram 貼文，再按「確認並連接」。",
      );
    setSourceId(source.id);
    if (
      activity &&
      !activity.demo &&
      activity.post.shortcode === post.shortcode &&
      activity.status !== "cancelled"
    ) {
      setNotice("已重新連接同一貼文，可續抓已保存的進度。");
      return;
    }
    await exclusive(async () => {
      const metadata = await liveAdapter(source.id).readPost(post.shortcode);
      const a = newActivity({ ...metadata, url: post.url });
      await store.saveActivity(a);
      await load(a);
      await refreshList();
    });
  }
  async function capture() {
    if (!activity) return;
    const id = activity.id;
    await exclusive(async () => {
      const current = await store.getActivity(id);
      if (!current) throw new Error("找不到活動。");
      if (current.status === "complete" || current.status === "cancelled") {
        await load(current);
        return;
      }
      const sources = await findSource(current.post.shortcode),
        source = sources.find((s) => s.id === sourceId) ?? sources[0];
      if (!source)
        throw new Error("來源分頁已關閉或切換，請開啟原貼文再續抓。");
      setSourceId(source.id);
      controller.current = new AbortController();
      try {
        await runCapture({
          activity: current,
          adapter: liveAdapter(source.id),
          store,
          signal: controller.current.signal,
          onUpdate: (a) => {
            setActivity(a);
          },
        });
        setComments(await store.comments(id));
        await refreshList();
      } finally {
        controller.current = null;
      }
    });
  }
  function exportComments(snapshot?: DrawRecord) {
    if (!activity) return;
    downloadCsv(
      `${snapshot?.demo || activity.demo ? "示範_" : ""}${activity.post.shortcode}_${snapshot ? snapshot.id : "目前規則"}_留言資格.csv`,
      commentsCsv(
        snapshot?.comments ?? comments,
        snapshot?.evaluation ?? evaluation,
      ),
    );
  }
  async function go(next: number) {
    if (!activity) {
      setStep(next);
      return;
    }
    if (next > 0 && activity.status !== "complete")
      throw new Error("需完成所有留言及回覆擷取後，才能設定並確認正式抽獎。");
    if (deadlineError || result.error)
      throw new Error(deadlineError || result.error);
    await exclusive(saveDraft);
    setStep(next);
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#" onClick={(e) => e.preventDefault()}>
          <span className="brand-icon">✳</span>
          <span>
            集好運<small>COMMUNITY LOTTERY</small>
          </span>
        </a>
        <div className="sidebar-label">抽獎工作室</div>
        <nav aria-label="抽獎步驟">
          {stages.map((s, i) => (
            <button
              key={s}
              className={`nav-item ${step === i ? "active" : ""}`}
              disabled={
                busy ||
                (i > 0 && !activity) ||
                (i > 0 && activity?.status !== "complete") ||
                (i === 3 && !draws.length)
              }
              onClick={() => void action(() => go(i))}
            >
              <span className="step-number">{i + 1}</span>
              {s}
              {i < step && <span className="nav-check">✓</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-label activity-label">
          本機活動 <span>{activities.length}</span>
        </div>
        <div className="activity-list">
          {activities.map((a) => (
            <button
              disabled={busy}
              key={a.id}
              className={`activity-item ${a.id === activity?.id ? "chosen" : ""}`}
              onClick={() =>
                void action(async () => {
                  if (activity && !deadlineError && !result.error)
                    await exclusive(saveDraft);
                  const latest = await store.getActivity(a.id);
                  if (latest) await load(latest);
                })
              }
            >
              <span className="activity-dot" />
              <span>
                {a.demo ? "示範抽獎活動" : a.post.shortcode}
                <small>{statusNames[a.status]}</small>
              </span>
            </button>
          ))}
        </div>
        <button
          className="new-activity"
          disabled={busy}
          onClick={() =>
            void action(async () => {
              if (activity && !deadlineError && !result.error)
                await exclusive(saveDraft);
              setActivity(null);
              setComments([]);
              setDraws([]);
              setStep(0);
              setError("");
              setDeadlineError("");
            })
          }
        >
          ＋ 建立新活動
        </button>
        <div className="local-note">
          <span>◉</span>
          <div>
            資料只留在這台電腦<small>免伺服器・不匯出登入資訊</small>
          </div>
        </div>
        <a
          className="maintenance-link"
          href="update.html"
          target="_blank"
          rel="noreferrer"
        >
          資料維護 ↗
        </a>
      </aside>
      <main>
        <header className="topbar">
          <span>
            工作室 <span className="slash">/</span>{" "}
            {activity?.demo
              ? "示範抽獎活動"
              : (activity?.post.shortcode ?? "新活動")}
          </span>
          <span className="local-badge">
            <i /> 本機模式
          </span>
        </header>
        <div className="main-content">
          {!isExtension && (
            <div className="banner">
              介面預覽模式：可體驗示範流程。擷取 Instagram 請載入 Chrome
              擴充功能。
            </div>
          )}
          {activity?.demo && (
            <div className="demo-banner">
              示範活動 · 所有帳號與留言均為測試資料
            </div>
          )}
          <div className="heading">
            <div>
              <div className="eyebrow">STEP 0{step + 1} / 04</div>
              <h1>
                {
                  [
                    "讓每一份期待，都有機會。",
                    "好運，從清楚的規則開始。",
                    "一切準備好，就讓好運發生。",
                    "恭喜，這次的幸運得主。",
                  ][step]
                }
              </h1>
              <p>
                {
                  [
                    "連接 Instagram 貼文，將留言與回覆安全保存在本機。",
                    "先看清楚誰能參加、每人有幾張籤，再安心抽獎。",
                    "確認貼文、參加方式與獎項，這些設定將隨結果一起保存。",
                    "每次抽獎各自保存，隨時回查規則與參加資料。",
                  ][step]
                }
              </p>
            </div>
            <span className="heading-art" aria-hidden="true">
              ✳
            </span>
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
          {step === 0 && (
            <>
              <section className="panel connect-panel">
                <div className="section-title">
                  <span className="icon-box">↗</span>
                  <div>
                    <h2>連接你的 Instagram 貼文</h2>
                    <p>先在 Chrome 登入 Instagram，並開啟要抽獎的貼文。</p>
                  </div>
                </div>
                <label className="field-label" htmlFor="post-url">
                  貼文網址
                </label>
                <div className="input-action">
                  <input
                    id="post-url"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    placeholder="https://www.instagram.com/p/…"
                    disabled={busy}
                  />
                  <button
                    className="primary"
                    disabled={busy || !isExtension || !url}
                    onClick={() => void action(connect)}
                  >
                    確認並連接 ↗
                  </button>
                </div>
                <p className="helper">
                  支援貼文與
                  Reels。請在擷取期間保持來源分頁開啟，並停留在同一貼文。
                </p>
              </section>
              {activity && (
                <section className="panel">
                  <div className="section-title spread">
                    <div>
                      <h2>
                        {activity.post.owner
                          ? `@${activity.post.owner}`
                          : activity.post.shortcode}
                      </h2>
                      <a
                        href={activity.post.url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {activity.post.shortcode} ↗
                      </a>
                    </div>
                    <span
                      className={`status-pill ${activity.status === "complete" ? "success" : ""}`}
                    >
                      {statusNames[activity.status]}
                    </span>
                  </div>
                  <div className="progress-track">
                    <span
                      style={{
                        width: `${progressPercent(activity)}%`,
                      }}
                    />
                  </div>
                  <p role="status">{activity.message}</p>
                  <div className="capture-counts">
                    {reportedTotal(activity) !== undefined && (
                      <span>
                        <strong>
                          {reportedTotal(activity)!.toLocaleString()}
                        </strong>{" "}
                        IG 回報留言數
                      </span>
                    )}
                    <span>
                      <strong>{activity.commentCount.toLocaleString()}</strong>{" "}
                      實際取得留言數
                    </span>
                    <span>
                      <strong>{activity.pages}</strong> 已保存頁數
                    </span>
                    <span>
                      <strong>
                        {
                          activity.tasks.filter((t) => t.parentId && !t.done)
                            .length
                        }
                      </strong>{" "}
                      待抓回覆串
                    </span>
                  </div>
                  <div className="button-row">
                    {busy && controller.current ? (
                      <button onClick={() => controller.current?.abort()}>
                        暫停擷取
                      </button>
                    ) : (
                      <button
                        className="primary"
                        disabled={
                          busy ||
                          ["complete", "cancelled"].includes(activity.status) ||
                          activity.demo
                        }
                        onClick={() => void action(capture)}
                      >
                        {activity.pages ? "繼續擷取" : "開始擷取"} →
                      </button>
                    )}
                    <button
                      disabled={
                        busy ||
                        ["complete", "cancelled"].includes(activity.status)
                      }
                      onClick={() =>
                        void action(async () =>
                          exclusive(async () => {
                            const current = await store.getActivity(
                              activity.id,
                            );
                            if (!current) return;
                            const a: Activity = {
                              ...current,
                              status: "cancelled",
                              message:
                                "已取消擷取，保留現有留言。若要重新擷取，請重新連接建立新活動。",
                            };
                            await store.saveActivity(a);
                            setActivity(a);
                            await refreshList();
                          }),
                        )
                      }
                    >
                      取消擷取
                    </button>
                    <button
                      disabled={
                        busy || !comments.length || Boolean(result.error)
                      }
                      onClick={() => exportComments()}
                    >
                      匯出目前留言
                    </button>
                    <button
                      className="primary push-right"
                      disabled={busy || activity.status !== "complete"}
                      onClick={() => void action(() => go(1))}
                    >
                      設定抽獎規則 →
                    </button>
                  </div>
                </section>
              )}
              {!activity && (
                <section className="starter-grid">
                  <div className="panel">
                    <span className="starter-number">01</span>
                    <h3>完整收集</h3>
                    <p>逐頁擷取留言與回覆，隨時暫停、接續進度。</p>
                  </div>
                  <div className="panel">
                    <span className="starter-number">02</span>
                    <h3>公平計算</h3>
                    <p>以帳號識別參加者，每張籤都有清楚的依據。</p>
                  </div>
                  <div className="panel">
                    <span className="starter-number">03</span>
                    <h3>留下紀錄</h3>
                    <p>保存當時規則與結果，匯出後也能回查。</p>
                  </div>
                </section>
              )}
              <section className="demo-entry">
                <div>
                  <strong>想先走一次流程？</strong>
                  <p>使用 240 則示範留言，試試規則、抽獎與匯出。</p>
                </div>
                <button
                  disabled={busy}
                  onClick={() =>
                    void action(async () =>
                      exclusive(async () => {
                        const { activity: a, comments: c } = demoData();
                        await store.commitPage(a, c);
                        await load(a);
                        await refreshList();
                      }),
                    )
                  }
                >
                  體驗示範活動 →
                </button>
              </section>
              <p className="footnote">
                「全部留言」指登入帳號可取得的留言與回覆，不含已刪除或無權存取的內容。Instagram
                查詢相容性仍待實機驗收。
              </p>
            </>
          )}
          {activity && step === 1 && (
            <>
              <div className="stats">
                <div>
                  <span>已擷取留言與回覆</span>
                  <strong>
                    {comments.length.toLocaleString()}
                    <small>則</small>
                  </strong>
                  <em>包含所有已取得的回覆</em>
                </div>
                <div>
                  <span>符合資格的帳號</span>
                  <strong>
                    {evaluation.eligibleAccounts.toLocaleString()}
                    <small>人</small>
                  </strong>
                  <em>依帳號 ID 去重計算</em>
                </div>
                <div className="accent-stat">
                  <span>本次抽獎總籤數</span>
                  <strong>
                    {evaluation.tickets.length.toLocaleString()}
                    <small>張</small>
                  </strong>
                  <em>隨規則即時更新</em>
                </div>
              </div>
              <div className="rules-grid">
                <section className="panel">
                  <div className="section-title">
                    <span className="icon-box">≡</span>
                    <h2>留言資格</h2>
                  </div>
                  <label className="field-label">
                    必須包含的文字
                    <input
                      disabled={busy}
                      value={activity.rules.text}
                      onChange={(e) => updateRules({ text: e.target.value })}
                      placeholder="不填代表不限文字"
                    />
                  </label>
                  <p className="helper">依照原文字面比對，包含標點與大小寫。</p>
                  <div className="two-fields">
                    <label className="field-label">
                      至少 Tag 幾位不同朋友
                      <input
                        type="number"
                        min={activity.rules.mode === "friends" ? 1 : 0}
                        step="1"
                        disabled={busy}
                        value={
                          Number.isNaN(activity.rules.minTags)
                            ? ""
                            : activity.rules.minTags
                        }
                        onChange={(e) =>
                          updateRules({
                            minTags:
                              e.target.value === ""
                                ? NaN
                                : Number(e.target.value),
                          })
                        }
                      />
                    </label>
                    <label className="field-label">
                      截止時間（台北 UTC+8）
                      <input
                        type="datetime-local"
                        step="1"
                        disabled={busy}
                        defaultValue={utcToTaipeiInput(activity.rules.deadline)}
                        key={activity.id}
                        onChange={(e) => {
                          try {
                            updateRules({
                              deadline: taipeiToUtc(e.target.value),
                            });
                            setDeadlineError("");
                          } catch (err) {
                            setDeadlineError((err as Error).message);
                          }
                        }}
                      />
                    </label>
                  </div>
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      disabled={busy}
                      checked={activity.rules.excludeSelfTags ?? true}
                      onChange={(e) =>
                        updateRules({ excludeSelfTags: e.target.checked })
                      }
                    />
                    標註對象不可為自己
                  </label>
                  <p className="helper">
                    勾選時，標註自己不計入有效 Tag；其他標註仍正常計算。重複 Tag
                    只計一次，截止當下的留言也納入。
                  </p>
                  {(deadlineError || result.error) && (
                    <p role="alert" className="field-error">
                      {deadlineError || result.error}
                    </p>
                  )}
                </section>
                <section className="panel">
                  <div className="section-title">
                    <span className="icon-box">◎</span>
                    <h2>參加方式</h2>
                  </div>
                  <fieldset className="mode-options">
                    <legend className="sr-only">參加方式</legend>
                    <label
                      className={`mode-card ${activity.rules.mode === "person" ? "selected" : ""}`}
                    >
                      <input
                        type="radio"
                        name="mode"
                        checked={activity.rules.mode === "person"}
                        disabled={busy}
                        onChange={() => updateRules({ mode: "person" })}
                      />
                      <span>
                        <strong>
                          每人一次機會 <small>預設</small>
                        </strong>
                        <span>
                          至少一則留言合格就有一張籤。
                          <br />
                          多次留言不增加機會。
                        </span>
                      </span>
                    </label>
                    <label
                      className={`mode-card ${activity.rules.mode === "friends" ? "selected" : ""}`}
                    >
                      <input
                        type="radio"
                        name="mode"
                        checked={activity.rules.mode === "friends"}
                        disabled={busy}
                        onChange={() =>
                          updateRules({
                            mode: "friends",
                            minTags: Math.max(1, activity.rules.minTags || 0),
                          })
                        }
                      />
                      <span>
                        <strong>Tag 新朋友增加機會</strong>
                        <span>
                          每則合格留言達到新朋友門檻，再得一張籤。
                          <br />
                          重複 Tag 同一批朋友不增加機會。
                        </span>
                      </span>
                    </label>
                  </fieldset>
                  <p className="helper">
                    依留言時間先後計算，回覆與留言共用同帳號籤數。
                  </p>
                </section>
              </div>
              <section className="panel prize-panel">
                <div className="section-title spread">
                  <div>
                    <h2>準備送出的好運</h2>
                    <p>獎項依照下方順序抽取。</p>
                  </div>
                  <button
                    disabled={busy}
                    onClick={() =>
                      setActivity({
                        ...activity,
                        prizes: [
                          ...activity.prizes,
                          { id: crypto.randomUUID(), name: "", quantity: 1 },
                        ],
                      })
                    }
                  >
                    ＋ 新增獎項
                  </button>
                </div>
                {activity.prizes.map((p, i) => (
                  <div className="prize-row" key={p.id}>
                    <span className="prize-order">
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    <input
                      aria-label={`獎項 ${i + 1} 名稱`}
                      placeholder="獎項名稱"
                      value={p.name}
                      disabled={busy}
                      onChange={(e) =>
                        updatePrize(p.id, { name: e.target.value })
                      }
                    />
                    <label className="quantity">
                      <input
                        aria-label={`獎項 ${i + 1} 數量`}
                        type="number"
                        min="1"
                        step="1"
                        disabled={busy}
                        value={Number.isNaN(p.quantity) ? "" : p.quantity}
                        onChange={(e) =>
                          updatePrize(p.id, {
                            quantity:
                              e.target.value === ""
                                ? NaN
                                : Number(e.target.value),
                          })
                        }
                      />
                      名
                    </label>
                    <button
                      aria-label={`將獎項 ${i + 1} 上移`}
                      disabled={busy || i === 0}
                      onClick={() => {
                        const prizes = [...activity.prizes];
                        [prizes[i - 1], prizes[i]] = [prizes[i], prizes[i - 1]];
                        setActivity({ ...activity, prizes });
                      }}
                    >
                      ↑
                    </button>
                    <button
                      aria-label={`刪除獎項 ${i + 1}`}
                      disabled={busy}
                      onClick={() =>
                        setActivity({
                          ...activity,
                          prizes: activity.prizes.filter((x) => x.id !== p.id),
                        })
                      }
                    >
                      ×
                    </button>
                  </div>
                ))}
                <label className="checkbox">
                  <input
                    type="checkbox"
                    disabled={busy}
                    checked={activity.rules.repeatWinners}
                    onChange={(e) =>
                      updateRules({ repeatWinners: e.target.checked })
                    }
                  />
                  同帳號可多次中獎 <span>每張籤最多使用一次</span>
                </label>
              </section>
              <section className="panel data-panel">
                <div className="section-title spread">
                  <div>
                    <h2>
                      每一張籤，都有依據{" "}
                      <span className="count-tag">{comments.length}</span>
                    </h2>
                    <p>檢查資格、籤數與排除原因。點選留言查看完整內容。</p>
                  </div>
                  <button
                    disabled={busy || Boolean(result.error || deadlineError)}
                    onClick={() => exportComments()}
                  >
                    ↓ 匯出留言及資格
                  </button>
                </div>
                <div className="table-tools">
                  <div className="tabs">
                    <button
                      className={table === "comments" ? "selected" : ""}
                      onClick={() => setTable("comments")}
                    >
                      留言明細
                    </button>
                    <button
                      className={table === "accounts" ? "selected" : ""}
                      onClick={() => setTable("accounts")}
                    >
                      每人籤數
                    </button>
                  </div>
                  <input
                    aria-label="搜尋帳號或留言"
                    placeholder="搜尋帳號或留言…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                  {table === "comments" && (
                    <select
                      aria-label="篩選資格"
                      value={filter}
                      onChange={(e) => setFilter(e.target.value)}
                    >
                      <option value="all">全部留言</option>
                      <option value="tickets">取得籤數</option>
                      <option value="excluded">不符合資格</option>
                    </select>
                  )}
                </div>
                {table === "comments" ? (
                  <>
                    <div className="table-head comment-row">
                      <span>留言者 / 台北時間</span>
                      <span>留言內容</span>
                      <span>資格與籤數</span>
                      <span>判定原因</span>
                    </div>
                    <VirtualList
                      items={shownComments}
                      label="留言資格明細"
                      render={(c) => {
                        const d = decisionMap.get(c.id);
                        return (
                          <button
                            className="comment-row data-row"
                            onClick={() => setDetail(c)}
                          >
                            <span>
                              <strong>@{c.username}</strong>
                              <small>{formatTime(c.createdAt)}</small>
                            </span>
                            <span className="comment-text">
                              {c.parentId && <em>回覆 </em>}
                              {c.text}
                            </span>
                            <span>
                              <span
                                className={`tag ${d?.eligible ? "green" : ""}`}
                              >
                                {d?.eligible ? "符合資格" : "未符合"}
                              </span>
                              <small className={d?.ticket ? "ticket-yes" : ""}>
                                {d?.ticket ? "＋ 1 張籤" : "不增加籤數"}
                              </small>
                            </span>
                            <span className="reason">{d?.reason}</span>
                          </button>
                        );
                      }}
                    />
                  </>
                ) : (
                  <>
                    <div className="table-head account-row">
                      <span>留言帳號</span>
                      <span>留言數</span>
                      <span>獲得籤數</span>
                    </div>
                    <VirtualList
                      items={accounts}
                      label="每人籤數"
                      height={64}
                      render={(a) => (
                        <div className="account-row data-row">
                          <strong>@{a.username}</strong>
                          <span>{a.comments} 則</span>
                          <span className={a.tickets ? "ticket-yes" : ""}>
                            {a.tickets} 張籤
                          </span>
                        </div>
                      )}
                    />
                  </>
                )}
                <div className="table-footer">
                  共{" "}
                  {table === "comments"
                    ? shownComments.length + " 則留言"
                    : accounts.length + " 個帳號"}{" "}
                  · 大量資料以虛擬捲動顯示
                </div>
              </section>
              <div className="bottom-actions">
                <span>
                  {problem ||
                    `共 ${activity.prizes.reduce((sum, p) => sum + p.quantity, 0)} 個得獎名額，準備就緒。`}
                </span>
                <button
                  className="primary"
                  disabled={busy || Boolean(problem)}
                  onClick={() => void action(() => go(2))}
                >
                  儲存規則，確認抽獎 →
                </button>
              </div>
            </>
          )}
          {activity && step === 2 && (
            <>
              <section className="panel confirmation">
                <div className="confirm-icon">✳</div>
                <h2>這一刻的規則，會和結果一起留下。</h2>
                <p>
                  抽出後可返回調整規則。再次抽獎會建立新紀錄，既有結果仍保留。
                </p>
                <div className="confirm-grid">
                  <div>
                    <span>抽獎貼文</span>
                    <strong>{activity.post.shortcode}</strong>
                  </div>
                  <div>
                    <span>資料完整性</span>
                    <strong>留言與回覆分頁皆完成 ✓</strong>
                  </div>
                  <div>
                    <span>參加方式</span>
                    <strong>
                      {activity.rules.mode === "person"
                        ? "每人一次機會"
                        : "Tag 新朋友增加機會"}
                    </strong>
                  </div>
                  <div>
                    <span>可參加帳號 / 總籤數</span>
                    <strong>
                      {evaluation.eligibleAccounts} 人 /{" "}
                      {evaluation.tickets.length} 張
                    </strong>
                  </div>
                  <div>
                    <span>標註對象不可為自己</span>
                    <strong>
                      {(activity.rules.excludeSelfTags ?? true) ? "是" : "否"}
                    </strong>
                  </div>
                  <div>
                    <span>指定文字 / Tag 人數</span>
                    <strong>
                      {activity.rules.text || "不限文字"} /{" "}
                      {activity.rules.minTags} 人
                    </strong>
                  </div>
                  <div>
                    <span>截止時間（台北）</span>
                    <strong>
                      {activity.rules.deadline
                        ? formatTime(activity.rules.deadline)
                        : "不限時間"}
                    </strong>
                  </div>
                  <div>
                    <span>重複得獎</span>
                    <strong>
                      {activity.rules.repeatWinners
                        ? "同帳號可多次，每張籤限一次"
                        : "每人最多中獎一次"}
                    </strong>
                  </div>
                  <div>
                    <span>獎項（依序抽出）</span>
                    <strong>
                      {activity.prizes
                        .map((p) => `${p.name} × ${p.quantity}`)
                        .join("、")}
                    </strong>
                  </div>
                </div>
                {problem && (
                  <p role="alert" className="field-error">
                    {problem}
                  </p>
                )}
                <div className="button-row">
                  <button disabled={busy} onClick={() => setStep(1)}>
                    ← 返回修改
                  </button>
                  <button
                    className="primary"
                    disabled={busy || Boolean(problem)}
                    onClick={() =>
                      void action(async () =>
                        exclusive(async () => {
                          const a = await saveDraft();
                          const raw = await store.comments(a.id);
                          const draw = createDraw(a, raw);
                          await store.saveDraw(draw);
                          setDraws(await store.draws(a.id));
                          setDrawId(draw.id);
                          setPlaying(draw);
                        }),
                      )
                    }
                  >
                    {activity.demo
                      ? "確認並進行示範抽獎"
                      : "確認規則，開始抽獎"}{" "}
                    ✳
                  </button>
                </div>
              </section>
            </>
          )}
          {activity && step === 3 && selectedDraw && (
            <>
              <div className="results-toolbar">
                <label>
                  抽獎紀錄
                  <select
                    aria-label="抽獎紀錄"
                    value={selectedDraw.id}
                    onChange={(e) => setDrawId(e.target.value)}
                  >
                    {draws.map((d, i) => (
                      <option key={d.id} value={d.id}>
                        {formatTime(d.createdAt)} · {draws.length - i} 次
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  onClick={() =>
                    downloadCsv(
                      `${selectedDraw.demo ? "示範_" : ""}${selectedDraw.post.shortcode}_${selectedDraw.id}_得獎名單.csv`,
                      winnersCsv(selectedDraw),
                    )
                  }
                >
                  ↓ 匯出得獎名單
                </button>
                <button onClick={() => exportComments(selectedDraw)}>
                  ↓ 匯出當時留言及資格
                </button>
                <button
                  disabled={recording !== null}
                  onClick={() => setPlaying(selectedDraw)}
                >
                  ▶ 重播動畫
                </button>
                <button
                  disabled={recording !== null}
                  onClick={() =>
                    void action(async () => {
                      const draw = selectedDraw;
                      setRecording(0);
                      try {
                        const video = await recordAnimation(draw, setRecording);
                        downloadBlob(
                          `${draw.demo ? "示範_" : ""}${draw.post.shortcode}_${draw.id}_抽獎動畫.${video.extension}`,
                          video.blob,
                        );
                      } finally {
                        setRecording(null);
                      }
                    })
                  }
                >
                  {recording === null
                    ? "↓ 下載抽獎動畫"
                    : `產生影片中 ${Math.round(recording * 100)}%`}
                </button>
              </div>
              <section className="panel winners-panel">
                <div className="section-title spread">
                  <div>
                    <div className="eyebrow">LUCKY WINNERS</div>
                    <h2>
                      好運名單{" "}
                      <span className="count-tag">
                        {selectedDraw.winners.length} 名
                      </span>
                    </h2>
                  </div>
                  <span className="success status-pill">已保存結果</span>
                </div>
                {selectedDraw.prizes.map((p) => (
                  <div className="winner-group" key={p.id}>
                    <h3>
                      <span>✧</span> {p.name} <small>{p.quantity} 名</small>
                    </h3>
                    <div className="winner-grid">
                      {selectedDraw.winners
                        .filter((w) => w.prizeId === p.id)
                        .map((w) => (
                          <div className="winner-card" key={w.id}>
                            <span className="avatar">
                              {w.username.slice(0, 1).toUpperCase()}
                            </span>
                            <div>
                              <strong>@{w.username}</strong>
                              <small>
                                第 {w.position} 位幸運得主 · 籤 {w.id}
                              </small>
                            </div>
                            <span className="winner-spark">✳</span>
                          </div>
                        ))}
                    </div>
                  </div>
                ))}
              </section>
              <details className="panel snapshot">
                <summary>查看本次保存的規則與參加資料</summary>
                <p>紀錄 ID：{selectedDraw.id}</p>
                <p>
                  原始留言 {selectedDraw.comments.length} 則 · 合格帳號{" "}
                  {selectedDraw.evaluation.eligibleAccounts} 人 · 籤數{" "}
                  {selectedDraw.evaluation.tickets.length} 張
                </p>
                <p>
                  參加方式：
                  {selectedDraw.rules.mode === "person"
                    ? "每人一次機會"
                    : "Tag 新朋友增加機會"}{" "}
                  · 最少 Tag {selectedDraw.rules.minTags} 人 ·{" "}
                  {(selectedDraw.rules.excludeSelfTags ?? true)
                    ? "標註自己不計數"
                    : "標註自己可計數"}
                </p>
                <p>
                  指定文字：{selectedDraw.rules.text || "不限"} · 截止時間：
                  {selectedDraw.rules.deadline
                    ? formatTime(selectedDraw.rules.deadline)
                    : "不限"}
                </p>
                <p>
                  {selectedDraw.rules.repeatWinners
                    ? "同帳號可多次中獎，每張籤只用一次。"
                    : "每人最多中獎一次，抽中後移除該帳號全部籤。"}
                </p>
                <p>抽獎採用瀏覽器安全亂數與拒絕取樣，不使用固定亂數種子。</p>
              </details>
              <div className="bottom-actions">
                <span>修改目前規則，不會改變這份結果。</span>
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() => setStep(1)}
                >
                  調整規則，建立另一次抽獎 →
                </button>
              </div>
            </>
          )}
          {activity && (
            <div className="danger-zone">
              <button
                className="text-button"
                disabled={busy}
                onClick={() => setDeleting(true)}
              >
                刪除此活動資料
              </button>
              <span>本機保存 · 台北時間 UTC+8</span>
            </div>
          )}
        </div>
      </main>
      {playing && (
        <DrawAnimation
          draw={playing}
          onDone={() => {
            setPlaying(null);
            setStep(3);
          }}
        />
      )}
      {detail && (
        <div className="modal-overlay" onClick={() => setDetail(null)}>
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="detail-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="detail-title">@{detail.username} 的留言</h2>
            <p>
              {formatTime(detail.createdAt)}（台北）
              {detail.parentId ? " · 回覆" : ""}
            </p>
            <p className="full-comment">{detail.text}</p>
            <p>{decisionMap.get(detail.id)?.reason}</p>
            <p>
              有效 Tag：{decisionMap.get(detail.id)?.tags.join("、") || "無"}
            </p>
            <p className="helper">
              留言 ID：{detail.id} · 作者 ID：{detail.authorId}
            </p>
            <button
              autoFocus
              className="primary"
              onClick={() => setDetail(null)}
            >
              關閉
            </button>
          </section>
        </div>
      )}
      {deleting && activity && (
        <div className="modal-overlay">
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-title"
          >
            <h2 id="delete-title">刪除此活動的所有本機資料？</h2>
            <p>
              將刪除貼文 {activity.post.shortcode} 的留言、資格及 {draws.length}{" "}
              份抽獎紀錄，無法復原。請先匯出需要保留的資料。
            </p>
            <div className="button-row">
              <button autoFocus onClick={() => setDeleting(false)}>
                保留資料
              </button>
              <button
                className="danger"
                disabled={busy}
                onClick={() =>
                  void action(async () =>
                    exclusive(async () => {
                      await store.deleteActivity(activity.id);
                      setActivity(null);
                      setComments([]);
                      setDraws([]);
                      setDeleting(false);
                      setStep(0);
                      await refreshList();
                    }),
                  )
                }
              >
                確認刪除
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
