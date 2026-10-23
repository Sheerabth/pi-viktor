// Layer 2 — one Jev Noul. No thresholds-on-thresholds:
// noul > 0.5 → pi, else silent.

const API = "https://api.typesafe.ai/v1/systemone";
const MODEL = "jev-latest";

export interface GateContext {
  message: string;
  author: string;
  recent: { author: string; text: string }[];
}

export interface GateVerdict {
  action: "pass" | "ignore";
  noul: number;
}

export async function judge(ctx: GateContext): Promise<GateVerdict> {
  const key = process.env.TYPESAFE_API_KEY;
  if (!key) return { action: "ignore", noul: 0 };

  const body = {
    model: MODEL,
    state: {
      trigger: { author: ctx.author, text: ctx.message },
      recent: ctx.recent.slice(-5),
      note: "The bot named viktor is an active participant in this conversation (it was addressed moments ago).",
    },
    questions: {
      reply: {
        type: "noul",
        instructions:
          "Should viktor reply to trigger.text? Yes if it follows up on the conversation viktor is in, answers or asks viktor something, or asks the room something nobody answered. No if it's chatter between humans, a duplicate, or already answered.",
      },
    },
  };

  try {
    const res = await fetch(API, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) return { action: "ignore", noul: 0 };
    const j = (await res.json()) as any;
    const noul: number = j.answers?.reply?.noul ?? 0;
    return noul > 0.5 ? { action: "pass", noul } : { action: "ignore", noul };
  } catch {
    return { action: "ignore", noul: 0 };
  }
}
