import { Events } from "discord.js";
import type { GuildMember } from "discord.js";
import { assignAutoRole } from "../autorole/service.js";
import { sendMemberWelcome } from "../welcome-goodbye/service.js";
import { logger } from "../lib/logger.js";
import { inviteTracker } from "../trackers/invite-tracker.js";

export const name = Events.GuildMemberAdd;
export const once = false;

export async function execute(member: GuildMember): Promise<void> {
  void inviteTracker.recordJoin(member).catch((error: unknown) => {
    logger.error(
      `Invite tracking failed for member ${member.id}: ${
        error instanceof Error ? error.stack ?? error.message : String(error)
      }`,
    );
  });
  await assignAutoRole(member);
  await sendMemberWelcome(member);
}