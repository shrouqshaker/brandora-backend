import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ExcelAdapter } from './adapters/excel.adapter';
import { ImportsController } from './imports.controller';
import { ImportsService } from './imports.service';
import { ImportFileStorage } from './storage/import-file.storage';
import { LocalImportFileStorage } from './storage/local-import-file.storage';
import { MappingController } from './mapping.controller';
import { MappingService } from './mapping.service';
import { ValidationController } from './validation.controller';
import { ValidationService } from './validation.service';
import { RowNormalizer } from './validation/row-normalizer';
import { RowValidator } from './validation/row-validator';
import { PreviewController } from './preview.controller';
import { PreviewService } from './preview.service';
import { ImportPlanner } from './preview/import-planner';
import { InventoryModule } from '../inventory/inventory.module';
import { ExecutionController } from './execution.controller';
import { ExecutionService } from './execution.service';

@Module({
  imports: [PrismaModule, InventoryModule],
  controllers: [ImportsController, MappingController, ValidationController, PreviewController, ExecutionController],
  providers: [
    ImportsService,
    ExcelAdapter,
    MappingService,
    ValidationService,
    RowNormalizer,
    RowValidator,
    PreviewService,
    ImportPlanner,
    ExecutionService,
    LocalImportFileStorage,
    { provide: ImportFileStorage, useExisting: LocalImportFileStorage },
  ],
})
export class ImportsModule {}
