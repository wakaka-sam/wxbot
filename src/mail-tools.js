import { readFile } from 'node:fs/promises';
import { installFile } from './grok-video-tools.js';
export async function installMailTools(home){
 await installFile(home,['.local','share','wxbot-tools','mail-client.js'],await readFile(new URL('./mail-client.js',import.meta.url)),0o600);
 await installFile(home,['.local','bin','mail-read'],`#!/bin/sh\nexport WXBOT_MAIL_RELAY=/home/assistant/.local/share/wxbot-mail\nexec /usr/local/bin/node /home/assistant/.local/share/wxbot-tools/mail-client.js "$@"\n`,0o700);
}
