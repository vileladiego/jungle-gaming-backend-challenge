import { Body, Controller, Get, Inject, Param, Post, Query, Res, UseFilters, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { AuthGuard } from '../auth.guard';
import { OpenWalletService } from '../open-wallet.service';
import { ReconcileWalletService } from '../reconcile-wallet.service';
import { WalletQueryService } from '../wallet-query.service';
import { ApiExceptionFilter } from './api-exception.filter';

@Controller()
@UseGuards(AuthGuard)
@UseFilters(ApiExceptionFilter)
export class WalletsController {
  constructor(
    @Inject(OpenWalletService) private readonly openWallet: OpenWalletService,
    @Inject(WalletQueryService) private readonly queries: WalletQueryService,
    @Inject(ReconcileWalletService) private readonly reconcileWallet: ReconcileWalletService,
  ) {}

  @Post('wallets')
  async create(@Body() body: unknown, @Res() response: Response): Promise<void> {
    const result = await this.openWallet.open(body);
    response.status(result.status).json(result.body);
  }

  @Get('wallets/:walletId')
  async wallet(@Param('walletId') walletId: string, @Res() response: Response): Promise<void> {
    const result = await this.queries.wallet(walletId);
    response.status(result.status).json(result.body);
  }

  @Get('wallets/:walletId/ledger')
  async ledger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor: unknown,
    @Query('limit') limit: unknown,
    @Res() response: Response,
  ): Promise<void> {
    const result = await this.queries.ledger(walletId, cursor, limit);
    response.status(result.status).json(result.body);
  }

  @Post('wallets/:walletId/reconciliation')
  async reconcile(@Param('walletId') walletId: string, @Res() response: Response): Promise<void> {
    const result = await this.reconcileWallet.reconcile(walletId);
    response.status(result.status).json(result.body);
  }
}
