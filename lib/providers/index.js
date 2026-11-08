import * as groq from './groq.js';
import * as local from './local.js';

const table = { groq, local };

export const getStt = (name) => table[name].transcribe;
export const getChat = (name) => table[name].chat;
