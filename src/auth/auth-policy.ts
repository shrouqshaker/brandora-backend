import {
  createParamDecorator,
  ExecutionContext,
  SetMetadata,
} from '@nestjs/common';

export type Scope =
  'public' | 'identity' | 'params' | 'query' | 'body' | 'import';
export const AUTH_SCOPE = 'brandora:auth-scope';
export const AuthScope = (scope: Scope) => SetMetadata(AUTH_SCOPE, scope);
export interface Identity {
  id: string;
  sessionId?: string;
}
export interface AuthRequest {
  headers: {
    authorization?: string;
    [name: string]: string | string[] | undefined;
  };
  params: Record<string, unknown>;
  query: Record<string, unknown>;
  body?: Record<string, unknown>;
  socket: { remoteAddress?: string };
  user?: Identity;
}
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Identity =>
    context.switchToHttp().getRequest<AuthRequest>().user!,
);
