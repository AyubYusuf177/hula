Read AGENTS.md first and follow it strictly.

We are on branch `development`.

This is the FINAL Section 23 Google Drive + Google Docs live-certification repair.

DO NOT:
- stage
- commit
- push
- reset
- checkout
- stash
- discard existing work
- modify .env
- weaken tests merely to make them pass
- hardcode the live fixture names or answers into production runtime code

Work from first principles.

IMPORTANT CONTEXT

Section 23 implements Google Drive + Google Docs.

A previous fresh Codex pass already repaired:
- native Google Docs discovery
- grounded document Q&A
- evidence validation
- prompt-injection resistance
- duplicate filename disambiguation
- metadata follow-ups
- Shared Drive flags
- Google Drive folder creation
- Google Doc creation
- confirmation/idempotency
- cross-provider routing

Automated state before this live test:
- Google Drive: 36 checks passed
- Slack: 85 checks passed
- Entity arbitration: 34 assertions passed
- Inbound routing: 30 E2E tests passed
- Notion: 52 checks passed
- Asana suites passed
- full npm test passed
- lint/typecheck passed

However REAL iMessage certification has exposed three remaining production bugs.

DO NOT assume the automated tests prove correctness.
Reproduce the exact failures through the production-like inbound path and fix root causes coherently.

==================================================
REAL DOCUMENT USED FOR CERTIFICATION
==================================================

Google Doc title:

Hula Drive Test

Exact document content:

Hula Drive Test

Project Atlas launches on 30 July 2026.

The project lead is Sarah Malik.

The launch budget is £25,000.

Key priorities:
- Finish mobile testing.
- Complete the launch checklist.
- Send the final report to Sarah.

Action items:
- Ayub must finish mobile testing by 25 July.
- Sarah must approve the launch checklist by 27 July.

==================================================
WHAT PASSED LIVE
==================================================

1.
Show me my latest Google Docs.

PASS:
Only Google Docs were returned and Hula Drive Test appeared.

2.
What is the launch budget in Hula Drive Test?

PASS:
£25,000.

3.
Who is the project lead in Hula Drive Test?

PASS:
Sarah Malik.

4.
What are the key priorities in Hula Drive Test?

PARTIAL PASS:
The correct priorities were present, but Hula dumped a much larger portion of the document rather than returning only the requested labelled section.

Correct facts were present:
- Finish mobile testing.
- Complete the launch checklist.
- Send the final report to Sarah.

5.
Duplicate Resume.pdf disambiguation:

Give me the link to Resume.pdf.

Hula correctly found two duplicates and asked which one.

The one modified 17/06/2026.

PASS:
Selected correct file.

Who owns it?

PASS:
Ayub Yusuf.

Give me its link.

PASS:
Correct selected PDF link.

Summarize it.

PASS:
Hula honestly said PDF/Office/image contents cannot currently be read.

6.
Create a Google Drive folder called Hula Drive Final Certification.

PASS:
- confirmation required
- Yes created the folder
- success response returned

7.
Create a Google Doc called Hula Final Certification with initial content: Final Drive and Docs live certification.

PASS:
- confirmation required
- Yes created document
- Hula said initial content was verified
- document visibly exists in Google Drive

PRESERVE ALL OF THESE WORKING BEHAVIOURS.

==================================================
BUG 1 — ACTION ITEMS FAIL LIVE
==================================================

Exact request:

What are the action items in Hula Drive Test?

Actual response:

Based on what I read in “Hula Drive Test”:
I couldn’t find that in the document.

This is objectively wrong.

The document contains:

Action items:
- Ayub must finish mobile testing by 25 July.
- Sarah must approve the launch checklist by 27 July.

Investigate the FULL path:

Sendblue inbound
→ routeInboundText
→ entity arbitration
→ Drive conversation
→ semantic/deterministic intent
→ native Google Docs fetch
→ document normalization
→ labelled-section extraction
→ action_items operation
→ grounded answer formatting

Determine EXACTLY where action_items is lost.

Do not patch only the fixture wording.

Required behavior for natural paraphrases:

What are the action items in Hula Drive Test?
Show me the action items from Hula Drive Test.
What tasks are assigned in Hula Drive Test?
What does Hula Drive Test say under Action items?
Who needs to do what in Hula Drive Test?

All should return only grounded action-item content when that interpretation is supported.

For the exact fixture the authoritative result is:

1. Ayub must finish mobile testing by 25 July.
2. Sarah must approve the launch checklist by 27 July.

No invented items.

==================================================
BUG 2 — SUMMARY IS INCOMPLETE
==================================================

Exact request:

Summarize Hula Drive Test.

Actual live result contained only approximately:

- Project Atlas launches on 30 July 2026.
- The project lead is Sarah Malik.
- The launch budget is £25,000.

It omitted:
- all 3 key priorities
- both action items

This is not a useful summary of a short document.

The document is small enough that all material sections are within processed content.

Investigate:
- document normalization
- section representation
- summary evidence selection
- evidence ranking/filtering
- max evidence count
- model JSON selection
- deterministic fallback
- post-generation validation
- output truncation

