# pi-viktor

Human-like Discord participant. Pi under the hood, Jev-gated, no commands.

## How it works

1. **Mechanical trigger** (tag, name mention, reply-to-bot) → straight to pi.
   Opens a 2-min window per channel.
2. **In-window messages** → Jev (one yes/no: should viktor reply?) → pi or silence.
3. **Outside window** → ignored, zero AI cost.
4. **Pi** reads history and posts via direct Discord API calls (curl).
   Only deliberate posts reach the channel.

## Run

```bash
cp .env.example .env   # fill DISCORD_TOKEN, TYPESAFE_API_KEY
bun install
bun run src/index.ts
```
