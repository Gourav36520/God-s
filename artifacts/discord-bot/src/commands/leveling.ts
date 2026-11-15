import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  ComponentType,
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import type {
  ChatInputCommandInteraction,
  Guild,
  GuildMember,
  SharedSlashCommand,
} from "discord.js";
import {
  getLevelingLeaderboardMembers,
  getLevelingRoleRewards,
  getLevelingMember,
  getLevelingMemberRank,
  getLevelingSettings,
  removeLevelingRoleReward,
  setLevelingAnnouncementChannel,
  setLevelingRoleReward,
} from "@workspace/db";
import type { Command } from "../lib/registry.js";
import {
  LEVEL_CLASSES,
  calculateLevelProgress,
  classNameForLevel,
  formatCompactXp,
} from "../leveling/progression.js";
import { renderLevelCard } from "../leveling/render.js";
import { levelingService } from "../leveling/service.js";

const GOLD = 0xffd94f;
const MAX_CONFIGURED_LEVEL = 2_147_483_647;
const LEADERBOARD_PAGE_SIZE = 10;
const LEADERBOARD_COLLECTOR_MS = 15 * 60_000;

export const levelData: SharedSlashCommand = new SlashCommandBuilder()
  .setName("level")
  .setDescription("View and configure server leveling")
  .addSubcommand((subcommand) =>
    subcommand
      .setName("channel")
      .setDescription("Set the channel for level-up announcements")
      .addChannelOption((option) =>
        option
          .setName("channel")
          .setDescription("Where level-up announcements should be posted")
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setRequired(true),
      ),
  )
  .addSubcommandGroup((group) =>
    group
      .setName("role")
      .setDescription("Configure level reward roles")
      .addSubcommand((subcommand) =>
        subcommand
          .setName("set")
          .setDescription("Set the role awarded at a level")
          .addIntegerOption((option) =>
            option
              .setName("level")
              .setDescription("The level members must reach")
              .setMinValue(1)
              .setMaxValue(MAX_CONFIGURED_LEVEL)
              .setRequired(true),
          )
          .addRoleOption((option) =>
            option
              .setName("role")
              .setDescription("The reward role")
              .setRequired(true),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("remove")
          .setDescription("Remove a role reward from a level")
          .addIntegerOption((option) =>
            option
              .setName("level")
              .setDescription("The level whose reward should be removed")
              .setMinValue(1)
              .setMaxValue(MAX_CONFIGURED_LEVEL)
              .setRequired(true),
          ),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("perks")
      .setDescription("Show configured level rewards"),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("list")
      .setDescription("List all level classes in order"),
  );

export const moneyData: SharedSlashCommand = new SlashCommandBuilder()
  .setName("money")
  .setDescription("View a member's level card")
  .addUserOption((option) =>
    option
      .setName("member")
      .setDescription("The member whose card you want to view")
      .setRequired(false),
  );

export const moneyLeaderboardData: SharedSlashCommand = new SlashCommandBuilder()
  .setName("money-leaderboard")
  .setDescription("View this server's Money leaderboard");

export const testData: SharedSlashCommand = new SlashCommandBuilder()
  .setName("test")
  .setDescription("Test configured bot outputs")
  .addSubcommand((subcommand) =>
    subcommand
      .setName("money")
      .setDescription("Send a preview money card to the level channel"),
  );

function isGuildManager(
  interaction: ChatInputCommandInteraction,
): boolean {
  return interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false;
}

async function requireGuild(
  interaction: ChatInputCommandInteraction,
): Promise<boolean> {
  if (interaction.guild) return true;
  await interaction.reply({
    content: "Use this command inside a server.",
    ephemeral: true,
  });
  return false;
}

async function requireGuildManager(
  interaction: ChatInputCommandInteraction,
): Promise<boolean> {
  if (isGuildManager(interaction)) return true;
  await interaction.reply({
    content: "You need the Manage Server permission to configure leveling.",
    ephemeral: true,
  });
  return false;
}

async function executeChannel(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!(await requireGuild(interaction))) return;
  if (!(await requireGuildManager(interaction))) return;

  const guild = interaction.guild!;
  const selectedChannel = interaction.options.getChannel("channel", true);
  const channel = await guild.channels
    .fetch(selectedChannel.id)
    .catch(() => null);
  if (
    !channel ||
    (channel.type !== ChannelType.GuildText &&
      channel.type !== ChannelType.GuildAnnouncement)
  ) {
    await interaction.reply({
      content: "Choose a text or announcement channel in this server.",
      ephemeral: true,
    });
    return;
  }
  const botMember =
    guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
  const permissions = botMember ? channel.permissionsFor(botMember) : null;
  if (
    !permissions?.has(PermissionFlagsBits.ViewChannel) ||
    !permissions.has(PermissionFlagsBits.SendMessages)
  ) {
    await interaction.reply({
      content: "I need permission to view and send messages in that channel.",
      ephemeral: true,
    });
    return;
  }

  await setLevelingAnnouncementChannel(guild.id, channel.id);
  await interaction.reply({
    content: `Level-up announcements will be posted in <#${channel.id}>.`,
    allowedMentions: { parse: [] },
    ephemeral: true,
  });
}

async function executeRoleSet(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!(await requireGuild(interaction))) return;
  if (!(await requireGuildManager(interaction))) return;

  const guild = interaction.guild!;
  const level = interaction.options.getInteger("level", true);
  const role = interaction.options.getRole("role", true);
  const botMember =
    guild.members.me ?? (await guild.members.fetchMe().catch(() => null));

  if (!botMember?.permissions.has(PermissionFlagsBits.ManageRoles)) {
    await interaction.reply({
      content: "I need the Manage Roles permission to grant level rewards.",
      ephemeral: true,
    });
    return;
  }
  if (
    role.id === guild.id ||
    role.managed ||
    role.position >= botMember.roles.highest.position
  ) {
    await interaction.reply({
      content:
        "That role cannot be assigned by me. Choose an unmanaged role below my highest role.",
      ephemeral: true,
    });
    return;
  }

  await setLevelingRoleReward(guild.id, level, role.id);
  await interaction.reply({
    content: `Members who reach level ${level.toLocaleString()} will receive <@&${role.id}>.`,
    allowedMentions: { parse: [] },
    ephemeral: true,
  });
}

