import assert from "node:assert/strict";
import test from "node:test";
import { securityManager } from "../lib/registry.js";
import { isJudgmentReactionRoleMutationBlocked } from "./service.js";

test("reaction roles cannot grant Judgment or mutate roles for an active member", () => {
  const originalGetConfig = securityManager.getConfig;
  securityManager.getConfig = (() =>
    ({
      godsJudgment: {
        judgmentRoleId: "judgment-role",
        activeJudgments: {
          "punished-user": { userId: "punished-user" },
        },
      },
    }) as unknown as ReturnType<typeof securityManager.getConfig>) as unknown as
    typeof securityManager.getConfig;

  try {
    assert.equal(
      isJudgmentReactionRoleMutationBlocked(
        "guild",
        "ordinary-user",
        "judgment-role",
      ),
      true,
    );
    assert.equal(
      isJudgmentReactionRoleMutationBlocked(
        "guild",
        "punished-user",
        "ordinary-role",
      ),
      true,
    );
    assert.equal(
      isJudgmentReactionRoleMutationBlocked(
        "guild",
        "ordinary-user",
        "ordinary-role",
      ),
      false,
    );
  } finally {
    securityManager.getConfig = originalGetConfig;
  }
});
