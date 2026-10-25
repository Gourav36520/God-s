import type { ButtonInteraction } from "discord.js";
import {
  createVerificationLink,
  VERIFICATION_BUTTON_ID,
} from "./api.js";

export function isVerificationButton(customId: string): boolean {
  return customId === VERIFICATION_BUTTON_ID;
}

export async function handleVerificationButton(
  interaction: ButtonInteraction,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  if (!interaction.guildId) {
    await interaction.editReply("Verification can only be started from a server.");
    return;
  }

  try {
    const verificationUrl = await createVerificationLink(
      interaction.user.id,
      interaction.guildId,
    );
    await interaction.editReply(
      `Your private verification link expires in 15 minutes:\n${verificationUrl}`,
    );
  } catch {
    await interaction.editReply(
      "Verification is temporarily unavailable. Please contact a server moderator.",
    );
  }
}
