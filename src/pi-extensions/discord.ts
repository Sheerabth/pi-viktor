// Discord tools for pi. Everything Discord lives here — no curl in prompts.
// File-based history: fetch writes JSONL, pi greps it. Never stuffs context.

import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const API = "https://discord.com/api/v10";
const HEADERS = () => ({
  Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN ?? ""}`,
  "Content-Type": "application/json",
  "User-Agent": "DiscordBot (pi-viktor, 1.0)",
});

async function req(path: string, init?: RequestInit): Promise<any> {
  const isForm = typeof FormData !== "undefined" && init?.body instanceof FormData;
  const h = HEADERS();
  const base = isForm ? { Authorization: h.Authorization, "User-Agent": h["User-Agent"] } : h;
  const res = await fetch(API + path, { ...init, headers: { ...base, ...(init?.headers ?? {}) } });
  if (!res.ok) throw new Error(`discord api ${res.status} on ${path}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

const SNOW_EPOCH = 1420070400000;
function parseDate(s: string): number {
  const t = s.trim().toLowerCase();
  const now = Date.now();
  const day = 86400000;
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  if (t === "today") return midnight.getTime();
  if (t === "yesterday") return midnight.getTime() - day;
  const m = t.match(/^(\d+)([hdw])$/);
  if (m) return now - parseInt(m[1]) * (m[2] === "h" ? 3600000 : m[2] === "d" ? day : day * 7);
  const ms = Date.parse(s);
  if (isNaN(ms)) throw new Error(`bad date: ${s}`);
  return ms;
}

function toRow(m: any): any {
  const at = m.attachments ?? [];
  return { id: m.id, author: m.author?.username ?? "?", authorId: m.author?.id,
    bot: !!m.author?.bot, timestamp: m.timestamp, content: m.content ?? "",
    has: { image: at.some((a: any) => (a.content_type ?? "").startsWith("image/")),
           video: at.some((a: any) => (a.content_type ?? "").startsWith("video/")),
           file: at.length > 0, link: /https?:\/\//.test(m.content ?? ""),
           embed: (m.embeds ?? []).length > 0, mention: (m.mentions ?? []).length > 0,
           reaction: (m.reactions ?? []).length > 0 },
    mentions: (m.mentions ?? []).map((u: any) => u.username ?? "?"),
    attachments: at.slice(0, 10).map((a: any) => ({ filename: a.filename, size: a.size, contentType: a.content_type })),
  };
}

async function dump(channelId: string, rows: any[], truncated: boolean): Promise<string> {
  const lines = rows.map((r: any) => JSON.stringify(r));
  const path = join(tmpdir(), `discord-${channelId}-${Date.now()}.jsonl`);
  await writeFile(path, lines.join("\n") + (lines.length ? "\n" : ""));
  const prev = [...lines.slice(0, 3), ...(lines.length > 6 ? ["..."] : []), ...lines.slice(-3)];
  return `${lines.length} messages${truncated ? " (TRUNCATED at 4000 — narrow the range)" : ""} -> ${path}\n${prev.join("\n") || "(empty)"}`;
}

const aroundTool = defineTool({
  name: "discord_around",
  label: "Discord around",
  description:
    "Messages AROUND a message, bounded by datetimes on both sides. Writes JSONL (one {id, author, timestamp, content, has, mentions, attachments} per line), returns path + count + preview — grep/sed the file. Use to see what led up to a message and what followed it.",
  parameters: Type.Object({
    channelId: Type.String({ description: "Channel ID (in [channel:...] of every request)" }),
    messageId: Type.String({ description: "Center message. Use a [msg:...] id." }),
    since: Type.String({ description: "Lower bound datetime (ISO, or today|yesterday)." }),
    until: Type.Optional(Type.String({ description: "Upper bound datetime (ISO, or today|yesterday). Default: now." })),
  }),
  async execute(_id, p, _signal, _onUpdate, _ctx) {
    if (!process.env.DISCORD_BOT_TOKEN) throw new Error("DISCORD_BOT_TOKEN missing");
    const sinceMs = parseDate(p.since), untilMs = p.until ? parseDate(p.until) : Date.now();
    const seen = new Map<string, any>();
    const first: any[] = await req(`/channels/${p.channelId}/messages?limit=100&around=${p.messageId}`);
    for (const m of first) seen.set(m.id, m);
    let before = first.length ? [...first].sort((a: any, b: any) => (a.id < b.id ? -1 : 1))[0].id : p.messageId;
    while (true) {
      const page = await req(`/channels/${p.channelId}/messages?limit=100&before=${before}`);
      if (!page.length) break;
      let stop = false;
      for (const m of page) {
        if (Date.parse(m.timestamp) < sinceMs) { stop = true; break; }
        seen.set(m.id, m);
      }
      if (stop || page.length < 100) break;
      before = page[page.length - 1].id;
    }
    let after = p.messageId;
    while (true) {
      const page = await req(`/channels/${p.channelId}/messages?limit=100&after=${after}`);
      if (!page.length) break;
      let stop = false;
      for (const m of page) {
        if (Date.parse(m.timestamp) > untilMs) { stop = true; break; }
        seen.set(m.id, m);
      }
      if (stop || page.length < 100) break;
      after = page[page.length - 1].id;
    }
    const msgs = [...seen.values()]
      .filter((m: any) => { const t = Date.parse(m.timestamp); return t >= sinceMs && t <= untilMs; })
      .sort((a: any, b: any) => (a.id < b.id ? -1 : 1));
    const text = await dump(p.channelId, msgs.map(toRow), false);
    return { content: [{ type: "text", text }], details: undefined };
  },
});

const rangeTool = defineTool({
  name: "discord_range",
  label: "Discord range",
  description:
    "Messages between two datetimes. Writes JSONL (one {id, author, timestamp, content, has, mentions, attachments} per line), returns path + count + preview — grep/sed the file. Use for bounded windows.",
  parameters: Type.Object({
    channelId: Type.String({ description: "Channel ID (in [channel:...] of every request)" }),
    since: Type.String({ description: "Start datetime (ISO, or today|yesterday)." }),
    until: Type.String({ description: "End datetime (ISO, or today|yesterday)." }),
  }),
  async execute(_id, p, _signal, _onUpdate, _ctx) {
    if (!process.env.DISCORD_BOT_TOKEN) throw new Error("DISCORD_BOT_TOKEN missing");
    const sinceMs = parseDate(p.since), untilMs = parseDate(p.until);
    const got: any[] = [];
    let after = String((BigInt(sinceMs) - BigInt(1420070400000)) << BigInt(22));
    while (true) {
      const page = await req(`/channels/${p.channelId}/messages?limit=100&after=${after}`);
      if (!page.length) break;
      const inRange = page.filter((m: any) => { const t = Date.parse(m.timestamp); return t >= sinceMs && t <= untilMs; });
      got.push(...inRange);
      if (page.length < 100) break;
      if (Date.parse(page[page.length - 1].timestamp) > untilMs) break;
      after = page[page.length - 1].id;
    }
    const msgs = got.sort((a: any, b: any) => (a.id < b.id ? -1 : 1));
    const text = await dump(p.channelId, msgs.map(toRow), false);
    return { content: [{ type: "text", text }], details: undefined };
  },
});

const sendTool = defineTool({
  name: "discord_send",
  label: "Discord send",
  description: "Post a message to a Discord channel. Use for everything the user should see. Silent = don't call it.",
  parameters: Type.Object({
    channelId: Type.String({}),
    content: Type.Optional(Type.String({ description: "Message text, max 2000 chars. <@user-id> mentions people." })),
    replyTo: Type.Optional(Type.String({ description: "Message ID to reply to. Auto-downgrades to plain send when the channel hasn't moved past it, or only your own messages followed." })),
    ping: Type.Optional(Type.Boolean({ description: "Ping on reply. Default false — only true when they must see it NOW." })),
    silent: Type.Optional(Type.Boolean({ description: "Send without triggering notifications. Default true. Set false only for must-see-now." })),
    filePath: Type.Optional(Type.String({ description: "Local file to upload (image, gif, video, doc)" })),
  }),
  async execute(_id, p, _signal, _onUpdate, _ctx) {
    const body: any = { content: (p.content ?? "").slice(0, 2000) };
    if (p.replyTo) {
      // Threaded reply only if the channel moved past the target: target
      // still latest, or only our own messages followed → plain send.
      // Invalid target → send plain, never fail the run.
      let wantRef = true;
      try {
        const latest: any = await req(`/channels/${p.channelId}/messages?limit=1`);
        if (latest?.[0]?.id === p.replyTo) wantRef = false;
        else {
          const after: any = await req(`/channels/${p.channelId}/messages?after=${p.replyTo}&limit=20`);
          const me = await botId();
          if (!(Array.isArray(after) ? after : []).some((m: any) => m.author?.id !== me)) wantRef = false;
        }
      } catch { wantRef = false; }
      if (wantRef) {
        body.message_reference = { message_id: p.replyTo };
        body.allowed_mentions = { replied_user: p.ping === true };
      }
    }
    if (p.silent !== false) body.flags = 1 << 12;
    if (p.filePath) {
      const data = await readFile(p.filePath);
      const fd = new FormData();
      fd.append("file", new Blob([data]), basename(p.filePath));
      fd.append("payload_json", JSON.stringify(body));
      const r = await req(`/channels/${p.channelId}/messages`, { method: "POST", body: fd });
      return { content: [{ type: "text", text: `sent ${r.id} with file` }], details: undefined };
    }
    const r = await req(`/channels/${p.channelId}/messages`, { method: "POST", body: JSON.stringify(body) });
    return { content: [{ type: "text", text: `sent ${r.id}` }], details: undefined };
  },
});

const reactTool = defineTool({
  name: "discord_react",
  label: "Discord react",
  description: "Add an emoji reaction to a message. Emoji: unicode char or custom name:id.",
  parameters: Type.Object({
    channelId: Type.String({}),
    messageId: Type.String({}),
    emoji: Type.String({ description: "Emoji, URL-encoded if unicode (e.g. %F0%9F%91%80)" }),
  }),
  async execute(_id, p, _signal, _onUpdate, _ctx) {
    await req(`/channels/${p.channelId}/messages/${p.messageId}/reactions/${p.emoji}/@me`, { method: "PUT" });
    return { content: [{ type: "text", text: "reacted" }], details: undefined };
  },
});

const downloadTool = defineTool({
  name: "discord_download",
  label: "Discord download",
  description: "Download attachments from specific messages to tmp. Returns local paths. Fetch first to see what's attached (or use a [msg:...] id straight from the request).",
  parameters: Type.Object({
    channelId: Type.String({}),
    messageIds: Type.Array(Type.String(), { description: "Message IDs to download attachments from" }),
  }),
  async execute(_id, p, _signal, _onUpdate, _ctx) {
    if (!process.env.DISCORD_BOT_TOKEN) throw new Error("DISCORD_BOT_TOKEN missing");
    const out: any[] = [];
    for (const mid of p.messageIds.slice(0, 10)) {
      let m: any;
      try {
        m = await req(`/channels/${p.channelId}/messages/${mid}`);
      } catch (e: any) {
        out.push({ messageId: mid, error: e?.message ?? "fetch failed" });
        continue;
      }
      for (const a of (m.attachments ?? []).slice(0, 5)) {
        try {
          if ((a.size ?? 0) > 25 * 1024 * 1024) { out.push({ messageId: mid, filename: a.filename, skipped: "over 25MB" }); continue; }
          const r = await fetch(a.url);
          if (!r.ok) throw new Error(`http ${r.status}`);
          const lp = join(tmpdir(), `discord-${mid}-${a.filename}`);
          await writeFile(lp, Buffer.from(await r.arrayBuffer()));
          out.push({ messageId: mid, filename: a.filename, contentType: a.content_type, localPath: lp });
        } catch (e: any) {
          out.push({ messageId: mid, filename: a.filename, error: e?.message ?? "download failed" });
        }
      }
      if (!(m.attachments ?? []).length) out.push({ messageId: mid, note: "no attachments" });
    }
    return { content: [{ type: "text", text: out.map((o: any) => JSON.stringify(o)).join("\n") || "(nothing)" }], details: undefined };
  },
});

let myId: string | null = null;
async function botId(): Promise<string> {
  if (!myId) myId = (await req("/users/@me")).id;
  return myId!;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool(aroundTool);
  pi.registerTool(rangeTool);
  pi.registerTool(sendTool);
  pi.registerTool(reactTool);
  pi.registerTool(downloadTool);
}
