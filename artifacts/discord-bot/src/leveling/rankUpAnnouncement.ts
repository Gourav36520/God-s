import { AttachmentBuilder, EmbedBuilder } from "discord.js";
import type { MessageCreateOptions } from "discord.js";
import { formatCompactXp } from "./progression.js";

const GOLD = 0xffd94f;

export function buildLevelingAnnouncementPayload(input: {
  userId: string;
  previousLevel: number;
  currentLevel: number;
  previousClass: string;
  currentClass: string;
  accumulatedXp: bigint;
  progressBar: string;
  card: Buffer;
}): MessageCreateOptions {
  const fileName = `money-${input.userId}.png`;
  const levelUp = input.currentLevel > input.previousLevel;
  const moneyTierUp = input.currentClass !== input.previousClass;
  const title = moneyTierUp
    ? "💰 MONEY UP!"
    : levelUp
      ? "📈 LEVEL UP!"
      : "✨ XP GAIN!";
  const announcementLine = moneyTierUp
    ? `🎉 <@${input.userId}> has ranked up!`
    : levelUp
      ? `🎉 <@${input.userId}> reached a new level!`
      : `🎉 <@${input.userId}> earned XP!`;
  const details = [
    ...(levelUp
      ? [`📈 Level: ${input.previousLevel} ➜ ${input.currentLevel}`]
      : []),
    ...(moneyTierUp
      ? [`${input.previousClass} ➜ ${input.currentClass}`]
      : []),
  ];
  const description = [
    "━━━━━━━━━━━━━━",
    "",
    announcementLine,
    ...details,
    "",
    `💸 Money: ${formatCompactXp(input.accumulatedXp)}`,
    `📊 Money Progress: ${input.progressBar}`,
    "",
    "Keep earning and climb to the next rank! 🚀",
    "",
    "━━━━━━━━━━━━━━",
  ].join("\n");
  const embed = new EmbedBuilder()
    .setColor(GOLD)
    .setTitle(title)
    .setDescription(description)
    .setImage(`attachment://${fileName}`);

  return {
    embeds: [embed],
    files: [new AttachmentBuilder(input.card, { name: fileName })],
    allowedMentions: { parse: [], users: [input.userId] },
  };
}
