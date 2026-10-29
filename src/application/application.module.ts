import { Module } from '@nestjs/common';
import { AuthGuard } from './auth.guard';
import { OpenWalletService } from './open-wallet.service';
import { ReconcileWalletService } from './reconcile-wallet.service';
import { SubmitWagerService } from './submit-wager.service';
import { WalletQueryService } from './wallet-query.service';
import { WageringController } from './http/wagering.controller';
import { WalletsController } from './http/wallets.controller';

@Module({
  controllers: [WalletsController, WageringController],
  providers: [AuthGuard, OpenWalletService, SubmitWagerService, WalletQueryService, ReconcileWalletService],
  exports: [AuthGuard],
})
export class ApplicationModule {}
