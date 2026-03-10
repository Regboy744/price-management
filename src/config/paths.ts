import fs from 'node:fs';
import path from 'node:path';

export function ensureDirectory(directoryPath: string): void {
  fs.mkdirSync(directoryPath, { recursive: true });
}

export function ensureParentDirectory(filePath: string): void {
  ensureDirectory(path.dirname(filePath));
}

export function sanitizeFileName(requestedName: string, fallbackName: string): string {
  const fallback = path.basename(fallbackName);
  const parsedFallback = path.parse(fallback);
  const parsedName = path.parse(path.basename(String(requestedName || '').trim() || fallback));

  const safeBaseName = (parsedName.name || parsedFallback.name)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || parsedFallback.name;

  const safeExtension = (parsedName.ext || parsedFallback.ext || '')
    .toLowerCase()
    .replace(/[^.a-z0-9]+/g, '');

  return `${safeBaseName}${safeExtension}`;
}

export function resolveJobDirectory(jobsRootDir: string, jobId: string): string {
  return path.resolve(jobsRootDir, jobId);
}

export function resolveJobFile(
  jobDirectory: string,
  requestedName: string | undefined,
  fallbackName: string
): string {
  return path.join(jobDirectory, sanitizeFileName(requestedName || fallbackName, fallbackName));
}

export function listFilesRecursively(rootDirectory: string): string[] {
  if (!fs.existsSync(rootDirectory)) {
    return [];
  }

  const files: string[] = [];
  const stack = [rootDirectory];

  while (stack.length > 0) {
    const currentPath = stack.pop()!;
    const entries = fs.readdirSync(currentPath, { withFileTypes: true });

    for (const entry of entries) {
      const nextPath = path.join(currentPath, entry.name);

      if (entry.isDirectory()) {
        stack.push(nextPath);
        continue;
      }

      files.push(nextPath);
    }
  }

  return files.sort();
}
