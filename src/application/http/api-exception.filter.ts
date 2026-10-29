import { Catch, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import { DomainError } from '../../domain/domain-error';
import { classifyPostgresError } from '../../persistence/postgres-error';

/**
 * Erro que escapa do caso de uso. Não grava FAILED.
 * 503 não carrega status terminal. 500 não devolve SQL.
 */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    if (exception instanceof DomainError) {
      const status =
        exception.failureCode === 'INVALID_PAYLOAD' || exception.failureCode === 'REFERENCE_REQUIRED'
          ? 400
          : 422;
      response.status(status).json({ failureCode: exception.failureCode });
      return;
    }
    if (classifyPostgresError(exception).kind === 'transient') {
      response.status(503).json({});
      return;
    }
    response.status(500).json({});
  }
}
