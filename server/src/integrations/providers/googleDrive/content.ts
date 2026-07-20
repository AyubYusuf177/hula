import { driveJsonRequest, driveRequestForUser, DriveError, type DriveFetchLike } from "./client";
import { downloadDriveText } from "./operations";
import {
  GOOGLE_DOC_MIME,
  type DriveContentSection,
  type DriveDocumentContent,
  type DriveFileEntity,
} from "./types";

export const DRIVE_PLAIN_TEXT_MAX_BYTES = 2 * 1024 * 1024;
export const DRIVE_DOCUMENT_MAX_CHARACTERS = 160_000;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function textRun(element: unknown): { text: string; links: string[] } {
  const run = record(record(element)?.textRun);
  const content = typeof run?.content === "string" ? run.content : "";
  const style = record(run?.textStyle);
  const link = record(style?.link);
  const url = typeof link?.url === "string" && /^https?:\/\//i.test(link.url)
    ? link.url
    : null;
  return { text: content, links: url ? [url] : [] };
}

function paragraphSections(value: unknown, tabTitle?: string): DriveContentSection[] {
  const paragraph = record(value);
  if (!paragraph) return [];
  const elements = Array.isArray(paragraph.elements) ? paragraph.elements : [];
  const runs = elements.map(textRun);
  const text = runs.map((run) => run.text).join("").replace(/\n+$/, "").trim();
  if (!text) return [];
  const style = record(paragraph.paragraphStyle);
  const named = typeof style?.namedStyleType === "string" ? style.namedStyleType : "";
  const heading = /^HEADING_(\d+)$/.exec(named);
  const links = [...new Set(runs.flatMap((run) => run.links))];
  // Docs normally returns one structural paragraph per visual paragraph, but
  // pasted/plain content and soft line breaks can place a complete labelled
  // section inside one provider paragraph. Preserve every logical line as its
  // own evidence unit so later QA never has to treat the whole document as one
  // lossy blob. This is syntax-aware, not heading-name-aware.
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const explicitList = /^(?:[-*•]|\d+[.)])\s+(.+)$/.exec(line);
    const lineText = explicitList?.[1]?.trim() ?? line;
    return {
      kind: heading ? "heading" : paragraph.bullet || explicitList ? "list_item" : "paragraph",
      text: lineText,
      ...(heading ? { level: Number(heading[1]) } : {}),
      ...(tabTitle ? { tabTitle } : {}),
      links,
    } satisfies DriveContentSection;
  });
}

function structuralText(elements: unknown[], tabTitle?: string): DriveContentSection[] {
  const sections: DriveContentSection[] = [];
  for (const element of elements) {
    const item = record(element);
    if (!item) continue;
    sections.push(...paragraphSections(item.paragraph, tabTitle));
    const table = record(item.table);
    if (table && Array.isArray(table.tableRows)) {
      const rows: string[] = [];
      const links: string[] = [];
      for (const rawRow of table.tableRows) {
        const row = record(rawRow);
        const cells = Array.isArray(row?.tableCells) ? row.tableCells : [];
        const rendered = cells.map((rawCell) => {
          const cell = record(rawCell);
          const nested = structuralText(Array.isArray(cell?.content) ? cell.content : [], tabTitle);
          links.push(...nested.flatMap((section) => section.links ?? []));
          return nested.map((section) => section.text).join(" ").trim();
        });
        rows.push(rendered.join(" | "));
      }
      const text = rows.filter(Boolean).join("\n").trim();
      if (text) sections.push({
        kind: "table",
        text,
        ...(tabTitle ? { tabTitle } : {}),
        links: [...new Set(links)],
      });
    }
    const toc = record(item.tableOfContents);
    if (toc && Array.isArray(toc.content)) sections.push(...structuralText(toc.content, tabTitle));
  }
  return sections;
}

function tabSections(tab: unknown): DriveContentSection[] {
  const value = record(tab);
  if (!value) return [];
  const properties = record(value.tabProperties);
  const title = typeof properties?.title === "string" && properties.title.trim()
    ? properties.title.trim()
    : "Document tab";
  const sections: DriveContentSection[] = [{ kind: "tab", text: title, tabTitle: title }];
  const documentTab = record(value.documentTab);
  const body = record(documentTab?.body);
  if (Array.isArray(body?.content)) sections.push(...structuralText(body.content, title));
  if (Array.isArray(value.childTabs)) {
    for (const child of value.childTabs) sections.push(...tabSections(child));
  }
  return sections;
}

