import {
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import type { ChatInputCommandInteraction } from "discord.js";
import { securityManager } from "../lib/registry.js";
import { welcomeGoodbyeStore } from "../welcome-goodbye/config-store.js";
import { sendConfiguredGreeting } from "../welcome-goodbye/service.js";
import type { GreetingKind } from "../welcome-goodbye/types.js";
import { requireGuildAdministrator } from "./welcome-goodbye-helpers.js";
import { arrowLine, createGodsEmbed, GODS_EMOJI } from "./ui.js";
import {
  buildMessageEditorPrompt,
  buildSavedEmbedPicker,
} from "../welcome-goodbye/views.js";

export function createGreetingCommand(kind: GreetingKind) {
  const label = kind === "welcome" ? "Welcome" : "Goodbye";
  return new SlashCommandBuilder()
    .setName(kind)
    .setDescription(`${label} messages and settings`)
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((subcommand) =>
      subcommand
        .setName("embed")
        .setDescription(`Choose the saved embed for ${label} messages`),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("message")
        .setDescription(`Set the ${label} message text`),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("config")
        .setDescription(`Show or change the ${label} settings`)
        .addBooleanOption((option) =>
          option
            .setName("enabled")
            .setDescription("Turn this message on or off; omit to view settings")
            .setRequired(false),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("test")
        .setDescription(`Send the current ${label} output to its channel`),
    );
}

export async function executeGreetingCommand(
  kind: GreetingKind,
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const guildId = await requireGuildAdministrator(interaction);
  if (!guildId) return;
  const config = welcomeGoodbyeStore.get(guildId);
  const flow = config[kind];

  switch (interaction.options.getSubcommand(true)) {
    case "embed": {
      const picker = buildSavedEmbedPicker({
        kind,
        guildId,
        userId: interaction.user.id,
        page: 0,
        config,
      });
      await interaction.reply({
        ...picker,
        ephemeral: true,
      });
      return;
    }
    case "message": {
      await interaction.reply({
        ...buildMessageEditorPrompt(kind, guildId, interaction.user.id, flow.message),
        ephemeral: true,
      });
      return;
    }
    case "config": {
      const enabled = interaction.options.getBoolean("enabled");
      if (enabled !== null) {
        try {
          await welcomeGoodbyeStore.updateFlow(guildId, kind, { enabled });
        } catch {
          await interaction.reply({
            embeds: [
              createGodsEmbed({
                title: `${labelFor(kind)} Settings Not Saved`,
                description: "The setting could not be saved. Please try again.",
                emoji: GODS_EMOJI.settings,
                tone: "error",
              }),
            ],
            ephemeral: true,
          });
          return;
        }
      }
      await replyConfig(interaction, guildId, kind);
      return;
    }
    case "test": {
      await interaction.deferReply({ ephemeral: true });
      try {
        const guild = interaction.guild;
        if (!guild) {
          await interaction.editReply({
            embeds: [
              createGodsEmbed({
                title: "Server Required",
                description: "Run this test inside the server you want to check.",
                emoji: GODS_EMOJI.settings,
                tone: "error",
              }),
            ],
          });
          return;
        }
        const member = await guild.members.fetch(interaction.user.id);
        const result = await sendConfiguredGreeting(member, kind, true);
        await interaction.editReply({
          embeds: [
            createGodsEmbed({
              title: result.sent ? `${labelFor(kind)} Test Sent` : `${labelFor(kind)} Test Not Sent`,
              description: result.sent
                ? `${labelFor(kind)} output was sent to **#${result.channelName}**.`
                : result.reason,
              emoji: GODS_EMOJI.settings,
              tone: result.sent ? "success" : "error",
            }),
          ],
        });
      } catch {
        await interaction.editReply({
          embeds: [
            createGodsEmbed({
              title: `${labelFor(kind)} Test Not Sent`,
              description: `Discord could not load your server member for this test. Please try again.`,
              emoji: GODS_EMOJI.settings,
              tone: "error",
            }),
          ],
        });
      }
    }
  }
}

async function replyConfig(
  interaction: ChatInputCommandInteraction,
  guildId: string,
  kind: GreetingKind,
): Promise<void> {
  const guild = interaction.guild;
  const config = welcomeGoodbyeStore.get(guildId);
  const flow = config[kind];
  let channelText = "Not configured — choose one with `/set " + kind + " channel`.";
  if (flow.channelId && guild) {
    const channel = await guild.channels.fetch(flow.channelId).catch(() => null);
    channelText = channel
      ? `<#${channel.id}>`
      : "Saved channel is unavailable — choose a replacement with `/set " + kind + " channel`.";
  }

  const savedEmbed = flow.embedId
    ? config.embeds.find((embed) => embed.id === flow.embedId)
    : undefined;
  const embedText = savedEmbed
    ? savedEmbed.name
    : flow.embedId
      ? `Selected embed is missing — choose a replacement with \`/${kind} embed\`.`
      : "None — choose one with `/create embed` and `/" + kind + " embed`.";
  const messageStatus = flow.message
    ? `Set (${flow.message.length} characters)`
    : "Not set — use `/" + kind + " message`.";
  const description = [
    arrowLine("Status", flow.enabled ? "ON" : "OFF"),
    arrowLine("Channel", channelText),
    arrowLine("Selected embed", embedText),
    arrowLine("Message", messageStatus),
    "",
    "Use `/welcome config enabled:true` or `/goodbye config enabled:false` to change the state.",
  ].join("\n");
  await interaction.reply({
    embeds: [
      createGodsEmbed({
        title: `${labelFor(kind)} Configuration`,
        description,
        emoji: GODS_EMOJI.settings,
        tone: "info",
      }),
    ],
    ephemeral: true,
  });
}

function labelFor(kind: GreetingKind): string {
  return kind === "welcome" ? "Welcome" : "Goodbye";
}