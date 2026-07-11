/**
 * Hula brain system prompt (Section 6).
 *
 * This is the dedicated instruction layer the model receives for a normal
 * message from an already-linked user. It defines Hula's identity, honest
 * limitations, and voice. It intentionally says NOTHING about the backend
 * implementation (transport, auth, database, model vendor, tunnels) so those
 * details can never leak into a reply.
 */

/**
 * The dedicated Hula system prompt. Keep this free of any internal/vendor
 * details — see the offline test that asserts none of them appear here.
 */
export const HULA_SYSTEM_PROMPT = `You are Hula, a personal AI assistant that lives inside the user's text messages.

The user texts you like they'd text a capable friend. There is no separate app to open — you meet them right where they already type.

What you are:
- Early but genuinely useful. You can think, reason, plan, break tasks down, draft messages and text, answer questions, and help the user get organised.
- Concise, smart, direct, and warm. You sound like a sharp personal assistant, not a chatbot.

Connected apps and actions:
- You have a real, safe action system behind you. When the user connects an app, you can use it — but only through actions that are actually turned on.
- Today you can READ a user's Google Calendar if they've connected it (tell them what's on their schedule or their next event). That is the only live capability.
- You cannot yet create, change, or cancel calendar events; send emails or messages; draft or send email; create or complete tasks; write to documents; or buy anything. Those write/send actions exist in the system but are turned OFF for now.
- When the user asks for a write/send action, do not pretend. Say plainly in one line that it isn't enabled yet, and offer what you CAN do instead (for example, draft the email text right here for them to send).
- Only ever say something is done when it has actually been done. Never claim you created, sent, booked, or changed anything unless the system confirms it happened. When a real action would need the user's go-ahead, ask them to confirm before it runs.

Honest limitations (be upfront, never pretend otherwise):
- You cannot browse the web or control apps beyond the specific actions above.

How to reply:
- Get to the point. Usually 1 to 6 short sentences. Go longer only when the user clearly asks for detail or a full plan.
- If you genuinely need one piece of information to help, ask a single clear question. Otherwise just be useful right away.
- Never say things like "as an AI language model."
- Do not mention how you are built, hosted, or delivered, or the names of any tools, vendors, or services behind you.`;

/** Lightweight, safe context the caller may pass to personalise the turn. */
export interface HulaPromptContext {
  /** The user's first name, if already known safely. */
  firstName?: string;
  /** A short tone hint (e.g. from onboarding), if known. */
  tone?: string;
  /** Areas the user most wants help with (from onboarding), if known. */
  helpMost?: string[];
  /** The user's birthday (ISO `YYYY-MM-DD`), used only to derive an approx age. */
  birthday?: string;
  /** The user's sex, if known. Used sparingly. */
  sex?: string;
  /** IANA timezone, if known (e.g. "Europe/London"). */
  timezone?: string;
  /** BCP-47 locale, if known (e.g. "en-GB"). */
  locale?: string;
  /** Country, if known. */
  country?: string;
  /** The channel the message arrived on (e.g. "imessage"). */
  channel?: string;
  /**
   * Explicit long-term memories the user asked Hula to remember (Section 8),
   * already phrased as direct "You …" statements. Used lightly.
   */
  memories?: string[];
  /**
   * Display names of external apps the user has actually connected (Section 10).
   * Used only to keep Hula HONEST — Hula still cannot act on them yet, so this
   * never lets Hula claim it performed an external action. Empty/absent today
   * because no real provider connect flow exists.
   */
  connectedProviders?: string[];
}

/**
 * Map a tone preference to a one-line style instruction. Unknown tones return
 * undefined so nothing is appended. Pure and DB-free.
 */
export function toneGuidance(tone: string | undefined): string | undefined {
  switch (tone) {
    case "concise":
      return "Match their preferred tone: direct, efficient, and minimal. Skip filler.";
    case "witty":
      return "Match their preferred tone: sharper and with a little personality, while staying genuinely useful.";
    case "strategic":
      return "Match their preferred tone: structured, high-agency, and planning-oriented.";
    default:
      return undefined;
  }
}

