const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/** A compact label for display. Row selection and commands keep the original member ID. */
export function memberDisplayId(id: string, code?: string | null): string {
  return code || (uuid.test(id) ? `M-${id.slice(0, 8).toUpperCase()}` : id);
}
