import { randomBytes } from "node:crypto";
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ModalSubmitInteraction,
} from "discord.js";
import {
  VerificationApiError,
  verificationAdminRequest,
  type VerificationGuildConfig,
} from "./api.js";
import {
  CAPTCHA_CODE_LENGTH,
  generateCaptchaCode,
  hashCaptchaAnswer,
  renderCaptchaPng,
} from "./captcha.js";

const ANSWER_BUTTON_PREFIX = "verification:answer:";
const ANSWER_MODAL_PREFIX = "verification:submit:";
const CHALLENGE_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;

interface ChallengeResponse {
  challengeId: string;
  expiresAt: string;
  maxAttempts: number;
}

interface ChallengeVerificationResponse {
  verified: boolean;
  reason?: "incorrect" | "attempt_limit" | "expired" | "unavailable";
  attemptsRemaining?: number;
  cooldownSeconds?: number;
}

interface ConfigResponse {
  config: VerificationGuildConfig | null;
}

function challengeFromCustomId(customId: string, prefix: string): string | null {
  if (!customId.startsWith(prefix)) return null;
  const challengeId = customId.slice(prefix.length);
  return CHALLENGE_ID_PATTERN.test(challengeId) ? challengeId : null;
}

export function isVerificationButton(customId: string): boolean {
  return (
    customId === "verification:start" ||
    challengeFromCustomId(customId, ANSWER_BUTTON_PREFIX) !== null
  );
}

export function isVerificationModal(customId: string): boolean {
  return challengeFromCustomId(customId, ANSWER_MODAL_PREFIX) !== null;
}

function answerModal(challengeId: string): ModalBuilder {
  const answer = new TextInputBuilder()
    .setCustomId("captcha-answer")
    .setLabel("CAPTCHA code")
    .setPlaceholder("Enter the 6 characters shown")
    .setMinLength(CAPTCHA_CODE_LENGTH)
    .setMaxLength(CAPTCHA_CODE_LENGTH)
    .setRequired(true)
    .setStyle(TextInputStyle.Short);
  return new ModalBuilder()
    .setCustomId(`${ANSWER_MODAL_PREFIX}${challengeId}`)
    .setTitle("Discord verification")
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(answer));
}

async function beginChallenge(interaction: ButtonInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  if (!interaction.guildId || !interaction.channelId) {
    await interaction.editReply("Verification can only start from the configured server channel.");
    return;
  }
  const code = generateCaptchaCode();
  const salt = randomBytes(16).toString("hex");
  try {
    const hmacSecret = process.env.VERIFICATION_BOT_HMAC_SECRET?.trim();
    if (!hmacSecret) {
      throw new Error("Verification is not configured.");
    }
    const challenge = await verificationAdminRequest<ChallengeResponse>(
      interaction.user.id,
      interaction.guildId,
      "challenge:create",
      {
        channelId: interaction.channelId,
        answerHash: hashCaptchaAnswer(salt, code, hmacSecret),
        salt,
      },
    );
    if (
      !CHALLENGE_ID_PATTERN.test(challenge.challengeId) ||
      !Number.isInteger(challenge.maxAttempts) ||
      challenge.maxAttempts < 1 ||
      !Number.isFinite(Date.parse(challenge.expiresAt))
    ) {
      throw new Error("Invalid CAPTCHA challenge response.");
    }

    const imageName = "verification-captcha.png";
    const image = new AttachmentBuilder(renderCaptchaPng(code), {
      name: imageName,
    });
    const enterAnswer = new ButtonBuilder()
      .setCustomId(`${ANSWER_BUTTON_PREFIX}${challenge.challengeId}`)
      .setLabel("Enter code")
      .setStyle(ButtonStyle.Secondary);
    const expiresAt = Math.floor(Date.parse(challenge.expiresAt) / 1000);
    await interaction.editReply({
      content: `Enter the code shown below using the button. This challenge expires <t:${expiresAt}:R> and allows ${challenge.maxAttempts} attempts.`,
      embeds: [
        new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle("Private CAPTCHA")
          .setImage(`attachment://${imageName}`),
      ],
      files: [image],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(enterAnswer),
      ],
    });
  } catch (error) {
    if (error instanceof VerificationApiError && error.status === 429) {
      const seconds = Math.max(1, error.retryAfterSeconds ?? 60);
      await interaction.editReply(
        `Please wait ${seconds} seconds before requesting another verification challenge.`,
      );
      return;
    }
    await interaction.editReply(
      "Verification is temporarily unavailable. Please contact a server moderator.",
    );
  }
}

