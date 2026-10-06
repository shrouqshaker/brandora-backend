import { Prisma } from '../../generated/prisma/client';
import { MappingType, STANDARD_FIELDS } from '../mapping-fields';
import { SavedColumnMapping } from '../mapping.service';

export function parseSavedMapping(value: Prisma.JsonValue, headers: string[]): SavedColumnMapping[] {
  if (!Array.isArray(value) || value.length !== headers.length) throw new Error('Invalid saved mapping');
  const sources = new Set<number>();
  const targets = new Set<string>();
  const mapping: SavedColumnMapping[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid saved mapping');
    const { sourceColumn, sourceColumnIndex, type, target } = item;
    if (typeof sourceColumn !== 'string' || typeof sourceColumnIndex !== 'number' || !Number.isInteger(sourceColumnIndex)
      || sourceColumnIndex < 1 || sourceColumnIndex > headers.length || headers[sourceColumnIndex - 1] !== sourceColumn
      || sources.has(sourceColumnIndex) || !Object.values(MappingType).includes(type as MappingType)) throw new Error('Invalid saved mapping');
    sources.add(sourceColumnIndex);
    if (type === MappingType.STANDARD) {
      if (!STANDARD_FIELDS.some((field) => field.target === target)) throw new Error('Invalid saved target');
    } else if (type === MappingType.ATTRIBUTE || type === MappingType.VARIANT_ATTRIBUTE) {
      if (typeof target !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(target)
        || ['constructor', 'prototype', '__proto__'].includes(target)) throw new Error('Invalid saved attribute key');
    } else if (target !== null) throw new Error('Invalid saved target');
    if (target !== null) {
      const key = `${type}:${target}`;
      if (targets.has(key)) throw new Error('Duplicate saved target');
      targets.add(key);
    }
    mapping.push({ sourceColumn, sourceColumnIndex, type: type as MappingType, target: target as string | null });
  }
  if (!targets.has('STANDARD:name')) throw new Error('Missing saved name mapping');
  return mapping;
}
