import { Injectable } from '@nestjs/common';
import type { ProviderIdentity, ProviderIdentityPort } from '../provider-identity.port';

@Injectable()
export class NoopProviderIdentity implements ProviderIdentityPort {
  current(): ProviderIdentity | undefined {
    return undefined;
  }
}
