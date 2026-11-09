import { buildMessage, ValidateBy } from 'class-validator';

/**
 * Meta's limit for one text message we send through the Cloud API, so every
 * reply must fit it. The dev endpoint uses it too. Stored text is never cut.
 */
export const MESSAGE_MAX_CHARACTERS = 4096;

/** The AI service answers customer text up to this length (AI contract). */
export const AI_MAX_CUSTOMER_TEXT_CHARACTERS = 2000;

/**
 * Length in Unicode code points, the same count as Python's len() on the AI
 * side: an Arabic letter or "😀" is 1, "👍🏽" (emoji + skin tone) is 2 and
 * "❤️" (heart + variation selector) is 2. Nothing is skipped or merged.
 */
export function characterCount(text: string): number {
  return Array.from(text).length;
}

/** Longer customer texts are stored and shown, but never sent to the AI. */
export function fitsAiLimit(text: string): boolean {
  return characterCount(text) <= AI_MAX_CUSTOMER_TEXT_CHARACTERS;
}

/** Like @MaxLength, but counts code points with characterCount(). */
export function MaxCharacters(max: number): PropertyDecorator {
  return ValidateBy({
    name: 'maxCharacters',
    constraints: [max],
    validator: {
      validate: (value: unknown) =>
        typeof value === 'string' && characterCount(value) <= max,
      defaultMessage: buildMessage(
        (prefix) =>
          prefix +
          '$property must be shorter than or equal to $constraint1 characters',
      ),
    },
  });
}
