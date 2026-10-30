// Opt-in SG CLI/model test: synthetic files and a temporary assistant only. No WeChat sends.
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {CodexHarness} from '../src/platform/adapters/codex.js';
import {prepareAttachments} from '../src/platform/attachments.js';

if(process.env.PLATFORM_AGENT_TEST!=='1')throw new Error('Set PLATFORM_AGENT_TEST=1 to run the isolated CLI test');
const dir=await mkdtemp(join(tmpdir(),'wxbot-input-files-'));
let harness,threadId;
try{
 const source=join(dir,'full.xlsx');
 execFileSync('/usr/bin/python3',['-c',`import openpyxl,sys
w=openpyxl.Workbook()
for s in range(6):
 sheet=w.active if s==0 else w.create_sheet()
 sheet.title='Sheet'+str(s+1)
 for i in range(1,302):sheet.append(['sheet-%d-row-%d-'%(s+1,i)+'x'*600])
 sheet.cell(301,2,'FULL-FILE-END-'+str(s+1))
w.save(sys.argv[1])`,source]);
 const file={id:randomUUID(),name:'完整表格.xlsx',bytes:await readFile(source)};
 harness=new CodexHarness({dir:join(dir,'assistant')});
 await harness.prepare({onThread:id=>threadId=id});
 const prepared=await prepareAttachments([file],a=>a.bytes,{stage:(a,o)=>harness.stageAttachment(a,o)});
 assert.equal(prepared.files.length,1);assert.doesNotMatch(prepared.text,/FULL-FILE-END/);assert.match(prepared.notices.join('\n'),/截断/);
 const path=prepared.files[0].path;
 // Input path is a sandbox path, never a host attachment-store path.
 assert.ok(prepared.text.includes(path));assert.match(path,/^\/workspace\/incoming\//);
 const read=async()=>{
  const r=await harness.client.request('command/exec',{command:['/usr/bin/python3','-c',"import openpyxl,sys,json;w=openpyxl.load_workbook(sys.argv[1],read_only=True);print(json.dumps({'sheets':len(w.sheetnames),'rows':w.worksheets[5].max_row,'tail':w.worksheets[5]['B301'].value}))",path],cwd:'/workspace',timeoutMs:20000});
  assert.equal(r.exitCode,0,r.stderr);assert.deepEqual(JSON.parse(r.stdout),{sheets:6,rows:301,tail:'FULL-FILE-END-6'});
 };
 await read();
 // A thread becomes resumable after its first persisted turn. Also verify that
 // the model follows the file path instead of treating the preview as complete.
 const answer=await harness.run({text:prepared.text+'\n\n请实际运行 Python 读取原始 Excel 第 6 个工作表的 B301 单元格，只回复单元格的值，不需要其他操作。',onEvent:()=>{}});
 assert.match(answer.text,/FULL-FILE-END-6/);
 await harness.close();
 harness=new CodexHarness({dir:join(dir,'assistant')});await harness.prepare({threadId,onThread:id=>assert.equal(id,threadId)});await read();
 console.log(JSON.stringify({originalBytes:'preserved',preview:'bounded',isolatedCliRead:'passed',modelRead:'passed',sixthSheetRow301:'passed',resume:'passed',wechatMessagesSent:0}));
}finally{await harness?.close();await rm(dir,{recursive:true,force:true});}
