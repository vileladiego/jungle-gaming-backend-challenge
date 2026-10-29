import { CanActivate, Injectable } from '@nestjs/common';

/**
 * Guard no-op (D2). Não está registrado como guard global:
 * /health/live e /health/ready ficam abertos.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}
