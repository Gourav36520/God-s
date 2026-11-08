import assert from "node:assert/strict";
import test from "node:test";
import {
  AuditLogEvent,
  Collection,
  EmbedBuilder,
} from "discord.js";
import type {
  Channel,
  Client,
  GuildAuditLogsEntry,
  GuildMember,
  Message,
  Role,
  User,
  VoiceState,
} from "discord.js";
import type { SecurityManager } from "../security/SecurityManager.js";
import type { LogCategory } from "./types.js";
import { LoggingService } from "./LoggingService.js";

interface RecordedLog {
  category: LogCategory;
  embed: EmbedBuilder;
}

function makeUser(
  id: string,
  username: string,
  globalName: string | null,
  avatar: string | null,
): User {
  return {
    id,
    username,
    globalName,
    tag: `${username}#0001`,
    avatar,
    bot: false,
    displayAvatarURL: ({ size = 256 }: { size?: number } = {}) =>
      `https://cdn.example.test/${id}/${avatar ?? "default"}?size=${size}`,
  } as unknown as User;
}

function makeMember(
  id: string,
  nickname: string | null,
  roles: { id: string; name: string }[],
): GuildMember {
  const user = {
    ...makeUser(id, "member", "Member", "member-avatar"),
    createdTimestamp: 1_600_000_000_000,
  } as User;
  const roleCache = new Collection(
    roles.map((role) => [role.id, role] as const),
  );
  return {
    id,
    user,
    nickname,
    guild: {
      id: "guild-1",
      memberCount: 12,
      roles: { everyone: { id: "everyone" } },
    },
    roles: { cache: roleCache },
  } as unknown as GuildMember;
}

function createHarness(
  severityFor: (userId: string) => string = () => "medium",
) {
  const service = new LoggingService();
  const users = new Collection<string, User>();
  const sent: RecordedLog[] = [];
  const client = {
    user: { id: "bot-user" },
    users: {
      cache: users,
      fetch: async (userId: string) => {
        const user = users.get(userId);
        if (!user) throw new Error("User not cached");
        return user;
      },
    },
  } as unknown as Client;
  const categories: LogCategory[] = [
    "moderation",
    "messages",
    "members",
    "channels",
    "roles",
    "security",
  ];
  const config = {
    logging: {
      categories: Object.fromEntries(categories.map((category) => [category, true])),
      channelIds: Object.fromEntries(categories.map((category) => [category, "shared-log"])),
    },
  };
  const manager = {
    getConfig: () => config,
    getHeatEngine: () => ({
      view: async (_guildId: string, userId: string) => ({
        severity: severityFor(userId),
      }),
    }),
  } as unknown as SecurityManager;
  const internals = service as unknown as {
    client: Client | null;
    manager: SecurityManager | null;
    send: (
      guildId: string,
      category: LogCategory,
      embed: EmbedBuilder,
    ) => Promise<Message | null>;
  };
  internals.client = client;
  internals.manager = manager;
  internals.send = async (_guildId, category, embed) => {
    const index = sent.push({ category, embed }) - 1;
    const message = {
      edit: async ({ embeds }: { embeds: EmbedBuilder[] }) => {
        sent[index].embed = embeds[0];
        return message;
      },
    };
    return message as unknown as Message;
  };

  return { service, sent, users };
}

function embedFields(embed: EmbedBuilder) {
  return embed.toJSON().fields ?? [];
}

test("profile logs share the blue card family and show before-to-after values", async () => {
  const { service, sent } = createHarness();
  const oldUser = makeUser("user-1", "nova", "Nova", "old-avatar");
  const newUser = makeUser("user-1", "nova.exe", "Nova.exe", "new-avatar");

  await service.logUserUpdate("guild-1", oldUser, newUser);

  assert.equal(sent.length, 2);
  const nameCard = sent[0].embed.toJSON();
  const avatarCard = sent[1].embed.toJSON();
  assert.equal(nameCard.color, 0x5865f2);
  assert.equal(avatarCard.color, 0x5865f2);
  assert.match(nameCard.title ?? "", /Name Changed/);
  assert.match(avatarCard.title ?? "", /Avatar Changed/);
  assert.equal(nameCard.author?.name, "Aegis Logs • Profile Update");
  assert.equal(avatarCard.author?.name, "Aegis Logs • Profile Update");
  const nameProfile = nameCard.fields?.find((field) => field.name === "Profile");
  const nameTransition = nameCard.fields?.find(
    (field) => field.name === "Before → After",
  );
  assert.equal(nameProfile?.inline, true);
  assert.match(nameProfile?.value ?? "", /Nova\.exe.*@nova\.exe.*user-1/s);
  assert.equal(nameTransition?.inline, true);
  assert.match(
    nameTransition?.value ?? "",
    /@nova.*@nova\.exe/s,
  );
  assert.match(
    nameTransition?.value ?? "",
    /Nova.*Nova\.exe/s,
  );
  assert.equal(
    avatarCard.thumbnail?.url,
    "https://cdn.example.test/user-1/new-avatar?size=256",
  );
  assert.equal(
    avatarCard.image?.url,
    "https://cdn.example.test/user-1/old-avatar?size=256",
  );
  assert.equal(
    avatarCard.thumbnail?.url,
    "https://cdn.example.test/user-1/new-avatar?size=256",
  );
  assert.equal(
    avatarCard.fields?.find((field) => field.name === "Profile")?.inline,
    true,
  );
  assert.equal(
    avatarCard.fields?.find((field) => field.name === "Before → After")?.inline,
    true,
  );
  assert.match(
    avatarCard.fields?.find((field) => field.name === "Before → After")?.value ?? "",
    /Before.*old-avatar.*After.*new-avatar/s,
  );
});

