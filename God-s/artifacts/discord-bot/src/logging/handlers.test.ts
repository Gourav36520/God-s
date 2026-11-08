import assert from "node:assert/strict";
import test from "node:test";
import { Events } from "discord.js";
import type { Client, GuildMember, Role } from "discord.js";
import { loggingService } from "../lib/registry.js";
import { registerLoggingHandlers } from "./handlers.js";

type Handler = (...args: unknown[]) => Promise<void>;

test("member and role Discord events reach their matching logging methods", async () => {
  const handlers = new Map<string, Handler>();
  const client = {
    on: (event: string, handler: Handler) => {
      handlers.set(event, handler);
      return client;
    },
  } as unknown as Client;
  const calls: { method: string; args: unknown[] }[] = [];
  const record = (method: string) => (...args: unknown[]) => {
    calls.push({ method, args });
    return Promise.resolve();
  };
  const originals = {
    logMemberJoin: loggingService.logMemberJoin,
    logMemberLeave: loggingService.logMemberLeave,
    logMemberUpdate: loggingService.logMemberUpdate,
    logRoleCreate: loggingService.logRoleCreate,
    logRoleDelete: loggingService.logRoleDelete,
    logRoleUpdate: loggingService.logRoleUpdate,
  };
  const member = { id: "member-1" } as GuildMember;
  const oldMember = { id: "member-1", nickname: "Before" } as GuildMember;
  const role = { id: "role-1" } as Role;
  const oldRole = { id: "role-1", name: "Before" } as Role;

  loggingService.logMemberJoin = record("logMemberJoin");
  loggingService.logMemberLeave = record("logMemberLeave");
  loggingService.logMemberUpdate = record("logMemberUpdate");
  loggingService.logRoleCreate = record("logRoleCreate");
  loggingService.logRoleDelete = record("logRoleDelete");
  loggingService.logRoleUpdate = record("logRoleUpdate");

  try {
    registerLoggingHandlers(client);

    await handlers.get(Events.GuildMemberAdd)?.(member);
    await handlers.get(Events.GuildMemberRemove)?.(member);
    await handlers.get(Events.GuildMemberUpdate)?.(oldMember, member);
    await handlers.get(Events.GuildRoleCreate)?.(role);
    await handlers.get(Events.GuildRoleUpdate)?.(oldRole, role);
    await handlers.get(Events.GuildRoleDelete)?.(role);

    assert.deepEqual(
      calls.map(({ method }) => method),
      [
        "logMemberJoin",
        "logMemberLeave",
        "logMemberUpdate",
        "logRoleCreate",
        "logRoleUpdate",
        "logRoleDelete",
      ],
    );
    assert.deepEqual(
      calls.map(({ args }) => args),
      [
        [member],
        [member],
        [oldMember, member],
        [role],
        [oldRole, role],
        [role],
      ],
    );
  } finally {
    loggingService.logMemberJoin = originals.logMemberJoin;
    loggingService.logMemberLeave = originals.logMemberLeave;
    loggingService.logMemberUpdate = originals.logMemberUpdate;
    loggingService.logRoleCreate = originals.logRoleCreate;
    loggingService.logRoleDelete = originals.logRoleDelete;
    loggingService.logRoleUpdate = originals.logRoleUpdate;
  }
});
