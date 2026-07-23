import { handleTodoistWrite } from "../integrations/providers/todoist/todoistActions";
import { handleAsanaWrite } from "../integrations/providers/asana/asanaActions";
import { handleAsanaRead } from "../integrations/providers/asana/asanaReads";
import { handleNotionConversation } from "../integrations/providers/notion/conversation";
import { handleSlackConversation } from "../integrations/providers/slack/conversation";
import { handleGoogleDriveConversation } from "../integrations/providers/googleDrive/conversation";
import { handleOutlookMailConversation } from "../integrations/providers/microsoft/mailConversation";
import { handleOutlookCalendarConversation } from "../integrations/providers/microsoft/calendarConversation";
import { handleOneDriveConversation } from "../integrations/providers/microsoft/oneDriveConversation";
import { logger } from "../utils/logger";
import {
  isDestructiveFollowup,
  resolveFollowupOwner,
  type ArbiterDeps,
  type FollowupOwner,
} from "../actions/entityContextArbiter";

/**
 * Cross-provider follow-up arbitration, as one cascade step.
 *
 * Placed ABOVE the Gmail handlers so a follow-up whose context is a Todoist list
 * ("change the second one's priority") reaches Todoist instead of being swallowed
 * by Gmail's draft-edit gate — the exact real-device failure.
 *
 * WHY IT ONLY CLAIMS FOR TODOIST. This is a targeted, reversible intervention, not
 * a re-architecture of a cascade that works. When the arbiter says Gmail or
 * Calendar owns the follow-up, this DECLINES and the existing, tested order runs
 * exactly as it does today — those handlers already sit first and already resolve
 * their own contexts correctly. The only ordering that was actually wrong was
 * Gmail-above-Todoist for a Todoist follow-up, so that is the only thing changed.
 *
 * A CONFLICT is answered here rather than delegated, because by definition no
 * single provider should act on it.
 *
 * The symmetric protection — Todoist grabbing a follow-up that Gmail or Calendar
 * owns — lives in `handleTodoistWrite`, which consults the SAME arbiter before
 * claiming a bare pronoun. Both directions therefore agree by construction.
 */

export interface HandlerResult {
  handled: boolean;
  reply?: string;
  routeSource?: string;
}

export interface EntityFollowupDeps extends ArbiterDeps {
  resolveOwner?: typeof resolveFollowupOwner;
  todoistWrite?: (userId: string, text: string | undefined) => Promise<HandlerResult>;
  asanaWrite?: (userId: string, text: string | undefined) => Promise<HandlerResult>;
  asanaRead?: (userId: string, text: string | undefined) => Promise<HandlerResult>;
  notion?: (userId: string, text: string | undefined) => Promise<HandlerResult>;
  slack?: (userId: string, text: string | undefined) => Promise<HandlerResult>;
  drive?: (userId: string, text: string | undefined) => Promise<HandlerResult>;
  outlook?: (userId: string, text: string | undefined) => Promise<HandlerResult>;
  outlookCalendar?: (userId: string, text: string | undefined) => Promise<HandlerResult>;
  oneDrive?: (userId: string, text: string | undefined) => Promise<HandlerResult>;
}

/**
 * What Hula says when a DESTRUCTIVE pronoun-only follow-up has no owner.
 *
 * Failing closed matters here more than anywhere else. "Delete it" with no live
 * context previously fell through every handler to the general brain, which is
 * free to answer "Deleted!" for something that still exists — the exact class of
 * fabrication this system is built to prevent. Asking is the only honest reply,
 * and it mutates nothing.
 */
export const DESTRUCTIVE_NO_CONTEXT_REPLY =
  "I’m not sure what you’d like me to delete — could you tell me which one you mean?";

/**
 * Route a bare ordinal/pronoun follow-up to whoever the conversation is about.
 *
 * Returns `{handled:false}` for anything that is not a follow-up, or that another
 * provider owns, so ordinary messages and every existing Gmail/Calendar path are
 * completely unaffected. Never throws: an arbitration failure degrades to the
 * normal cascade rather than blocking the reply.
 */
