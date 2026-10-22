import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpException,
  Inject,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import { audit, AuthGuard, AuthRequest, Db } from "./core";
import { LoginDto, PasswordDto } from "./dto";
import { hashPassword, hashToken, newToken, verifyPassword } from "./security";
@Controller("auth")
export class AuthController {
  private attempts = new Map<string, { count: number; until: number }>();
  private dummy = hashPassword("not-a-real-user-password");
  constructor(@Inject(Db) private db: Db) {}
  @Post("login") async login(@Body() input: LoginDto, @Req() req: Request) {
    const now = Date.now();
    for (const [k, v] of this.attempts)
      if (v.until < now) this.attempts.delete(k);
    const keys = [`ip:${req.ip}`, `email:${input.email.toLowerCase().trim()}`];
    for (const key of keys) {
      const a = this.attempts.get(key) || {
        count: 0,
        until: now + 15 * 60 * 1000,
      };
      if (a.count >= 10)
        throw new HttpException("Demasiados intentos; espera 15 minutos", 429);
      a.count++;
      this.attempts.set(key, a);
    }
    const user = await this.db.user.findUnique({
      where: { email: input.email.toLowerCase().trim() },
    });
    const valid = await verifyPassword(
      input.password,
      user?.passwordHash || (await this.dummy),
    );
    if (!user || !valid)
      throw new UnauthorizedException("Correo o contraseña incorrectos");
    const accessToken = newToken(),
      expiresAt = new Date(now + 8 * 60 * 60 * 1000);
    await this.db.session.create({
      data: { userId: user.id, tokenHash: hashToken(accessToken), expiresAt },
    });
    return {
      accessToken,
      expiresAt,
      user: { id: user.id, name: user.name, email: user.email },
    };
  }
  @Get("me") @UseGuards(AuthGuard) me(@Req() req: AuthRequest) {
    return req.actor;
  }
  // A new password closes every other session of the same person.
  @Post("password") @UseGuards(AuthGuard) async password(
    @Body() input: PasswordDto,
    @Req() req: AuthRequest,
  ) {
    const now = Date.now(),
      key = `password:${req.actor.id}`;
    const a = this.attempts.get(key);
    if (a && a.until > now && a.count >= 10)
      throw new HttpException("Demasiados intentos; espera 15 minutos", 429);
    const user = await this.db.user.findUniqueOrThrow({
      where: { id: req.actor.id },
    });
    if (!(await verifyPassword(input.currentPassword, user.passwordHash))) {
      this.attempts.set(key, {
        count: (a && a.until > now ? a.count : 0) + 1,
        until: a && a.until > now ? a.until : now + 15 * 60 * 1000,
      });
      throw new BadRequestException("La contraseña actual no es correcta.");
    }
    if (input.newPassword.length < 10)
      throw new BadRequestException(
        "La nueva contraseña debe tener al menos 10 caracteres.",
      );
    if (input.newPassword === input.currentPassword)
      throw new BadRequestException(
        "La nueva contraseña debe ser distinta de la actual.",
      );
    const passwordHash = await hashPassword(input.newPassword);
    await this.db.$transaction(async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { passwordHash } });
      await tx.session.deleteMany({
        where: { userId: user.id, tokenHash: { not: req.tokenHash } },
      });
      await audit(tx, user.id, "User", user.id, "PASSWORD", null, {
        changed: true,
      });
    });
    this.attempts.delete(key);
    return { ok: true };
  }
  @Post("logout") @UseGuards(AuthGuard) async logout(@Req() req: AuthRequest) {
    await this.db.session.deleteMany({ where: { tokenHash: req.tokenHash } });
    return { ok: true };
  }
}