test("moderation cards use heat severity and retain target, moderator, reason, and case", async () => {
  const { service, sent, users } = createHarness(() => "medium");
  const target = makeUser("user-2", "nova", "Nova", "latest-avatar");
  users.set(target.id, target);

  await service.logModerationCommand({
    guildId: "guild-1",
    targetId: target.id,
    targetLabel: target.tag,
    moderatorId: "moderator-1",
    action: "warn",
    reason: "Repeated spam",
    caseId: 42,
  });

  const card = sent[0].embed.toJSON();
  assert.equal(card.color, 0xfee75c);
  assert.equal(card.thumbnail?.url, "https://cdn.example.test/user-2/latest-avatar?size=256");
  assert.equal(card.fields?.find((field) => field.name === "Severity")?.value, "MEDIUM");
  assert.equal(card.fields?.find((field) => field.name === "Case ID")?.value, "42");
  assert.match(card.fields?.find((field) => field.name === "Reason")?.value ?? "", /Repeated spam/);
  assert.match(card.fields?.find((field) => field.name === "Moderator")?.value ?? "", /moderator-1/);
});

test("server mute and deafen audit changes produce the four expected actions", async () => {
  const { service, sent, users } = createHarness();
  const target = makeUser("voice-target", "nova", "Nova", "avatar");
  users.set(target.id, target);
  const transitions = [
    { key: "mute", old: false, new: true, action: "Server Mute" },
    { key: "mute", old: true, new: false, action: "Server Unmute" },
    { key: "deaf", old: false, new: true, action: "Server Deafen" },
    { key: "deaf", old: true, new: false, action: "Server Undeafen" },
  ];

  for (const transition of transitions) {
    const entry = {
      action: AuditLogEvent.MemberUpdate,
      executor: { id: "moderator-1", tag: "moderator#0001" },
      target,
      targetId: target.id,
      reason: "Voice moderation",
      changes: [{
        key: transition.key,
        old: transition.old,
        new: transition.new,
      }],
    } as unknown as GuildAuditLogsEntry;

    await service.logAuditAction("guild-1", entry);
  }

  assert.equal(sent.length, transitions.length);
  assert.deepEqual(
    sent.map(
      ({ embed }) =>
        embed.toJSON().fields?.find((field) => field.name === "Action")?.value,
    ),
    transitions.map(({ action }) => action),
  );
  assert.ok(sent.every(({ embed }) => embed.toJSON().color === 0xfee75c));
});

test("a moderation case enriches an earlier duplicate security action card", async () => {
  const { service, sent } = createHarness(() => "low");
  const target = makeUser("user-3", "nova", "Nova", "avatar");
  const member = { id: target.id, user: target } as GuildMember;

  await service.logSecurityTrigger({
    guildId: "guild-1",
    module: "Voice Moderation",
    member,
    action: "Server Mute",
    reason: "Repeated disruption",
  });
  await service.logModerationCommand({
    guildId: "guild-1",
    targetId: target.id,
    targetLabel: target.tag,
    moderatorId: "moderator-1",
    action: "server-mute",
    reason: "Repeated disruption",
    caseId: 57,
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].embed.toJSON().color, 0x57f287);
  assert.equal(sent[0].embed.toJSON().fields?.find((field) => field.name === "Case ID")?.value, "57");
});

