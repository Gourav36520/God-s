import { Events } from "discord.js";
import type { GuildMember } from "discord.js";
import { assignAutoRole } from "../autorole/service.js";
import { sendMemberWelcome } from "../welcome-goodbye/service.js";

export const name = Events.GuildMemberAdd;
export const once = false;

export async function execute(member: GuildMember): Promise<void> {
  await assignAutoRole(member);
  await sendMemberWelcome(member);
}