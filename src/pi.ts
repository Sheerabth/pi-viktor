// Layer 3 — one pi --mode rpc child. promptAndWait returns final text.
// Silence contract: system prompt says reply <SILENCE> when not worth speaking.

import { readFileSync } from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

const SYSTEM_PROMPT = readFileSync(new URL("./system-prompt.md", import.meta.url), "utf8");

export class Pi {
  private proc: ChildProcessWithoutNullStreams;
  private seq = 0;
  private pending = new Map<string, { res: (v: any) => void; rej: (e: any) => void }>();
  private queue: Promise<any> = Promise.resolve();
  private buf = "";

  constructor(cwd: string) {
    const bin = process.env.PI_BIN ?? `${process.env.HOME}/.pi/agent/bin/pi`;
    const home = process.env.HOME ?? "";
    this.proc = spawn(bin, ["--mode", "rpc", "--append-system-prompt", SYSTEM_PROMPT, "--extension", `${cwd}/src/pi-extensions/discord.ts`], {
      env: {
        ...process.env,
        PATH: `${home}/.local/bin:${process.env.PATH ?? ""}`,
        DISCORD_BOT_TOKEN: process.env.DISCORD_TOKEN ?? "",
      },
      cwd,
      stdio: ["pipe", "pipe", "ignore"],
    });
    this.proc.stdout.on("data", (d: Buffer) => this.onData(d));
    this.proc.on("exit", () => {
      for (const [, h] of this.pending) h.rej(new Error("pi exited"));
      this.pending.clear();
    });
  }

  private onData(d: Buffer) {
    this.buf += d.toString("utf8");
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, "");
      this.buf = this.buf.slice(i + 1);
      if (!line.trim()) continue;
      let rec: any;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      this.onRecord(rec);
    }
  }

  // Pi owns delivery (curl to the Discord API). Bot watches bash tool
  // calls to learn what posted. lastMsg is only a debug fallback.
  private current: { text: string; lastMsg: string; discordSent: boolean; res: (t: string) => void } | null = null;
  private sendIds = new Set<string>();
  sentCount = 0;

  private onRecord(rec: any) {
    if (rec.type === "response" && rec.id && this.pending.has(rec.id)) {
      const h = this.pending.get(rec.id)!;
      this.pending.delete(rec.id);
      if (rec.success) h.res(rec.data);
      else h.rej(new Error(rec.error ?? "pi error"));
      return;
    }
    if (rec.type === "message_update") {
      const u = rec.assistantMessageEvent;
      // Thinking/tool deltas never leave pi. Text accumulates for fallback.
      if (u?.type === "text_delta" && this.current) {
        this.current.text += u.delta ?? "";
      }
      return;
    }
    // A discord_send tool call = an outbound message.
    if (rec.type === "tool_execution_start" && this.current) {
      if (rec.toolName === "discord_send") this.sendIds.add(rec.toolCallId);
      return;
    }
    if (rec.type === "tool_execution_end" && this.current) {
      if (this.sendIds.has(rec.toolCallId)) {
        this.sendIds.delete(rec.toolCallId);
        if (!rec.isError) {
          this.sentCount++;
          if (this.current) this.current.discordSent = true;
        }
      }
      return;
    }
    // Track the latest assistant message; debug fallback only.
    if (rec.type === "message_end" && this.current) {
      const m = rec.message;
      if (m?.role === "assistant" && Array.isArray(m.content)) {
        const t = m.content
          .filter((b: any) => b?.type === "text" && typeof b.text === "string")
          .map((b: any) => b.text)
          .join("")
          .trim();
        if (t) this.current.lastMsg = t;
      }
      return;
    }
    if (rec.type === "agent_settled" && this.current) {
      const c = this.current;
      this.current = null;
      c.res({ text: c.lastMsg || c.text.trim(), posted: c.discordSent });
    }
  }

  private send(obj: any, timeoutMs = 120_000): Promise<any> {
    const id = `q${++this.seq}`;
    obj.id = id;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          rej(new Error("pi timeout"));
        }
      }, timeoutMs);
      this.pending.set(id, {
        res: (v) => {
          clearTimeout(timer);
          res(v);
        },
        rej: (e) => {
          clearTimeout(timer);
          rej(e);
        },
      });
      this.proc.stdin.write(JSON.stringify(obj) + "\n", (err) => {
        if (err) {
          this.pending.delete(id);
          clearTimeout(timer);
          rej(err);
        }
      });
    });
  }

  isBusy(): boolean {
    return this.current !== null;
  }

  private steerCount = 0;
  private static readonly MAX_STEERS = 2;

  /** Steer a live run. False = no live run or steer budget spent (caller falls back to a queued run). */
  async trySteer(message: string): Promise<boolean> {
    if (!this.current || this.steerCount >= Pi.MAX_STEERS) return false;
    try {
      await this.send({ type: "steer", message });
      if (this.current === null) return false;
      this.steerCount++;
      return true;
    } catch {
      return false;
    }
  }

  /** Fresh session for a new burst. Serialized with prompts. */
  newSession(): Promise<void> {
    const run = this.queue.then(async () => {
      const before: string | null = await this.send({ type: "get_state" }).then((d: any) => d?.sessionFile ?? null).catch(() => null);
      await this.send({ type: "new_session" });
      const t0 = Date.now();
      while (Date.now() - t0 < 4000) {
        const cur: string | null = await this.send({ type: "get_state" }).then((d: any) => d?.sessionFile ?? null).catch(() => null);
        if (cur && cur !== before) return;
        await new Promise((r) => setTimeout(r, 200));
      }
    });
    this.queue = run.catch(() => {});
    return run;
  }

  /** Serialize prompts — one run at a time for now. */
  ask(message: string): Promise<{ text: string; posted: boolean }> {
    const run = this.queue.then(async () => {
      const data: any = await this.send({ type: "prompt", message });
      if (data?.disposition === "handled") {
        const t: string = await this.send({ type: "get_last_assistant_text" }).then((d: any) => d?.text ?? "");
        return { text: t, posted: false };
      }
      this.sendIds.clear();
      this.sentCount = 0;
      this.steerCount = 0;
      return await new Promise<{ text: string; posted: boolean }>((res) => {
        this.current = { text: "", lastMsg: "", discordSent: false, res };
      });
    });
    this.queue = run.catch(() => {});
    return run;
  }
}
