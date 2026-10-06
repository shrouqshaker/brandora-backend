import { BadRequestException, Injectable } from '@nestjs/common';
import { Cell, Row, Workbook } from 'exceljs';
import { extname } from 'node:path';

export type ExcelValue = string | number | boolean | null;

export interface ExcelDataRow {
  rowNumber: number;
  values: ExcelValue[];
  isEmpty: boolean;
}

export interface ExcelAnalysis {
  sheetNames: string[];
  selectedSheetName: string;
  headerRow: number;
  headers: string[];
  sampleRows: { rowNumber: number; values: ExcelValue[] }[];
  totalRows: number;
}

@Injectable()
export class ExcelAdapter {
  async readDataRows(buffer: Buffer, sheetName: string, headerRow: number): Promise<{ headers: string[]; rows: ExcelDataRow[] }> {
    const workbook = new Workbook();
    await workbook.xlsx.load(Uint8Array.from(buffer).buffer);
    const sheet = workbook.getWorksheet(sheetName);
    if (!sheet || !Number.isInteger(headerRow) || headerRow < 1 || headerRow > sheet.rowCount
      || !sheet.getRow(headerRow).hasValues) throw new Error('Saved sheet or header row is unavailable');
    const header = sheet.getRow(headerRow);
    const headers = Array.from({ length: header.cellCount }, (_, index) => header.getCell(index + 1).text.trim());
    const rows: ExcelDataRow[] = [];
    for (let rowNumber = headerRow + 1; rowNumber <= sheet.rowCount; rowNumber++) {
      const row = sheet.getRow(rowNumber);
      let isEmpty = true;
      row.eachCell((cell) => {
        const value = this.cellValue(cell);
        if (value !== null && (typeof value !== 'string' || value.trim() !== '')) isEmpty = false;
        // A formula without a cached result is still a populated Excel cell.
        if (cell.value && typeof cell.value === 'object' && ('formula' in cell.value || 'sharedFormula' in cell.value)) isEmpty = false;
      });
      rows.push({ rowNumber, isEmpty, values: headers.map((_header, index) => this.cellValue(row.getCell(index + 1))) });
    }
    return { headers, rows };
  }

  validateUpload(file: Express.Multer.File | undefined): Express.Multer.File {
    if (!file) throw new BadRequestException('An .xlsx file is required in the file field');
    if (extname(file.originalname).toLowerCase() !== '.xlsx') {
      throw new BadRequestException('Only .xlsx files are supported');
    }
    if (!file.buffer || file.buffer.length < 4 || file.buffer.readUInt32LE(0) !== 0x04034b50) {
      throw new BadRequestException('The file is not a valid .xlsx workbook');
    }
    return file;
  }

  async analyze(buffer: Buffer, sheetName?: string, headerRow?: number): Promise<ExcelAnalysis> {
    const workbook = new Workbook();
    try {
      await workbook.xlsx.load(Uint8Array.from(buffer).buffer);
    } catch {
      throw new BadRequestException('The file is not a readable .xlsx workbook');
    }
    const sheetNames = workbook.worksheets.map((sheet) => sheet.name);
    const sheet = sheetName === undefined ? workbook.worksheets[0] : workbook.getWorksheet(sheetName);
    if (!sheet) throw new BadRequestException('The requested sheet does not exist or the workbook has no sheets');

    // Skip blank rows and title rows. Prefer the first row with at least two
    // textual cells in the first 50 rows; fall back to the first non-empty row.
    let firstRow: Row | undefined;
    let header: Row | undefined;
    if (headerRow !== undefined) {
      if (!Number.isInteger(headerRow) || headerRow < 1 || headerRow > sheet.rowCount) {
        throw new BadRequestException('The saved header row is not present in the selected sheet');
      }
      header = sheet.getRow(headerRow);
      if (!header.hasValues) throw new BadRequestException('The saved header row is empty');
    }
    for (let index = 1; header === undefined && index <= Math.min(sheet.rowCount, 50); index++) {
      const row = sheet.getRow(index);
      let nonEmpty = 0;
      let textCells = 0;
      row.eachCell((cell) => {
        const value = this.cellValue(cell);
        if (value !== null && value !== '') nonEmpty++;
        if (typeof value === 'string' && value.trim() !== '') textCells++;
      });
      if (nonEmpty === 0) continue;
      firstRow ??= row;
      if (textCells >= 2) { header = row; break; }
    }
    header ??= firstRow;
    if (!header) throw new BadRequestException('The selected sheet has no header within its first 50 rows');

    const headers = Array.from({ length: header.cellCount }, (_, index) => header!.getCell(index + 1).text.trim());
    const sampleRows: ExcelAnalysis['sampleRows'] = [];
    let totalRows = 0;
    sheet.eachRow((row, rowNumber) => {
      if (rowNumber <= header!.number) return;
      const values = headers.map((_name, index) => this.cellValue(row.getCell(index + 1)));
      if (values.every((value) => value === null || value === '')) return;
      totalRows++;
      if (sampleRows.length < 5) sampleRows.push({ rowNumber, values });
    });
    return { sheetNames, selectedSheetName: sheet.name, headerRow: header.number, headers, sampleRows, totalRows };
  }

  private cellValue(cell: Cell): ExcelValue {
    const value = cell.value;
    if (value === null || value === undefined) return null;
    if (value instanceof Date) return value.toISOString();
    if (typeof value !== 'object') return value;
    if ('formula' in value || 'sharedFormula' in value) {
      const result = value.result;
      if (result instanceof Date) return result.toISOString();
      return typeof result === 'object' ? cell.text : result ?? null;
    }
    return cell.text;
  }
}
