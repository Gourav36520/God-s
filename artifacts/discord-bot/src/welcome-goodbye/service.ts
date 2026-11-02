import type { GuildMember, TextChannel } from "discord.js";
import { logger } from "../lib/logger.js";
import { welcomeGoodbyeStore } from "./config-store.js";
import { buildGreetingPayload, GreetingOutputError } from "./render.js";
import type { GreetingKind } from "./types.js";

export type GreetingSendResult =
  | { sent: true; channelName: string }
  | { sent: false; reason: string };

export async function sendConfiguredGreeting(
  member: GuildMember,
  kind: GreetingKind,
  force = false,
): Promise<GreetingSendResult> {
  const displayName = kind === "welcome" ? "Welcome" : "Goodbye";

  try {
    const config = welcomeGoodbyeStore.get(member.guild.id);
    const flow = config[kind];

    if (!force && !flow.enabled) {
      return { sent: false, reason: `${displayName} is turned off.` };
    }
    if (!flow.channelId) {
      return {
        sent: false,
        reason: `No ${displayName.toLowerCase()} channel is configured. Set one with \`/set ${kind} channel\`.`,
      };
    }

    const channel = await member.guild.channels.fetch(flow.channelId);
    if (!channel || channel.guildId !== member.guild.id || !channel.isTextBased()) {
      return {
        sent: false,
        reason: `The saved ${displayName.toLowerCase()} channel is unavailable. Choose a new one with \`/set ${kind} channel\`.`,
      };
    }

    const savedEmbed = flow.embedId
      ? config.embeds.find((embed) => embed.id === flow.embedId)
      : undefined;
    if (flow.embedId && !savedEmbed) {
      return {
        sent: false,
        reason: `The selected ${displayName.toLowerCase()} embed is missing. Create an embed with \`/create embed\`, then select it with \`/${kind} embed\`.`,
      };
    }

    const payload = buildGreetingPayload(flow, savedEmbed, member);
    await (channel as TextChannel).send(payload);
    return { sent: true, channelName: channel.name };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logger.warn(`${displayName}: could not send for guild ${member.guild.id}: ${detail}`);
    return {
      sent: false,
      reason:
        error instanceof GreetingOutputError
          ? detail
          : `Discord could not send the ${displayName.toLowerCase()} message. Check that the bot can view and send messages in the configured channel${member.guild.id ? " and has Embed Links permission when an embed is selected" : ""}.`,
    };
  }
}

export async function sendMemberWelcome(member: GuildMember): Promise<void> {
  const result = await sendConfiguredGreeting(member, "welcome");
  if (!result.sent && result.reason !== "Welcome is turned off.") {
    logger.info(`Welcome skipped for guild ${member.guild.id}: ${result.reason}`);
  }
}

export async function sendMemberGoodbye(member: GuildMember): Promise<void> {
  const result = await sendConfiguredGreeting(member, "goodbye");
  if (!result.sent && result.reason !== "Goodbye is turned off.") {
    logger.info(`Goodbye skipped for guild ${member.guild.id}: ${result.reason}`);
  }
}