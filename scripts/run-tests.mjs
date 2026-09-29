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
for (const file of [
  '../src/test/verify.ts',
  '../src/test/planner.ts',
  '../src/test/patientAnatomy.ts'
]) {
  console.log(`\n### ${file}`);
  try {
    require(file);
    if (process.exitCode) failures++;
    process.exitCode = 0;
  } catch (error) {
    failures++;
    console.log(`FAIL: ${error.message}`);
  }
}

// The patient module is intentionally browser-only and therefore cannot execute in
// this Node math harness. Still guard the integration point so a green build cannot
// ship the module as unreachable/dead code again.
try {
  const viewport = readFileSync(new URL('../src/views/MultiViewport.ts', import.meta.url), 'utf8');
  if (!viewport.includes("import('../patientMode')")) {
    throw new Error('browser runtime does not load patientMode.ts');
  }
  console.log('\nPASS patientMode browser bootstrap is wired into the runtime graph');
} catch (error) {
  failures++;
  console.log(`\nFAIL patientMode bootstrap: ${error.message}`);
}

process.exitCode = failures ? 1 : 0;
if (failures) console.log(`\n${failures} test area(s) failed.`);
