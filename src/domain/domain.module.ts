import { Module } from '@nestjs/common';

/**
 * Composição Nest. As classes financeiras não importam este módulo:
 * Money, Wallet, ledger e transação ficam sem NestJS e sem MikroORM.
 */
@Module({})
export class DomainModule {}
