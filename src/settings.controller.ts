import {
  Body,
  ConflictException,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth } from "@nestjs/swagger";
import { audit, AuthGuard, AuthRequest, Db } from "./core";
import { SettingTextDto } from "./dto";
// Owner-editable texts; only known keys are exposed.
const KEYS = ["paymentInfo"];
@ApiBearerAuth()
@Controller("settings")
@UseGuards(AuthGuard)
export class SettingsController {
  constructor(@Inject(Db) private db: Db) {}
  @Get(":key") async get(@Param("key") key: string) {
    const row = KEYS.includes(key)
      ? await this.db.setting.findUnique({ where: { key } })
      : null;
    if (!row) throw new NotFoundException("Ajuste no encontrado.");
    return row;
  }
  @Patch(":key") async update(
    @Param("key") key: string,
    @Body() body: SettingTextDto,
    @Req() req: AuthRequest,
  ) {
    if (!KEYS.includes(key))
      throw new NotFoundException("Ajuste no encontrado.");
    return this.db.$transaction(async (tx) => {
      const before = await tx.setting.findUnique({ where: { key } });
      if (!before) throw new NotFoundException("Ajuste no encontrado.");
      const changed = await tx.setting.updateMany({
        where: { key, version: body.version },
        data: { value: body.value.trim(), version: { increment: 1 } },
      });
      if (!changed.count)
        throw new ConflictException("Alguien más lo cambió; actualiza antes.");
      const after = await tx.setting.findUniqueOrThrow({ where: { key } });
      await audit(
        tx,
        req.actor.id,
        "Setting",
        "00000000-0000-0000-0000-000000000000",
        `UPDATE:${key}`,
        before,
        after,
      );
      return after;
    });
  }
}
