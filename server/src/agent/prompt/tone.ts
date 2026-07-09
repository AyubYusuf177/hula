import type { UserTone } from "../../users/types";

/**
 * Tone layer for the Hula prompt. Maps the user's chosen tone (from onboarding)
 * to a short style instruction appended to the core prompt.
 *
 * Section 1: static strings only.
 */
export const TONE_INSTRUCTIONS: Record<UserTone, string> = {
  concise: "Keep replies short and to the point. Minimize filler.",
  witty: "Be warm and lightly witty, without sacrificing clarity.",
  strategic:
    "Be thoughtful and strategic. Surface tradeoffs and next steps succinctly.",
};

export function toneInstruction(tone: UserTone | undefined): string {
  if (!tone) return TONE_INSTRUCTIONS.concise;
  return TONE_INSTRUCTIONS[tone];
}