async function executeRoleRemove(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!(await requireGuild(interaction))) return;
  if (!(await requireGuildManager(interaction))) return;

  const level = interaction.options.getInteger("level", true);
  const removed = await removeLevelingRoleReward(interaction.guild!.id, level);
  await interaction.reply({
    content: removed
      ? `Removed the level ${level.toLocaleString()} role reward.`
      : `There is no role reward configured for level ${level.toLocaleString()}.`,
    ephemeral: true,
  });
}

function splitLines(lines: string[], maxLength: number): string[] {
  const pages: string[] = [];
  let page = "";
  for (const line of lines) {
    const next = page ? `${page}\n${line}` : line;
    if (next.length > maxLength && page) {
      pages.push(page);
      page = line;
    } else {
      page = next;
    }
  }
  if (page) pages.push(page);
  return pages;
}

async function executePerks(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!(await requireGuild(interaction))) return;
  const rewards = await getLevelingRoleRewards(interaction.guild!.id);
  if (rewards.length === 0) {
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(GOLD)
          .setTitle("Level rewards")
          .setDescription(
            "No reward roles are configured yet. A server manager can add one with `/level role set`.",
          ),
      ],
    });
    return;
  }

  const lines = rewards.map(
    ({ level, roleId }) =>
      `**Level ${level.toLocaleString()} · ${classNameForLevel(level)}** — <@&${roleId}>`,
  );
  const descriptions = splitLines(lines, 3_800);
  for (let index = 0; index < descriptions.length; index += 10) {
    const embeds = descriptions.slice(index, index + 10).map((description, pageIndex) =>
      new EmbedBuilder()
        .setColor(GOLD)
        .setTitle("Level rewards")
        .setDescription(description)
        .setFooter({
          text: `Page ${index + pageIndex + 1} of ${descriptions.length} · Rewards are granted when a member reaches the level.`,
        }),
    );
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({
        embeds,
        ephemeral: true,
        allowedMentions: { parse: [] },
      });
    } else {
      await interaction.reply({
        embeds,
        ephemeral: true,
        allowedMentions: { parse: [] },
      });
    }
  }
}

async function executeList(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const entries = LEVEL_CLASSES.map(
    (className, index) => `**${index + 1}.** ${className}`,
  );
  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setColor(GOLD)
        .setTitle("Level classes")
        .setDescription(
          `${entries.join("\n")}\n\n**Infinity is the final class.** Members can continue gaining XP and levels within Infinity; there is no higher class.`,
        ),
    ],
  });
}

export async function executeLevel(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const group = interaction.options.getSubcommandGroup(false);
  const subcommand = interaction.options.getSubcommand();

  if (group === "role") {
    if (subcommand === "set") {
      await executeRoleSet(interaction);
    } else {
      await executeRoleRemove(interaction);
    }
    return;
  }

  switch (subcommand) {
    case "channel":
      await executeChannel(interaction);
      return;
    case "perks":
      await executePerks(interaction);
      return;
    case "list":
      await executeList(interaction);
  }
}

