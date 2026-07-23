import assert from "node:assert/strict";

import type { ActionProposalView, CreateProposalInput } from "../src/actions/proposals";
import { loadGroundedContexts, resolveFollowupOwner } from "../src/actions/entityContextArbiter";
import { handleOneDriveConversation, type OneDriveConversationDeps } from "../src/integrations/providers/microsoft/oneDriveConversation";
import {
  loadOneDriveEntity,
  recordOneDriveEntity,
} from "../src/integrations/providers/microsoft/oneDriveContext";
import {
  explicitOneDriveFollowupIntent,
  explicitOneDriveIntent,
} from "../src/integrations/providers/microsoft/oneDriveIntent";
import {
  listOneDriveRoot,
  normalizeOneDriveItem,
} from "../src/integrations/providers/microsoft/oneDriveOperations";
import type { OneDriveItem } from "../src/integrations/providers/microsoft/oneDriveTypes";
import { handleEntityFollowup } from "../src/routes/entityFollowup";
import {
  routeInboundText,
  type HandlerResult,
  type InboundRouterDeps,
  type RoutedReply,
} from "../src/routes/inboundRouting";

const USER = "onedrive-hardening-user";
const NOW = new Date("2026-07-23T15:00:00Z");
const DOCUMENT_TEXT = [
  "Hula OneDrive Final Test",
  "",
  "Project Atlas launches on 30 July 2026.",
  "Ayub must finish final testing by 27 July 2026.",
  "Sarah must approve the launch checklist by 28 July 2026.",
  "",
  "The main priority is completing testing before launch.",
].join("\n");

let passed = 0;

async function check(name: string, run: () => Promise<void>): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ok - ${name}`);
}

function mimeType(name: string): string {
  if (/\.txt$/i.test(name)) return "text/plain";
  if (/\.md$/i.test(name)) return "text/markdown";
  if (/\.csv$/i.test(name)) return "text/csv";
  if (/\.json$/i.test(name)) return "application/json";
  if (/\.pdf$/i.test(name)) return "application/pdf";
  if (/\.docx$/i.test(name)) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  return "application/octet-stream";
}

function rawItem(
  id: string,
  name: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    name,
    size: 280,
    createdDateTime: "2026-07-22T10:00:00Z",
    lastModifiedDateTime: "2026-07-23T11:06:07Z",
    createdBy: { user: { id: "creator", displayName: "Ayub" } },
    lastModifiedBy: { user: { id: "modifier", displayName: "Sarah" } },
    webUrl: `https://onedrive.live.com/item/${id}`,
    parentReference: { driveId: "drive-1", id: "root", path: "/drive/root:" },
    file: { mimeType: mimeType(name) },
    ...overrides,
  };
}

function item(id: string, name: string, overrides: Record<string, unknown> = {}): OneDriveItem {
  const normalized = normalizeOneDriveItem(rawItem(id, name, overrides));
  assert.ok(normalized);
  return normalized;
}

function contextStore(now = NOW) {
  const rows: ActionProposalView[] = [];
  let sequence = 0;
  const store = {
    now,
    create: async (_userId: string, input: CreateProposalInput) => {
      sequence += 1;
      const createdAt = new Date(now.getTime() + sequence).toISOString();
      const row: ActionProposalView = {
        id: `ctx-${sequence}`,
        provider: input.provider ?? null,
        actionId: input.actionId,
        status: "proposed",
        riskLevel: input.riskLevel,
        confirmationRequired: input.confirmationRequired ?? false,
        previewText: input.previewText,
        input: input.input ?? null,
        expiresAt: new Date(now.getTime() + (input.ttlMs ?? 600_000)).toISOString(),
        confirmedAt: null,
        rejectedAt: null,
        executedAt: null,
        createdAt,
      };
      rows.unshift(row);
      return row;
    },
    listRecent: async (_userId: string, actionId: string) =>
      rows.filter((row) => row.actionId === actionId),
  };
  return { rows, store };
}

function conversation(
  state: ReturnType<typeof contextStore>,
  overrides: Partial<OneDriveConversationDeps> = {},
): OneDriveConversationDeps {
  return {
    ...state.store,
    extract: async () => null,
    getMicrosoftState: async () => ({ connected: true }),
    getGoogleState: async () => ({ connected: false }),
    getContexts: (userId) => loadGroundedContexts(userId, state.store),
    search: async () => ({ items: [], hasMore: false }),
    root: async () => ({ items: [], hasMore: false }),
    recent: async () => ({ items: [], hasMore: false }),
    ...overrides,
  };
}

