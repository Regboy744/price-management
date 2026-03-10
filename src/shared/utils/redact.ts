const SENSITIVE_KEYS = new Set([
  'password',
  'cookie',
  'cookieString',
  'authorization',
  'proxyAuthorization',
  'token',
  'secret',
  'ms_password',
  'aad_password',
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item));
  }

  if (!isPlainObject(value)) {
    return value;
  }

  const output: Record<string, unknown> = {};

  for (const [key, nestedValue] of Object.entries(value)) {
    if (SENSITIVE_KEYS.has(key) || SENSITIVE_KEYS.has(key.toLowerCase())) {
      output[key] = '[REDACTED]';
      continue;
    }

    output[key] = redactValue(nestedValue);
  }

  return output;
}

export function redactSensitiveData<T>(value: T): T {
  return redactValue(value) as T;
}
