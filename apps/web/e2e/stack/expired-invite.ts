import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { StackEnv } from "./stack-env";

/** Inserts an expired member invite for `email` from `ownerId` and returns its code. */
export const plantExpiredInvite = (stack: StackEnv, ownerId: string, email: string): string => {
  const code = randomBytes(18).toString("base64url");
  const dir = mkdtempSync(join(tmpdir(), "movies-e2e-"));
  const file = join(dir, "invites.jsonl");

  const invite = {
    codeHash: createHash("sha256").update(code).digest("hex"),
    email,
    role: "member",
    createdBy: ownerId,
    expiresAt: Date.now() - 86_400_000,
  };

  writeFileSync(file, `${JSON.stringify(invite)}\n`);

  try {
    execFileSync(
      "pnpm",
      ["exec", "convex", "import", "--table", "invites", "--append", "--yes", file],
      {
        cwd: stack.backendDir,
        stdio: "pipe",
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  return code;
};
