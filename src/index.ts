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
const WINDOW_MS = 2 * 60 * 1000;
function pushRecent(channelId: string, author: string, text: string) {
  const arr = recent.get(channelId) ?? [];
  arr.push({ author, text, ts: Date.now() });
  while (arr.length > 50) arr.shift();
  recent.set(channelId, arr);
}

// Append-only: send just the new message. The pi session itself
// tracks what it already has. Fetch-tools come later.
async function runPi(msg: any) {
  let ref = "";
  if (msg.reference?.messageId) {
    try {
      const r = await msg.fetchReference();
      ref = ` (replying to ${r.author?.username ?? "?"}: "${(r.content ?? "").slice(0, 300)}")`;
    } catch { /* ignore */ }
  }
  const seed = `[channel:${msg.channelId}] [${msg.author.username}]${ref}: ${msg.content}`;
  try {
    await (msg.channel as any).sendTyping?.();
    const ch: any = msg.channel;
    // Only the final answer posts. Mid-run messages never reach Discord.
    // First chunk honors [REPLY] (reply) vs default (normal message).
    let settled = false;
    let first = true;
    const sendOne = async (t: string) => {
      const reply = /^\[REPLY\]/i.test(t.trim());
      t = t.replace(/\[REPLY\]/gi, "").replace(/\[SEND\]/gi, "").trim();
      if (!t || t === "<SILENCE>") return;
      // Long messages split at a newline/space under the limit.
      const chunks: string[] = [];
      while (t.length > 1900) {
        let cut = t.lastIndexOf("\n", 1900);
        if (cut < 900) cut = t.lastIndexOf(" ", 1900);
        if (cut < 900) cut = 1900;
        chunks.push(t.slice(0, cut));
        t = t.slice(cut).trim();
      }
      chunks.push(t);
      for (const c of chunks) {
        if (first && reply) await msg.reply(c);
        else await ch.send(c);
        first = false;
      }
    };
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
    let finalText = "";
    try {
      finalText = await pi.ask(seed);
    } catch (e: any) {
      settled = true;
      await typingP;
      console.log(`[PI-ERR][${msg.channelId}] ${e?.message ?? e}`);
      return;
    }
    settled = true;
    await typingP;
    winExp.set(msg.channelId, Date.now() + WINDOW_MS);
    if (!finalText || finalText.includes("<SILENCE>")) {
      console.log(`[SILENT][${msg.channelId}] pi chose silence`);
      return;
    }
    await sendOne(finalText);
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
  if (isTag || isReplyToBot || isName) {
    console.log(`[MECH][${flag}][${msg.channelId}] ${msg.author.username}: ${msg.content}`);
    await runPi(msg);
    return;
  }

  // Inside the window → Jev decides pi-or-silent.
  if (Date.now() >= (winExp.get(msg.channelId) ?? 0)) {
    console.log(`[CLOSED][${msg.channelId}] ${msg.author.username}: ${msg.content}`);
    return;
  }
  const history = (recent.get(msg.channelId) ?? []).slice(-6, -1).map(({ author, text }) => ({ author, text }));
  const v = await judge({
    message: msg.content,
    author: msg.author.username,
    recent: history,
  });
  if (v.action === "pass") {
    console.log(`[WIN][PASS n=${v.noul.toFixed(2)}][${msg.channelId}] ${msg.author.username}: ${msg.content}`);
    await runPi(msg);
  } else {
    console.log(`[WIN][IGNORE n=${v.noul.toFixed(2)}][${msg.channelId}] ${msg.author.username}: ${msg.content}`);
  }
});

client.login(token);
