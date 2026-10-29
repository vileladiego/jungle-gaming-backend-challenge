import { Module } from '@nestjs/common';
import { ApplicationModule } from './application/application.module';
import { DomainModule } from './domain/domain.module';
import { HealthModule } from './health/health.module';
import { MessagingModule } from './messaging/messaging.module';
import { PersistenceModule } from './persistence/persistence.module';

@Module({
  imports: [
    DomainModule,
    ApplicationModule,
    PersistenceModule.register(),
    MessagingModule,
    HealthModule,
  ],
})
export class AppModule {}