function decline() {
  return Promise.resolve({ handled: false as const });
}

function router(
  state: ReturnType<typeof contextStore>,
  oneDriveDeps: OneDriveConversationDeps,
  driveHandler: (userId: string, text: string | undefined) => Promise<HandlerResult> =
    async () => ({ handled: false }),
): InboundRouterDeps {
  const oneDrive = (userId: string, text: string | undefined) =>
    handleOneDriveConversation(userId, text, oneDriveDeps);
  const oneDriveFollowup = (userId: string, text: string | undefined) =>
    handleOneDriveConversation(userId, text, { ...oneDriveDeps, arbitrated: true });
  return {
    transportKeyword: decline,
    mailProposalRevision: decline,
    confirmation: decline,
    entityFollowup: (userId, text) => handleEntityFollowup(userId, text, {
      listRecent: state.store.listRecent,
      now: state.store.now,
      oneDrive: oneDriveFollowup,
      drive: driveHandler,
    }),
    memory: decline,
    reminder: decline,
    teamsUnsupported: decline,
    slack: decline,
    oneDrive,
    drive: driveHandler,
    notion: decline,
    asanaWrite: decline,
    asanaRead: decline,
    outlookMail: decline,
    gmailClarify: decline,
    gmailDraftFollowup: decline,
    gmailDraftLifecycle: decline,
    gmailCommand: decline,
    calendarUndo: decline,
    todoistUndo: decline,
    todoistWrite: decline,
    todoistRead: decline,
    outlookCalendar: decline,
    calendarWrite: decline,
    gmailWrite: decline,
    actionIntent: decline,
    calendarAvailability: decline,
    calendar: decline,
    calendarRead: decline,
    gmailReadOne: decline,
    gmailSummary: decline,
    gmailSearch: decline,
    gmailQuestion: decline,
    pendingReprompt: async () => ({ handled: false }),
  };
}

async function route(
  text: string,
  state: ReturnType<typeof contextStore>,
  deps: OneDriveConversationDeps,
  driveHandler?: () => Promise<{ handled: boolean; reply?: string }>,
): Promise<RoutedReply | null> {
  return routeInboundText(USER, text, router(state, deps, driveHandler));
}

