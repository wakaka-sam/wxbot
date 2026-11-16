import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { installFile } from './grok-video-tools.js';
export { SCHEDULE_INSTRUCTIONS, scheduleTurnHint } from './schedule-protocol.js';
export async function installScheduleTools(home,{node=process.execPath,visibleHome='/home/assistant'}={}){
 await installFile(home,['.local','share','wxbot-tools','schedule-protocol.js'],await readFile(new URL('./schedule-protocol.js',import.meta.url)),0o600);
 await installFile(home,['.local','share','wxbot-tools','schedule-client.js'],await readFile(new URL('./schedule-client.js',import.meta.url)),0o600);
 const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
 await installFile(home,['.local','bin','wxbot-schedule'],`#!/bin/sh\nexport WXBOT_SCHEDULE_RELAY=${quote(join(visibleHome,'.local/share/wxbot-schedules'))}\nexec ${quote(node)} ${quote(join(visibleHome,'.local/share/wxbot-tools/schedule-client.js'))} "$@"\n`,0o700);
}
