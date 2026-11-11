import { HttpStatus, Injectable } from '@nestjs/common';
import { AppHttpException } from '../common/errors/app-http.exception';
import { ErrorCode } from '../common/errors/error-code';
import { isUniqueViolation } from '../common/database/is-unique-violation';
import { PrismaService } from '../prisma/prisma.service';
import { PutWhatsAppConnectionDto } from './dto/put-whatsapp-connection.dto';

export const connectionSelect = {
  businessId: true,
  phoneNumberId: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} as const;

/** The link "Meta phone_number_id <-> business". The webhook trusts only this. */
@Injectable()
export class WhatsAppConnectionsService {
  constructor(private readonly prisma: PrismaService) {}

  async get(businessId: string) {
    const connection = await this.prisma.whatsAppConnection.findUnique({
      where: { businessId },
      select: connectionSelect,
    });
    if (!connection)
      throw new AppHttpException(
        ErrorCode.WHATSAPP_CONNECTION_NOT_FOUND,
        HttpStatus.NOT_FOUND,
        'This business has no WhatsApp number yet',
      );
    return connection;
  }

  async put(businessId: string, dto: PutWhatsAppConnectionDto) {
    const owner = await this.prisma.whatsAppConnection.findUnique({
      where: { phoneNumberId: dto.phoneNumberId },
      select: { businessId: true },
    });
    if (owner && owner.businessId !== businessId) throw this.inUse();
    const data = {
      phoneNumberId: dto.phoneNumberId,
      ...(dto.isActive === undefined ? {} : { isActive: dto.isActive }),
    };
    try {
      return await this.prisma.whatsAppConnection.upsert({
        where: { businessId },
        create: { businessId, ...data },
        update: data,
        select: connectionSelect,
      });
    } catch (error: unknown) {
      // Another business took the number at the same moment.
      if (isUniqueViolation(error)) throw this.inUse();
      throw error;
    }
  }

  /** Webhook: "this number belongs to which business?" null = nobody (or paused). */
  async activeBusinessFor(phoneNumberId: string): Promise<string | null> {
    const connection = await this.prisma.whatsAppConnection.findUnique({
      where: { phoneNumberId },
      select: { businessId: true, isActive: true },
    });
    return connection?.isActive ? connection.businessId : null;
  }

  private inUse(): AppHttpException {
    return new AppHttpException(
      ErrorCode.WHATSAPP_PHONE_NUMBER_IN_USE,
      HttpStatus.CONFLICT,
      'This WhatsApp number is already linked to another business',
    );
  }
}