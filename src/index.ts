import { Client, GatewayIntentBits, Events } from "discord.js";
import "dotenv/config";
import { judge } from "./gate";
import { Pi } from "./pi";

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error("Missing DISCORD_TOKEN in .env");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const pi = new Pi(process.cwd());
let botId = "";
const NAMES = (process.env.BOT_NAMES ?? "viktor").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

// Ephemeral window for the gate only — Discord stays the store.
const recent = new Map<string, { author: string; text: string; ts: number }[]>();
// One window per channel. Mechanical cross opens it (2 min);
// every pi run resets it. Inside → Jev gates to pi. Outside → silent.
const winExp = new Map<string, number>();
const WINDOW_MS = 5 * 60 * 1000;
function pushRecent(channelId: string, author: string, text: string) {
  const arr = recent.get(channelId) ?? [];
  arr.push({ author, text, ts: Date.now() });
  while (arr.length > 50) arr.shift();
  recent.set(channelId, arr);
}

// Append-only: send just the new message. The pi session itself
// Last Discord message id pi has seen per channel. New sessions reset it.
const lastFed = new Map<string, string>();
const MIN5 = 5 * 60 * 1000;
const HALF = 2.5 * 60 * 1000;
const MAX_CTX_LINES = 40;

// Fresh-window pre-context only. Plain trigger → last 5 min.
// Reply trigger → up to 2.5 min below the replied-to message (y),
// remainder (5-y, cap 2.5) above it.
async function fetchPreContext(msg: any): Promise<string> {
  try {
    const ch: any = msg.channel;
    const fmt = (m: any) => `[${m.author?.username ?? "?"}]: ${(m.content ?? "").slice(0, 300)}`;
    const refId = msg.reference?.messageId;
    if (!refId) {
      const coll = await ch.messages.fetch({ limit: 50 });
      const lines = [...coll.values()]
        .filter((m: any) => Date.now() - m.createdTimestamp < MIN5 && m.id !== msg.id)
        .sort((a: any, b: any) => (a.id < b.id ? -1 : 1))
        .slice(-MAX_CTX_LINES)
        .map(fmt);
      return lines.length ? `Channel context (last 5 min, oldest first):\n${lines.join("\n")}\n\n` : "";
    }
    const ref = await msg.fetchReference().catch(() => null);
    const refTs = ref ? ref.createdTimestamp : Date.now();
    const below = await ch.messages.fetch({ before: refId, limit: 50 }).catch(() => null);
    const belowLines = below
      ? [...below.values()].filter((m: any) => refTs - m.createdTimestamp <= HALF).sort((a: any, b: any) => (a.id < b.id ? -1 : 1))
      : [];
    const y = belowLines.length ? Math.min(refTs - belowLines[0].createdTimestamp, HALF) : 0;
    const aboveMs = Math.min(MIN5 - y, HALF);
    const above = await ch.messages.fetch({ after: refId, limit: 50 }).catch(() => null);
    const aboveLines = above
      ? [...above.values()].filter((m: any) => m.createdTimestamp - refTs <= aboveMs && m.id !== msg.id).sort((a: any, b: any) => (a.id < b.id ? -1 : 1))
      : [];
    const refLine = ref ? fmt(ref) : "";
    const all = [...belowLines.map(fmt), ...(refLine ? [`> ${refLine}  <-- replied-to`] : []), ...aboveLines.map(fmt)];
    const trimmed = all.slice(-MAX_CTX_LINES);
    return trimmed.length ? `Channel context around the replied-to message (oldest first):\n${trimmed.join("\n")}\n\n` : "";
  } catch {
    return "";
  }
}

async function buildSeed(msg: any, pre = ""): Promise<string> {
  let ref = "";
  if (msg.reference?.messageId) {
    try {
      const r = await msg.fetchReference();
      ref = ` (replying to ${r.author?.username ?? "?"}: "${(r.content ?? "").slice(0, 300)}")`;
    } catch { /* ignore */ }
  }
  // Catch-up: everything since pi last saw, so the session never gaps.
  // Only inside a live window — new sessions start blank (lastFed reset).
  let missed = "";
  const since = lastFed.get(msg.channelId);
  if (since && since !== msg.id) {
    try {
      const coll = await (msg.channel as any).messages.fetch({ after: since, limit: 20 });
      const lines = [...coll.values()]
        .reverse()
        .filter((m: any) => m.id !== msg.id && m.author?.id !== botId)
        .map((m: any) => `[${m.author?.username ?? "?"}]: ${(m.content ?? "").slice(0, 300)}`);
      if (lines.length) missed = `Missed since you last saw:\n${lines.join("\n")}\n`;
    } catch { /* seed still goes out */ }
  }
  lastFed.set(msg.channelId, msg.id);
  return `${pre}${missed}[channel:${msg.channelId}] [msg:${msg.id}] [${msg.author.username}(${msg.author.id})]${ref}: ${msg.content}`;
}

