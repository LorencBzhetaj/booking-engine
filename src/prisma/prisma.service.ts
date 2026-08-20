import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

// Thin wrapper so Prisma participates in Nest's lifecycle and can be injected.
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit(): Promise<void> {
    // Non-fatal: if the DB is briefly unreachable at boot, the app still starts
    // and binds its port (avoids an opaque 502). Prisma reconnects on first query.
    try {
      await this.$connect();
      this.logger.log('Connected to the database');
    } catch (e) {
      this.logger.error(
        `Database connect failed at boot (will retry on first query): ${String(e)}`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
