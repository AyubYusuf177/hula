export interface OutlookCalendar {
  id: string;
  name: string;
  canEdit: boolean;
  isDefault: boolean;
  ownerName: string | null;
  ownerAddress: string | null;
  color: string | null;
}

export interface OutlookCalendarAttendee {
  name: string | null;
  address: string;
  type: "required" | "optional" | "resource";
  response: string | null;
}

export interface OutlookCalendarRecurrence {
  patternType: string | null;
  interval: number | null;
  daysOfWeek: string[];
  rangeType: string | null;
  startDate: string | null;
  endDate: string | null;
  numberOfOccurrences: number | null;
}

export interface OutlookCalendarEvent {
  provider: "microsoft";
  service: "outlook_calendar";
  id: string;
  calendarId: string | null;
  seriesMasterId: string | null;
  type: string | null;
  subject: string;
  bodyPreview: string;
  body: string | null;
  start: string | null;
  end: string | null;
  timeZone: string | null;
  isAllDay: boolean;
  isCancelled: boolean;
  organizerName: string | null;
  organizerAddress: string | null;
  attendees: OutlookCalendarAttendee[];
  location: string | null;
  webUrl: string | null;
  isOnlineMeeting: boolean;
  onlineMeetingProvider: string | null;
  teamsJoinUrl: string | null;
  recurrence: OutlookCalendarRecurrence | null;
  createdAt: string | null;
  modifiedAt: string | null;
}

export type OutlookCalendarMutation = "create" | "update" | "delete";

export interface OutlookCalendarMutationReceipt {
  operation: OutlookCalendarMutation;
  event: OutlookCalendarEvent | null;
  eventId: string;
  verification: "verified";
}