test("message edit and delete cards include author avatars, channels, and content", async () => {
  const { service, sent } = createHarness();
  const author = makeUser("author-1", "editor", null, "author-avatar");
  const baseMessage = {
    guildId: "guild-1",
    channelId: "channel-1",
    id: "message-1",
    author,
    partial: false,
    attachments: new Collection(),
    url: "https://discord.example.test/message-1",
  };

  await service.logMessageEdit(
    { ...baseMessage, content: "before text" } as unknown as Message,
    { ...baseMessage, content: "after text" } as unknown as Message,
  );
  await service.logMessageDelete({
    ...baseMessage,
    content: "deleted text",
  } as unknown as Message);

  assert.equal(sent.length, 2);
  const editCard = sent[0].embed.toJSON();
  const deleteCard = sent[1].embed.toJSON();
  assert.match(editCard.fields?.find((field) => field.name === "Previous Content")?.value ?? "", /before text/);
  assert.match(editCard.fields?.find((field) => field.name === "Updated Content")?.value ?? "", /after text/);
  assert.equal(editCard.thumbnail?.url, "https://cdn.example.test/author-1/author-avatar?size=256");
  assert.match(deleteCard.fields?.find((field) => field.name === "Deleted Content")?.value ?? "", /deleted text/);
  assert.match(deleteCard.fields?.find((field) => field.name === "Channel")?.value ?? "", /channel-1/);
});

test("voice join, move, and leave cards identify the user and affected channels", async () => {
  const { service, sent } = createHarness();
  const user = makeUser("voice-user", "voice", null, "avatar");
  const member = { id: user.id, user } as GuildMember;
  const state = (channelId: string | null) =>
    ({
      guild: { id: "guild-1" },
      id: user.id,
      channelId,
      member,
    }) as VoiceState;

  await service.logVoiceStateUpdate(state(null), state("voice-1"));
  await service.logVoiceStateUpdate(state("voice-1"), state("voice-2"));
  await service.logVoiceStateUpdate(state("voice-2"), state(null));

  assert.equal(sent.length, 3);
  assert.match(sent[0].embed.toJSON().title ?? "", /Joined/);
  assert.match(sent[1].embed.toJSON().title ?? "", /Moved/);
  assert.match(sent[2].embed.toJSON().title ?? "", /Left/);
  assert.match(sent[1].embed.toJSON().fields?.find((field) => field.name === "Previous Channel")?.value ?? "", /voice-1/);
  assert.match(sent[1].embed.toJSON().fields?.find((field) => field.name === "New Channel")?.value ?? "", /voice-2/);
});

test("channel update cards include previous and updated settings", async () => {
  const { service, sent } = createHarness();
  const oldChannel = {
    id: "channel-1",
    guildId: "guild-1",
    name: "general",
    topic: "Old topic",
    rateLimitPerUser: 0,
    nsfw: false,
  } as unknown as Channel;
  const newChannel = {
    ...oldChannel,
    name: "community",
    topic: "New topic",
    rateLimitPerUser: 10,
    nsfw: true,
  } as unknown as Channel;

  await service.logChannelUpdate(oldChannel, newChannel);

  const fields = embedFields(sent[0].embed);
  assert.match(fields.find((field) => field.name === "Name")?.value ?? "", /general.*community/s);
  assert.match(fields.find((field) => field.name === "Topic")?.value ?? "", /Old topic.*New topic/s);
  assert.match(fields.find((field) => field.name === "Slowmode")?.value ?? "", /0s.*10s/s);
  assert.match(fields.find((field) => field.name === "NSFW")?.value ?? "", /Off.*On/s);
});

test("member join and leave cards use the members category and include member details", async () => {
  const { service, sent } = createHarness();
  const member = makeMember("member-1", null, [
    { id: "everyone", name: "@everyone" },
    { id: "helper", name: "Helper" },
  ]);

  await service.logMemberJoin(member);
  await service.logMemberLeave(member);

  assert.deepEqual(sent.map(({ category }) => category), ["members", "members"]);
  const joinCard = sent[0].embed.toJSON();
  assert.match(joinCard.title ?? "", /Member Joined/);
  assert.equal(joinCard.color, 0x57f287);
  assert.match(
    joinCard.fields?.find((field) => field.name === "Account Created")?.value ?? "",
    /<t:1600000000:R>/,
  );
  assert.equal(
    joinCard.fields?.find((field) => field.name === "Member Count")?.value,
    "12",
  );

  const leaveCard = sent[1].embed.toJSON();
  assert.match(leaveCard.title ?? "", /Member Left/);
  assert.equal(
    leaveCard.fields?.find((field) => field.name === "Roles")?.value,
    "<@&helper>",
  );
});

