import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';

/**
 * Ponto de extensão da autenticação (ver ARCHITECTURE.md §14).
 *
 * Desenho pensado: o provedor se autentica com OAuth2 client-credentials num IdP
 * externo (Keycloak/Zitadel); o guard valida o JWT pelo JWKS do IdP e descobre a
 * identidade do provedor. Aí o controller exige
 * `identity.providerId === body.providerId` (provedor só mexe nas próprias
 * transações) — as validações de domínio continuam iguais.
 *
 * O adaptador padrão confia em todo mundo, por isso o nome diz exatamente o que ele faz.
 */
export interface ProviderIdentity {
  /** `undefined` = anônimo/confiável: nenhuma restrição de provedor é aplicada. */
  providerId?: string;
}

export interface ProviderIdentityPort {
  resolve(headers: Record<string, string | string[] | undefined>): Promise<ProviderIdentity | null>;
}

export const PROVIDER_IDENTITY_PORT = Symbol('PROVIDER_IDENTITY_PORT');

export class TrustAllProviderIdentity implements ProviderIdentityPort {
  async resolve(): Promise<ProviderIdentity> {
    return {};
  }
}

@Injectable()
export class ProviderAuthGuard implements CanActivate {
  constructor(@Inject(PROVIDER_IDENTITY_PORT) private readonly identities: ProviderIdentityPort) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{ headers: Record<string, string>; providerIdentity?: ProviderIdentity }>();
    const identity = await this.identities.resolve(request.headers);
    if (!identity) return false;
    request.providerIdentity = identity;
    return true;
  }
}
