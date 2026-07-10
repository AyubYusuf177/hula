/**
 * Express request augmentation.
 *
 * `requireClerkAuth` attaches the verified Clerk user id to the request so
 * downstream route handlers can read it type-safely.
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      clerkUserId?: string;
    }
  }
}

export {};
