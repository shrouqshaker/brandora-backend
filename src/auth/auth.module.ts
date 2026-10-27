import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AuthRateGuard } from './auth-rate.guard';
import { AuthService } from './auth.service';
import { jwtConfig } from './auth-config';
import { AuthSessionsService } from './auth-sessions.service';
import { AuthRateStore, PostgresAuthRateStore } from './auth-rate.store';
import {
  PasswordResetMailer,
  SmtpPasswordResetMailer,
} from './password-reset.mailer';
import { AuthRetryInterceptor } from './auth-retry.interceptor';

@Module({
  imports: [
    PrismaModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: jwtConfig,
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    AuthSessionsService,
    AuthRetryInterceptor,
    { provide: AuthRateStore, useClass: PostgresAuthRateStore },
    { provide: PasswordResetMailer, useClass: SmtpPasswordResetMailer },
    AuthRateGuard,
    AuthGuard,
    { provide: APP_GUARD, useExisting: AuthGuard },
  ],
})
export class AuthModule {}
