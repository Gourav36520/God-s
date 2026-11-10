import assert from "node:assert/strict";
import test from "node:test";
import {
  AuditLogEvent,
  AttachmentBuilder,
  Collection,
  EmbedBuilder,
  GatewayIntentBits,
  IntentsBitField,
} from "discord.js";
import type {
  Channel,
  Client,
  GuildAuditLogsEntry,
  GuildMember,
  Message,
  PartialMessage,
  User,
  VoiceState,
} from "discord.js";
import type { SecurityManager } from "../security/SecurityManager.js";
import type { LogCategory } from "./types.js";
import { LoggingService } from "./LoggingService.js";
import {
  createMessageEditCardSvg,
  renderMessageEditCard,
} from "./messageEditCard.js";
import {
  createAvatarChangeCardSvg,
  createMessageDeleteCardSvg,
  createNameChangeCardSvg,
} from "./profileAndDeleteCards.js";

interface RecordedLog {
  category: LogCategory;
  embed: EmbedBuilder;
  embeds: EmbedBuilder[];
  files?: AttachmentBuilder[];
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
    options: {
      intents: new IntentsBitField(GatewayIntentBits.MessageContent),
    },
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
      embed: EmbedBuilder | EmbedBuilder[],
      files?: AttachmentBuilder[],
    ) => Promise<Message | null>;
  };
  const realSend = internals.send.bind(service);
  internals.client = client;
  internals.manager = manager;
  internals.send = async (_guildId, category, embed, files) => {
    const embeds = Array.isArray(embed) ? embed : [embed];
    const index =
      sent.push({
        category,
        embed: embeds[0],
        embeds,
        ...(files?.length ? { files } : {}),
      }) - 1;
    const message = {
      edit: async ({
        embeds,
        files,
      }: {
        embeds: EmbedBuilder[];
        files?: AttachmentBuilder[];
      }) => {
        sent[index].embed = embeds[0];
        sent[index].embeds = embeds;
        sent[index].files = files;
        return message;
      },
    };
    return message as unknown as Message;
  };

  return {
    service,
    sent,
    users,
    client,
    useRealSend: () => {
      internals.send = realSend;
    },
  };
}

function embedFields(embed: EmbedBuilder) {
  return embed.toJSON().fields ?? [];
}

test("profile logs use summary embeds and attached comparison PNGs", async () => {
  const { service, sent } = createHarness();
  const oldUser = makeUser("user-1", "nova", "Nova", "old-avatar");
  const newUser = makeUser("user-1", "nova.exe", "Nova.exe", "new-avatar");

  await service.logUserUpdate("guild-1", oldUser, newUser);

  assert.equal(sent.length, 2);
  assert.ok(sent.every(({ embeds }) => embeds.length === 2));
  const nameSummary = sent[0].embeds[0].toJSON();
  const nameCard = sent[0].embeds[1].toJSON();
  const avatarSummary = sent[1].embeds[0].toJSON();
  const avatarCard = sent[1].embeds[1].toJSON();
  assert.equal(sent[0].files?.[0].name, "name-change-card.png");
  assert.equal(sent[1].files?.[0].name, "avatar-change-card.png");
  assert.equal(nameSummary.color, 0x5865f2);
  assert.equal(avatarSummary.color, 0x5865f2);
  assert.match(nameSummary.title ?? "", /Name Changed/);
  assert.match(avatarSummary.title ?? "", /Avatar Changed/);
  assert.equal(nameSummary.author?.name, "Aegis Logs • Profile Update");
  assert.equal(avatarSummary.author?.name, "Aegis Logs • Profile Update");
  assert.equal(
    nameSummary.fields?.find((field) => field.name === "Change")?.value,
    "username updated, display name updated",
  );
  assert.equal(
    avatarSummary.fields?.find((field) => field.name === "Changed")?.value,
    "By user",
  );
  assert.equal(
    nameCard.image?.url,
    "attachment://name-change-card.png",
  );
  assert.equal(nameCard.thumbnail, undefined);
  assert.equal(avatarCard.image?.url, "attachment://avatar-change-card.png");
  assert.equal(avatarCard.thumbnail, undefined);
});

