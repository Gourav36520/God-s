import { Collection } from "discord.js";
import type {
  ChatInputCommandInteraction,
  Message,
  SharedSlashCommand,
} from "discord.js";
import { SecurityManager } from "../security/SecurityManager.js";
import { LoggingService } from "../logging/LoggingService.js";

export interface Command {
  data: SharedSlashCommand;
  execute(interaction: ChatInputCommandInteraction): Promise<void>;
  executePrefix?(message: Message, args: string[]): Promise<void>;
}

export const commands = new Collection<string, Command>();

export const securityManager = new SecurityManager();
export const loggingService = new LoggingService();