IMPORTANT:
A safety fix must not become an information-loss bug.

For short documents, a summary should cover the material sections of the document, not arbitrarily return only the first/highest-ranked 3 facts.

For this fixture a good grounded summary must materially cover:

- Project Atlas launches 30 July 2026
- project lead Sarah Malik
- £25,000 launch budget
- Finish mobile testing
- Complete the launch checklist
- Send final report to Sarah
- Ayub mobile testing deadline 25 July
- Sarah launch checklist approval deadline 27 July

It may paraphrase, but every claim must be grounded.

Do NOT return unrelated or fabricated:
- marketing campaign
- generic product features
- tracking spend
- other invented priorities

Preserve prompt-injection protection and evidence verification.

==================================================
BUG 3 — CURRENT DRIVE ENTITY IS LOST BETWEEN FOLLOW-UPS
==================================================

This is the highest-priority bug.

Exact live sequence:

Summarize Hula Drive Test.

Then:

Who owns it?

Response:

Google Drive lists Ayub Yusuf as owner of “Hula Drive Test”.

THIS WAS CORRECT.

Immediately then:

When was it last modified?

WRONG RESPONSE:

Google Drive says
“Deeplearning Specialization-
Course 4 - Convolutional Neural Networks”
was last modified 26/09/2025...

Then:

Give me its link.

WRONG:
link was for the Deeplearning document.

Then:

What folder is it in?

WRONG:
answered about the Deeplearning document.

This proves entity continuity is unstable.

A prior `Show me my latest Google Docs` selection contained 10 files.
After explicitly opening/querying/summarizing `Hula Drive Test`, Hula correctly knew Hula Drive Test for ONE follow-up (`Who owns it?`) but the next bare follow-up reverted to another item in the old selection.

THIS MUST NEVER HAPPEN.

The invariant must be:

Once a specific entity becomes the active/current Drive entity,
all subsequent unambiguous bare follow-ups continue to refer to that entity
until:
- the user explicitly selects another entity,
- names another entity,
- or a true ambiguity requires clarification.

A metadata follow-up MUST NOT mutate active context to an unrelated selection item.

Exact sequence that must work:

Show me my latest Google Docs.
What is the launch budget in Hula Drive Test?
Who is the project lead in Hula Drive Test?
Summarize Hula Drive Test.
Who owns it?
When was it last modified?
Give me its link.
What folder is it in?

EVERY request after explicit Hula Drive Test selection must stay on Hula Drive Test.

Investigate:
- recordDriveSelection
- recordDriveEntity
- loadDriveSelection
- loadDriveEntity
- resolveDriveReference
- timestamps
- entityContextArbiter
- handleEntityFollowup
- whether metadata operations re-record entity correctly
- whether a list selection remains incorrectly stronger/newer
- whether list ordering/position is accidentally used for a bare pronoun
- whether active entity expiry/timestamp handling is inconsistent
- whether the first metadata follow-up changes context ownership
- whether entityFollowup vs Drive handler path changes state differently

Do not solve this with filename-specific logic.

Required invariant across providers:
ACTIVE EXPLICIT ENTITY > stale list selection.

A successful operation against a concrete entity should preserve or refresh that entity as active.

A bare:
- it
- that file
- its
must never silently jump to an unrelated result.

==================================================
KEY-PRIORITIES RESPONSE QUALITY
==================================================

Live:

What are the key priorities in Hula Drive Test?

returned almost the entire document.

The answer included the correct priorities, so grounding worked,
but the requested operation should return the requested labelled section.

For an explicit `key_points` / priorities request, prefer:

1. Finish mobile testing.
2. Complete the launch checklist.
3. Send the final report to Sarah.

Do not dump unrelated:
- launch date
- project lead
- budget
- action items

Similarly action_items should return action items only.

Summary can cover the whole document.

Question answers should answer the specific question.

==================================================
PRODUCTION-LIKE REGRESSION REQUIRED
==================================================

Add/extend a test entering through the same production-like routeInboundText path used by Sendblue.

Use a realistic native Google Doc fixture with the exact structure above.

Test this exact sequence IN ONE SHARED CONTEXT:

1.
Show me my latest Google Docs.

Assert:
- Drive
- Docs MIME filter
- Hula Drive Test visible

2.
What is the launch budget in Hula Drive Test?

Assert:
- £25,000
- no unsupported claims

3.
Who is the project lead in Hula Drive Test?

Assert:
- Sarah Malik
- NOT Ayub as project lead

4.
What are the key priorities in Hula Drive Test?

Assert EXACT grounded priorities are represented:
- Finish mobile testing
- Complete launch checklist
- Send final report to Sarah

Assert unrelated document facts are not dumped if operation is key_points.

5.
What are the action items in Hula Drive Test?

Assert:
- Ayub must finish mobile testing by 25 July
- Sarah must approve launch checklist by 27 July

Assert:
- no “couldn’t find that”
- no invented actions

6.
Summarize Hula Drive Test.

Assert material coverage of:
- launch date
- lead
- budget
- all three priorities
- both action items