/**
 * Derive an approximate age in whole years from an ISO `YYYY-MM-DD` birthday.
 * Returns undefined for anything unparseable or out of a sane range. Pure.
 */
export function deriveAge(birthday: string | undefined, now: Date = new Date()): number | undefined {
  if (!birthday) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(birthday.trim());
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!year || !month || !day) return undefined;
  let age = now.getFullYear() - year;
  const beforeBirthday =
    now.getMonth() + 1 < month || (now.getMonth() + 1 === month && now.getDate() < day);
  if (beforeBirthday) age -= 1;
  return age >= 0 && age < 120 ? age : undefined;
}

/**
 * Build the full system prompt, optionally appending a compact context block.
 * The context is limited to lightweight, non-sensitive hints and never includes
 * any backend/vendor detail. Profile facts are used LIGHTLY — the prompt tells
 * the model to personalise naturally without ever announcing what it knows.
 */
export function buildHulaSystemPrompt(context?: HulaPromptContext): string {
  if (!context) return HULA_SYSTEM_PROMPT;

  const lines: string[] = [];
  if (context.firstName) lines.push(`The user's first name is ${context.firstName}.`);

  const tone = toneGuidance(context.tone);
  if (tone) lines.push(tone);

  if (context.helpMost && context.helpMost.length > 0) {
    lines.push(
      `They mainly want help with: ${context.helpMost.join(", ")}. Bias useful suggestions toward these when relevant.`,
    );
  }

  const age = deriveAge(context.birthday);
  if (age !== undefined) lines.push(`They are around ${age} years old.`);

  if (context.sex) lines.push(`Sex: ${context.sex}.`);

  const place: string[] = [];
  if (context.timezone) place.push(`timezone ${context.timezone}`);
  if (context.locale) place.push(`locale ${context.locale}`);
  if (context.country) place.push(`country ${context.country}`);
  if (place.length > 0) lines.push(`Regional context: ${place.join(", ")}.`);

  if (context.channel) lines.push(`This conversation is over ${context.channel}.`);

  const sections: string[] = [HULA_SYSTEM_PROMPT];

  if (lines.length > 0) {
    sections.push(
      `Context for this user (use it lightly and naturally — personalise, but never announce what you know about them or mention onboarding/profiles):
${lines.join("\n")}`,
    );
  }

  // Explicit long-term memory (Section 8). Unlike profile context, the user
  // asked for these directly, so Hula may acknowledge them when asked what it
  // remembers — but should still use them naturally rather than reciting them.
  const memories = (context.memories ?? []).filter((m) => m.trim().length > 0);
  if (memories.length > 0) {
    sections.push(
      `Things the user has explicitly asked you to remember about them (each is written as a direct "you" statement about the user). Use them naturally when relevant; only bring them up unprompted if it clearly helps:
${memories.map((m) => `- ${m}`).join("\n")}`,
    );
  }

  // Connected integrations (Section 10/12). Strictly honest: name the apps the
  // user connected. Google Calendar reads are live; every other capability is a
  // read-only acknowledgement or turned off, so Hula never claims a write it can't do.
  const connected = (context.connectedProviders ?? []).filter((p) => p.trim().length > 0);
  if (connected.length > 0) {
    sections.push(
      `The user has connected these apps to Hula: ${connected.join(", ")}. If Google Calendar is connected, you can READ it (upcoming events, their next event) — the system fetches it for you when asked. For every other connected app, and for any create/edit/cancel/send action, the capability is not turned on yet: acknowledge the app is connected, but never claim you read its data or performed an action in it.`,
    );
  }

  if (sections.length === 1) return HULA_SYSTEM_PROMPT;

  return sections.join("\n\n");
}
