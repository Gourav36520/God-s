import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import type {
  ButtonInteraction,
  ChatInputCommandInteraction,
  GuildMember,
  SharedSlashCommand,
  TextChannel,
} from "discord.js";
import { logger } from "../lib/logger.js";
import { memberCardService, formatGenerationProgress } from "../member-cards/service.js";
import type { MemberCardKind } from "../member-cards/types.js";
import type { Command } from "../lib/registry.js";

const MEMBER_CARD_BUTTON_PREFIX = "member-card:";

export const generateData: SharedSlashCommand = new SlashCommandBuilder()
  .setName("generate")
  .setDescription("Generate member cards for this server")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommandGroup((group) =>
    group
      .setName("all")
      .setDescription("Generate cards for server members")
      .addSubcommand((subcommand) =>
        subcommand
          .setName("cards")
          .setDescription("Create or refresh all member cards"),
      ),
  );

export const cardData: SharedSlashCommand = new SlashCommandBuilder()
  .setName("card")
  .setDescription("View a server member card")
  .addSubcommand((subcommand) =>
    subcommand
      .setName("user")
      .setDescription("View a member profile and related cards")
      .addUserOption((option) =>
        option
          .setName("member")
          .setDescription("The server member")
          .setRequired(true),
      ),
  );

function cardButtons(
  guildId: string,
  targetId: string,
  ownerId: string,
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${MEMBER_CARD_BUTTON_PREFIX}${ownerId}:${guildId}:${targetId}:history`)
      .setLabel("Profile")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`${MEMBER_CARD_BUTTON_PREFIX}${ownerId}:${guildId}:${targetId}:roles`)
      .setLabel("Role")
      .setStyle(ButtonStyle.Secondary),
  );
}

function cardAttachment(kind: MemberCardKind, image: Buffer): AttachmentBuilder {
  const filename =
    kind === "member"
      ? "member-profile.png"
      : kind === "history"
        ? "member-history.png"
        : "member-roles.png";
  return new AttachmentBuilder(image, { name: filename });
}

function textChannelForGeneration(
  interaction: ChatInputCommandInteraction,
): TextChannel | null {
  const channel = interaction.channel;
  if (
    !channel ||
    (channel.type !== ChannelType.GuildText &&
      channel.type !== ChannelType.GuildAnnouncement)
  ) {
    return null;
  }
  return channel as TextChannel;
}

async function executeGenerate(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!interaction.guild) {
    await interaction.reply({
      content: "Run this command inside the server whose member cards you want to generate.",
      ephemeral: true,
    });
    return;
  }
  const destination = textChannelForGeneration(interaction);
  if (!destination) {
    await interaction.reply({
      content: "Use this command in a server text or announcement channel.",
      ephemeral: true,
    });
    return;
  }
  if (!(await memberCardService.canUseChannel(destination, interaction.guild))) {
    await interaction.reply({
      content:
        "I need View Channel, Read Message History, Send Messages, and Attach Files in this channel to create the cards.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  let progressCanBeUpdated = true;
  const task = memberCardService.startGenerateAll(
    interaction.guild,
    destination,
    async (progress) => {
      if (!progressCanBeUpdated) return;
      try {
        await interaction.editReply(
          `Generating or refreshing member cards…\n\n${formatGenerationProgress(progress)}`,
        );
      } catch {
        progressCanBeUpdated = false;
      }
    },
  );
  if (!task) {
    await interaction.editReply(
      "A member-card generation pass is already running for this server.",
    );
    return;
  }

  try {
    const result = await task;
    const heading = result.complete
      ? "Member-card generation finished."
      : "Member-card generation finished with errors.";
    const retry = result.memberFailures
      ? "\nRun the same command again to retry cards that could not be created or updated."
      : result.membersProcessed < result.membersTotal
        ? "\nThe member list may have been incomplete; check the Guild Members intent and try again."
        : "";
    await interaction
      .editReply(
        `${heading}\n\n${formatGenerationProgress(result)}${retry}`,
      )
      .catch(() => null);
  } catch (error) {
    logger.error(
      `All-member card generation failed in guild ${interaction.guild.id}:`,
      error instanceof Error ? error.stack ?? error.message : String(error),
    );
    await interaction
      .editReply(
        "Member-card generation could not finish. Check the bot logs, then run the same command again to resume safely.",
      )
      .catch(() => null);
  }
}

async function fetchTargetMember(
  interaction: ChatInputCommandInteraction,
): Promise<GuildMember | null> {
  if (!interaction.guild) return null;
  const user = interaction.options.getUser("member", true);
  return interaction.guild.members.fetch(user.id).catch(() => null);
}

async function executeCard(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!interaction.guild) {
    await interaction.reply({
      content: "Run this command inside the server where the member is located.",
      ephemeral: true,
    });
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  const member = await fetchTargetMember(interaction);
  if (!member) {
    await interaction.editReply(
      "That user is not a current member of this server, or Discord could not load the member.",
    );
    return;
  }

  const image = await memberCardService.renderCurrentCard(member, "member");
  await interaction.editReply({
    files: [cardAttachment("member", image)],
    components: [
      cardButtons(interaction.guild.id, member.id, interaction.user.id),
    ],
    allowedMentions: { parse: [] },
  });
}

export const memberCardCommands: Command[] = [
  {
    data: generateData,
    execute: executeGenerate,
  },
  {
    data: cardData,
    execute: executeCard,
  },
];

interface MemberCardButtonContext {
  ownerId: string;
  guildId: string;
  targetId: string;
  kind: "history" | "roles";
}

function parseCardButton(customId: string): MemberCardButtonContext | null {
  const match =
    /^member-card:(\d{16,20}):(\d{16,20}):(\d{16,20}):(history|roles)$/.exec(
      customId,
    );
  if (!match) return null;
  return {
    ownerId: match[1]!,
    guildId: match[2]!,
    targetId: match[3]!,
    kind: match[4] as "history" | "roles",
  };
}

export function isMemberCardButton(customId: string): boolean {
  return customId.startsWith(MEMBER_CARD_BUTTON_PREFIX);
}

export async function handleMemberCardButton(
  interaction: ButtonInteraction,
): Promise<void> {
  const context = parseCardButton(interaction.customId);
  if (!context) return;
  if (interaction.user.id !== context.ownerId) {
    await interaction
      .reply({
        content: "Only the member who opened this card can switch its view.",
        ephemeral: true,
      })
      .catch(() => null);
    return;
  }
  if (interaction.guildId !== context.guildId) {
    await interaction
      .reply({
        content: "This card belongs to a different server.",
        ephemeral: true,
      })
      .catch(() => null);
    return;
  }

  await interaction.deferUpdate();
  try {
    const guild = interaction.guild;
    if (!guild) {
      await interaction.editReply({
        content: "This card is only available inside its server.",
        files: [],
        components: [],
      });
      return;
    }
    const member = await guild.members.fetch(context.targetId).catch(() => null);
    if (!member) {
      await interaction.editReply({
        content: "That member is no longer in this server.",
        files: [],
        components: [],
      });
      return;
    }
    const image = await memberCardService.renderCurrentCard(member, context.kind);
    await interaction.editReply({
      content: "",
      files: [cardAttachment(context.kind, image)],
      attachments: [],
      components: [
        cardButtons(context.guildId, context.targetId, context.ownerId),
      ],
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    logger.warn(
      `Member-card navigation failed for ${context.targetId} in guild ${context.guildId}:`,
      error instanceof Error ? error.message : "unknown error",
    );
    await interaction
      .followUp({
        content: "That card could not be displayed right now. Please try again.",
        ephemeral: true,
      })
      .catch(() => null);
  }
}