async function resolveMember(
  interaction: ChatInputCommandInteraction,
): Promise<GuildMember | null> {
  const guild = interaction.guild;
  if (!guild) return null;
  const selected = interaction.options.getUser("member");
  return guild.members.fetch(selected?.id ?? interaction.user.id).catch(() => null);
}

export async function executeMoney(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!(await requireGuild(interaction))) return;
  await interaction.deferReply();

  const member = await resolveMember(interaction);
  if (!member) {
    await interaction.editReply(
      "That member is not in this server, or Discord could not load them.",
    );
    return;
  }

  const image = await levelingService.renderCard(member);
  await interaction.editReply({
    files: [
      new AttachmentBuilder(image, {
        name: `level-${member.id}.png`,
      }),
    ],
    allowedMentions: { parse: [] },
  });
}

interface LeaderboardPage {
  embed: EmbedBuilder;
  hasEntries: boolean;
  hasNextPage: boolean;
}

async function createLeaderboardPage(
  guild: Guild,
  page: number,
): Promise<LeaderboardPage> {
  const rows = await getLevelingLeaderboardMembers(
    guild.id,
    page * LEADERBOARD_PAGE_SIZE,
    LEADERBOARD_PAGE_SIZE + 1,
  );
  const members = rows.slice(0, LEADERBOARD_PAGE_SIZE);
  const description =
    members.length > 0
      ? members
          .map((member, index) => {
            const rank = page * LEADERBOARD_PAGE_SIZE + index + 1;
            const medal = rank === 1 ? "🥇 " : rank === 2 ? "🥈 " : rank === 3 ? "🥉 " : "";
            const className = calculateLevelProgress(member.totalXp).className;
            return `${medal}**#${rank}** · <@${member.userId}>\n└ **${className}** · **${formatCompactXp(member.totalXp)} XP**`;
          })
          .join("\n\n")
      : "No members have earned Money XP in this server yet.";

  return {
    embed: new EmbedBuilder()
      .setColor(GOLD)
      .setTitle("💰 MONEY LEADERBOARD")
      .setDescription(description)
      .setFooter({
        text: members.length > 0
          ? `Page ${page + 1} · Ranked by combined lifetime XP`
          : "Server-wide Money rankings",
      }),
    hasEntries: members.length > 0,
    hasNextPage: rows.length > LEADERBOARD_PAGE_SIZE,
  };
}

