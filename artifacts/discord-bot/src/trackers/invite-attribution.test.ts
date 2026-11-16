import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findVerifiedInviteUse, type InviteSnapshot } from "./invite-attribution.js";

describe("invite attribution", () => {
  const before: Record<string, InviteSnapshot> = {
    alpha: { uses: 4, inviterId: "inviter-1" },
    beta: { uses: 7, inviterId: "inviter-2" },
  };

  it("verifies exactly one single-use increase", () => {
    assert.deepEqual(
      findVerifiedInviteUse(before, {
        alpha: { uses: 5, inviterId: "inviter-1" },
        beta: { uses: 7, inviterId: "inviter-2" },
      }),
      { code: "alpha", inviterId: "inviter-1" },
    );
  });

  it("does not guess when multiple invite counters changed", () => {
    assert.equal(
      findVerifiedInviteUse(before, {
        alpha: { uses: 5, inviterId: "inviter-1" },
        beta: { uses: 8, inviterId: "inviter-2" },
      }),
      null,
    );
  });

  it("does not attribute a new invite code or an increment larger than one", () => {
    assert.equal(
      findVerifiedInviteUse(before, {
        alpha: { uses: 4, inviterId: "inviter-1" },
        beta: { uses: 7, inviterId: "inviter-2" },
        fresh: { uses: 1, inviterId: "inviter-3" },
      }),
      null,
    );
    assert.equal(
      findVerifiedInviteUse(before, {
        alpha: { uses: 6, inviterId: "inviter-1" },
        beta: { uses: 7, inviterId: "inviter-2" },
      }),
      null,
    );
  });
});