test("name and avatar changes send their PNGs with the embeds payload", async () => {
  const { service, client, useRealSend } = createHarness();
  const payloads: Array<{
    embeds: EmbedBuilder[];
    files?: AttachmentBuilder[];
    content?: string;
  }> = [];
  (client as unknown as {
    channels: {
      fetch: (channelId: string) => Promise<{
        isTextBased: () => boolean;
        send: (payload: {
          embeds: EmbedBuilder[];
          files?: AttachmentBuilder[];
          content?: string;
        }) => Promise<Message>;
      }>;
    };
  }).channels = {
    fetch: async () => ({
      isTextBased: () => true,
      send: async (payload) => {
        payloads.push(payload);
        return {} as Message;
      },
    }),
  };
  useRealSend();

  await service.logUserUpdate(
    "guild-1",
    makeUser("avatar-user", "nova", "Nova", "before"),
    makeUser("avatar-user", "nova.exe", "Nova.exe", "after"),
  );

  assert.equal(payloads.length, 2);
  assert.deepEqual(
    payloads.map(({ files }) => files?.[0].name),
    ["name-change-card.png", "avatar-change-card.png"],
  );
  assert.ok(
    payloads
      .flatMap(({ embeds }) => embeds)
      .every((embed) => embed instanceof EmbedBuilder),
  );
  assert.ok(payloads.every(({ content }) => content === undefined));
  assert.equal(
    payloads[0].embeds[1].toJSON().image?.url,
    "attachment://name-change-card.png",
  );
  assert.equal(
    payloads[1].embeds[1].toJSON().image?.url,
    "attachment://avatar-change-card.png",
  );
  assert.ok(payloads.every(({ files }) => Buffer.isBuffer(files?.[0].attachment)));
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

  const summary = sent[0].embeds[0].toJSON();
  const card = sent[0].embeds[1].toJSON();
  assert.equal(summary.color, 0xfee75c);
  assert.equal(card.author?.icon_url, "https://cdn.example.test/user-2/latest-avatar?size=256");
  assert.equal(summary.fields?.find((field) => field.name === "Severity")?.value, "**MEDIUM**");
  assert.match(card.footer?.text ?? "", /CASE #42/);
  assert.match(summary.fields?.find((field) => field.name === "Reason")?.value ?? "", /Repeated spam/);
  assert.match(card.fields?.find((field) => field.name === "Moderator")?.value ?? "", /moderator-1/);
  assert.equal(card.fields?.find((field) => field.name === "Moderator ID")?.value, "moderator-1");
  assert.equal(card.image?.url, "attachment://moderation-action-card.png");
  assert.equal(sent[0].files?.[0].name, "moderation-action-card.png");
});

test("all supported moderation commands use the same severity-colored PNG card", async () => {
  const actionCases = [
    ["ban", "low", 0x57f287],
    ["unban", "medium", 0xfee75c],
    ["kick", "high", 0xe67e22],
    ["timeout", "critical", 0x8b0000],
    ["untimeout", "low", 0x57f287],
    ["softban", "medium", 0xfee75c],
    ["softban-partial", "high", 0xe67e22],
    ["warn", "critical", 0x8b0000],
    ["warn-remove", "low", 0x57f287],
    ["server-mute", "medium", 0xfee75c],
    ["server-unmute", "high", 0xe67e22],
    ["server-deafen", "critical", 0x8b0000],
    ["server-undeafen", "low", 0x57f287],
    ["nickname", "medium", 0xfee75c],
  ] as const;
  const severityByUser = new Map<string, string>(
    actionCases.map(
      ([, severity], index) => [`target-${index}`, severity] as [string, string],
    ),
  );
  const { service, sent, users } = createHarness(
    (userId) => severityByUser.get(userId) ?? "none",
  );

  for (const [index, [action]] of actionCases.entries()) {
    const target = makeUser(`target-${index}`, `member${index}`, null, "avatar");
    users.set(target.id, target);
    await service.logModerationCommand({
      guildId: "guild-1",
      targetId: target.id,
      targetLabel: target.tag,
      moderatorId: "moderator-1",
      action,
      reason: "Action-specific test",
      duration: action === "timeout" ? "15 minutes" : undefined,
      caseId: index + 1,
    });
  }

  assert.equal(sent.length, actionCases.length);
  for (const [index, [action, severity, color]] of actionCases.entries()) {
    const summary = sent[index].embeds[0].toJSON();
    const card = sent[index].embeds[1].toJSON();
    assert.equal(summary.color, color, action);
    assert.equal(card.color, color, action);
    assert.equal(card.image?.url, "attachment://moderation-action-card.png", action);
    assert.equal(sent[index].files?.[0].name, "moderation-action-card.png", action);
    assert.equal(
      card.fields?.find((field) => field.name === "Action")?.value,
      action,
    );
    assert.equal(
      summary.fields?.find((field) => field.name === "Severity")?.value,
      `**${severity.toUpperCase()}**`,
    );
  }
});

test("non-user moderation targets use the same card without inventing severity", async () => {
  const { service, sent } = createHarness(() => "critical");

  await service.logModerationCommand({
    guildId: "guild-1",
    targetId: "role-1",
    targetLabel: "Helpers",
    moderatorId: "moderator-1",
    action: "role-add",
    reason: "Role access updated",
    caseId: 77,
  });

  const summary = sent[0].embeds[0].toJSON();
  const card = sent[0].embeds[1].toJSON();
  assert.equal(summary.color, 0x5865f2);
  assert.equal(summary.fields?.find((field) => field.name === "Severity")?.value, "Unrated");
  assert.equal(card.color, 0x5865f2);
  assert.equal(card.fields?.find((field) => field.name === "Action")?.value, "role-add");
  assert.equal(card.image?.url, "attachment://moderation-action-card.png");
  assert.equal(sent[0].files?.[0].name, "moderation-action-card.png");
});

test("judgment and release actions use the shared moderation PNG card", async () => {
  const { service, sent } = createHarness(() => "low");
  const user = makeUser("judgment-target", "nova", "Nova", "avatar");
  const target = { id: user.id, user } as GuildMember;

  await service.logJudgment({
    guildId: "guild-1",
    target,
    moderatorId: "moderator-1",
    reason: "Repeated disruption",
    savedRoles: ["role-1"],
  });
  await service.logRelease({
    guildId: "guild-1",
    target,
    moderatorId: "moderator-1",
    reason: "Review complete",
    restoredRoles: ["role-1"],
    skippedRoles: 0,
  });

  assert.equal(sent.length, 2);
  assert.deepEqual(
    sent.map(({ embeds }) =>
      embeds[1].toJSON().fields?.find((field) => field.name === "Action")?.value,
    ),
    ["Judgment", "Release"],
  );
  assert.ok(sent.every(({ files }) => files?.[0].name === "moderation-action-card.png"));
});

test("audit timeout cards show duration, expiry, timestamp, and target fallback data", async () => {
  const { service, sent, users } = createHarness(() => "high");
  const target = makeUser("timeout-user", "nova", "Nova", "avatar");
  const moderator = makeUser("timeout-mod", "kai", "Kai", "mod-avatar");
  users.set(target.id, target);
  users.set(moderator.id, moderator);
  const createdAt = new Date("2026-11-10T04:00:00.000Z");
  const expiresAt = new Date("2026-11-10T04:30:00.000Z");
  const entry = {
    action: AuditLogEvent.MemberUpdate,
    executor: moderator,
    target,
    targetId: target.id,
    reason: null,
    createdAt,
    changes: [{
      key: "communication_disabled_until",
      old: null,
      new: expiresAt.toISOString(),
    }],
  } as unknown as GuildAuditLogsEntry;

  await service.logAuditAction("guild-1", entry);

  const summary = sent[0].embeds[0].toJSON();
  const card = sent[0].embeds[1].toJSON();
  const fields = card.fields ?? [];
  assert.equal(summary.color, 0xe67e22);
  assert.match(fields.find((field) => field.name === "Duration")?.value ?? "", /30 minutes/);
  assert.match(fields.find((field) => field.name === "Expires")?.value ?? "", /<t:1794285000:F>/);
  assert.match(fields.find((field) => field.name === "Moderator ID")?.value ?? "", /timeout-mod/);
  assert.equal(summary.timestamp, createdAt.toISOString());
  assert.equal(card.image?.url, "attachment://moderation-action-card.png");
  assert.equal(sent[0].files?.[0].name, "moderation-action-card.png");
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
      ({ embeds }) =>
        embeds[1].toJSON().fields?.find((field) => field.name === "Action")?.value,
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
  assert.equal(sent[0].embeds[0].toJSON().color, 0x57f287);
  assert.match(sent[0].embeds[1].toJSON().footer?.text ?? "", /CASE #57/);
  assert.equal(sent[0].files?.[0].name, "moderation-action-card.png");
});

test("message edit and delete cards keep metadata and attach their PNGs", async () => {
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
    {
      ...baseMessage,
      content: "before text",
      editedTimestamp: null,
    } as unknown as Message,
    {
      ...baseMessage,
      content: "after text",
      editedTimestamp: 1_794_200_000_000,
    } as unknown as Message,
  );
  await service.logMessageDelete({
    ...baseMessage,
    content: "deleted text",
  } as unknown as Message);

  assert.equal(sent.length, 2);
  const editCard = sent[0].embed.toJSON();
  const deleteCard = sent[1].embed.toJSON();
  assert.equal(editCard.thumbnail, undefined);
  assert.equal(sent[0].embeds.length, 2);
  assert.equal(
    sent[0].embeds[1].toJSON().image?.url,
    "attachment://message-edit-card.png",
  );
  assert.equal(sent[0].files?.[0].name, "message-edit-card.png");
  assert.equal(deleteCard.color, 0x5865f2);
  assert.equal(deleteCard.thumbnail, undefined);
  assert.equal(sent[1].embeds.length, 2);
  assert.equal(
    sent[1].embeds[1].toJSON().image?.url,
    "attachment://message-delete-card.png",
  );
  assert.equal(sent[1].files?.[0].name, "message-delete-card.png");
  assert.match(editCard.fields?.find((field) => field.name === "Author")?.value ?? "", /author-1/);
  assert.match(editCard.fields?.find((field) => field.name === "Channel")?.value ?? "", /channel-1/);
  assert.match(editCard.fields?.find((field) => field.name === "Message ID")?.value ?? "", /message-1/);
  assert.match(deleteCard.fields?.find((field) => field.name === "Deleted Content")?.value ?? "", /deleted text/);
  assert.match(deleteCard.fields?.find((field) => field.name === "Channel")?.value ?? "", /channel-1/);
});

test("message delete sends the PNG attachment with its information embed", async () => {
  const { service, client, useRealSend } = createHarness();
  const payloads: Array<{
    embeds: EmbedBuilder[];
    files?: AttachmentBuilder[];
  }> = [];
  (client as unknown as {
    channels: {
      fetch: (channelId: string) => Promise<{
        isTextBased: () => boolean;
        send: (payload: {
          embeds: EmbedBuilder[];
          files?: AttachmentBuilder[];
        }) => Promise<Message>;
      }>;
    };
  }).channels = {
    fetch: async () => ({
      isTextBased: () => true,
      send: async (payload) => {
        payloads.push(payload);
        return {} as Message;
      },
    }),
  };
  useRealSend();

  const author = makeUser("deleted-author", "editor", "Editor", "avatar");
  await service.logMessageDelete({
    guildId: "guild-1",
    channelId: "channel-1",
    id: "deleted-message",
    author,
    partial: false,
    content: "This message was removed.",
    attachments: new Collection(),
    url: "https://discord.example.test/deleted-message",
  } as unknown as Message);

  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].embeds.length, 2);
  assert.equal(
    payloads[0].embeds[1].toJSON().image?.url,
    "attachment://message-delete-card.png",
  );
  assert.equal(payloads[0].files?.[0].name, "message-delete-card.png");
  assert.ok(Buffer.isBuffer(payloads[0].files?.[0].attachment));
  assert.match(
    payloads[0].embeds[0].toJSON().fields?.find(
      (field) => field.name === "Deleted Content",
    )?.value ?? "",
    /This message was removed/,
  );
});

