import {
  Controller,
  Get,
  Inject,
  ServiceUnavailableException,
} from "@nestjs/common";
import { Db } from "./core";
@Controller("health")
export class HealthController {
  constructor(@Inject(Db) private db: Db) {}
  @Get() health() {
    return { status: "ok" };
  }
  @Get("ready") async ready() {
    try {
      await this.db.$queryRaw`SELECT 1`;
      return { status: "ok" };
    } catch {
      throw new ServiceUnavailableException("Base de datos no disponible");
    }
  }
}
