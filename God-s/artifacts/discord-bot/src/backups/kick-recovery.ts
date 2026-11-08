export type KickInviteStatus =
  | "provided_to_admin"
  | "dm_delivered"
  | "dm_failed";

export interface KickInviteDeliveryResult {
  code: string;
  status: KickInviteStatus;
  deliveredToMember: boolean;
}

export async function createAndDeliverKickInvite(options: {
  delivery: "dm" | "admin";
  createInvite: () => Promise<{ code: string }>;
  sendDirectMessage: (inviteUrl: string) => Promise<void>;
  saveInvite: (
    code: string,
    status: "created" | KickInviteStatus,
    delivered: boolean,
  ) => Promise<void>;
}): Promise<KickInviteDeliveryResult> {
  const invite = await options.createInvite();
  if (!invite.code) {
    throw new Error("Discord did not return an invite code.");
  }

  await options.saveInvite(invite.code, "created", false);
  let status: KickInviteStatus = "provided_to_admin";
  let deliveredToMember = false;
  if (options.delivery === "dm") {
    try {
      await options.sendDirectMessage(`https://discord.gg/${invite.code}`);
      status = "dm_delivered";
      deliveredToMember = true;
    } catch {
      status = "dm_failed";
    }
  }
  await options.saveInvite(invite.code, status, deliveredToMember);
  return { code: invite.code, status, deliveredToMember };
}
