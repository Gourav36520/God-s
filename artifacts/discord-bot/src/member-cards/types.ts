export type MemberCardKind = "member" | "history" | "roles";

export type MemberProfileChange =
  | {
      id: string;
      kind: "name";
      field: "username" | "displayName" | "nickname";
      previousValue: string;
      newValue: string;
      occurredAt: string;
    }
  | {
      id: string;
      kind: "avatar";
      previousValue: string | null;
      newValue: string | null;
      occurredAt: string;
    };

export type NewMemberProfileChange =
  | (Omit<Extract<MemberProfileChange, { kind: "name" }>, "id" | "occurredAt"> & {
      occurredAt?: string;
    })
  | (Omit<Extract<MemberProfileChange, { kind: "avatar" }>, "id" | "occurredAt"> & {
      occurredAt?: string;
    });

export interface MemberCardRecord {
  createdAt: string;
  departedAt: string | null;
  changes: MemberProfileChange[];
}
