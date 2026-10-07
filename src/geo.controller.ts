import {
  BadRequestException,
  Body,
  Controller,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth } from "@nestjs/swagger";
import { audit, AuthGuard, AuthRequest, Db } from "./core";
import { CustomerLocationDto, MapLinkDto } from "./dto";
import { coordinatesIn, isMapsHost } from "./geo";
@ApiBearerAuth()
@Controller()
@UseGuards(AuthGuard)
export class GeoController {
  constructor(@Inject(Db) private db: Db) {}
  @Patch("customers/:id/location") location(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: CustomerLocationDto,
    @Req() req: AuthRequest,
  ) {
    if ((body.latitude === null) !== (body.longitude === null))
      throw new BadRequestException("Faltan latitud o longitud.");
    return this.db.$transaction(async (tx) => {
      const before = await tx.customer.findUnique({ where: { id } });
      if (!before) throw new NotFoundException("Cliente no encontrado.");
      const after = await tx.customer.update({
        where: { id },
        data: {
          latitude: body.latitude,
          longitude: body.longitude,
          ...(body.address !== undefined
            ? { address: body.address?.trim() || null }
            : {}),
        },
      });
      await audit(tx, req.actor.id, "Customer", id, "LOCATION", before, after);
      return after;
    });
  }
  // Read coordinates from a shared Maps link, following short links.
  @Post("geo/resolve") async resolve(@Body() body: MapLinkDto) {
    const direct = coordinatesIn(body.url);
    if (direct) return direct;
    let url: URL;
    try {
      url = new URL(body.url.trim());
    } catch {
      throw new BadRequestException(
        "Pega un enlace de Google Maps o coordenadas.",
      );
    }
    for (let hop = 0; hop < 5 && isMapsHost(url); hop++) {
      const r = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(5000),
      }).catch(() => null);
      if (!r) break;
      const next = r.headers.get("location");
      const found =
        coordinatesIn(next ?? "") ??
        (next ? null : coordinatesIn(await r.text()));
      if (found) return found;
      if (!next) break;
      url = new URL(next, url);
      const inUrl = coordinatesIn(url.toString());
      if (inUrl) return inUrl;
    }
    throw new BadRequestException(
      "No encontramos la ubicación en ese enlace. Prueba con “Usar mi ubicación” o marcándola en el mapa.",
    );
  }
}
