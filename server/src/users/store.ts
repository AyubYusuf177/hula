import { getPrisma } from "../db/prisma";

/**
 * User persistence helpers.
 *
 * A Hula `User` row is keyed off the Clerk user id. Everything else (link
 * sessions, messaging identities, conversations, messages) references the
 * internal `User.id`, so the Clerk id lives in exactly one place.
 */

/**
 * Find the Hula user for a Clerk user id, creating it on first sight. Uses an
 * upsert so concurrent link attempts can't create duplicates.
 */
export async function getOrCreateUserByClerkId(
  clerkUserId: string,
): Promise<{ id: string; clerkUserId: string }> {
  const user = await getPrisma().user.upsert({
    where: { clerkUserId },
    update: {},
    create: { clerkUserId },
    select: { id: true, clerkUserId: true },
  });
  return user;
}
