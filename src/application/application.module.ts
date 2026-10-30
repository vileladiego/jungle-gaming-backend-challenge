import { Module } from '@nestjs/common';
import { MessagingModule } from '../messaging/messaging.module';
import { AuthGuard } from './auth.guard';
import { NoopProviderIdentity } from './messaging/noop-provider-identity';
import { OutboxPublisher } from './messaging/outbox-publisher';
import { PendingReferenceWorker } from './messaging/pending-reference-worker';
import { ProcessingMetrics } from './messaging/processing-metrics';
import { PROVIDER_IDENTITY, SqsWagerConsumer } from './messaging/sqs-wager-consumer';
import { OpenWalletService } from './open-wallet.service';
import { ReconcileWalletService } from './reconcile-wallet.service';
import { SubmitWagerService } from './submit-wager.service';
import { WalletQueryService } from './wallet-query.service';
import { WageringController } from './http/wagering.controller';
import { WalletsController } from './http/wallets.controller';

@Module({
  imports: [MessagingModule],
  controllers: [WalletsController, WageringController],
  providers: [
    AuthGuard,
    OpenWalletService,
    SubmitWagerService,
    WalletQueryService,
    ReconcileWalletService,
    ProcessingMetrics,
    SqsWagerConsumer,
    OutboxPublisher,
    PendingReferenceWorker,
    { provide: PROVIDER_IDENTITY, useClass: NoopProviderIdentity },
  ],
  exports: [AuthGuard, SqsWagerConsumer, OutboxPublisher, PendingReferenceWorker, ProcessingMetrics],
})
export class ApplicationModule {}
