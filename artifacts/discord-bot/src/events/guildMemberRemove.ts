import { Events } from "discord.js";
import type { GuildMember } from "discord.js";
import { sendMemberGoodbye } from "../welcome-goodbye/service.js";

export const name = Events.GuildMemberRemove;
export const once = false;

export async function execute(member: GuildMember): Promise<void> {
  await sendMemberGoodbye(member);
}