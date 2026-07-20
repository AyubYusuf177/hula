# Google Drive / Docs capability matrix

| Capability | API | Scope | Policy | Section 23 |
|---|---|---|---|---|
| Identity/status | Drive `about.get` | `drive.readonly` | Read | Yes |
| List/search/metadata | Drive `files.list`, `files.get` | `drive.readonly` | Read | Yes |
| Shared files/Shared Drives | Drive `files.list` with bounded corpora and `supportsAllDrives` | `drive.readonly` | Read | Yes, where accessible |
| Google Docs content | Docs `documents.get` (tabs/structured body) | `drive.readonly` (or `drive.file` for app-authorized files) | Read | Yes |
| Plain text/Markdown | Drive media download | `drive.readonly` | Read | Yes |
| PDF/Office/image content | None in this section | — | Metadata/link only | No |
| Create folder | Drive `files.create` | `drive.file` | Existing Hula write policy | Yes |
| Create Google Doc + initial text | Drive `files.create`, Docs `documents.batchUpdate` | `drive.file` | Existing Hula write policy | Yes |

Section 23 requests exactly `drive.readonly` and `drive.file`. `drive.readonly` is a restricted scope and requires Google OAuth verification and appropriate restricted-scope data-handling review before production launch. `drive.file` is non-sensitive but only covers app-created or explicitly app-authorized files; it is insufficient for arbitrary existing Drive search. No separate Docs scope is requested because the Docs API accepts the required Drive scopes for document reads.

All searches are deterministic allowlisted filters and include `trashed=false`. Full-text matching is Drive’s indexed `fullText` search, not semantic vector search. Bodies are bounded, treated as untrusted data, and never persisted in entity context or logged.
