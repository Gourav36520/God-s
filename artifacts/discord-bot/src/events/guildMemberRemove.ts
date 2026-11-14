import { Events } from "discord.js";
import type { GuildMember } from "discord.js";
import { sendMemberGoodbye } from "../welcome-goodbye/service.js";
import { logger } from "../lib/logger.js";
import { memberCardService } from "../member-cards/service.js";
import { levelingService } from "../leveling/service.js";

export const name = Events.GuildMemberRemove;
export const once = false;

export async function execute(member: GuildMember): Promise<void> {
  void memberCardService.markMemberDeparted(member).catch((error) =>
    logger.warn(
      `Could not update stored member cards after ${member.id} left:`,
      error instanceof Error ? error.message : "unknown error",
    ),
  );
  void levelingService.markMemberDeparted(member).catch((error) =>
    logger.warn(
      `Could not save level data after ${member.id} left:`,
      error instanceof Error ? error.message : String(error),
    ),
  );
  await sendMemberGoodbye(member);
}