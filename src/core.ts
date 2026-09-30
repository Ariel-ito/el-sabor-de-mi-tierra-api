import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { Prisma, PrismaClient } from "@prisma/client";
import type { Request } from "express";
import { hashToken } from "./security";
@Injectable()
export class Db extends PrismaClient {}
export type AuthRequest = Request & {
  actor: { id: string; name: string; email: string };
  tokenHash: string;
};
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(Db) private db: Db) {}
  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<AuthRequest>();
    const token = req.headers.authorization?.match(
      /^Bearer ([A-Za-z0-9_-]{43})$/,
    )?.[1];
    if (!token) throw new UnauthorizedException("Sesión requerida");
    const tokenHash = hashToken(token);
    const session = await this.db.session.findUnique({
      where: { tokenHash },
      include: { user: true },
    });
    if (!session || session.expiresAt <= new Date())
      throw new UnauthorizedException("Sesión vencida");
    req.actor = {
      id: session.user.id,
      name: session.user.name,
      email: session.user.email,
    };
    req.tokenHash = tokenHash;
    return true;
  }
}
export async function audit(
  tx: Prisma.TransactionClient,
  actorId: string,
  entityType: string,
  entityId: string,
  action: string,
  before: any,
  after: any,
) {
  await tx.auditLog.create({
    data: {
      actorId,
      entityType,
      entityId,
      action,
      before: before ? JSON.parse(JSON.stringify(before)) : Prisma.JsonNull,
      after: JSON.parse(JSON.stringify(after)),
    },
  });
}
export async function lockRound(tx: Prisma.TransactionClient, id: string) {
  await tx.$queryRaw`SELECT id FROM "Round" WHERE id=${id}::uuid FOR UPDATE`;
  const round = await tx.round.findUnique({ where: { id } });
  if (!round) throw new NotFoundException("Ciclo no encontrado");
  return round;
}
