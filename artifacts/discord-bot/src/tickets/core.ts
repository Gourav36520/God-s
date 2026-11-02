import { PermissionFlagsBits } from "discord.js";
import type { OverwriteResolvable } from "discord.js";
import type { TicketConfig } from "../security/types.js";

export const TICKET_CREATE_BUTTON_ID = "gods-ticket:create";
export const TICKET_CLOSE_BUTTON_ID = "gods-ticket:close";

export type TicketStatus = "open" | "closed";

export interface TicketChannelMetadata {
  guildId: string;
  openerId: string;
  status: TicketStatus;
}

export function buildTicketTopic(
  guildId: string,
  openerId: string,
  status: TicketStatus = "open",
): string {
  return `gods-ticket:v1|guild=${guildId}|opener=${openerId}|status=${status}`;
}

export function parseTicketTopic(
  topic: string | null | undefined,
): TicketChannelMetadata | null {
  if (!topic) return null;
  const match = /^gods-ticket:v1\|guild=(\d+)\|opener=(\d+)\|status=(open|closed)$/.exec(
    topic,
  );
  if (!match) return null;
  return {
    guildId: match[1],
    openerId: match[2],
    status: match[3] as TicketStatus,
  };
}

export function findOpenTicketForOpener<T extends { topic?: string | null }>(
  channels: Iterable<T>,
  guildId: string,
  openerId: string,
): T | undefined {
  for (const channel of channels) {
    const metadata = parseTicketTopic(channel.topic);
    if (
      metadata?.guildId === guildId &&
      metadata.openerId === openerId &&
      metadata.status === "open"
    ) {
      return channel;
    }
  }
  return undefined;
}

export function getTicketPanelMissingItems(
  config: TicketConfig,
  hasSelectedEmbed: boolean,
): string[] {
  const missing: string[] = [];
  if (!config.enabled) missing.push("Ticket System is disabled");
  if (!config.staffRoleId) missing.push("Staff Role");
  if (!config.categoryId) missing.push("Ticket Category");
  if (!config.panelChannelId) missing.push("Panel Channel");
  if (!config.panelEmbedId || !hasSelectedEmbed) missing.push("Panel Embed");
  return missing;
}

export interface TicketPermissionIds {
  everyoneRoleId: string;
  openerId: string;
  staffRoleId: string;
  botUserId: string;
}

export function buildTicketPermissionOverwrites(
  ids: TicketPermissionIds,
): OverwriteResolvable[] {
  return [
    {
      id: ids.everyoneRoleId,
      deny: [PermissionFlagsBits.ViewChannel],
    },
    {
      id: ids.openerId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.EmbedLinks,
      ],
    },
    {
      id: ids.staffRoleId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.EmbedLinks,
      ],
    },
    {
      id: ids.botUserId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.ManageMessages,
        PermissionFlagsBits.EmbedLinks,
      ],
    },
  ];
}