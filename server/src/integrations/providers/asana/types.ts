export const ASANA_PROVIDER = "asana" as const;

export interface AsanaResource {
  gid: string;
  resource_type?: string;
  name?: string;
  [key: string]: unknown;
}

export interface AsanaPage<T> {
  data: T[];
  nextPageOffset: string | null;
}