test("message edit sends its image attachment with both embeds", async () => {
  const { service, client, useRealSend } = createHarness();
  const payloads: Array<{
    embeds: EmbedBuilder[];
    files?: AttachmentBuilder[];
  }> = [];
  (client as unknown as {
    channels: {
      fetch: (channelId: string) => Promise<{
        isTextBased: () => boolean;
        send: (payload: {
          embeds: EmbedBuilder[];
          files?: AttachmentBuilder[];
        }) => Promise<Message>;
      }>;
    };
  }).channels = {
    fetch: async () => ({
      isTextBased: () => true,
      send: async (payload) => {
        payloads.push(payload);
        return {} as Message;
      },
    }),
  };
  useRealSend();

  const author = makeUser("author-1", "editor", "Editor", "avatar");
  const baseMessage = {
    guildId: "guild-1",
    channelId: "channel-1",
    id: "message-send",
    author,
    partial: false,
    attachments: new Collection(),
    url: "https://discord.example.test/message-send",
  };
  await service.logMessageEdit(
    {
      ...baseMessage,
      content: "before",
      editedTimestamp: null,
    } as unknown as Message,
    {
      ...baseMessage,
      content: "after",
      editedTimestamp: 1_794_200_000_000,
    } as unknown as Message,
  );

  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].embeds.length, 2);
  assert.equal(
    payloads[0].embeds[1].toJSON().image?.url,
    "attachment://message-edit-card.png",
  );
  assert.equal(payloads[0].files?.[0].name, "message-edit-card.png");
  assert.ok(Buffer.isBuffer(payloads[0].files?.[0].attachment));
});

