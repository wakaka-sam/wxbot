import { createRequestRelay } from './request-relay.js';
export const createMailRelay=(home,onRequest)=>createRequestRelay(home,onRequest);
