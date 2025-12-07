import { assertEquals } from '@std/assert';
import {
  readVersionFile,
  resolveVersionFile,
  scanForVersionFile,
  syncVersionFile,
  updateVersionFile,
} from './version-file.ts';
import { getVersionFile, setVersionFile } from '../versions/mod.ts';

Deno.test('scanForVersionFile - returns null when no src directory', async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const result = await scanForVersionFile(tempDir);
    assertEquals(result, null);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test('scanForVersionFile - returns null when no magic comment found', async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${tempDir}/src`, { recursive: true });
    await Deno.writeTextFile(
      `${tempDir}/src/mod.ts`,
      'export const FOO = "bar";',
    );

    const result = await scanForVersionFile(tempDir);
    assertEquals(result, null);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test('scanForVersionFile - finds file with magic comment', async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${tempDir}/src`, { recursive: true });
    await Deno.writeTextFile(
      `${tempDir}/src/version_info.ts`,
      `// @pls-version
export const VERSION = "1.0.0";
`,
    );

    const result = await scanForVersionFile(tempDir);
    assertEquals(result, 'src/version_info.ts');
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test('scanForVersionFile - skips test files', async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${tempDir}/src`, { recursive: true });
    // Only a test file has the magic comment
    await Deno.writeTextFile(
      `${tempDir}/src/version_test.ts`,
      `// @pls-version
export const VERSION = "1.0.0";
`,
    );

    const result = await scanForVersionFile(tempDir);
    assertEquals(result, null);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test('readVersionFile - returns version from file', async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${tempDir}/src`, { recursive: true });
    await Deno.writeTextFile(
      `${tempDir}/src/version_info.ts`,
      `// @pls-version
export const VERSION = "2.3.4";
`,
    );

    const result = await readVersionFile('src/version_info.ts', tempDir);
    assertEquals(result, '2.3.4');
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test('readVersionFile - returns null without magic comment', async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${tempDir}/src`, { recursive: true });
    await Deno.writeTextFile(
      `${tempDir}/src/version_info.ts`,
      `export const VERSION = "2.3.4";
`,
    );

    const result = await readVersionFile('src/version_info.ts', tempDir);
    assertEquals(result, null);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test('readVersionFile - returns null for missing file', async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const result = await readVersionFile('src/version_info.ts', tempDir);
    assertEquals(result, null);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test('updateVersionFile - updates version in file', async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${tempDir}/src`, { recursive: true });
    await Deno.writeTextFile(
      `${tempDir}/src/version_info.ts`,
      `// @pls-version
export const VERSION = "1.0.0";
`,
    );

    const result = await updateVersionFile('src/version_info.ts', '2.0.0', tempDir);
    assertEquals(result, true);

    const content = await Deno.readTextFile(`${tempDir}/src/version_info.ts`);
    assertEquals(
      content,
      `// @pls-version
export const VERSION = "2.0.0";
`,
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test('updateVersionFile - returns false without magic comment', async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${tempDir}/src`, { recursive: true });
    await Deno.writeTextFile(
      `${tempDir}/src/version_info.ts`,
      `export const VERSION = "1.0.0";
`,
    );

    const result = await updateVersionFile('src/version_info.ts', '2.0.0', tempDir);
    assertEquals(result, false);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test('updateVersionFile - handles single quotes', async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${tempDir}/src`, { recursive: true });
    await Deno.writeTextFile(
      `${tempDir}/src/version_info.ts`,
      `// @pls-version
export const VERSION = '1.0.0';
`,
    );

    const result = await updateVersionFile('src/version_info.ts', '2.0.0', tempDir);
    assertEquals(result, true);

    const content = await Deno.readTextFile(`${tempDir}/src/version_info.ts`);
    // Output uses double quotes
    assertEquals(
      content,
      `// @pls-version
export const VERSION = "2.0.0";
`,
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test('resolveVersionFile - uses configured path from versions.json', async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    // Set up configured version file in versions.json
    await setVersionFile('src/my-version.ts', '.', tempDir);

    const result = await resolveVersionFile('.', tempDir);
    assertEquals(result, 'src/my-version.ts');
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test('resolveVersionFile - scans and caches when not configured', async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${tempDir}/src`, { recursive: true });
    await Deno.writeTextFile(
      `${tempDir}/src/version_info.ts`,
      `// @pls-version
export const VERSION = "1.0.0";
`,
    );

    // First call should scan and find the file
    const result = await resolveVersionFile('.', tempDir);
    assertEquals(result, 'src/version_info.ts');

    // Should now be cached in versions.json
    const cached = await getVersionFile('.', tempDir);
    assertEquals(cached, 'src/version_info.ts');
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test('resolveVersionFile - returns null when nothing found', async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${tempDir}/src`, { recursive: true });
    await Deno.writeTextFile(`${tempDir}/src/mod.ts`, 'export const FOO = 1;');

    const result = await resolveVersionFile('.', tempDir);
    assertEquals(result, null);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test('syncVersionFile - updates file and returns path', async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${tempDir}/src`, { recursive: true });
    await Deno.writeTextFile(
      `${tempDir}/src/version_info.ts`,
      `// @pls-version
export const VERSION = "1.0.0";
`,
    );

    const result = await syncVersionFile('3.0.0', '.', tempDir);
    assertEquals(result, 'src/version_info.ts');

    // Verify file was updated
    const content = await Deno.readTextFile(`${tempDir}/src/version_info.ts`);
    assertEquals(
      content,
      `// @pls-version
export const VERSION = "3.0.0";
`,
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test('syncVersionFile - returns null when no version file', async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${tempDir}/src`, { recursive: true });

    const result = await syncVersionFile('3.0.0', '.', tempDir);
    assertEquals(result, null);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});
