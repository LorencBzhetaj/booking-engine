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

  onModuleInit(): void {
    // Fire-and-forget: never block Nest bootstrap on the DB, so the app binds
    // its port immediately (critical on free-tier cold starts). Prisma also
    // connects lazily on the first query, so this is just an early warm-up.
    this.$connect()
      .then(() => this.logger.log('Connected to the database'))
      .catch((e) =>
        this.logger.error(
          `DB connect at boot failed (will retry on first query): ${String(e)}`,
        ),
      );
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
