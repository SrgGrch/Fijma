import { build } from 'esbuild';

export class CompilationError extends Error {
  readonly phase = 'prepare' as const;
  constructor(readonly line?: number, readonly column?: number) { super('COMPILATION_FAILED'); }
}

// Compile only: user code is never evaluated by the server.
export async function compileExecution(language: 'javascript' | 'typescript', code: string) {
  try {
    const result = await build({
      stdin: { contents: `async function __figma_execute__(figma, args, console, execution) {\n${code}\n}`, loader: language === 'typescript' ? 'ts' : 'js' },
      bundle: true, write: false, format: 'esm', platform: 'neutral', target: 'es2020', treeShaking: false,
      supported: { 'dynamic-import': false }, logOverride: { 'unsupported-dynamic-import': 'error' },
      logLevel: 'silent', plugins: [{ name: 'reject-imports', setup(builder) {
        builder.onResolve({ filter: /.*/ }, () => ({ errors: [{ text: 'Imports are not supported.' }] }));
      } }],
    });
    return result.outputFiles[0].text + '\nreturn await __figma_execute__(figma, args, console, execution);';
  } catch (error) {
    const location = (error as { errors?: Array<{ location?: { line: number; column: number } }> })?.errors?.[0]?.location;
    const line = location && location.line > 1 ? location.line - 1 : undefined;
    const column = line && Number.isSafeInteger(location?.column) ? location!.column + 1 : undefined;
    throw new CompilationError(line, column);
  }
}
