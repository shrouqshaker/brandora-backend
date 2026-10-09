import { HttpStatus, Injectable } from '@nestjs/common';
import { AppHttpException } from '../common/errors/app-http.exception';
import { ErrorCode } from '../common/errors/error-code';
import { PrismaService } from '../prisma/prisma.service';
import { DayOfWeek, Prisma } from '../generated/prisma/client';
import { UpdateBusinessDto } from './dto/update-business.dto';
import { UpdateBusinessSettingsDto } from './dto/update-business-settings.dto';
import { PutWorkingHoursDto } from './dto/put-working-hours.dto';

const profileSelect = {
  id: true,
  name: true,
  description: true,
  category: true,
  phone: true,
  address: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.BusinessSelect;
const settingsSelect = {
  businessId: true,
  acceptsCash: true,
  acceptsOnlinePayment: true,
  deliveryEnabled: true,
  pickupEnabled: true,
} satisfies Prisma.BusinessSettingsSelect;
const settingsDefaults = {
  acceptsCash: true,
  acceptsOnlinePayment: false,
  deliveryEnabled: false,
  pickupEnabled: true,
};
const weekdays = Object.values(DayOfWeek);

@Injectable()
export class BusinessesService {
  constructor(private readonly prisma: PrismaService) {}

  async get(id: string) {
    const business = await this.prisma.business.findUnique({
      where: { id },
      select: profileSelect,
    });
    if (!business) this.notFound();
    return business;
  }

  private async requireBusiness(id: string) {
    if (
      !(await this.prisma.business.findUnique({
        where: { id },
        select: { id: true },
      }))
    )
      this.notFound();
  }

  async update(id: string, dto: UpdateBusinessDto) {
    const data = this.provided(dto, [
      'name',
      'description',
      'category',
      'phone',
      'address',
    ]);
    this.requirePatch(data);
    try {
      return await this.prisma.business.update({
        where: { id },
        data,
        select: profileSelect,
      });
    } catch (error) {
      this.handleMissing(error);
    }
  }

  async settings(id: string) {
    await this.requireBusiness(id);
    return (
      (await this.prisma.businessSettings.findUnique({
        where: { businessId: id },
        select: settingsSelect,
      })) ?? { businessId: id, ...settingsDefaults }
    );
  }

  async updateSettings(id: string, dto: UpdateBusinessSettingsDto) {
    const data = this.provided(dto, Object.keys(settingsDefaults));
    this.requirePatch(data);
    await this.requireBusiness(id);
    try {
      return await this.prisma.businessSettings.upsert({
        where: { businessId: id },
        create: { businessId: id, ...settingsDefaults, ...data },
        update: data,
        select: settingsSelect,
      });
    } catch (error) {
      this.handleMissing(error);
    }
  }

  async hours(id: string) {
    await this.requireBusiness(id);
    return this.prisma.workingHour.findMany({
      where: { businessId: id },
      orderBy: { dayOfWeek: 'asc' },
    });
  }

  async putHours(id: string, dto: PutWorkingHoursDto) {
    for (const day of dto.days) {
      if (
        day.isOpen &&
        (!day.opensAt || !day.closesAt || day.closesAt <= day.opensAt)
      )
        this.invalid(
          'Open days require opensAt < closesAt in HH:mm format; overnight hours are unsupported',
        );
      if (!day.isOpen && (day.opensAt != null || day.closesAt != null))
        this.invalid(
          'Closed days must omit opening and closing times or set them to null',
        );
    }
    await this.requireBusiness(id);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const schedule = [];
        for (const dayOfWeek of weekdays) {
          const day = dto.days.find((day) => day.dayOfWeek === dayOfWeek)!;
          const data = {
            isOpen: day.isOpen,
            opensAt: day.opensAt ?? null,
            closesAt: day.closesAt ?? null,
          };
          schedule.push(
            await tx.workingHour.upsert({
              where: { businessId_dayOfWeek: { businessId: id, dayOfWeek } },
              create: { businessId: id, dayOfWeek, ...data },
              update: data,
            }),
          );
        }
        return schedule;
      });
    } catch (error) {
      this.handleMissing(error);
    }
  }

  private provided(dto: object, fields: string[]) {
    return Object.fromEntries(
      fields
        .filter((key) => (dto as Record<string, unknown>)[key] !== undefined)
        .map((key) => [key, (dto as Record<string, unknown>)[key]]),
    );
  }
  private requirePatch(data: object) {
    if (!Object.keys(data).length)
      this.invalid('At least one editable field must be supplied');
  }
  private invalid(message: string): never {
    throw new AppHttpException(
      ErrorCode.VALIDATION_ERROR,
      HttpStatus.BAD_REQUEST,
      message,
    );
  }
  private notFound(): never {
    throw new AppHttpException(
      ErrorCode.BUSINESS_NOT_FOUND,
      HttpStatus.NOT_FOUND,
      'Business not found',
    );
  }
  private handleMissing(error: unknown): never {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      ['P2025', 'P2003'].includes(error.code)
    )
      this.notFound();
    throw error;
  }
}