test("partial message edits log attachment-only changes using the old guild context", async () => {
  const { service, sent } = createHarness();
  const author = makeUser("author-2", "editor", null, "author-avatar");
  const oldAttachments = new Collection([
    ["old-file", { id: "old-file", name: "before.png", url: "https://files.test/before.png" }],
  ]);
  const updatedAttachments = new Collection([
    ["new-file", { id: "new-file", name: "after.png", url: "https://files.test/after.png" }],
  ]);
  const oldMessage = {
    guildId: "guild-1",
    channelId: "channel-1",
    id: "message-partial",
    author,
    partial: false,
    content: "same text",
    attachments: oldAttachments,
    editedTimestamp: 1_794_200_000_000,
    url: "https://discord.example.test/message-partial",
  } as unknown as Message;
  const fetchedMessage = {
    ...oldMessage,
    guildId: null,
    partial: false,
    attachments: updatedAttachments,
    editedTimestamp: 1_794_200_001_000,
  } as unknown as Message;
  const newMessage = {
    ...fetchedMessage,
    partial: true,
    content: null,
    fetch: async () => fetchedMessage,
  } as unknown as PartialMessage;

  await service.logMessageEdit(oldMessage, newMessage);

  assert.equal(sent.length, 1);
  const embed = sent[0].embed.toJSON();
  assert.match(embed.fields?.find((field) => field.name === "Previous Attachments")?.value ?? "", /before\.png/);
  assert.match(embed.fields?.find((field) => field.name === "Updated Attachments")?.value ?? "", /after\.png/);
  assert.equal(sent[0].files?.[0].name, "message-edit-card.png");
});

