import type { ChatInputCommandInteraction } from "discord.js";
import { createGreetingCommand, executeGreetingCommand } from "./greeting-command.js";

export const data = createGreetingCommand("goodbye");

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  await executeGreetingCommand("goodbye", interaction);
}