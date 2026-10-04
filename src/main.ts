import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import helmet from "helmet";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { json } from "express";
import { AppModule } from "./app";
import { Errors } from "./errors";
async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const origins = (process.env.CORS_ORIGINS || "http://localhost:5173")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  if (
    process.env.NODE_ENV === "production" &&
    (!process.env.CORS_ORIGINS || origins.includes("*"))
  )
    throw new Error("Explicit CORS_ORIGINS required in production");
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  app.use(json({ limit: "128kb" }));
  app.use(helmet());
  // Railway's single reverse proxy; localhost development remains untrusted.
  if (process.env.TRUST_PROXY === "1")
    app.getHttpAdapter().getInstance().set("trust proxy", 1);
  app.enableCors({
    origin: origins,
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  });
  app.setGlobalPrefix("api/v1");
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      forbidUnknownValues: true,
    }),
  );
  app.useGlobalFilters(new Errors());
  app.enableShutdownHooks();
  if (process.env.ENABLE_API_DOCS === "true") {
    const config = new DocumentBuilder()
      .setTitle("El Sabor de Mi Tierra API")
      .setVersion("1.0")
      .addBearerAuth()
      .build();
    SwaggerModule.setup(
      "api/docs",
      app,
      SwaggerModule.createDocument(app, config),
    );
  }
  await app.listen(Number(process.env.PORT || 4100), "0.0.0.0");
}
main().catch(() => {
  console.error(
    "API startup failed; check environment and database configuration",
  );
  process.exit(1);
});