test("message edit card escapes text and safely shortens long content", () => {
  const svg = createMessageEditCardSvg({
    authorName: "Editor <admin>",
    authorTag: "@editor",
    authorId: "user-1",
    beforeContent: `<script>${"long text ".repeat(100)}</script>`,
    afterContent: "updated",
  });

  assert.match(svg, /BEFORE/);
  assert.match(svg, /AFTER/);
  assert.match(svg, /&lt;script&gt;/);
  assert.doesNotMatch(svg, /<script>/);
  assert.match(svg, /CONTENT SHORTENED/);
});

test("message edit card renders to a valid PNG", async () => {
  const png = await renderMessageEditCard({
    authorName: "Nova",
    authorTag: "@nova",
    authorId: "user-1",
    beforeContent: "Before content",
    afterContent: "After content",
  });

  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
});

test("profile and delete PNG templates show event values and safe avatar images", () => {
  const avatarBefore = "data:image/png;base64,b2xk";
  const avatarAfter = "data:image/png;base64,bmV3";
  const profile = {
    authorName: "Nova",
    authorTag: "@nova.exe",
    authorId: "482901736154209281",
    avatarUrl: "https://cdn.discordapp.com/avatar.png",
  };
  const nameSvg = createNameChangeCardSvg(
    {
      ...profile,
      beforeName: "Nova",
      afterName: "Nova.exe",
      beforeTag: "@nova",
      afterTag: "@nova.exe",
    },
    avatarAfter,
  );
  const avatarSvg = createAvatarChangeCardSvg(
    profile,
    avatarAfter,
    avatarBefore,
    avatarAfter,
  );
  const deleteSvg = createMessageDeleteCardSvg(
    {
      ...profile,
      content: `<script>${"deleted content ".repeat(100)}</script>`,
    },
    avatarAfter,
  );

  assert.match(nameSvg, /BEFORE/);
  assert.match(nameSvg, /Nova\.exe/);
  assert.match(nameSvg, /@nova/);
  assert.match(avatarSvg, /href="data:image\/png;base64,b2xk"/);
  assert.match(avatarSvg, /href="data:image\/png;base64,bmV3"/);
  assert.match(avatarSvg, /AFTER/);
  assert.match(deleteSvg, /DELETED MESSAGE/);
  assert.match(deleteSvg, /&lt;script&gt;/);
  assert.doesNotMatch(deleteSvg, /<script>/);
  assert.match(deleteSvg, /MESSAGE PREVIEW SHORTENED TO FIT/);
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
