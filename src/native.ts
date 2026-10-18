import type { Command } from './runtime.ts';
export type Editor = 'sublime'|'vscode'|'system'|'finder';
export function openCommand(platform:string,application:Editor,target:string):Pick<Command,'executable'|'args'> {
  if(platform==='darwin')return {executable:'/usr/bin/open',args:application==='finder'?['-R',target]:application==='system'?['--',target]:['-a',application==='sublime'?'Sublime Text':'Visual Studio Code','--',target]};
  if(application==='sublime')return {executable:'subl',args:['--',target]};
  if(application==='vscode')return {executable:'code',args:['--',target]};
  if(platform==='win32')return {executable:'explorer.exe',args:application==='finder'?['/select,',target]:[target]};
  return {executable:'xdg-open',args:[target]};
}
