import assert from "node:assert/strict";
import test from "node:test";
import { PermissionFlagsBits } from "discord.js";
import type { ChatInputCommandInteraction, GuildMember } from "discord.js";
import { securityManager } from "../lib/registry.js";
import { execute, executeRelease, data } from "./judgment.js";
import { data as judgementAliasData } from "./judgement.js";
import { moderationCommands } from "./moderation.js";

function makeJudgmentInteraction(
  actorId: string,
  ownerId: string,
  isAdministrator: boolean,
) {
  const target = {
    id: "target-user",
    user: { tag: "target#0001" },
  } as unknown as GuildMember;
  let reply: unknown;
  let editReply: unknown;
  let deferred = false;
  const interaction = {
    guildId: "guild",
    guild: { id: "guild", name: "test-guild", ownerId },
    user: { id: actorId, tag: "actor#0001" },
    memberPermissions: {
      has: (permission: bigint) =>
        permission === PermissionFlagsBits.Administrator && isAdministrator,
    },
    options: {
      getSubcommand: () => "user",
      getMember: () => target,
      getString: () => "reason",
      getUser: () => ({ id: target.id }),
      getRole: () => ({ id: "judgment-role" }),
    },
    deferReply: async () => {
      deferred = true;
    },
    reply: async (payload: unknown) => {
      reply = payload;
    },
    editReply: async (payload: unknown) => {
      editReply = payload;
      return payload;
    },
    get deferred() {
      return deferred;
    },
    get replied() {
      return reply !== undefined;
    },
  } as unknown as ChatInputCommandInteraction;
  return {
    interaction,
    target,
    getReply: () => reply,
    getEditReply: () => editReply,
    didDefer: () => deferred,
  };
}

test("Administrators and the owner can apply Judgment through both command aliases", async () => {
  const originalPlace = securityManager.placeInJudgment;
  const actors: string[] = [];
  securityManager.placeInJudgment = async (_target, _reason, judgedBy) => {
    actors.push(judgedBy);
    return { success: true, roleAssigned: true, reason: "placed" };
  };
  try {
    const admin = makeJudgmentInteraction("admin-id", "owner-id", true);
    await execute(admin.interaction);
    assert.equal(admin.getEditReply() !== undefined, true);

    const owner = makeJudgmentInteraction("owner-id", "owner-id", false);
    await execute(owner.interaction);
    assert.equal(owner.getEditReply() !== undefined, true);
  } finally {
    securityManager.placeInJudgment = originalPlace;
  }

  assert.deepEqual(actors, ["admin-id", "owner-id"]);
  assert.equal(data.name, "judgment");
  assert.equal(judgementAliasData.name, "judgement");
  assert.ok(
    judgementAliasData.toJSON().options?.some((option) => option.name === "user"),
    "the /judgement user alias remains registered",
  );
});

test("non-administrator non-owners cannot apply Judgment", async () => {
  const originalPlace = securityManager.placeInJudgment;
  let placeCalls = 0;
  securityManager.placeInJudgment = async () => {
    placeCalls++;
    return { success: true, roleAssigned: true, reason: "unexpected" };
  };
  const actor = makeJudgmentInteraction("member-id", "owner-id", false);
  try {
    await execute(actor.interaction);
  } finally {
    securityManager.placeInJudgment = originalPlace;
  }

  assert.equal(placeCalls, 0);
  assert.equal(actor.getEditReply() !== undefined, true);
});

test("Administrator cannot use /release, but the actual owner can", async () => {
  const originalRelease = securityManager.releaseFromJudgment;
  let releaseActors: string[] = [];
  securityManager.releaseFromJudgment = async (_target, _reason, releasedBy) => {
    releaseActors.push(releasedBy);
    return {
      success: true,
      reason: "released",
      record: { savedRoles: [] } as never,
    };
  };
  try {
    const admin = makeJudgmentInteraction("admin-id", "owner-id", true);
    await executeRelease(admin.interaction);
    assert.equal(admin.didDefer(), false);
    assert.match(
      JSON.stringify(admin.getReply()),
      /actual owner/u,
    );

    const owner = makeJudgmentInteraction("owner-id", "owner-id", true);
    await executeRelease(owner.interaction);
    assert.equal(owner.didDefer(), true);
  } finally {
    securityManager.releaseFromJudgment = originalRelease;
  }

  assert.deepEqual(releaseActors, ["owner-id"]);
});

test("role-remove cannot remove the Judgment role from an active member", async () => {
  const originalGetConfig = securityManager.getConfig;
  const activeJudgments = {
    "target-user": {
      userId: "target-user",
      savedRoles: [],
      judgedAt: "2026-01-01T00:00:00.000Z",
      reason: "test",
      judgedBy: "owner-id",
    },
  };
  securityManager.getConfig = (() =>
    ({
      godsJudgment: {
        judgmentRoleId: "judgment-role",
        activeJudgments,
      },
    }) as unknown as ReturnType<typeof securityManager.getConfig>) as unknown as
    typeof securityManager.getConfig;

  let roleRemoveCalls = 0;
  const targetRole = {
    id: "target-role",
    permissions: { has: () => false },
  };
  const judgmentRole = {
    id: "judgment-role",
    name: "God's Judgment",
    managed: false,
    permissions: { has: () => false },
  };
  const target = {
    id: "target-user",
    user: { id: "target-user", tag: "target#0001", username: "target" },
    permissions: { has: () => false },
    roles: {
      cache: new Map<string, { id: string; permissions: { has: () => boolean } }>([
        [targetRole.id, targetRole],
        ["guild", { id: "guild", permissions: { has: () => false } }],
        [judgmentRole.id, judgmentRole],
      ]),
      highest: { comparePositionTo: () => -1 },
      remove: async () => {
        roleRemoveCalls++;
      },
    },
  } as unknown as GuildMember;
  const moderator = {
    id: "admin-id",
    permissions: { has: () => true },
    roles: { highest: { comparePositionTo: () => 1 } },
  };
  const botMember = {
    permissions: { has: () => true },
    roles: { highest: { comparePositionTo: () => 1 } },
  };
  const guild = {
    id: "guild",
    ownerId: "owner-id",
    members: {
      me: botMember,
      fetch: async (id: string) =>
        id === "admin-id" ? moderator : id === target.id ? target : null,
    },
    roles: {
      cache: new Map<string, { id: string; permissions: { has: () => boolean } }>([
        ["guild", { id: "guild", permissions: { has: () => false } }],
        [targetRole.id, targetRole],
        [judgmentRole.id, judgmentRole],
      ]),
    },
  };
  let reply: unknown;
  const interaction = {
    guild,
    user: { id: "admin-id" },
    commandName: "role-remove",
    deferred: false,
    replied: false,
    options: {
      getUser: () => ({ id: target.id }),
      getRole: () => ({ id: judgmentRole.id }),
      getString: () => null,
    },
    deferReply: async () => undefined,
    reply: async (payload: unknown) => {
      reply = payload;
    },
    editReply: async (payload: unknown) => {
      reply = payload;
    },
  } as unknown as ChatInputCommandInteraction;
  const roleRemoveCommand = moderationCommands.find(
    (command) => command.data.name === "role-remove",
  );

  try {
    assert.ok(roleRemoveCommand);
    await roleRemoveCommand.execute(interaction);
  } finally {
    securityManager.getConfig = originalGetConfig;
  }

  assert.equal(roleRemoveCalls, 0);
  assert.match(JSON.stringify(reply), /actual owner/u);
});
