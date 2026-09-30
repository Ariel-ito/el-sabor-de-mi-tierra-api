import { Catch, ExceptionFilter, HttpException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
@Catch()
export class Errors implements ExceptionFilter {
  catch(error: any, host: any) {
    const res = host.switchToHttp().getResponse();
    if (error?.type === "entity.parse.failed")
      return res
        .status(400)
        .json({ statusCode: 400, message: "JSON inválido" });
    if (error?.type === "entity.too.large")
      return res
        .status(413)
        .json({ statusCode: 413, message: "Solicitud demasiado grande" });
    if (error instanceof HttpException) {
      return res
        .status(error.getStatus())
        .json(
          typeof error.getResponse() === "string"
            ? { statusCode: error.getStatus(), message: error.message }
            : error.getResponse(),
        );
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      const status =
        error.code === "P2025" ? 404 : error.code === "P2003" ? 400 : 409;
      return res.status(status).json({
        statusCode: status,
        message:
          status === 404
            ? "Registro no encontrado"
            : status === 400
              ? "Referencia a un registro inexistente"
              : "Conflicto al guardar; actualiza y vuelve a intentar",
      });
    }
    console.error("Request failed", error?.name);
    res
      .status(500)
      .json({ statusCode: 500, message: "Error interno del servidor" });
  }
}