No fabricated facts.

7.
Who owns it?

Assert Hula Drive Test metadata.

8.
When was it last modified?

Assert STILL Hula Drive Test.

9.
Give me its link.

Assert STILL Hula Drive Test URL.

10.
What folder is it in?

Assert STILL Hula Drive Test parent/root.

CRITICAL:
The old 10-item Docs selection must remain present in state during this test so the regression proves Hula does NOT revert to another list item.

11.
Give me the link to Resume.pdf.

Assert duplicate clarification.

12.
The one modified 17/06/2026.

Assert selected correct duplicate.

13.
Who owns it?
14.
Give me its link.
15.
Summarize it.

Assert selected PDF remains current and unsupported content is disclosed honestly.

==================================================
CONTEXT STATE MACHINE TESTS
==================================================

Add explicit focused tests for:

A)
list A,B,C
→ explicitly select B
→ owner(B)
→ modified?
→ link?
→ folder?
All remain B.

B)
list A,B,C
→ explicitly select B
→ metadata request
→ metadata request
→ content request
All remain B.

C)
select B
→ explicitly name C
→ follow-up `Who owns it?`
Must be C.

D)
duplicate filename unresolved
→ `Who owns it?`
Must clarify, not pick one.

E)
duplicate selected by metadata
→ several follow-ups
Must remain selected duplicate.

F)
one provider selection then another provider explicit entity
Entity arbitration must follow explicit current target without breaking Slack/Notion/Asana/Gmail/Calendar.

==================================================
DOCUMENT INTELLIGENCE REQUIREMENTS
==================================================

Preserve:

- Native Google Docs body retrieval
- headings
- paragraphs
- bullets
- nested tables
- tabs/child tabs
- text runs
- links
- truncation disclosure
- prompt injection fencing
- no generic model knowledge fallback
- exact evidence validation

But fix over-restrictive evidence selection.

Do not use a blanket “top 3 evidence only” strategy for summary if it drops material sections of a small document.

Operation-specific behavior:

question:
- answer only relevant supported evidence

key_points:
- exact labelled priority/key-point section if available

action_items:
- exact labelled action-item section if available

decisions:
- exact labelled decisions if available, else grounded evidence

deadlines:
- grounded deadline/date evidence only

summary:
- broad representative coverage across material processed sections
- still grounded
- no fabrication

==================================================
OBSERVABILITY
==================================================

Add safe diagnostics sufficient to diagnose future live failures:

- drive route operation
- route path
- active-entity source:
  active_entity / selection / explicit_name / clarification
- hashed entity/file reference only
- selection count
- document section count
- evidence candidate count
- validated evidence count
- summary coverage count/categories if useful

NEVER log:
- OAuth tokens
- raw document bodies
- secrets
- raw private file content
- raw file IDs if avoidable

==================================================
DO NOT BREAK WORKING WRITES
==================================================

Re-run and preserve:

Create a Google Drive folder...
→ proposal
→ Yes
→ exactly one creation

Create a Google Doc with initial content...
→ proposal
→ Yes
→ exactly one Doc
→ initial content verified

Duplicate confirmation:
→ exactly one mutation

No confirmation:
→ zero mutations

==================================================
CROSS-INTEGRATION REGRESSION
==================================================

Drive changes must not steal:

Remind me in 2 minutes...
→ reminder

Show me latest messages in all-hula.
→ Slack

Show me my latest email.
→ Gmail

What meetings do I have tomorrow?
→ Calendar

Add buy milk to Todoist.
→ Todoist

Create an Asana task...
→ Asana

Update my Notion page...
→ Notion

Provider-specific signals dominate generic nouns.

==================================================
REQUIRED TESTS
==================================================

Run ALL:

cd server

npm run test:google-drive
npm run test:slack
npx tsx scripts/entityArbitration.test.ts
npx tsx scripts/inboundRouting.test.ts
npm run test:notion
npm run test:asana
npm run test:asana-safety
npm run test:asana-self-assignment
npm run test:asana-hierarchy
npm run test:asana-lookup-move
npm run test:asana-routing
npm run test:asana-conversation
npm test
npm run typecheck

root:

npm run lint
npx tsc --noEmit
git diff --check

Then:
git branch --show-current
git rev-parse --short HEAD
git status --short
git diff --cached --quiet

DO NOT COMMIT.

==================================================
FINAL REPORT
==================================================

Report exactly:

1. Exact root cause of action_items live failure.
2. Exact root cause of incomplete summary.
3. Exact root cause of Hula Drive Test context switching to the Deeplearning file.
4. Why automated tests previously missed each bug.
5. Files changed.
6. New active-entity/context invariant.
7. Document intelligence changes.
8. Production-like exact live-sequence regression results.
9. Duplicate selection regression.
10. Write confirmation/idempotency results.
11. Cross-provider regression results.
12. Exact test counts.
13. Whether restart is required.
14. Whether reconnect is required.
15. Git safety state.
16. Explicit statement that nothing was staged/committed/pushed and .env was untouched.

Do not claim Section 23 complete until all automated tests pass.
