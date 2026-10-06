import { BadRequestException, ConflictException, Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { ImportJobStatus } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ExcelAdapter } from './adapters/excel.adapter';
import { ConfirmMappingDto } from './dto/confirm-mapping.dto';
import { aliasKey, MappingType, STANDARD_FIELDS } from './mapping-fields';
import { ImportFileStorage } from './storage/import-file.storage';

export interface SavedColumnMapping {
  sourceColumn: string;
  sourceColumnIndex: number;
  type: MappingType;
  target: string | null;
}

@Injectable()
export class MappingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly excel: ExcelAdapter,
    private readonly storage: ImportFileStorage,
  ) {}

  async suggest(importId: string) {
    const { job, analysis } = await this.loadWorkbook(importId);
    const candidates = analysis.headers.map((header) => {
      const matches = STANDARD_FIELDS.filter((field) => (field.aliases as readonly string[]).includes(aliasKey(header)));
      return matches.length === 1 ? matches[0] : null;
    });
    const columns = analysis.headers.map((header, index) => {
      const candidate = candidates[index];
      // If multiple columns would claim a standard target, suggest none of them.
      const uniqueTarget = candidate && candidates.filter((other) => other?.target === candidate.target).length === 1;
      const field = uniqueTarget ? candidate : null;
      const samples = analysis.sampleRows.map((row) => row.values[index])
        .filter((value) => value !== null && value !== undefined && value !== '');
      return {
        sourceColumn: header,
        sourceColumnIndex: index + 1,
        samples: [...new Set(samples)].slice(0, 3),
        suggestedType: field ? MappingType.STANDARD : MappingType.UNMAPPED,
        suggestedTarget: field?.target ?? null,
        displayLabel: field?.displayLabel ?? null,
      };
    });
    return { importId: job.id, status: job.status, columns, mapping: job.mapping };
  }

  async confirm(importId: string, dto: ConfirmMappingDto) {
    const { analysis } = await this.loadWorkbook(importId);
    const mapping: SavedColumnMapping[] = analysis.headers.map((sourceColumn, index) => ({
      sourceColumn, sourceColumnIndex: index + 1, type: MappingType.UNMAPPED, target: null,
    }));
    const sources = new Set<number>();
    const standardTargets = new Set<string>();
    const customTargets = new Set<string>();

    for (const entry of dto.mapping) {
      let index: number;
      if (entry.sourceColumnIndex !== undefined) {
        index = entry.sourceColumnIndex - 1;
        if (analysis.headers[index] !== entry.sourceColumn) {
          throw new BadRequestException('sourceColumnIndex must identify the supplied sourceColumn');
        }
      } else {
        const matches = analysis.headers.flatMap((header, position) => header === entry.sourceColumn ? [position] : []);
        if (entry.sourceColumn === '' || matches.length !== 1) {
          throw new BadRequestException('sourceColumn must match one header; duplicate or blank headers require sourceColumnIndex');
        }
        index = matches[0];
      }
      if (sources.has(index)) throw new BadRequestException('A source column cannot be mapped more than once');
      sources.add(index);

      switch (entry.type) {
        case MappingType.STANDARD:
          if (!STANDARD_FIELDS.some((field) => field.target === entry.target)) {
            throw new BadRequestException('Unknown standard target');
          }
          if (standardTargets.has(entry.target!)) throw new BadRequestException('A standard target cannot be mapped more than once');
          standardTargets.add(entry.target!);
          break;
        case MappingType.ATTRIBUTE:
        case MappingType.VARIANT_ATTRIBUTE: {
          if (typeof entry.target !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(entry.target)
            || ['constructor', 'prototype', '__proto__'].includes(entry.target)) {
            throw new BadRequestException('Attribute targets must be safe lowercase keys of 1 to 64 letters, digits, or underscores, starting with a letter');
          }
          const key = `${entry.type}:${entry.target}`;
          if (customTargets.has(key)) throw new BadRequestException('An attribute key cannot be mapped more than once within its type');
          customTargets.add(key);
          break;
        }
        case MappingType.IGNORE:
        case MappingType.UNMAPPED:
          if (entry.target !== null) throw new BadRequestException('IGNORE and UNMAPPED targets must be null');
          break;
        default:
          throw new BadRequestException('Unknown mapping type');
      }
      mapping[index] = { sourceColumn: entry.sourceColumn, sourceColumnIndex: index + 1, type: entry.type, target: entry.target };
    }
    if (!standardTargets.has('name')) throw new BadRequestException('The name standard field must be mapped before confirmation');

    // Guard the write atomically so a job cannot be remapped after validation starts.
    const result = await this.prisma.importJob.updateMany({
      where: { id: importId, status: ImportJobStatus.MAPPING_REQUIRED },
      data: { mapping: mapping.map((entry) => ({ ...entry })) },
    });
    if (result.count !== 1) throw new ConflictException('The import job is no longer awaiting mapping');
    return { importId, status: ImportJobStatus.MAPPING_REQUIRED, mapping };
  }

  private async loadWorkbook(importId: string) {
    const job = await this.prisma.importJob.findUnique({
      where: { id: importId },
      select: { id: true, status: true, fileKey: true, sheetName: true, headerRow: true, mapping: true },
    });
    if (!job) throw new NotFoundException('Import job not found');
    if (job.status !== ImportJobStatus.MAPPING_REQUIRED) {
      throw new ConflictException('The import job is not awaiting mapping');
    }
    if (!job.fileKey || !job.sheetName || job.headerRow === null) {
      throw new ConflictException('The import job does not have a retained analyzed workbook');
    }
    let buffer: Buffer;
    try {
      buffer = await this.storage.read(job.fileKey);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new ConflictException('The retained workbook is unavailable');
      }
      throw new InternalServerErrorException('Unable to read the retained workbook');
    }
    const analysis = await this.excel.analyze(buffer, job.sheetName, job.headerRow);
    return { job, analysis };
  }
}
