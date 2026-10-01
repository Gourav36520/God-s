import { randomUUID } from "node:crypto";
import { createDefaultEmbedDefinition } from "./types.js";
import type { WelcomeGoodbyeEmbedDefinition } from "./types.js";

export interface EmbedDraftSession {
  id: string;
  guildId: string;
  userId: string;
  name: string;
  definition: WelcomeGoodbyeEmbedDefinition;
  expiresAt: number;
}

const DRAFT_LIFETIME_MS = 30 * 60 * 1000;
const drafts = new Map<string, EmbedDraftSession>();

export function createEmbedDraft(
  guildId: string,
  userId: string,
  name: string,
): EmbedDraftSession {
  const now = Date.now();
  for (const [id, draft] of drafts) {
    if (draft.expiresAt <= now) drafts.delete(id);
  }
  const draft = {
    id: randomUUID().replaceAll("-", ""),
    guildId,
    userId,
    name,
    definition: createDefaultEmbedDefinition(),
    expiresAt: now + DRAFT_LIFETIME_MS,
  };
  drafts.set(draft.id, draft);
  return draft;
}

export function getEmbedDraft(id: string): EmbedDraftSession | undefined {
  const draft = drafts.get(id);
  if (!draft) return undefined;
  if (draft.expiresAt <= Date.now()) {
    drafts.delete(id);
    return undefined;
  }
  return draft;
}

export function updateEmbedDraft(
  draft: EmbedDraftSession,
  definition: WelcomeGoodbyeEmbedDefinition,
): void {
  draft.definition = definition;
  draft.expiresAt = Date.now() + DRAFT_LIFETIME_MS;
  drafts.set(draft.id, draft);
}

export function deleteEmbedDraft(id: string): void {
  drafts.delete(id);
}