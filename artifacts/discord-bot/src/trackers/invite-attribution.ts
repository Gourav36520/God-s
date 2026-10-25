export interface InviteSnapshot {
  uses: number | null;
  inviterId: string | null;
}

export interface VerifiedInviteUse {
  code: string;
  inviterId: string;
}

export function findVerifiedInviteUse(
  before: Record<string, InviteSnapshot> | undefined,
  after: Record<string, InviteSnapshot>,
): VerifiedInviteUse | null {
  if (!before) return null;

  const changed: Array<{ code: string; delta: number; inviterId: string | null }> =
    [];
  let ambiguous = false;

  for (const [code, current] of Object.entries(after)) {
    const previous = before[code];
    if (!previous) {
      if (current.uses !== 0) ambiguous = true;
      continue;
    }

    if (previous.uses === null || current.uses === null) {
      if (previous.uses !== current.uses) ambiguous = true;
      continue;
    }

    const delta = current.uses - previous.uses;
    if (delta !== 0) {
      changed.push({ code, delta, inviterId: current.inviterId });
    }
  }

  if (Object.keys(before).some((code) => !(code in after))) {
    ambiguous = true;
  }

  if (
    ambiguous ||
    changed.length !== 1 ||
    changed[0].delta !== 1 ||
    !changed[0].inviterId
  ) {
    return null;
  }

  return { code: changed[0].code, inviterId: changed[0].inviterId };
}
