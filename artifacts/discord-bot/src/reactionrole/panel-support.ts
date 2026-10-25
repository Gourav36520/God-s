import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ChatInputCommandInteraction,
  type Guild,
  type Message,
  type TextChannel,
} from "discord.js";
import {
  getReactionRolePanels,
  normalizeReactionEmoji,
  REACTION_ROLE_EMOJI,
  resolveReactionRoleChannel,
  updateReactionRoleConfig,
} from "./service.js";
import type { ReactionRolePanel } from "./types.js";
import { GOLDEN_ARROW, createGodsEmbed } from "../commands/ui.js";

export const LIST_BUTTON_PREFIX = "reactionrole:list:";
export const PANELS_PER_PAGE = 10;
const MESSAGE_ID_PATTERN = /^\d{17,20}$/;

export class ReactionRoleCommandError extends Error {
  constructor(
    readonly title: string,
    message: string,
  ) {
    super(message);
  }
}

export function requireMessageId(
  interaction: ChatInputCommandInteraction,
): string {
  const messageId = interaction.options.getString("message-id", true).trim();
  if (!MESSAGE_ID_PATTERN.test(messageId)) {
    throw new ReactionRoleCommandError(
      "Invalid Message ID",
      "Enter a valid 17–20 digit Discord message ID.",
    );
  }
  return messageId;
}

export function requireEmoji(input: string) {
  const emoji = normalizeReactionEmoji(input);
  if (!emoji) {
    throw new ReactionRoleCommandError(
      "Invalid Emoji",
      "Enter one valid Unicode emoji or a custom emoji such as `<:name:id>`.",
    );
  }
  return emoji;
}

export function findPanel(
  guildId: string,
  messageId: string,
): ReactionRolePanel | undefined {
  return getReactionRolePanels(guildId).find(
    (panel) => panel.messageId === messageId,
  );
}

export async function fetchPanelMessage(
  guild: Guild,
  panel: ReactionRolePanel,
): Promise<{ channel: TextChannel | null; message: Message | null }> {
  const channel = await resolveReactionRoleChannel(guild, panel.channelId);
  if (!channel) return { channel: null, message: null };
  const message = await channel.messages.fetch(panel.messageId).catch(() => null);
  return { channel, message };
}

export function assertPanelEmbedFits(panel: ReactionRolePanel): void {
  const description = panelDescription(panel);
  if (panel.title.length > 256 || description.length > 4_096) {
    throw new ReactionRoleCommandError(
      "Panel Content Too Long",
      "Shorten the title or description, or remove some mappings to fit Discord's embed limits.",
    );
  }
}

export function panelDescription(panel: ReactionRolePanel): string {
  const mappings =
    panel.mappings.length > 0
      ? panel.mappings.map(
          (mapping) => `${GOLDEN_ARROW} ${mapping.emoji} → <@&${mapping.roleId}>`,
        )
      : ["No roles are configured yet. An administrator can add a mapping."];
  return [
    panel.description || null,
    panel.description ? "" : null,
    "**Available roles**",
    ...mappings,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

export function buildPanelEmbed(panel: ReactionRolePanel) {
  return createGodsEmbed({
    title: panel.title,
    description: panelDescription(panel),
    emoji: REACTION_ROLE_EMOJI,
  });
}

export function escapeTitle(title: string): string {
  return title.replace(/([_*`~|])/g, "\\$1").slice(0, 100);
}

export function panelListView(
  panels: ReactionRolePanel[],
  guildId: string,
  userId: string,
  page: number,
) {
  const pageCount = Math.max(1, Math.ceil(panels.length / PANELS_PER_PAGE));
  const safePage = Math.min(Math.max(page, 0), pageCount - 1);
  const pagePanels = panels.slice(
    safePage * PANELS_PER_PAGE,
    (safePage + 1) * PANELS_PER_PAGE,
  );
  const description =
    panels.length === 0
      ? "No Reaction Role panels are configured in this server."
      : pagePanels
          .map(
            (panel) =>
              `${GOLDEN_ARROW} **${escapeTitle(panel.title || "Reaction Role Panel")}**\n<#${panel.channelId}> · \`${panel.messageId}\` · ${panel.mappings.length} mapping(s)`,
          )
          .join("\n\n");
  const embeds = [
    createGodsEmbed({
      title: `Reaction Role Panels · ${safePage + 1}/${pageCount}`,
      description,
      emoji: REACTION_ROLE_EMOJI,
    }),
  ];
  const components =
    pageCount <= 1
      ? []
      : [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId(`${LIST_BUTTON_PREFIX}${guildId}:${userId}:${safePage - 1}`)
              .setLabel("Previous")
              .setStyle(ButtonStyle.Secondary)
              .setDisabled(safePage === 0),
            new ButtonBuilder()
              .setCustomId(`${LIST_BUTTON_PREFIX}${guildId}:${userId}:${safePage + 1}`)
              .setLabel("Next")
              .setStyle(ButtonStyle.Secondary)
              .setDisabled(safePage >= pageCount - 1),
          ),
        ];
  return { embeds, components };
}

export async function removeMappingFromConfig(
  guildId: string,
  messageId: string,
  emojiKey: string,
): Promise<void> {
  await updateReactionRoleConfig(guildId, (current) => ({
    reactionRolePanels: current.reactionRolePanels.map((panel) =>
      panel.messageId === messageId
        ? {
            ...panel,
            mappings: panel.mappings.filter(
              (mapping) => mapping.emojiKey !== emojiKey,
            ),
          }
        : panel,
    ),
  }));
}

export function describeReactionFailure(error: unknown): string {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? Number((error as { code: unknown }).code)
      : null;
  if (code === 10014) {
    return "Discord rejected that emoji. Check that it is valid and that the bot can use the custom emoji.";
  }
  if (code === 50013 || code === 50001) {
    return "The bot cannot add that reaction. Check Add Reactions, View Channel, and external emoji permissions.";
  }
  return "Discord could not add the reaction. Check the emoji and the bot's Add Reactions permission.";
}

export function describeSendFailure(channelId: string): string {
  return `The bot could not send an embed in <#${channelId}>. Check View Channel, Send Messages, and Embed Links permissions.`;
}

export async function editNotice(
  interaction: ChatInputCommandInteraction,
  title: string,
  description: string,
  tone: "success" | "error" | "warning" | "info" = "info",
): Promise<void> {
  await interaction.editReply({
    embeds: [
      createGodsEmbed({
        title,
        description,
        emoji: REACTION_ROLE_EMOJI,
        tone,
      }),
    ],
    components: [],
  });
}