async function main(): Promise<void> {
  await check("class 1: fresh root file is found when Graph search indexing is empty", async () => {
    const state = contextStore();
    const fresh = item("fresh", "Hula OneDrive Final Test.txt");
    let searchCalls = 0;
    let rootCalls = 0;
    const deps = conversation(state, {
      search: async () => { searchCalls += 1; return { items: [], hasMore: false }; },
      root: async () => { rootCalls += 1; return { items: [fresh], hasMore: false }; },
    });
    const result = await route("Find my OneDrive file called Hula OneDrive Final Test.", state, deps);
    assert.equal(result?.source, "oneDrive");
    assert.match(result?.reply ?? "", /Hula OneDrive Final Test\.txt/);
    assert.equal(searchCalls, 1);
    assert.equal(rootCalls, 1);
    assert.equal((await loadOneDriveEntity(USER, state.store))?.itemId, "fresh");
  });

  await check("class 2: an omitted extension resolves a unique exact basename", async () => {
    const state = contextStore();
    const atlas = item("atlas", "Project Atlas.txt");
    const deps = conversation(state, {
      search: async () => ({ items: [atlas], hasMore: false }),
      root: async () => { throw new Error("strong search match must not enumerate root"); },
    });
    const result = await route("Find OneDrive Project Atlas.", state, deps);
    assert.match(result?.reply ?? "", /Project Atlas\.txt/);
    assert.equal((await loadOneDriveEntity(USER, state.store))?.itemId, "atlas");
  });

  await check("class 3: same-basename files clarify instead of selecting arbitrarily", async () => {
    const state = contextStore();
    const deps = conversation(state, {
      search: async () => ({ items: [], hasMore: false }),
      root: async () => ({
        items: [item("txt", "Project Atlas.txt"), item("md", "Project Atlas.md")],
        hasMore: false,
      }),
    });
    const result = await route("Find Project Atlas in OneDrive.", state, deps);
    assert.match(result?.reply ?? "", /Which one do you mean/i);
    assert.match(result?.reply ?? "", /Project Atlas\.txt/);
    assert.match(result?.reply ?? "", /Project Atlas\.md/);
    assert.equal(await loadOneDriveEntity(USER, state.store), null);
  });

  await check("class 4: a strong direct search result avoids fallback enumeration", async () => {
    const state = contextStore();
    let rootCalls = 0;
    const deps = conversation(state, {
      search: async () => ({ items: [item("direct", "Launch Notes.md")], hasMore: false }),
      root: async () => { rootCalls += 1; return { items: [], hasMore: false }; },
    });
    const result = await route("Search OneDrive for Launch Notes.md.", state, deps);
    assert.match(result?.reply ?? "", /Launch Notes\.md/);
    assert.equal(rootCalls, 0);
  });

  await check("class 5: named fallback reads later pages but stops at the bounded page limit", async () => {
    const state = contextStore();
    let pageCalls = 0;
    const target = rawItem("later", "Later Page Match.txt");
    const root = async (userId: string, limit = 10) => listOneDriveRoot(userId, limit, {
      request: async (_userId, options) => {
        pageCalls += 1;
        if (!options.nextLink) {
          return {
            value: Array.from({ length: 25 }, (_, index) => rawItem(`p1-${index}`, `First ${index}.txt`)),
            "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/drive/root/children?$skip=25",
          } as never;
        }
        if (options.nextLink.includes("$skip=25")) {
          return {
            value: Array.from({ length: 25 }, (_, index) => rawItem(`p2-${index}`, `Second ${index}.txt`)),
            "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/drive/root/children?$skip=50",
          } as never;
        }
        return {
          value: [target, ...Array.from({ length: 24 }, (_, index) => rawItem(`p3-${index}`, `Third ${index}.txt`))],
          "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/drive/root/children?$skip=75",
        } as never;
      },
    });
    const deps = conversation(state, {
      search: async () => ({ items: [], hasMore: false }),
      root,
    });
    const result = await route("Find Later Page Match in OneDrive.", state, deps);
    assert.match(result?.reply ?? "", /Later Page Match\.txt/);
    assert.equal(pageCalls, 3);
  });

  await check("class 6: find, open, summary, deadlines, modified time, and link stay on one entity", async () => {
    const state = contextStore();
    const atlas = item("atlas", "Hula OneDrive Final Test.txt");
    const deps = conversation(state, {
      search: async () => ({ items: [atlas], hasMore: false }),
      get: async (_userId, ref) => {
        assert.equal(ref.itemId, "atlas");
        return atlas;
      },
      getOwner: async () => ({ id: "owner", name: "Ayub", email: null }),
      getContent: async (_userId, selected) => ({
        item: selected,
        text: DOCUMENT_TEXT,
        originalCharacters: DOCUMENT_TEXT.length,
        processedCharacters: DOCUMENT_TEXT.length,
        truncated: false,
      }),
      analyze: async ({ content, mode }) => {
        assert.match(content.text, /Ayub must finish final testing by 27 July 2026/);
        return mode === "deadlines"
          ? "27 July 2026 — Ayub final testing\n28 July 2026 — Sarah approval\n30 July 2026 — Project Atlas launch"
          : "Project Atlas launches on 30 July; testing is due 27 July and Sarah’s approval is due 28 July.";
      },
    });
    await route("Find my OneDrive file called Hula OneDrive Final Test.", state, deps);
    assert.match((await route("Open it.", state, deps))?.reply ?? "", /Hula OneDrive Final Test\.txt/);
    const gistOwner = await resolveFollowupOwner(USER, "What’s the gist?", {
      listRecent: state.store.listRecent,
      now: state.store.now,
    });
    assert.equal(gistOwner.kind, "owner");
    if (gistOwner.kind === "owner") assert.equal(gistOwner.owner, "onedrive_file");
    assert.match((await route("What’s the gist?", state, deps))?.reply ?? "", /launches on 30 July/i);
    assert.match((await route("What are the deadlines?", state, deps))?.reply ?? "", /27 July 2026[\s\S]*28 July 2026[\s\S]*30 July 2026/);
    assert.match((await route("When was it modified?", state, deps))?.reply ?? "", /23 Jul 2026/);
    assert.match((await route("Give me the link.", state, deps))?.reply ?? "", /onedrive\.live\.com\/item\/atlas/);
    assert.equal((await loadOneDriveEntity(USER, state.store))?.itemId, "atlas");
  });

  await check("class 7: expired bare context fails closed while an explicit name re-grounds", async () => {
    const state = contextStore();
    const old = item("old", "Old Notes.txt");
    await recordOneDriveEntity(USER, old, state.store);
    for (const row of state.rows) row.expiresAt = new Date(NOW.getTime() - 1).toISOString();
    const current = item("current", "Current Notes.txt");
    const deps = conversation(state, {
      search: async () => ({ items: [current], hasMore: false }),
      get: async () => current,
      getOwner: async () => ({ id: "owner", name: "Ayub", email: null }),
    });
    assert.equal(await route("Open it.", state, deps), null);
    const result = await route("Open the OneDrive file called Current Notes.", state, deps);
    assert.match(result?.reply ?? "", /Current Notes\.txt/);
    assert.equal((await loadOneDriveEntity(USER, state.store))?.itemId, "current");
  });

  await check("class 8: explicit Google Drive and OneDrive requests override stale cross-provider context", async () => {
    const state = contextStore();
    const one = item("one", "Hula OneDrive Final Test.txt");
    let oneDriveSearches = 0;
    let googleCalls = 0;
    const deps = conversation(state, {
      getGoogleState: async () => ({ connected: true }),
      search: async () => { oneDriveSearches += 1; return { items: [one], hasMore: false }; },
    });
    await route("Find Hula OneDrive Final Test in OneDrive.", state, deps);
    const google = await route("Find Google Drive Hula Drive Test.", state, deps, async () => {
      googleCalls += 1;
      return { handled: true, reply: "Hula Drive Test — Google Drive" };
    });
    assert.equal(google?.source, "drive");
    assert.equal(googleCalls, 1);
    assert.equal(oneDriveSearches, 1);

    state.rows.unshift({
      id: "google-context",
      provider: "google_drive",
      actionId: "drive.entityContext",
      status: "proposed",
      riskLevel: "read",
      confirmationRequired: false,
      previewText: "",
      input: { ref: { fileId: "google", name: "Old Google File" }, contextEstablishedAt: NOW.getTime() + 100 },
      expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
      confirmedAt: null,
      rejectedAt: null,
      executedAt: null,
      createdAt: new Date(NOW.getTime() + 100).toISOString(),
    });
    const oneDrive = await route("Find OneDrive Hula OneDrive Final Test.", state, deps);
    assert.equal(oneDrive?.source, "oneDrive");
    assert.equal(oneDriveSearches, 2);
  });

  await check("class 9: txt, Markdown, CSV, and JSON content reaches grounded analysis", async () => {
    for (const extension of ["txt", "md", "csv", "json"]) {
      const state = contextStore();
      const supported = item(extension, `Grounded.${extension}`);
      let reads = 0;
      const deps = conversation(state, {
        search: async () => ({ items: [supported], hasMore: false }),
        get: async () => supported,
        getContent: async () => {
          reads += 1;
          return {
            item: supported,
            text: DOCUMENT_TEXT,
            originalCharacters: DOCUMENT_TEXT.length,
            processedCharacters: DOCUMENT_TEXT.length,
            truncated: false,
          };
        },
        analyze: async ({ content }) => {
          assert.match(content.text, /Project Atlas launches/);
          return "Grounded: Project Atlas launches on 30 July 2026.";
        },
      });
      await route(`Find Grounded.${extension} in OneDrive.`, state, deps);
      const result = await route("What does it basically say?", state, deps);
      assert.match(result?.reply ?? "", /30 July 2026/);
      assert.equal(reads, 1);
    }
  });

  await check("class 10: unsupported binaries keep metadata and refuse invented summaries", async () => {
    const state = contextStore();
    const binary = item("word", "Hula OneDrive Final Test.txt.docx");
    let reads = 0;
    const deps = conversation(state, {
      search: async () => ({ items: [binary], hasMore: false }),
      get: async () => binary,
      getContent: async () => {
        reads += 1;
        throw new Error("binary content must not be read");
      },
    });
    await route("Find Hula OneDrive Final Test in OneDrive.", state, deps);
    const result = await route("Summarize it.", state, deps);
    assert.match(result?.reply ?? "", /can’t read this file type/i);
    assert.equal(reads, 0);
  });

  await check("class 11: folder context lists children and scopes named fallback to that folder", async () => {
    const state = contextStore();
    const folder = item("folder", "Project Atlas", {
      file: undefined,
      folder: { childCount: 2 },
    });
    const final = item("final", "Final Notes.md", {
      parentReference: { driveId: "drive-1", id: "folder", path: "/drive/root:/Project Atlas" },
    });
    let rootCalls = 0;
    let folderCalls = 0;
    const deps = conversation(state, {
      search: async (_userId, query) => ({
        items: /project atlas/i.test(query) ? [folder] : [],
        hasMore: false,
      }),
      root: async () => { rootCalls += 1; return { items: [], hasMore: false }; },
      folder: async (_userId, selected) => {
        folderCalls += 1;
        assert.equal(selected.itemId, "folder");
        return { items: [final], hasMore: false };
      },
      get: async (_userId, ref) => ref.itemId === "folder" ? folder : final,
      getOwner: async () => ({ id: "owner", name: "Ayub", email: null }),
    });
    await route("Open the OneDrive folder called Project Atlas.", state, deps);
    assert.match((await route("What files are in it?", state, deps))?.reply ?? "", /Final Notes\.md/);
    assert.match((await route("Find Final Notes in that folder.", state, deps))?.reply ?? "", /Final Notes\.md/);
    assert.equal(rootCalls, 0);
    assert.equal(folderCalls, 2);
    assert.equal((await loadOneDriveEntity(USER, state.store))?.itemId, "final");
  });

  await check("class 12: remote items preserve the underlying remote drive and item IDs", async () => {
    const state = contextStore();
    const remote = normalizeOneDriveItem({
      id: "wrapper",
      name: "Shared Atlas.txt",
      parentReference: { driveId: "local-drive" },
      remoteItem: rawItem("remote-item", "Shared Atlas.txt", {
        parentReference: { driveId: "remote-drive", id: "remote-parent", path: "/drive/root:/Shared" },
      }),
    });
    assert.ok(remote);
    let authoritativeRef = "";
    const deps = conversation(state, {
      search: async () => ({ items: [remote], hasMore: false }),
      get: async (_userId, ref) => {
        authoritativeRef = `${ref.driveId}:${ref.itemId}`;
        return remote;
      },
      getOwner: async () => ({ id: "owner", name: "Remote owner", email: null }),
    });
    await route("Find Shared Atlas in OneDrive.", state, deps);
    await route("Open it.", state, deps);
    assert.equal(authoritativeRef, "remote-drive:remote-item");
    const active = await loadOneDriveEntity(USER, state.store);
    assert.equal(`${active?.driveId}:${active?.itemId}`, "remote-drive:remote-item");
  });

  await check("class 13: at least 20 structurally different natural paraphrases stay typed", async () => {
    const initialCases: Array<[string, string]> = [
      ["Find Hula OneDrive Final Test in OneDrive.", "search"],
      ["Open my Hula OneDrive Final Test file in OneDrive.", "get"],
      ["Where’s my Hula OneDrive Final Test file in OneDrive?", "get"],
      ["Search OneDrive for Hula OneDrive Final Test.", "search"],
      ["Show me the OneDrive file Hula OneDrive Final Test.", "search"],
      ["Pull up Hula OneDrive Final Test from OneDrive.", "search"],
      ["What are my latest 3 OneDrive files?", "recent"],
      ["Show my recent OneDrive files.", "recent"],
      ["What files are in my OneDrive?", "root"],
      ["Show me what’s in the Project Atlas folder in OneDrive.", "list_folder"],
    ];
    const followupCases: Array<[string, string]> = [
      ["Open it.", "get"],
      ["What’s the gist?", "summarize"],
      ["What are the deadlines?", "deadlines"],
      ["Who modified it?", "owner"],
      ["When was this last changed?", "modified"],
      ["How big is it?", "metadata"],
      ["What type of file is it?", "metadata"],
      ["Give me the link.", "link"],
      ["Any action items?", "action_items"],
      ["What does this mean for me?", "question"],
      ["Give me the important part.", "summarize"],
      ["What folder is it in?", "metadata"],
      ["Who is mentioned?", "question"],
      ["What date is the launch?", "question"],
      ["What does Sarah need to do?", "question"],
      ["Find Final Notes in that folder.", "search"],
    ];
    for (const [text, operation] of initialCases) {
      assert.equal(explicitOneDriveIntent(text)?.operation, operation, text);
    }
    for (const [text, operation] of followupCases) {
      assert.equal(explicitOneDriveFollowupIntent(text)?.operation, operation, text);
    }

    const state = contextStore();
    const recent = [item("r1", "Newest.txt"), item("r2", "Second.txt"), item("r3", "Third.txt")];
    let requestedCount = 0;
    const deps = conversation(state, {
      recent: async (_userId, count) => {
        requestedCount = count ?? 10;
        return { items: recent.slice(0, requestedCount), hasMore: false };
      },
    });
    const result = await route("What are my latest 3 OneDrive files?", state, deps);
    assert.equal(requestedCount, 3);
    assert.equal((result?.reply.match(/^\d+\./gm) ?? []).length, 3);
  });

  console.log(`\nOneDrive hardening tests: ${passed} passed, 0 failed`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
