import type { DrawRecord, Winner } from "../core/types";
import { formatTime } from "../core/rules";

// Presentation only: winners are already chosen and saved before this runs.
// Every frame is a pure function of (draw, t), so live playback and the downloaded video match.
export const WIDTH = 1280,
  HEIGHT = 720;
const INTRO = 1200,
  OUTRO = 1800,
  PER_WINNER = 1400,
  MIN = 5000,
  MAX = 10000,
  FILLERS = 22,
  ROW = 92;
const colors = {
  bg: "#f7f8f5",
  panel: "#ffffff",
  border: "#e3e8e1",
  text: "#28352f",
  muted: "#77827b",
  green: "#277357",
  accent: "#b0c08c",
  soft: "#edf3e7",
};
const font = (size: number, weight = 400) =>
  `${weight} ${size}px Inter, -apple-system, "PingFang TC", "Noto Sans TC", sans-serif`;

export interface Reveal {
  winner: Winner;
  start: number;
  end: number;
  names: string[];
}
export interface AnimationPlan {
  duration: number;
  reveals: Reveal[];
}

function seed(text: string): () => number {
  let h = 2166136261;
  for (const c of text) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {
    h = (h + 0x6d2b79f5) | 0;
    let x = Math.imul(h ^ (h >>> 15), 1 | h);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

export function animationPlan(draw: DrawRecord): AnimationPlan {
  const winners = [...draw.winners].sort((a, b) => a.position - b.position),
    n = winners.length;
  const duration = Math.min(MAX, Math.max(MIN, INTRO + OUTRO + n * PER_WINNER)),
    slot = n ? (duration - INTRO - OUTRO) / n : 0;
  const pool = [...new Set(draw.evaluation.tickets.map((t) => t.username))];
  return {
    duration,
    reveals: winners.map((winner, i) => {
      const random = seed(`${draw.id}:${i}`);
      const names = Array.from(
        { length: FILLERS },
        () => pool[Math.floor(random() * pool.length)] ?? winner.username,
      );
      names.push(winner.username);
      return {
        winner,
        start: INTRO + i * slot,
        end: INTRO + (i + 1) * slot,
        names,
      };
    }),
  };
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}
function fitText(
  ctx: CanvasRenderingContext2D,
  text: string,
  size: number,
  weight: number,
  maxWidth: number,
) {
  let s = size;
  ctx.font = font(s, weight);
  while (s > 14 && ctx.measureText(text).width > maxWidth) {
    s -= 2;
    ctx.font = font(s, weight);
  }
  return s;
}
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const easeOut = (x: number) => 1 - (1 - x) ** 3;

function chrome(ctx: CanvasRenderingContext2D, draw: DrawRecord) {
  ctx.fillStyle = colors.bg;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  ctx.fillStyle = colors.green;
  ctx.font = font(18, 600);
  ctx.fillText(`LUCKY DRAW · ${draw.post.shortcode}`, 80, 86);
  ctx.textAlign = "right";
  ctx.fillStyle = colors.muted;
  ctx.font = font(18);
  ctx.fillText(
    `籤池 ${draw.evaluation.tickets.length.toLocaleString()} 張 · 合格帳號 ${draw.evaluation.eligibleAccounts.toLocaleString()} 人`,
    WIDTH - 80,
    86,
  );
  ctx.textAlign = "left";
  ctx.font = font(15);
  ctx.fillText(
    `${draw.demo ? "示範 · " : ""}抽獎紀錄 ${draw.id} · ${formatTime(draw.createdAt)}`,
    80,
    HEIGHT - 36,
  );
}
function title(ctx: CanvasRenderingContext2D, text: string, alpha = 1) {
  ctx.globalAlpha = alpha;
  ctx.textAlign = "left";
  ctx.fillStyle = colors.text;
  ctx.font = font(46, 700);
  ctx.fillText(text, 80, 146);
  ctx.globalAlpha = 1;
}
function chips(ctx: CanvasRenderingContext2D, winners: Winner[]) {
  const shown = winners.slice(-6),
    w = 360,
    h = 46;
  shown.forEach((winner, i) => {
    const x = 80 + (i % 3) * (w + 20),
      y = 510 + Math.floor(i / 3) * (h + 14);
    roundRect(ctx, x, y, w, h, 10);
    ctx.fillStyle = colors.soft;
    ctx.fill();
    ctx.fillStyle = colors.green;
    ctx.textAlign = "left";
    const label = `#${winner.position} @${winner.username} · ${winner.prizeName}`;
    fitText(ctx, label, 18, 600, w - 32);
    ctx.fillText(label, x + 16, y + 30);
  });
}
function sparkle(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  t: number,
) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(t / 600);
  ctx.strokeStyle = colors.accent;
  ctx.lineWidth = 4;
  ctx.lineCap = "round";
  for (let i = 0; i < 4; i++) {
    ctx.rotate(Math.PI / 4);
    ctx.beginPath();
    ctx.moveTo(-26, 0);
    ctx.lineTo(26, 0);
    ctx.stroke();
  }
  ctx.restore();
}

function slot(ctx: CanvasRenderingContext2D, reveal: Reveal, t: number) {
  const local = (t - reveal.start) / (reveal.end - reveal.start),
    roll = clamp01(local / 0.68),
    landed = roll >= 1,
    target = reveal.names.length - 1,
    p = target * easeOut(roll);
  const box = { x: 240, y: 236, w: 800, h: 230 },
    center = box.y + box.h / 2;
  ctx.textAlign = "center";
  ctx.fillStyle = colors.green;
  ctx.font = font(24, 600);
  ctx.fillText(
    `第 ${reveal.winner.position} 位 · ${reveal.winner.prizeName}`,
    WIDTH / 2,
    box.y - 22,
  );
  roundRect(ctx, box.x, box.y, box.w, box.h, 18);
  ctx.fillStyle = landed ? colors.soft : colors.panel;
  ctx.fill();
  ctx.strokeStyle = landed ? colors.accent : colors.border;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.save();
  ctx.clip();
  ctx.textBaseline = "middle";
  for (let i = Math.floor(p) - 2; i <= Math.ceil(p) + 2; i++) {
    if (i < 0 || i > target) continue;
    const offset = i - p,
      focus = 1 - Math.min(1, Math.abs(offset));
    ctx.globalAlpha = 0.25 + 0.75 * focus;
    ctx.fillStyle = landed && i === target ? colors.green : colors.text;
    const label = `@${reveal.names[i]}`;
    fitText(ctx, label, 40 + 18 * focus, focus > 0.5 ? 700 : 500, box.w - 120);
    ctx.fillText(label, WIDTH / 2, center + offset * ROW);
  }
  ctx.restore();
  ctx.globalAlpha = 1;
  ctx.textBaseline = "alphabetic";
  if (landed) {
    sparkle(ctx, box.x + 60, center, t);
    sparkle(ctx, box.x + box.w - 60, center, t);
  }
}

function summary(ctx: CanvasRenderingContext2D, draw: DrawRecord, t: number) {
  const winners = [...draw.winners].sort((a, b) => a.position - b.position);
  title(ctx, "恭喜以下幸運得主", 1);
  const max = 12,
    shown = winners.slice(0, max),
    cols = 3,
    w = 360,
    h = 74;
  shown.forEach((winner, i) => {
    const appear = clamp01((t - i * 60) / 300);
    const x = 80 + (i % cols) * (w + 20),
      y = 196 + Math.floor(i / cols) * (h + 14) + (1 - appear) * 12;
    ctx.globalAlpha = appear;
    roundRect(ctx, x, y, w, h, 12);
    ctx.fillStyle = colors.panel;
    ctx.fill();
    ctx.strokeStyle = colors.border;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.textAlign = "left";
    ctx.fillStyle = colors.muted;
    ctx.font = font(15);
    ctx.fillText(
      `第 ${winner.position} 位 · ${winner.prizeName}`,
      x + 20,
      y + 28,
    );
    ctx.fillStyle = colors.text;
    const label = `@${winner.username}`;
    fitText(ctx, label, 24, 700, w - 40);
    ctx.fillText(label, x + 20, y + 58);
  });
  ctx.globalAlpha = 1;
  if (winners.length > max) {
    ctx.textAlign = "left";
    ctx.fillStyle = colors.muted;
    ctx.font = font(18);
    ctx.fillText(
      `還有 ${winners.length - max} 位，完整名單請見得獎名單 CSV`,
      80,
      196 + 4 * (h + 14) + 14,
    );
  }
}

export function renderFrame(
  ctx: CanvasRenderingContext2D,
  draw: DrawRecord,
  plan: AnimationPlan,
  t: number,
) {
  chrome(ctx, draw);
  const outroStart = plan.duration - OUTRO;
  if (t >= outroStart || !plan.reveals.length) {
    summary(ctx, draw, t - outroStart);
    return;
  }
  if (t < INTRO) {
    const a = clamp01(t / 500);
    title(ctx, "抽出好運得主", a);
    ctx.globalAlpha = a;
    ctx.textAlign = "center";
    ctx.fillStyle = colors.green;
    ctx.font = font(64, 700);
    ctx.fillText(`共 ${plan.reveals.length} 位`, WIDTH / 2, 370);
    ctx.fillStyle = colors.muted;
    ctx.font = font(24);
    ctx.fillText(
      draw.prizes.map((p) => `${p.name} × ${p.quantity}`).join("　"),
      WIDTH / 2,
      420,
    );
    ctx.globalAlpha = 1;
    sparkle(ctx, WIDTH / 2, 250, t);
    return;
  }
  title(ctx, "抽出好運得主");
  const index = plan.reveals.findIndex((r) => t < r.end),
    current = plan.reveals[index < 0 ? plan.reveals.length - 1 : index];
  slot(ctx, current, t);
  chips(
    ctx,
    plan.reveals.filter((r) => r.end <= t).map((r) => r.winner),
  );
}

// Real-time playback: rAF while visible, a timer when hidden so recording never stalls.
export function play(
  canvas: HTMLCanvasElement,
  draw: DrawRecord,
  onFrame?: (progress: number) => void,
): { done: Promise<void>; stop: () => void } {
  const ctx = canvas.getContext("2d")!,
    plan = animationPlan(draw);
  let stopped = false,
    finish = () => {};
  const done = new Promise<void>((resolve) => (finish = resolve));
  const start = performance.now();
  const tick = () => {
    if (stopped) return;
    const t = Math.min(plan.duration, performance.now() - start);
    renderFrame(ctx, draw, plan, t);
    onFrame?.(t / plan.duration);
    if (t >= plan.duration) finish();
    else if (document.hidden) setTimeout(tick, 33);
    else requestAnimationFrame(tick);
  };
  tick();
  return {
    done,
    stop: () => {
      stopped = true;
      finish();
    },
  };
}

export function videoType(): { mimeType: string; extension: string } | null {
  if (typeof MediaRecorder === "undefined") return null;
  const mimeType = [
    "video/mp4;codecs=avc1",
    "video/mp4",
    "video/webm;codecs=vp9",
    "video/webm",
  ].find((t) => MediaRecorder.isTypeSupported(t));
  return mimeType
    ? { mimeType, extension: mimeType.startsWith("video/mp4") ? "mp4" : "webm" }
    : null;
}

// Records the same timeline in real time, so it takes about as long as the animation itself.
export async function recordAnimation(
  draw: DrawRecord,
  onProgress?: (progress: number) => void,
): Promise<{ blob: Blob; extension: string }> {
  const type = videoType();
  if (!type) throw new Error("此瀏覽器不支援錄製影片。");
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const stream = canvas.captureStream(30),
    recorder = new MediaRecorder(stream, {
      mimeType: type.mimeType,
      videoBitsPerSecond: 6_000_000,
    }),
    chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data);
  };
  const stopped = new Promise((resolve) => (recorder.onstop = resolve));
  renderFrame(canvas.getContext("2d")!, draw, animationPlan(draw), 0);
  recorder.start(250);
  await play(canvas, draw, onProgress).done;
  // Hold the last frame briefly so players don't cut the summary short.
  await new Promise((resolve) => setTimeout(resolve, 400));
  recorder.stop();
  await stopped;
  stream.getTracks().forEach((t) => t.stop());
  return {
    blob: new Blob(chunks, { type: type.mimeType.split(";")[0] }),
    extension: type.extension,
  };
}
