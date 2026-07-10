import { generateHulaReply } from "../src/ai/hulaBrain";
import { isAnthropicConfigured } from "../src/ai/anthropicClient";

/**
 * MANUAL brain check (Section 6). Not part of `npm test`.
 *
 * Calls the real Hula brain with a small fake message history so you can eyeball
 * the model's reply. If ANTHROPIC_API_KEY is present in `.env` it makes a real
 * Anthropic call; if not, it exercises the safe fallback path. It prints only the
 * reply text — never the API key or any provider payload.
 *
 * Run with: `npm run test:brain`
 */

async function main(): Promise<void> {
  console.log(
    isAnthropicConfigured()
      ? "Anthropic key detected — calling the real model.\n"
      : "No Anthropic key — exercising the fallback path.\n",
  );

  const scenarios: { title: string; history: { role: "user" | "assistant"; text: string }[] }[] = [
    {
      title: "What can you help me with today?",
      history: [{ role: "user", text: "What can you help me with today?" }],
    },
    {
      title: "Plan my next 3 hours",
      history: [
        { role: "user", text: "What can you help me with today?" },
        {
          role: "assistant",
          text: "I can help you think, plan, draft messages, and get organised.",
        },
        { role: "user", text: "Help me plan my next 3 hours." },
      ],
    },
  ];

  for (const s of scenarios) {
    const { reply, usedFallback } = await generateHulaReply({
      history: s.history,
      context: { channel: "imessage" },
    });
    console.log(`> ${s.title}`);
    console.log(`  fallback: ${usedFallback}`);
    console.log(`  reply: ${reply}\n`);
  }
}

void main();
