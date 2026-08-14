import { Module } from '@nestjs/common';
import { EmailModule } from '../email/email.module';
import { Beds24Service } from './beds24.service';
import { Beds24SyncService } from './beds24-sync.service';

@Module({
  imports: [EmailModule],
  providers: [Beds24Service, Beds24SyncService],
  exports: [Beds24Service, Beds24SyncService],
})
export class Beds24Module {}
