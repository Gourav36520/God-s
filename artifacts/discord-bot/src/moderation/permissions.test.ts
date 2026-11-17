import assert from "node:assert/strict";
import test from "node:test";
import { PermissionFlagsBits } from "discord.js";
import type {
  ChatInputCommandInteraction,
  Guild,
  GuildMember,
} from "discord.js";
import {
  requireConfiguredModerationContext,
  targetHierarchyError,
  type ModerationContext,
} from "./permissions.js";

function makeMember(id: string, permissions = new Set<bigint>()) {
  return {
    id,
    permissions: { has: (permission: bigint) => permissions.has(permission) },
    roles: {
      cache: new Map(),
      highest: { comparePositionTo: () => 1 },
    },
    user: { tag: `${id}#0001`, username: id },
  } as unknown as GuildMember;
}

function makeGuardInteraction(options: {
  actorId: string;
  ownerId: string;
  moderator?: GuildMember;
  botMember?: GuildMember;
  rolesFetch?: (roleId: string) => Promise<unknown>;
}) {
  const moderator = options.moderator ?? makeMember(options.actorId);
  const botMember =
    options.botMember ??
    makeMember("bot", new Set([PermissionFlagsBits.ManageMessages]));
  let response: unknown;
  const guild = {
    id: "guild",
    ownerId: options.ownerId,
    members: {
      me: botMember,
      fetch: async (id: string) => (id === options.actorId ? moderator : null),
    },
    roles: {
      fetch: options.rolesFetch ?? (async () => null),
    },
  } as unknown as Guild;
  const interaction = {
    guild,
    user: { id: options.actorId },
    deferred: true,
    replied: false,
    editReply: async (payload: unknown) => {
      response = payload;
      return payload;
    },
    reply: async (payload: unknown) => {
      response = payload;
      return payload;
    },
  } as unknown as ChatInputCommandInteraction;

  return {
    interaction,
    moderator,
    botMember,
    getResponse: () => response,
  };
}

function responseTitle(response: unknown): string | undefined {
  const title = (
    response as {
      embeds?: Array<{ data?: { title?: string } }>;
    }
  )?.embeds?.[0]?.data?.title;
  return title?.replace(/^<:[^>]+>\s*/u, "");
}

test("only the actual server owner passes owner-only moderation access", async () => {
  const administrator = makeGuardInteraction({
    actorId: "administrator",
    ownerId: "actual-owner",
    moderator: makeMember(
      "administrator",
      new Set([PermissionFlagsBits.Administrator]),
    ),
  });
  const denied = await requireConfiguredModerationContext(
    administrator.interaction,
    null,
    { ownerOnly: true },
  );

  assert.equal(denied, null);
  assert.equal(responseTitle(administrator.getResponse()), "Server Owner Only");

  const owner = makeGuardInteraction({
    actorId: "actual-owner",
    ownerId: "actual-owner",
  });
  const allowed = await requireConfiguredModerationContext(
    owner.interaction,
    null,
    { ownerOnly: true },
  );

  assert.ok(allowed);
  assert.equal(allowed.moderator.id, "actual-owner");
});

test("role-gated moderation denies both an unset role and a missing member role", async () => {
  const unset = makeGuardInteraction({
    actorId: "manager",
    ownerId: "owner",
  });
  const deniedWithoutConfig = await requireConfiguredModerationContext(
    unset.interaction,
    null,
    { roleFields: ["managerRoleId"] },
    async () => null,
  );

  assert.equal(deniedWithoutConfig, null);
  assert.equal(responseTitle(unset.getResponse()), "Role Not Configured");

  const configured = makeGuardInteraction({
    actorId: "manager",
    ownerId: "owner",
    rolesFetch: async (roleId) => ({ id: roleId }),
  });
  const deniedWithoutRole = await requireConfiguredModerationContext(
    configured.interaction,
    null,
    { roleFields: ["managerRoleId"] },
    async () =>
      ({
        guildId: "guild",
        managerRoleId: "manager-role",
      }) as never,
  );

  assert.equal(deniedWithoutRole, null);
  assert.equal(responseTitle(configured.getResponse()), "Role Required");
});

test("Manager hierarchy blocks equal or higher targets but keeps owner and bot limits", () => {
  const roleAt = (position: number) => ({
    comparePositionTo: (other: { position?: number }) =>
      position - (other.position ?? 0),
    position,
  });
  const makeContext = (
    moderatorId: string,
    moderatorPosition: number,
    botPosition: number,
    ownerId = "owner",
  ) =>
    ({
      guild: { ownerId },
      moderator: {
        id: moderatorId,
        permissions: { has: () => false },
        roles: { highest: roleAt(moderatorPosition) },
      },
      botMember: { roles: { highest: roleAt(botPosition) } },
    }) as unknown as ModerationContext;
  const target = {
    id: "target",
    permissions: { has: () => false },
    roles: { highest: roleAt(5) },
  } as unknown as GuildMember;

  assert.match(
    targetHierarchyError(makeContext("manager", 5, 10), target) ?? "",
    /Your highest role must be above/u,
  );
  assert.match(
    targetHierarchyError(makeContext("manager", 6, 5), target) ?? "",
    /Gods Bot's highest role must be above/u,
  );
  assert.equal(targetHierarchyError(makeContext("manager", 6, 10), target), null);
  assert.equal(
    targetHierarchyError(makeContext("owner", 1, 10), target),
    null,
    "the server owner is exempt from moderator role ordering",
  );
});
