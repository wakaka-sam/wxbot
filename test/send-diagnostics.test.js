import test from 'node:test';
import assert from 'node:assert/strict';
import { Weixin } from '../src/weixin.js';

test('发送诊断区分明确回执、空响应、拒绝和网络不明且不记录敏感数据', async () => {
  const events = [], replies = [Response.json({ret:0}), new Response(''), Response.json({ret:-1}), new TypeError('private-network-detail')];
  const api = new Weixin({onSendResult: e => events.push(e), fetchImpl: async () => {
    const result = replies.shift(); if (result instanceof Error) throw result; return result;
  }});
  const account = {baseUrl:'https://ilinkai.weixin.qq.com',userId:'PRIVATE-USER',token:'PRIVATE-TOKEN'};
  await api.sendText(account,'PRIVATE-TEXT','test-1','PRIVATE-CONTEXT');
  await api.sendText(account,'PRIVATE-TEXT','test-2');
  await assert.rejects(api.sendText(account,'PRIVATE-TEXT','test-3','PRIVATE-CONTEXT'));
  await assert.rejects(api.sendText(account,'PRIVATE-TEXT','test-4','PRIVATE-CONTEXT'));
  assert.deepEqual(events.map(e=>e.outcome),['accepted','accepted','rejected','unknown']);
  assert.equal(events[0].ret,0);assert.equal(events[0].hasContext,true);
  assert.equal(events[1].ret,null);assert.equal(events[1].emptyAcknowledgement,true);
  assert.equal(events[1].hasContext,false);assert.equal(events[2].errorCode,-1);
  assert(events.every(e=>e.durationMs>=0&&e.event==='wechat.send_result'));
  assert(!JSON.stringify(events).toLowerCase().includes('private'));
});

test('诊断记录异常不会把已发送消息变成失败或重发', async () => {
  let calls=0;
  const api=new Weixin({onSendResult(){throw Error('logger failed');},fetchImpl:async()=>{calls++;return Response.json({ret:0});}});
  assert.equal((await api.sendText({baseUrl:'https://ilinkai.weixin.qq.com',userId:'owner'},'test','test-1')).ret,0);
  assert.equal(calls,1);
});
