/** "201000000001" -> "********0001". Logs never show a full customer number. */
export function maskPhone(phone: string): string {
  return phone.length > 4
    ? '*'.repeat(phone.length - 4) + phone.slice(-4)
    : '****';
}