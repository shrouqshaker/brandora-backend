import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { AuthScope, CurrentUser, Identity } from './auth-policy';
import { AuthRateGuard } from './auth-rate.guard';
import { AuthService } from './auth.service';
import {
  LoginDto,
  RegisterDto,
  RefreshTokenDto,
  ForgotPasswordDto,
  ResetPasswordDto,
  EmptyAuthDto,
} from './auth.dto';
import { AuthSessionsService } from './auth-sessions.service';
import { AuthRetryInterceptor } from './auth-retry.interceptor';

@Controller('auth')
@UseInterceptors(AuthRetryInterceptor)
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: AuthSessionsService,
  ) {}
  @Post('register')
  @AuthScope('public')
  @UseGuards(AuthRateGuard)
  register(@Body() dto: RegisterDto) {
    return this.auth.register(dto);
  }
  @Post('login')
  @HttpCode(200)
  @AuthScope('public')
  @UseGuards(AuthRateGuard)
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto);
  }
  @Get('me')
  @AuthScope('identity')
  me(@CurrentUser() user: Identity) {
    return this.auth.me(user.id);
  }
  @Post('refresh')
  @HttpCode(200)
  @AuthScope('public')
  @UseGuards(AuthRateGuard)
  refresh(@Body() dto: RefreshTokenDto) {
    return this.sessions.refresh(dto.refreshToken);
  }
  @Post('logout')
  @HttpCode(204)
  @AuthScope('public')
  @UseGuards(AuthRateGuard)
  logout(@Body() dto: RefreshTokenDto) {
    return this.sessions.logout(dto.refreshToken);
  }
  @Post('logout-all')
  @HttpCode(204)
  @AuthScope('identity')
  logoutAll(@CurrentUser() user: Identity, @Body() _dto: EmptyAuthDto) {
    return this.sessions.logoutAll(user.id);
  }
  @Post('forgot-password')
  @HttpCode(200)
  @AuthScope('public')
  @UseGuards(AuthRateGuard)
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.auth.forgotPassword(dto);
  }
  @Post('reset-password')
  @HttpCode(204)
  @AuthScope('public')
  @UseGuards(AuthRateGuard)
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.auth.resetPassword(dto);
  }
}
