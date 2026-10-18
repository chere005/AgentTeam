import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { SkillRoot } from './skills.ts';
export let projectRoot=fileURLToPath(new URL('../',import.meta.url));
export const dataDir=resolve(process.env.AGENTTEAM_DATA_DIR??join(projectRoot,'.agentteam'));
export function roots():SkillRoot[]{
 const home=homedir();const defaults:SkillRoot[]=[{path:join(projectRoot,'assets/skills'),origin:'bundled',label:'AgentTeam recommended'}, {path:join(home,'.codex/skills'),environment:'codex',label:'Codex skills'}, {path:join(home,'.agents/skills'),label:'Shared agent skills'}, {path:join(home,'.claude/skills'),environment:'claude',label:'Claude Code skills'}, {path:join(home,'.claude/plugins/cache'),environment:'claude',label:'Claude plugins'}, {path:join(home,'.codex/plugins/cache'),environment:'codex',label:'Codex plugins'}];
 if(process.env.AGENTTEAM_SKILL_ROOTS){const extra=z.array(z.object({path:z.string(),environment:z.enum(['codex','claude','wolfram']).optional(),label:z.string().optional()}).strict()).parse(JSON.parse(process.env.AGENTTEAM_SKILL_ROOTS));defaults.push(...extra.map(r=>({...r,path:resolve(r.path)})));}return defaults;
}
export async function recommendations(){return JSON.parse(await readFile(join(projectRoot,'assets/recommended-skills.json'),'utf8'));}

export function setProjectRoot(path:string){projectRoot=path;}
