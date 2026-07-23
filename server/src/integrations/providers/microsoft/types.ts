export const MICROSOFT_PROVIDER = "microsoft" as const;

export const MICROSOFT_CALLBACK_PATH =
  "/v1/integrations/microsoft/callback" as const;

export const MICROSOFT_GRAPH_BASE_URL =
  "https://graph.microsoft.com/v1.0" as const;

export const MICROSOFT_AUTHORITY =
  "https://login.microsoftonline.com/common/oauth2/v2.0" as const;

export type MicrosoftCapability =
  | "microsoft.identity"
  | "outlook_mail.read"
  | "outlook_mail.write"
  | "outlook_mail.send"
  | "outlook_calendar.read"
  | "outlook_calendar.write"
  | "onedrive.read"
  | "onedrive.write"
  | "teams.discovery"
  | "teams.read"
  | "teams.send";

export interface MicrosoftAccountIdentity {
  id: string;
  displayName: string | null;
  email: string | null;
}