function renderSection(section: DriveContentSection): string {
  if (section.kind === "tab") return `## Tab: ${section.text}`;
  if (section.kind === "heading") return `${"#".repeat(Math.min(section.level ?? 1, 6))} ${section.text}`;
  if (section.kind === "list_item") return `- ${section.text}`;
  return section.text;
}

function boundedContent(input: {
  fileId: string;
  title: string;
  mimeType: string;
  sections: DriveContentSection[];
}): DriveDocumentContent {
  const originalText = input.sections.map(renderSection).join("\n\n").trim();
  const text = originalText.slice(0, DRIVE_DOCUMENT_MAX_CHARACTERS);
  const truncated = text.length < originalText.length;
  const sections: DriveContentSection[] = [];
  let remaining = text.length;
  for (const section of input.sections) {
    if (remaining <= 0) break;
    const rendered = renderSection(section);
    if (rendered.length <= remaining) {
      sections.push(section);
      remaining -= rendered.length + 2;
    } else {
      sections.push({ ...section, text: section.text.slice(0, Math.max(0, remaining)) });
      remaining = 0;
    }
  }
  return {
    fileId: input.fileId,
    title: input.title,
    mimeType: input.mimeType,
    sections,
    text,
    originalCharacters: originalText.length,
    processedCharacters: text.length,
    truncated,
    complete: !truncated,
  };
}

export function normalizeGoogleDocument(
  file: Pick<DriveFileEntity, "fileId" | "name" | "mimeType">,
  raw: unknown,
): DriveDocumentContent {
  const document = record(raw);
  if (!document) throw new DriveError("malformed_provider_response");
  let sections: DriveContentSection[] = [];
  if (Array.isArray(document.tabs) && document.tabs.length > 0) {
    sections = document.tabs.flatMap(tabSections);
  } else {
    const body = record(document.body);
    sections = structuralText(Array.isArray(body?.content) ? body.content : []);
  }
  return boundedContent({
    fileId: file.fileId,
    title: typeof document.title === "string" && document.title.trim()
      ? document.title.trim()
      : file.name,
    mimeType: file.mimeType,
    sections,
  });
}

export function normalizePlainTextDocument(
  file: Pick<DriveFileEntity, "fileId" | "name" | "mimeType">,
  text: string,
): DriveDocumentContent {
  const sections: DriveContentSection[] = text.split(/\r?\n/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const heading = /^(#{1,6})\s+(.+)$/.exec(part);
      if (heading) return { kind: "heading" as const, level: heading[1]!.length, text: heading[2]!.trim(), links: [] };
      const list = /^(?:[-*•]|\d+[.)])\s+(.+)$/.exec(part);
      return list
        ? { kind: "list_item" as const, text: list[1]!.trim(), links: [] }
        : { kind: "paragraph" as const, text: part, links: [] };
    });
  return boundedContent({ ...file, title: file.name, sections });
}

export async function fetchDriveDocumentContent(input: {
  userId: string;
  file: DriveFileEntity;
  fetchImpl?: DriveFetchLike;
}): Promise<DriveDocumentContent> {
  if (input.file.mimeType === GOOGLE_DOC_MIME) {
    const raw = await driveRequestForUser({
      userId: input.userId,
      run: (accessToken) => driveJsonRequest<unknown>({
        accessToken,
        api: "docs",
        path: `/documents/${encodeURIComponent(input.file.fileId)}`,
        query: { includeTabsContent: "true" },
        fetchImpl: input.fetchImpl,
      }),
    });
    return normalizeGoogleDocument(input.file, raw);
  }
  if (input.file.contentAvailability === "plain_text") {
    const text = await downloadDriveText({
      userId: input.userId,
      fileId: input.file.fileId,
      fetchImpl: input.fetchImpl,
      maxBytes: DRIVE_PLAIN_TEXT_MAX_BYTES,
    });
    return normalizePlainTextDocument(input.file, text);
  }
  throw new DriveError("unsupported_content");
}
