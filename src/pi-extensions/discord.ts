// Pi extension: Discord history as files, not context.
// discord_fetch pulls (with Discord's own paging params + local filters),
// writes JSONL to a file, returns path + preview. Agent greps/seds the file.

import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const fetchTool = defineTool({
  name: "discord_fetch",
  label: "Discord fetch",
  description:
    "Pull messages from a Discord channel into a JSONL file (one {id, author, authorId, timestamp, content} per line). Returns the file path, count, and a head/tail preview — grep/sed the file for the rest, don't ask for re-fetches. Use whenever a message is ambiguous, refers to earlier discussion, or needs context you don't have.",
  parameters: Type.Object({
    channelId: Type.String({ description: "Discord channel ID (in [channel:...] of every request)" }),
    limit: Type.Optional(Type.Number({ description: "Max messages after filtering, default 50, max 500" })),
    beforeId: Type.Optional(Type.String({ description: "Page backwards from this message ID (Discord param)" })),
    afterId: Type.Optional(Type.String({ description: "Only messages after this ID (Discord param)" })),
    aroundId: Type.Optional(Type.String({ description: "Messages around this ID (Discord param)" })),
    author: Type.Optional(Type.String({ description: "Keep only this username (case-insensitive)" })),
    since: Type.Optional(Type.String({ description: "Keep only messages at/after this ISO time" })),
    until: Type.Optional(Type.String({ description: "Keep only messages at/before this ISO time" })),
  }),

  async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
    const token = process.env.DISCORD_TOKEN;
    if (!token) throw new Error("DISCORD_TOKEN missing in pi process env");
    const want = Math.min(Math.max(params.limit ?? 50, 1), 500);
    const sinceMs = params.since ? Date.parse(params.since) : NaN;
    const untilMs = params.until ? Date.parse(params.until) : NaN;
    if (params.since && isNaN(sinceMs)) throw new Error(`bad since: ${params.since}`);
    if (params.until && isNaN(untilMs)) throw new Error(`bad until: ${params.until}`);

    // Page Discord (100/page) until we have enough post-filter or run dry.
    const got: any[] = [];
    let before = params.beforeId;
    let guard = 0;
    const needRaw = params.author || params.since || params.until ? want * 3 : want;
    while (got.length < Math.max(needRaw, want) && guard++ < 6) {
      let url = `https://discord.com/api/v10/channels/${params.channelId}/messages?limit=100`;
      if (params.aroundId && guard === 1) url += `&around=${params.aroundId}`;
      else if (params.afterId && guard === 1 && !before) url += `&after=${params.afterId}`;
      else if (before) url += `&before=${before}`;
      const res = await fetch(url, { headers: { Authorization: `Bot ${token}` } });
      if (!res.ok) throw new Error(`discord_fetch http-${res.status}`);
      const page = (await res.json()) as any[];
      if (!page.length) break;
      got.push(...page);
      if (page.length < 100) break;
      before = page[page.length - 1].id;
      if (params.afterId && got.some((m: any) => m.id <= params.afterId!)) break;
    }

    let msgs = got;
    if (params.afterId && !params.aroundId) msgs = msgs.filter((m: any) => m.id > params.afterId!);
    if (params.author) {
      const a = params.author.toLowerCase();
      msgs = msgs.filter((m: any) => (m.author?.username ?? "").toLowerCase().includes(a));
    }
    if (!isNaN(sinceMs)) msgs = msgs.filter((m: any) => Date.parse(m.timestamp) >= sinceMs);
    if (!isNaN(untilMs)) msgs = msgs.filter((m: any) => Date.parse(m.timestamp) <= untilMs);
    msgs = msgs.slice(0, want).reverse();

    const lines = msgs.map((m: any) =>
      JSON.stringify({
        id: m.id,
        author: m.author?.username ?? "?",
        authorId: m.author?.id,
        timestamp: m.timestamp,
        content: m.content ?? "",
      })
    );
    const path = join(tmpdir(), `discord-${params.channelId}-${Date.now()}.jsonl`);
    await writeFile(path, lines.join("\n") + (lines.length ? "\n" : ""));
    const preview = [...lines.slice(0, 3), ...(lines.length > 6 ? ["..."] : []), ...lines.slice(-3)].join("\n");
    return {
      content: [{ type: "text", text: `${lines.length} messages → ${path}\n${preview || "(empty)"}` }],
      details: undefined,
    };
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(fetchTool);
}
