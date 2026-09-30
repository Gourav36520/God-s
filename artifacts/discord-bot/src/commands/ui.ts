import { EmbedBuilder } from "discord.js";

export const GODS_EMOJI = {
  logo: "<:Gods_logo:1553644211612553296>",
  security: "<:Gods_security:1553646039339376660>",
  settings: "<:Gods_setting:1553647566061830195>",
  judgment: "<:Judgement:1553680621673521153>",
  heat: "<:Security_heat:1553680339103129640>",
  badWord: "<:security_badword:1553678437191786586>",
  antiLink: "<:security_antilink:1553678253213098014>",
  antiMention: "<:security_antimention:1553678901887369278>",
  antiInvite: "<:security_anti_invite:1553679724637716611>",
} as const;

export const GOLDEN_ARROW = "<a:arrow_arrow_1:1554486982439079966>";

export type EmbedTone = "gold" | "success" | "error" | "warning" | "info";

const TONE_COLORS: Record<EmbedTone, number> = {
  gold: 0xd4af37,
  success: 0x57f287,
  error: 0xed4245,
  warning: 0xfee75c,
  info: 0xd4af37,
};

interface GodsEmbedOptions {
  title: string;
  description: string;
  emoji?: string;
  tone?: EmbedTone;
}

export function createGodsEmbed({
  title,
  description,
  emoji = GODS_EMOJI.logo,
  tone = "gold",
}: GodsEmbedOptions): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(`${emoji} ${title}`)
    .setColor(TONE_COLORS[tone])
    .setDescription(description)
    .setFooter({
      text: "Gods Bot • Your Server's Guardian · Developed by @gourav.s",
    })
    .setTimestamp();
}

export function arrowLine(label: string, value: string): string {
  return `${GOLDEN_ARROW} **${label}:** ${value}`;
}