# Google Drive live certification

Run this checklist through the production-like iMessage path, in order. Use only real files from the connected test account. Do not invent file names, document facts, or provider results, and do not treat mocked or deterministic tests as live evidence.

## Preconditions and evidence

1. Confirm the intended Google Drive account is connected and inspect its real, non-trashed contents.
2. Choose a readable native Google Doc, `[DOC_A]`, whose content contains at least one fact that can be used for grounded Q&A. If it contains action items, record that without copying its body into logs.
3. Choose a different real file or native Google Doc, `[FILE_B]`, for the re-grounding check.
4. If available, choose a second readable native Google Doc, `[DOC_B]`, with enough content for a meaningful comparison.
5. Choose a real PDF or image, `[UNSUPPORTED_FILE]`, if one is available.
6. Choose a unique `[RUN_ID]`, such as `20260720-1530`, for created resource names and initial content.
7. Record the date, account, prompts, replies, safe provider file IDs/links, and observed mutation counts. Never record access tokens, raw document bodies, or model prompts.
8. Confirm the OAuth client has passed the review required for the restricted `drive.readonly` scope. The `drive.file` scope alone cannot discover arbitrary existing files.

## A. Connection

1. Send: `Is my Google Drive connected?`
2. Pass only if Hula reports the actual connection state.

## B. Discovery

1. Send: `Show me my 5 most recently modified Drive files.`
2. Verify the order, names, types, and modified dates against Google Drive.
3. Send: `Show me my latest Google Docs.`
4. Pass only if the results are real native Google Docs and exclude trashed files.

## C. Native Google Doc entity follow-ups

1. Send: `Find the Google Doc called "[DOC_A]".`
2. Confirm the result identifies the real native Google Doc, then send these follow-ups without naming it again:
   1. `Who owns it?`
   2. `When was it last modified?`
   3. `Give me its link.`
   4. `What folder is it in?`
3. Verify every answer against Google Drive. An honest My Drive root, Shared Drive, inaccessible-parent, or no-individual-owner result is valid when it matches Google.

## D. Native Google Doc content

Continue from `[DOC_A]`:

1. Send: `Summarize it.`
2. Send: `What does it say about [KNOWN_TOPIC_OR_FACT]?`
3. Send: `What are its key points?`
4. If `[DOC_A]` contains action items, send: `What action items are in it?`
5. Pass only if every answer is grounded in the real native Google Doc. Hula must state uncertainty or absence instead of adding unsupported facts.

## E. Re-grounding

1. Send: `Find the Google Drive file called "[FILE_B]".`
2. Confirm the result is the different real file, then send:
   1. `Who owns it?`
   2. `Give me its link.`
3. Pass only if both follow-ups resolve to `[FILE_B]`, not `[DOC_A]`.

## F. Native Google Doc comparison

Run this check only when two suitable, readable native Google Docs exist.

1. Send: `Show me my latest Google Docs.`
2. Record the displayed positions of `[DOC_A]` and `[DOC_B]` as `[DOC_A_NUMBER]` and `[DOC_B_NUMBER]`.
3. Send: `Summarize the [DOC_B_NUMBER] one.`
4. Send: `Compare it with the [DOC_A_NUMBER] one.`
5. Pass only if Hula identifies both real Docs, keeps their content distinct, and grounds the comparison in their retrieved content.
6. If two suitable native Google Docs do not exist, record `NOT CURRENTLY VIABLE — fewer than two suitable native Google Docs` with no synthetic substitute. Do not claim this check passed.

## G. Confirmed writes and duplicate protection

Use the same `[RUN_ID]` throughout this section.

1. Send: `Create a Google Drive folder called Hula Drive Certification [RUN_ID].`
2. Before confirmation, verify no folder exists. Send `Yes`, then verify exactly one folder exists in Drive and Hula returns a real provider result.
3. Send: `Create a Google Doc called Hula Drive Notes [RUN_ID] with this initial content: Drive certification marker [RUN_ID].`
4. Before confirmation, verify no Doc exists. Send `Yes`, then open the returned provider result and verify exactly one native Google Doc exists with the exact initial marker.
5. Replay the same confirmation delivery/webhook path used by the first confirmation. Do not issue a new create request. Verify the provider mutation count remains one and no duplicate folder, Doc, or inserted content appears.
6. A duplicate `Yes` must not cause another provider mutation.
7. The initial-content failure path is a controlled failure-injection check, not a reason to damage a live Doc. If it is exercised, Hula must report that the Doc exists while its initial content was not verified, include the created Doc reference when available, and must not report complete success.

## H. Unsupported content

1. Send: `Find the Google Drive file called "[UNSUPPORTED_FILE]".`
2. Send: `Summarize it.`
3. Send: `Give me its link.`
4. Pass only if Hula gives an honest file-details/link limitation and does not fabricate PDF or image content.
5. If the connected Drive has no real PDF or image, record `NOT CURRENTLY VIABLE — no suitable unsupported file exists`. Do not invent one or claim this check passed.

## I. Cross-provider live regression

Run only these representative live smoke prompts unless a routing result exposes a specific concern:

1. Reminder: `Remind me in 20 minutes to record the Drive certification results.`
2. Slack: `Which Slack workspace is connected?`
3. Gmail: `What are my 5 most recent emails?`
4. Calendar: `What’s on my calendar today?`

Pass only if each request routes to and answers from the intended provider. Do not spend additional live Todoist, Asana, or Notion credits when their deterministic regression suites pass and no routing concern is observed.

Google Drive is not live-certified until every required viable check above passes through iMessage. A check recorded as not currently viable is evidence of missing test data, not a pass.
