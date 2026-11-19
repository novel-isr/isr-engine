export type LogValue = null | boolean | number | string | LogValue[] | { [key: string]: LogValue };

/** Snapshot once so console and file output cannot invoke a caller's toJSON twice. */
export function snapshotLogArgument(value: unknown): LogValue {
  try {
    const seen = new WeakSet<object>();
    const serialized = JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === 'bigint') return `${item}n`;
      if (item && typeof item === 'object') {
        if (seen.has(item)) return '[Circular]';
        seen.add(item);
        if (item instanceof Error) {
          return {
            ...item,
            name: item.name,
            message: item.message,
            stack: item.stack,
            cause: item.cause,
          };
        }
      }
      return item;
    });
    return serialized === undefined ? String(value) : (JSON.parse(serialized) as LogValue);
  } catch {
    return '[Unserializable log argument]';
  }
}

/** JSON handles C0/CR/LF; these additional controls are legal raw JSON characters. */
export function escapeSupplementalLogControls(serialized: string): string {
  return serialized.replace(
    /[\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g,
    character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`
  );
}

/** Keep every untrusted console field visibly quoted and inside one physical line. */
export function encodeLogField(value: LogValue): string {
  return escapeSupplementalLogControls(JSON.stringify(value));
}

export function encodeSpinnerMessage(value: string): string {
  return encodeLogField(value).slice(1, -1);
}
