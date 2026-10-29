import { Body, Controller, Get, Headers, Inject, Param, Post, Res, UseFilters, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { AuthGuard } from '../auth.guard';
import { SubmitWagerService } from '../submit-wager.service';
import { WalletQueryService } from '../wallet-query.service';
import { ApiExceptionFilter } from './api-exception.filter';

@Controller()
@UseGuards(AuthGuard)
@UseFilters(ApiExceptionFilter)
export class WageringController {
  constructor(
    @Inject(SubmitWagerService) private readonly submitWager: SubmitWagerService,
    @Inject(WalletQueryService) private readonly queries: WalletQueryService,
  ) {}

  @Post('wagering/transactions')
  async submit(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: unknown,
    @Res() response: Response,
  ): Promise<void> {
    const result = await this.submitWager.submit(body, idempotencyKey);
    response.status(result.status).json(result.body);
  }

  @Get('wagering/transactions/:transactionId')
  async byId(@Param('transactionId') transactionId: string, @Res() response: Response): Promise<void> {
    const result = await this.queries.transaction(transactionId);
    response.status(result.status).json(result.body);
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async byExternal(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
    @Res() response: Response,
  ): Promise<void> {
    const result = await this.queries.transactionByExternal(providerId, externalTransactionId);
    response.status(result.status).json(result.body);
  }
}