function leaderboardButtons(
  prefix: string,
  page: number,
  hasNextPage: boolean,
  disabled = false,
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${prefix}:previous`)
      .setLabel("Previous")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled || page === 0),
    new ButtonBuilder()
      .setCustomId(`${prefix}:next`)
      .setLabel("Next")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled || !hasNextPage),
  );
}

export async function executeMoneyLeaderboard(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!(await requireGuild(interaction))) return;
  const guild = interaction.guild!;
  let page = 0;
  const pageData = await createLeaderboardPage(guild, page);
  const prefix = `money-leaderboard:${interaction.id}`;

  await interaction.reply({
    embeds: [pageData.embed],
    components: pageData.hasEntries
      ? [leaderboardButtons(prefix, page, pageData.hasNextPage)]
      : [],
    allowedMentions: { parse: [] },
  });

  if (!pageData.hasEntries) return;
  const message = await interaction.fetchReply();
  const collector = message.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: LEADERBOARD_COLLECTOR_MS,
    filter: (button) => button.customId.startsWith(`${prefix}:`),
  });

  let hasNextPage = pageData.hasNextPage;
  collector.on("collect", async (button) => {
    const previousPage = page;
    page += button.customId.endsWith(":next") ? 1 : -1;
    page = Math.max(0, page);
    try {
      const nextPage = await createLeaderboardPage(guild, page);
      if (!nextPage.hasEntries && page > 0) {
        page -= 1;
        await button.deferUpdate();
        return;
      }
      hasNextPage = nextPage.hasNextPage;
      await button.update({
        embeds: [nextPage.embed],
        components: [
          leaderboardButtons(prefix, page, hasNextPage),
        ],
        allowedMentions: { parse: [] },
      });
    } catch (error) {
      page = previousPage;
      await button.update({
        embeds: [
          new EmbedBuilder()
            .setColor(GOLD)
            .setTitle("💰 MONEY LEADERBOARD")
            .setDescription(
              `This leaderboard page could not be loaded: ${describeFailure(error)}`,
            ),
        ],
        components: [],
        allowedMentions: { parse: [] },
      }).catch(() => null);
    }
  });

  collector.on("end", () => {
    void message.edit({
      components: [
        leaderboardButtons(prefix, page, hasNextPage, true),
      ],
    }).catch(() => null);
  });
}

function describeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code: unknown }).code)
      : null;
  return `${code ? `Error code ${code}: ` : ""}${message}`.slice(0, 500);
}

async function executeMoneyTest(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!(await requireGuild(interaction))) return;
  await interaction.deferReply({ ephemeral: true });

  const guild = interaction.guild!;
  let configuredChannelId: string | null = null;
  try {
    const settings = await getLevelingSettings(guild.id);
    const channelId = settings?.announcementChannelId;
    if (!channelId) {
      await interaction.editReply(
        "No level channel is configured, so the test card was not sent. Configure one with `/level channel`.",
      );
      return;
    }
    configuredChannelId = channelId;

    let fetchFailure: unknown = null;
    const target = await guild.channels.fetch(channelId).catch((error: unknown) => {
      fetchFailure = error;
      return null;
    });
    if (!target) {
      await interaction.editReply({
        content: fetchFailure
          ? `The configured level channel <#${channelId}> could not be fetched. The test card was not sent. Actual failure: ${describeFailure(fetchFailure)}`
          : `The configured level channel <#${channelId}> no longer exists. The test card was not sent.`,
        allowedMentions: { parse: [] },
      });
      return;
    }
    if (
      target.type !== ChannelType.GuildText &&
      target.type !== ChannelType.GuildAnnouncement
    ) {
      await interaction.editReply({
        content: `The configured level channel <#${channelId}> is not a text or announcement channel. The test card was not sent.`,
        allowedMentions: { parse: [] },
      });
      return;
    }

    let botMemberFailure: unknown = null;
    const botMember =
      guild.members.me ??
      (await guild.members.fetchMe().catch((error: unknown) => {
        botMemberFailure = error;
        return null;
      }));
    const channelPermissions = botMember
      ? target.permissionsFor(botMember)
      : null;
    const requiredPermissions = [
      [PermissionFlagsBits.ViewChannel, "View Channel"],
      [PermissionFlagsBits.SendMessages, "Send Messages"],
      [PermissionFlagsBits.AttachFiles, "Attach Files"],
    ] as const;
    const missingPermissions = requiredPermissions
      .filter(([permission]) => !channelPermissions?.has(permission))
      .map(([, label]) => label);
    if (!botMember || missingPermissions.length > 0) {
      await interaction.editReply({
        content: botMember
          ? `The test card was not sent to <#${channelId}>. Missing channel permission${missingPermissions.length === 1 ? "" : "s"}: ${missingPermissions.join(", ")}.`
          : `The test card was not sent to <#${channelId}>. I could not load my server member permissions. Actual failure: ${botMemberFailure ? describeFailure(botMemberFailure) : "The bot is not present in the server member cache."}`,
        allowedMentions: { parse: [] },
      });
      return;
    }

    const member = await guild.members.fetch(interaction.user.id).catch(
      (error: unknown) => {
        throw new Error(
          `Could not load the command invoker in this server: ${describeFailure(error)}`,
        );
      },
    );
    const record = await getLevelingMember(guild.id, member.id);
    const totalXp = record?.totalXp ?? 0n;
    const image = await renderLevelCard(member, {
      totalXp,
      recentXp: record?.recentXp ?? 0n,
      rank: await getLevelingMemberRank(guild.id, member.id, totalXp),
    });

    try {
      await target.send({
        files: [
          new AttachmentBuilder(image, {
            name: `money-preview-${member.id}.png`,
          }),
        ],
        allowedMentions: { parse: [] },
      });
    } catch (error) {
      await interaction.editReply({
        content: `The test card could not be delivered to the configured level channel <#${channelId}>. Actual failure: ${describeFailure(error)}`,
        allowedMentions: { parse: [] },
      });
      return;
    }

    await interaction.editReply({
      content: `The test card was delivered successfully to the configured level channel <#${channelId}>.`,
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    await interaction.editReply(
      configuredChannelId
        ? `The money test failed before delivery to the configured level channel <#${configuredChannelId}>. Actual failure: ${describeFailure(error)}`
        : `The configured level channel could not be checked, and no test card was delivered. Actual failure: ${describeFailure(error)}`,
    );
  }
}

export const levelingCommands: Command[] = [
  { data: levelData, execute: executeLevel },
  { data: moneyData, execute: executeMoney },
  { data: moneyLeaderboardData, execute: executeMoneyLeaderboard },
  { data: testData, execute: executeMoneyTest },
];
