import { buildMessage, ValidateBy } from 'class-validator';

export const EXTERNAL_KEY_MAX_LENGTH = 200;

// Count Unicode code points, including combining marks and variation selectors.
// Callers trim first; never rewrite or normalize the stored matching identity.
export function validExternalKeyLength(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Array.from(value).length <= EXTERNAL_KEY_MAX_LENGTH
  );
}

export function ExternalKeyLength(): PropertyDecorator {
  return ValidateBy({
    name: 'maxLength',
    constraints: [EXTERNAL_KEY_MAX_LENGTH],
    validator: {
      validate: validExternalKeyLength,
      defaultMessage: buildMessage(
        (prefix) =>
          prefix +
          '$property must be shorter than or equal to $constraint1 characters',
      ),
    },
  });
}