export async function handleVerificationButton(
  interaction: ButtonInteraction,
): Promise<void> {
  if (interaction.customId === "verification:start") {
    await beginChallenge(interaction);
    return;
  }

  const challengeId = challengeFromCustomId(
    interaction.customId,
    ANSWER_BUTTON_PREFIX,
  );
  if (!challengeId) return;
  await interaction.showModal(answerModal(challengeId));
}

async function finalizeChallenge(
  interaction: ModalSubmitInteraction,
  challengeId: string,
  action: "challenge:complete" | "challenge:fail",
): Promise<void> {
  if (!interaction.guildId) return;
  await verificationAdminRequest(
    interaction.user.id,
    interaction.guildId,
    action,
    { challengeId },
  );
}

async function failRoleGrant(
  interaction: ModalSubmitInteraction,
  challengeId: string,
  message: string,
): Promise<void> {
  try {
    await finalizeChallenge(interaction, challengeId, "challenge:fail");
  } catch {
    // The challenge remains single-use even if this best-effort status update fails.
  }
  await interaction.editReply(message);
}

export async function handleVerificationModal(
  interaction: ModalSubmitInteraction,
): Promise<void> {
  const challengeId = challengeFromCustomId(
    interaction.customId,
    ANSWER_MODAL_PREFIX,
  );
  if (!challengeId) return;
  await interaction.deferReply({ ephemeral: true });
  if (!interaction.guildId || !interaction.guild) {
    await interaction.editReply("Verification must be completed in the server where it started.");
    return;
  }

  let result: ChallengeVerificationResponse;
  try {
    result = await verificationAdminRequest<ChallengeVerificationResponse>(
      interaction.user.id,
      interaction.guildId,
      "challenge:verify",
      {
        challengeId,
        answer: interaction.fields.getTextInputValue("captcha-answer"),
      },
    );
  } catch (error) {
    if (error instanceof VerificationApiError && error.status === 429) {
      await interaction.editReply(
        `Too many attempts. Wait ${Math.max(1, error.retryAfterSeconds ?? 60)} seconds before trying again.`,
      );
      return;
    }
    if (error instanceof VerificationApiError && error.status === 410) {
      await interaction.editReply(
        "This CAPTCHA expired. Click Verify on the server panel to start again.",
      );
      return;
    }
    await interaction.editReply(
      "This challenge is unavailable or has already been used. Start again from the server verification panel.",
    );
    return;
  }

  if (!result.verified) {
    if (result.reason === "expired") {
      await interaction.editReply(
        "This CAPTCHA expired. Click Verify on the server panel to start again.",
      );
      return;
    }
    const remaining = result.attemptsRemaining ?? 0;
    if (remaining < 1) {
      await interaction.editReply(
        `Too many incorrect answers. Wait ${result.cooldownSeconds ?? 60} seconds before starting again.`,
      );
      return;
    }
    const retry = new ButtonBuilder()
      .setCustomId(`${ANSWER_BUTTON_PREFIX}${challengeId}`)
      .setLabel("Try again")
      .setStyle(ButtonStyle.Secondary);
    await interaction.editReply({
      content: `That code was incorrect. ${remaining} attempt(s) remain.`,
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(retry),
      ],
    });
    return;
  }

  try {
    const { config } = await verificationAdminRequest<ConfigResponse>(
      interaction.user.id,
      interaction.guildId,
      "config:get",
    );
    if (!config?.enabled) {
      await failRoleGrant(
        interaction,
        challengeId,
        "Verification passed, but this server's verification configuration is unavailable. Contact an administrator.",
      );
      return;
    }

    const role = await interaction.guild.roles.fetch(config.verifiedRoleId);
    const botMember = await interaction.guild.members.fetchMe();
    if (
      !role ||
      role.guild.id !== interaction.guildId ||
      role.id === interaction.guildId ||
      role.managed ||
      !botMember.permissions.has(PermissionFlagsBits.ManageRoles) ||
      botMember.roles.highest.comparePositionTo(role) <= 0
    ) {
      await failRoleGrant(
        interaction,
        challengeId,
        "Verification passed, but the bot cannot assign the configured role. Contact a server administrator.",
      );
      return;
    }

    const member = await interaction.guild.members.fetch(interaction.user.id);
    await member.roles.add(role, "Completed Discord-native verification CAPTCHA");
    try {
      await finalizeChallenge(interaction, challengeId, "challenge:complete");
    } catch {
      await interaction.editReply(
        `Your verified role ${role} was assigned, but the completion status could not be saved. Contact a server administrator.`,
      );
      return;
    }
    await interaction.editReply(
      `Verification complete. The ${role} role has been assigned.`,
    );
  } catch {
    await failRoleGrant(
      interaction,
      challengeId,
      "Verification could not assign the role because of a Discord or API error. Contact a server administrator.",
    );
  }
}