async function runPi(msg: any, pre = "") {
  const seed = await buildSeed(msg, pre);
  try {
    const ch: any = msg.channel;
    // Pi owns delivery via direct Discord API calls. Bot gates, types, logs.
    let settled = false;
    // Typing indicator ⟺ not settled.
    const keepTyping = async () => {
      while (!settled) {
        try {
          await ch.sendTyping?.();
        } catch { /* ignore */ }
        for (let i = 0; i < 8 && !settled; i++) await new Promise((r) => setTimeout(r, 1000));
      }
    };
    const typingP = keepTyping();
    let res: { text: string; posted: boolean };
    try {
      res = await pi.ask(seed);
    } catch (e: any) {
      settled = true;
      await typingP;
      console.log(`[PI-ERR][${msg.channelId}] ${e?.message ?? e}`);
      return;
    }
    settled = true;
    await typingP;
    if (res.posted || pi.sentCount > 0) {
      console.log(`[SENT x${pi.sentCount}][${msg.channelId}] ${msg.author.username}: ${msg.content.slice(0, 120)}`);
    } else {
      console.log(`[SILENT][${msg.channelId}] pi posted nothing (${(res.text ?? "").slice(0, 120)})`);
    }
  } catch (e: any) {
    console.log(`[PI-ERR][${msg.channelId}] ${e?.message ?? e}`);
  }
}

client.once(Events.ClientReady, (c) => {
  botId = c.user.id;
  console.log(`Online as ${c.user.tag} (id=${botId}) names=[${NAMES.join(",")}]`);
});

client.on(Events.MessageCreate, async (msg) => {
  // Track everything (including own msgs) so Jev sees bot questions.
  pushRecent(msg.channelId, msg.author.username, msg.content);
  if (msg.author.bot) return;

  // Role mentions (<@&...>) don't land in mentions.users — match raw id too.
  const isTag = msg.mentions.users.has(botId) || msg.content.includes(botId);
  const lowered = msg.content.toLowerCase();
  const isName = NAMES.some((n) => lowered.includes(n));

  let isReplyToBot = false;
  if (msg.reference?.messageId) {
    try {
      const ref = await msg.fetchReference();
      isReplyToBot = ref.author.id === botId;
    } catch { /* deleted/unknown ref */ }
  }

  const flag = isTag ? "TAG" : isReplyToBot ? "REPLY" : isName ? "NAME" : "--";

  // Mechanical trigger: certain → straight to pi, Jev skipped.
  // Window was open → same session. Closed → new session, then open.
  if (isTag || isReplyToBot || isName) {
    const wasOpen = Date.now() < (winExp.get(msg.channelId) ?? 0);
    console.log(`[MECH][${flag}][${wasOpen ? "CONT" : "NEW"}][${msg.channelId}] ${msg.author.username}: ${msg.content}`);
    let pre = "";
    if (!wasOpen) {
      lastFed.delete(msg.channelId);
      pre = await fetchPreContext(msg);
      await pi.newSession();
    }
    winExp.set(msg.channelId, Date.now() + WINDOW_MS);
    // Mid-run mechanical: steer into the live run instead of a new one.
    if (wasOpen && pi.isBusy()) {
      console.log(`[MECH-STEER][${flag}][${msg.channelId}] ${msg.author.username}: ${msg.content}`);
      if (await pi.trySteer(await buildSeed(msg))) return;
    }
    await runPi(msg, pre);
    return;
  }

  // Inside the window → Jev decides pi-or-silent.
  if (Date.now() >= (winExp.get(msg.channelId) ?? 0)) {
    console.log(`[CLOSED][${msg.channelId}] ${msg.author.username}: ${msg.content}`);
    return;
  }
  const history = (recent.get(msg.channelId) ?? []).slice(-11, -1).map(({ author, text }) => ({ author, text }));
  const v = await judge({
    message: msg.content,
    author: msg.author.username,
    recent: history,
  });
  if (v.action === "pass") {
    console.log(`[WIN][PASS n=${v.noul.toFixed(2)}][${msg.channelId}] ${msg.author.username}: ${msg.content}`);
    // Jev yes reopens the window even if pi ends up silent.
    winExp.set(msg.channelId, Date.now() + WINDOW_MS);
    // Mid-run pass: steer into the live run instead of a new one.
    if (pi.isBusy()) {
      console.log(`[WIN-STEER][${msg.channelId}] ${msg.author.username}: ${msg.content}`);
      if (await pi.trySteer(await buildSeed(msg))) return;
    }
    await runPi(msg);
  } else {
    console.log(`[WIN][IGNORE n=${v.noul.toFixed(2)}][${msg.channelId}] ${msg.author.username}: ${msg.content}`);
  }
});

client.login(token);
