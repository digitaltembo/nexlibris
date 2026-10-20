import { builtinModules } from 'node:module';
import { defineConfig } from 'rolldown';

const external = [...builtinModules, ...builtinModules.map((m) => `node:${m}`)];

export default defineConfig({ input: 'src/main.ts', platform: 'node', external, output: { file: 'dist/main.js', format: 'esm' } });
