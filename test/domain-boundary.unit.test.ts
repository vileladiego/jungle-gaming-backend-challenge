import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function typescriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return typescriptFiles(path);
    }
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

describe('fronteira do domínio', () => {
  test('classes financeiras não importam NestJS nem MikroORM', () => {
    const files = typescriptFiles(join(process.cwd(), 'src/domain')).filter(
      (path) => !path.endsWith(`${join('domain', 'domain.module.ts')}`),
    );
    expect(files.length).toBeGreaterThan(0);
    for (const path of files) {
      const source = readFileSync(path, 'utf8');
      expect(source).not.toContain('@nestjs/');
      expect(source).not.toContain('@mikro-orm/');
    }
  });
});