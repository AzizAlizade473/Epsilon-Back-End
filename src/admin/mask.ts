/** `+994501234555` -> `+994 50 ••• •• 55` style: country code, operator and last two digits only. */
export function maskPhone(phone: string | null): string | null {
  if (!phone) return null;
  const d = phone.replace(/\D/g, '');
  if (d.length < 9) return '•••';
  const national = d.slice(-9);
  return `+994 ${national.slice(0, 2)} ••• •• ${national.slice(-2)}`;
}

/** `aziz@gmail.com` -> `a•••@gmail.com`. */
export function maskEmail(email: string | null): string | null {
  if (!email) return null;
  const at = email.lastIndexOf('@');
  if (at < 1) return '•••';
  return `${email[0]}•••${email.slice(at)}`;
}

/** Fiscal IDs and VÖEN: first 4 + last 4 stay visible. */
export function maskId(value: string | null): string | null {
  if (!value) return null;
  return value.length <= 8 ? '•'.repeat(value.length) : `${value.slice(0, 4)}${'•'.repeat(value.length - 8)}${value.slice(-4)}`;
}

/** CSV cell: quoted, and prefixed with `'` when a spreadsheet would read it as a formula. */
export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? '' : value instanceof Date ? value.toISOString() : typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) || s.startsWith("'") ? `"${s.replace(/"/g, '""')}"` : s;
}
