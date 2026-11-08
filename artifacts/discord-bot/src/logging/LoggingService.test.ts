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
  assert.match(
    nameCard.fields?.find((field) => field.name === "Username")?.value ?? "",
    /@nova.*@nova\.exe/s,
  );
  assert.match(
    nameCard.fields?.find((field) => field.name === "Display Name")?.value ?? "",
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
  assert.match(
    avatarCard.fields?.find((field) => field.name === "Avatar Transition")?.value ?? "",
    /Before.*After/s,
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
