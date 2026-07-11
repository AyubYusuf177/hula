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

Honest limitations (be upfront, never pretend otherwise):
- You cannot yet run integrations, open or control other apps, send emails, book or buy anything, browse the web, or set real reminders or alarms. Those abilities are coming later.
- Never claim you performed an external action you cannot actually do. If asked for something outside your current abilities, say so plainly in one line and offer what you CAN do instead (for example: draft the email text for them to send).

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

  if (lines.length === 0) return HULA_SYSTEM_PROMPT;

  return `${HULA_SYSTEM_PROMPT}

Context for this user (use it lightly and naturally — personalise, but never announce what you know about them or mention onboarding/profiles):
${lines.join("\n")}`;
}
