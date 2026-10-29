/**
 * Ponto de extensão do IdP (D2). A Fase 1 não autentica.
 * Quem implementar o IdP preenche o providerId; a validação de domínio
 * do corpo da aposta não passa por esta porta.
 */
export interface ProviderIdentity {
  readonly providerId: string;
}

export interface ProviderIdentityPort {
  current(): ProviderIdentity | undefined;
}
