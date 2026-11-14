import {
  AttachmentBuilder,
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import type {
  ChatInputCommandInteraction,
  GuildMember,
  SharedSlashCommand,
} from "discord.js";
import {
  getLevelingRoleRewards,
  removeLevelingRoleReward,
  setLevelingAnnouncementChannel,
  setLevelingRoleReward,
} from "@workspace/db";
import type { Command } from "../lib/registry.js";
import { LEVEL_CLASSES, classNameForLevel } from "../leveling/progression.js";
import { levelingService } from "../leveling/service.js";

const GOLD = 0xffd94f;
const MAX_CONFIGURED_LEVEL = 2_147_483_647;

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

export const levelingCommands: Command[] = [
  { data: levelData, execute: executeLevel },
  { data: moneyData, execute: executeMoney },
];
