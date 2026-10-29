import { Module } from '@nestjs/common';
import { MessagingModule } from '../messaging/messaging.module';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

@Module({
  imports: [MessagingModule],
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
