import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../src/security";
async function main() {
  const { USER_EMAIL, USER_NAME, USER_PASSWORD } = process.env;
  if (
    !USER_EMAIL ||
    !USER_NAME ||
    !USER_PASSWORD ||
    USER_PASSWORD.length < 8 ||
    USER_PASSWORD.length > 256
  )
    throw new Error(
      "Set USER_EMAIL, USER_NAME and USER_PASSWORD (8–256 characters) in environment. Never pass password in arguments.",
    );
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(USER_EMAIL))
    throw new Error("Invalid email");
  const db = new PrismaClient();
  try {
    const existing = await db.user.findUnique({ where: { email: USER_EMAIL.toLowerCase().trim() } });
    if (existing && process.env.BOOTSTRAP_ADMIN === "1") {
      console.log("Initial user already exists; credentials unchanged.");
      return;
    }
    await db.user.create({
      data: {
        email: USER_EMAIL.toLowerCase().trim(),
        name: USER_NAME,
        passwordHash: await hashPassword(USER_PASSWORD),
      },
    });
    console.log("User created. No public registration is available.");
  } finally {
    await db.$disconnect();
  }
}
main().catch(() => {
  console.error(
    "User could not be created. Check environment, database and duplicate email.",
  );
  process.exitCode = 1;
});