export async function handleEntityFollowup(
  userId: string,
  text: string | undefined,
  deps: EntityFollowupDeps = {},
): Promise<HandlerResult> {
  const resolve = deps.resolveOwner ?? resolveFollowupOwner;

  let owner: FollowupOwner;
  try {
    owner = await resolve(userId, text, deps);
  } catch (err) {
    logger.error("entityFollowup arbitration failed", {
      reason: err instanceof Error ? err.message : "unknown error",
    });
    return { handled: false };
  }

  if (owner.kind === "none") {
    // Nothing owns it. Harmless for most follow-ups — the cascade carries on — but
    // a DESTRUCTIVE one must never be guessed at, or handed to the brain.
    if (isDestructiveFollowup(text)) {
      logger.info("entityFollowup destructive with no context");
      return { handled: true, reply: DESTRUCTIVE_NO_CONTEXT_REPLY };
    }
    return { handled: false };
  }

  if (owner.kind === "conflict") {
    // Two different entities named in one message. Acting on either could mutate
    // the wrong provider, so Hula asks — and mutates nothing.
    logger.info("entityFollowup conflict", { source: "arbiter" });
    return { handled: true, reply: owner.clarification };
  }

  if (owner.owner === "asana_task") {
    logger.info("entityFollowup routed", { owner: owner.owner, reason: owner.reason });
    const asanaRead = deps.asanaRead ?? ((u, t) => handleAsanaRead(u, t, { arbitrated: true }));
    const readResult = await asanaRead(userId, text);
    if (readResult.handled) return readResult;
    const asanaWrite = deps.asanaWrite ?? ((u, t) => handleAsanaWrite(u, t, { arbitrated: true }));
    return asanaWrite(userId, text);
  }
  if(owner.owner==="notion_entity"){
    logger.info("entityFollowup routed",{owner:owner.owner,reason:owner.reason});
    return (deps.notion??((u,t)=>handleNotionConversation(u,t,{arbitrated:true})))(userId,text);
  }
  if (owner.owner === "slack_entity") {
    logger.info("entityFollowup routed", { owner: owner.owner, reason: owner.reason });
    return (deps.slack ?? ((u, t) => handleSlackConversation(u, t, { arbitrated: true })))(userId, text);
  }
  if (owner.owner === "drive_file") {
    logger.info("entityFollowup routed", { owner: owner.owner, reason: owner.reason });
    const result = await (deps.drive ?? ((u, t) => handleGoogleDriveConversation(u, t, { arbitrated: true })))(userId, text);
    return result.handled ? { ...result, routeSource: "drive" } : result;
  }
  if (owner.owner === "outlook_message" || owner.owner === "outlook_draft") {
    logger.info("entityFollowup routed", { owner: owner.owner, reason: owner.reason });
    const result = await (deps.outlook ?? ((u, t) => handleOutlookMailConversation(u, t, { arbitrated: true })))(userId, text);
    return result.handled ? { ...result, routeSource: "outlookMail" } : result;
  }
  if (owner.owner === "outlook_calendar_event") {
    logger.info("entityFollowup routed", { owner: owner.owner, reason: owner.reason });
    const result = await (deps.outlookCalendar ?? ((u, t) => handleOutlookCalendarConversation(u, t, { arbitrated: true })))(userId, text);
    return result.handled ? { ...result, routeSource: "outlookCalendar" } : result;
  }
  if (owner.owner === "onedrive_file") {
    logger.info("entityFollowup routed", { owner: owner.owner, reason: owner.reason });
    const result = await (deps.oneDrive ?? ((u, t) => handleOneDriveConversation(u, t, { arbitrated: true })))(userId, text);
    return result.handled ? { ...result, routeSource: "oneDrive" } : result;
  }

  if (owner.owner !== "todoist_task") {
    // Gmail/Calendar own it — leave the tested cascade to do exactly what it
    // already does.
    return { handled: false };
  }

  logger.info("entityFollowup routed", { owner: owner.owner, reason: owner.reason });
  const todoistWrite = deps.todoistWrite ?? ((u, t) => handleTodoistWrite(u, t, { arbitrated: true }));
  return todoistWrite(userId, text);
}
