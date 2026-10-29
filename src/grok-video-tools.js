import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function installGrokVideoTools(home,{node=process.execPath,visibleHome='/home/assistant'}={}){
 const tools=join(home,'.local','share','wxbot-tools'),bin=join(home,'.local','bin'),skill=join(home,'.agents','skills','grok-video');
 for(const p of [tools,bin,skill,join(home,'.local','share','wxbot-video')])await mkdir(p,{recursive:true,mode:0o700});
 await writeFile(join(tools,'grok-video-client.js'),await readFile(new URL('./grok-video-client.js',import.meta.url)),{mode:0o600});
 await writeFile(join(tools,'package.json'),'{"type":"module"}\n',{mode:0o600});
 await writeFile(join(skill,'SKILL.md'),await readFile(new URL('../skills/grok-video/SKILL.md',import.meta.url)),{mode:0o600});
 const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
 await writeFile(join(bin,'grok-video'),`#!/bin/sh\nexport WXBOT_VIDEO_RELAY=${quote(join(visibleHome,'.local/share/wxbot-video'))}\nexec ${quote(node)} ${quote(join(visibleHome,'.local/share/wxbot-tools/grok-video-client.js'))} "$@"\n`,{mode:0o700});
}