test("member nickname and role changes produce separate cards in the members category", async () => {
  const { service, sent } = createHarness();
  const oldMember = makeMember("member-2", "Before", [
    { id: "everyone", name: "@everyone" },
    { id: "kept", name: "Kept" },
    { id: "removed", name: "Removed" },
  ]);
  const newMember = makeMember("member-2", "After", [
    { id: "everyone", name: "@everyone" },
    { id: "kept", name: "Kept" },
    { id: "added", name: "Added" },
  ]);

  await service.logMemberUpdate(oldMember, newMember);

  assert.deepEqual(
    sent.map(({ category }) => category),
    ["members", "members", "members"],
  );
  const [nicknameCard, addedRoleCard, removedRoleCard] = sent.map(({ embed }) =>
    embed.toJSON(),
  );
  assert.match(nicknameCard.title ?? "", /Name Changed/);
  assert.match(
    nicknameCard.fields?.find((field) => field.name === "Before → After")?.value ?? "",
    /Display Name.*Before.*Before.*After.*After/s,
  );
  assert.match(addedRoleCard.title ?? "", /Member Role Added/);
  assert.match(
    addedRoleCard.fields?.find((field) => field.name === "Role Added (1)")?.value ?? "",
    /<@&added> `Added`/,
  );
  assert.match(removedRoleCard.title ?? "", /Member Role Removed/);
  assert.match(
    removedRoleCard.fields?.find((field) => field.name === "Role Removed (1)")?.value ?? "",
    /<@&removed> `Removed`/,
  );
});

test("role create, update, and delete cards preserve their payloads in the roles category", async () => {
  const { service, sent } = createHarness();
  const role = {
    id: "role-1",
    name: "Builder",
    color: 0x123456,
    hexColor: "#123456",
    position: 3,
    hoist: true,
    mentionable: true,
    permissions: { toArray: () => ["ViewChannel", "SendMessages"] },
    guild: {
      id: "guild-1",
      fetchAuditLogs: async () => ({
        entries: {
          find: (predicate: (entry: unknown) => boolean) => {
            const entry = {
              target: { id: "role-1" },
              executor: { id: "creator-1", tag: "creator#0001" },
            };
            return predicate(entry) ? entry : undefined;
          },
        },
      }),
    },
  } as unknown as Role;
  const oldRole = {
    ...role,
    name: "Builder",
    color: 0x123456,
    hexColor: "#123456",
    position: 3,
    hoist: false,
    mentionable: false,
  } as unknown as Role;
  const newRole = {
    ...role,
    name: "Senior Builder",
    color: 0x654321,
    hexColor: "#654321",
    position: 5,
    hoist: true,
    mentionable: true,
  } as unknown as Role;

  await service.logRoleCreate(role);
  await service.logRoleUpdate(oldRole, newRole);
  await service.logRoleDelete(newRole);

  assert.deepEqual(sent.map(({ category }) => category), ["roles", "roles", "roles"]);
  const [createdCard, updatedCard, deletedCard] = sent.map(({ embed }) =>
    embed.toJSON(),
  );
  assert.match(createdCard.title ?? "", /Role Created/);
  assert.match(createdCard.fields?.find((field) => field.name === "Name")?.value ?? "", /Builder/);
  assert.match(
    createdCard.fields?.find((field) => field.name === "Created By")?.value ?? "",
    /creator#0001.*creator-1/s,
  );
  assert.equal(createdCard.fields?.find((field) => field.name === "Role ID")?.value, "`role-1`");
  assert.equal(createdCard.fields?.find((field) => field.name === "Color")?.value, "#123456");
  assert.equal(createdCard.fields?.find((field) => field.name === "Position")?.value, "3");
  assert.equal(createdCard.fields?.find((field) => field.name === "Hoisted")?.value, "Yes");
  assert.equal(createdCard.fields?.find((field) => field.name === "Mentionable")?.value, "Yes");
  assert.match(
    createdCard.fields?.find((field) => field.name === "Permissions (2)")?.value ?? "",
    /View Channel, Send Messages/,
  );

  assert.match(updatedCard.title ?? "", /Role Updated/);
  assert.match(updatedCard.fields?.find((field) => field.name === "Name")?.value ?? "", /Builder.*Senior Builder/s);
  assert.match(updatedCard.fields?.find((field) => field.name === "Color")?.value ?? "", /#123456.*#654321/s);
  assert.equal(updatedCard.fields?.find((field) => field.name === "Position")?.value, "3 → 5");
  assert.equal(updatedCard.fields?.find((field) => field.name === "Hoisted")?.value, "No → Yes");
  assert.equal(updatedCard.fields?.find((field) => field.name === "Mentionable")?.value, "No → Yes");

  assert.match(deletedCard.title ?? "", /Role Deleted/);
  assert.match(deletedCard.fields?.find((field) => field.name === "Name")?.value ?? "", /Senior Builder/);
  assert.equal(deletedCard.fields?.find((field) => field.name === "Color")?.value, "#654321");
  assert.equal(deletedCard.fields?.find((field) => field.name === "Role ID")?.value, "`role-1`");
});
