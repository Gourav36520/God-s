import { Collection } from "discord.js";
import type { ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";
import { SecurityManager } from "../security/SecurityManager.js";
import { LoggingService } from "../logging/LoggingService.js";

export interface Command {
  data: SlashCommandBuilder;
  execute(interaction: ChatInputCommandInteraction): Promise<void>;
}

export const commands = new Collection<string, Command>();

export const securityManager = new SecurityManager();
export const loggingService = new LoggingService();
