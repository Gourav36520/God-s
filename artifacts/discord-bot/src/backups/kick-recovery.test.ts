import assert from "node:assert/strict";
import test from "node:test";
import { createAndDeliverKickInvite } from "./kick-recovery.js";

test("kick recovery stores an invite and records successful DM delivery", async () => {
  const saved: { code: string; status: string; delivered: boolean }[] = [];
  let sentUrl = "";
  const result = await createAndDeliverKickInvite({
    delivery: "dm",
    createInvite: async () => ({ code: "one-use-code" }),
    sendDirectMessage: async (url) => {
      sentUrl = url;
    },
    saveInvite: async (code, status, delivered) => {
      saved.push({ code, status, delivered });
    },
  });

  assert.equal(sentUrl, "https://discord.gg/one-use-code");
  assert.equal(result.status, "dm_delivered");
  assert.equal(result.deliveredToMember, true);
  assert.deepEqual(saved, [
    { code: "one-use-code", status: "created", delivered: false },
    { code: "one-use-code", status: "dm_delivered", delivered: true },
  ]);
});

test("kick recovery preserves an admin-visible invite when DMs are closed", async () => {
  const saved: { status: string; delivered: boolean }[] = [];
  const result = await createAndDeliverKickInvite({
    delivery: "dm",
    createInvite: async () => ({ code: "fallback-code" }),
    sendDirectMessage: async () => {
      throw new Error("DMs are unavailable");
    },
    saveInvite: async (_code, status, delivered) => {
      saved.push({ status, delivered });
    },
  });

  assert.equal(result.code, "fallback-code");
  assert.equal(result.status, "dm_failed");
  assert.equal(result.deliveredToMember, false);
  assert.deepEqual(saved, [
    { status: "created", delivered: false },
    { status: "dm_failed", delivered: false },
  ]);
});

test("admin delivery generates a one-use invite without attempting a DM", async () => {
  let dmCalled = false;
  const result = await createAndDeliverKickInvite({
    delivery: "admin",
    createInvite: async () => ({ code: "admin-code" }),
    sendDirectMessage: async () => {
      dmCalled = true;
    },
    saveInvite: async () => undefined,
  });

  assert.equal(dmCalled, false);
  assert.equal(result.status, "provided_to_admin");
  assert.equal(result.deliveredToMember, false);
});
