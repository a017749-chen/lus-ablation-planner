import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const typescript = require('typescript');

require.extensions['.ts'] = (module, filename) => {
  const source = readFileSync(filename, 'utf8');
  const output = typescript.transpileModule(source, {
    compilerOptions: {
      module: typescript.ModuleKind.CommonJS,
      target: typescript.ScriptTarget.ES2020,
      esModuleInterop: true
    },
    fileName: filename
  }).outputText;
  module._compile(output, filename);
};

// Each file runs even if an earlier one fails, so one broken area cannot hide another.
let failures = 0;
for (const file of ['../src/test/verify.ts', '../src/test/planner.ts']) {
  console.log(`
### ${file}`);
  try {
    require(file);
    if (process.exitCode) failures++;
    process.exitCode = 0;
  } catch (error) {
    failures++;
    console.log(`FAIL: ${error.message}`);
  }
}
process.exitCode = failures ? 1 : 0;
if (failures) console.log(`
${failures} test file(s) failed.`);
