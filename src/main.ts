import { config } from 'dotenv';
config(); // ensure DATABASE_URL is in process.env before Prisma instantiates

import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { configureApp } from './setup-app';

async function bootstrap() {
  // rawBody: true keeps the untouched request body on req.rawBody so the PayPal
  // webhook can verify the signature (JSON body-parsing would otherwise corrupt it).
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
  });
  configureApp(app);

  // Enable CORS so the gjecaj.al frontend (and others) can call the API from
  // the browser if ever needed; the BFF proxy is same-origin, but this is safe.
  app.enableCors();

  const port = process.env.PORT ?? 3001;
  // Bind 0.0.0.0 so container/PaaS hosts (Render, Railway, Fly) can route to it.
  await app.listen(port, '0.0.0.0');
  // eslint-disable-next-line no-console
  console.log(`Gjecaj booking engine listening on port ${port}`);
}

void bootstrap();
