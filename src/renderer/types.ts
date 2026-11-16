/** What the main process sends the window: the lab as plain data. Mirrors `Lab.snapshot()` in the core. */
export interface Operation { type: string; [field: string]: unknown }

export interface RosterKey {
  key: string; person: string; role: "member" | "keeper"; founder: boolean; added: string;
  removed: { by: string; cutoff: number } | null; fingerprint: string; you: boolean;
}
export interface Part {
  checksum: string; sequence: string; circular: boolean; length: number; name: string; offered: boolean;
  fields: Record<string, string | number | null>; added: string;
}
export interface Item {
  item: string; part: string; unit: string | null; amount: number; retired: boolean; needsRecount: boolean;
  fields: Record<string, string | number | null>; added: string;
}
export interface Entry {
  id: string; author: string; seq: number; op: Operation; status: "applied" | "set aside" | "refused" | "not understood";
  reason: string | null; signer: string | null; signed_at: string;
}
export interface LabView {
  id: string | null; name: string | null; arrived: boolean; member: boolean; keeper: boolean;
  roster: RosterKey[]; parts: Part[]; items: Item[]; overlaps: { what: string; kept: string; dropped: string }[];
  waiting: number; entries: Entry[];
}
export interface PeerView {
  url: string | null; origin: string | null; invite: string | null;
  status: "offline" | "connecting" | "waiting" | "syncing" | "synced"; problem: string | null; pending: number; lastSynced: string | null;
}
export interface Snapshot {
  device: { key: string; fingerprint: string; person: string | null };
  lab: LabView | null;
  peer: PeerView;
  published: string | null;
}

export type Answer = { ok: true; result: unknown } | { ok: false; error: string };

declare global {
  interface Window {
    bionet: {
      state: () => Promise<Snapshot>;
      do: (action: string, payload?: unknown) => Promise<Answer>;
      onState: (listener: (state: Snapshot) => void) => () => void;
      copy: (words: string) => Promise<void>;
    };
  }
}
