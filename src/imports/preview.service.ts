import { ConflictException, Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { ImportJobStatus } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ExcelAdapter } from './adapters/excel.adapter';
import { ImportFileStorage } from './storage/import-file.storage';
import { RowValidator } from './validation/row-validator';
import { RowValidationResult } from './validation/row.types';
import { parseSavedMapping } from './validation/saved-mapping';
import { ImportPlanner } from './preview/import-planner';
import { ExistingCatalogItem } from './preview/preview.types';

@Injectable()
export class PreviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: ImportFileStorage,
    private readonly excel: ExcelAdapter,
    private readonly rows: RowValidator,
    private readonly planner: ImportPlanner,
  ) {}

  async generate(importId: string) {
    const job = await this.prisma.importJob.findUnique({
      where: { id: importId },
      select: { id: true, businessId: true, status: true, fileKey: true, sheetName: true, headerRow: true, mapping: true },
    });
    if (!job) throw new NotFoundException('Import job not found');
    if (job.status !== ImportJobStatus.READY) throw new ConflictException('The import job must be READY before preview');
    if (!job.fileKey || !job.sheetName || job.headerRow === null || !Array.isArray(job.mapping) || job.mapping.length === 0) {
      throw new ConflictException('The import job has no retained mapped workbook');
    }
    let validated: RowValidationResult;
    try {
      const workbook = await this.excel.readDataRows(await this.storage.read(job.fileKey), job.sheetName, job.headerRow);
      validated = this.rows.validate(workbook.rows, parseSavedMapping(job.mapping, workbook.headers));
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') throw new ConflictException('The retained workbook is unavailable');
      throw new InternalServerErrorException('Unable to rebuild the import preview from the retained workbook');
    }
    const keys = [...new Set(validated.validRows.flatMap((row) => row.data.externalKey == null ? [] : [row.data.externalKey]))];
    const existing: ExistingCatalogItem[] = [];
    for (let offset = 0; offset < keys.length; offset += 1000) {
      existing.push(...await this.prisma.catalogItem.findMany({
        where: { businessId: job.businessId, externalKey: { in: keys.slice(offset, offset + 1000) } },
        select: { id: true, businessId: true, externalKey: true, name: true, description: true, category: true,
          basePrice: true, stockQuantity: true, attributes: true },
      }));
    }
    const plan = this.planner.plan(job.businessId, validated.validRows, existing);
    return {
      importId: job.id, status: ImportJobStatus.READY,
      summary: { ...validated.summary, willInsert: plan.inserts.length, willUpdate: plan.updates.length, unchanged: plan.unchanged.length },
      ...plan, invalidRows: validated.invalidRows,
    };
  }
}
