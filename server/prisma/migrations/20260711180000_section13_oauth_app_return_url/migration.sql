-- Section 13: seamless OAuth return.
-- Additive, nullable column carrying the validated app deep-link used to bounce
-- the user back into Hula after the Google Calendar OAuth callback. No data reset,
-- no destructive change — existing pending/consumed rows are unaffected.
ALTER TABLE "integration_oauth_states" ADD COLUMN "appReturnUrl" TEXT;
