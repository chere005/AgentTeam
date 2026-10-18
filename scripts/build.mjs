import { build } from 'esbuild';
await build({entryPoints:['desktop/main.ts'],outfile:'dist/desktop/main.js',bundle:true,platform:'node',format:'esm',banner:{js:"import {createRequire} from 'node:module';const require=createRequire(import.meta.url);"},external:['electron'],target:'node22'});
await build({entryPoints:['desktop/preload.ts'],outfile:'dist/desktop/preload.cjs',bundle:true,platform:'node',format:'cjs',external:['electron'],target:'node22'});
