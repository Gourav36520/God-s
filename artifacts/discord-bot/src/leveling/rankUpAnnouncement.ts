import { AttachmentBuilder, EmbedBuilder } from "discord.js";
import type { MessageCreateOptions } from "discord.js";
import { formatCompactXp } from "./progression.js";

const GOLD = 0xffd94f;

export function buildMoneyRankUpPayload(input: {
  userId: string;
  previousClass: string;
  currentClass: string;
  recentXp: bigint;
  progressBar: string;
  card: Buffer;
}): MessageCreateOptions {
  const fileName = `money-${input.userId}.png`;
  const embed = new EmbedBuilder()
    .setColor(GOLD)
    .setTitle("💰 MONEY UP!")
    .setDescription(
      [
        "━━━━━━━━━━━━━━",
        "",
        `🎉 <@${input.userId}> has ranked up!`,
        `${input.previousClass} ➜ ${input.currentClass}`,
        "",
        `💸 Money: ${formatCompactXp(input.recentXp)}`,
        `📊 Money Progress: ${input.progressBar}`,
        "",
        "Keep earning and climb to the next rank! 🚀",
        "",
        "━━━━━━━━━━━━━━",
      ].join("\n"),
    )
    .setImage(`attachment://${fileName}`);

  return {
    embeds: [embed],
    files: [new AttachmentBuilder(input.card, { name: fileName })],
    allowedMentions: { parse: [], users: [input.userId] },
  };
}
