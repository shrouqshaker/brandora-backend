import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { AiSecurity } from './ai-security';

@Injectable()
export class AiInternalGuard implements CanActivate {
  constructor(private readonly security: AiSecurity) {}
  canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest();
    req.aiClaims = this.security.authenticate(
      req.headers.authorization,
      req.headers['x-ai-context'],
    );
    return true;
  }
}
