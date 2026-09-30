import { StudyService } from '../lib/service.js';
import { boardAction } from '../lib/board.js';
import { normalizeAssistRequest } from '../lib/assist.js';
import { demoModel } from './model.js';
import { sampleCards } from './content.js';
import { getUiLanguage } from '../ui/i18n.js';
const service=new StudyService('/demo',{complete:demoModel,coach:true});
const jobs=[];
const assist=[];
const message=()=>getUiLanguage()==='en'?'This feature needs the installed plugin. Use the built-in sample material in this static demo.':'此功能需要安装插件，静态体验版请使用内置示例资料。';
export async function call(action,args={}) {
  if(action.startsWith('audio.')||action.startsWith('live.'))throw new Error(message());
  if(action==='binding.get')return {root:'/demo',rootSource:'workspace',workspaceRoot:'/demo',provider:'demo',model:'preset',modelSource:'session',route:{provider:'demo',model:'preset'}};
  if(action==='binding.set')throw new Error(message());
  if(action.startsWith('board.'))return boardAction(action,args,'/demo');
  if(action==='notebook.list')return {notebooks:[],current:null};
  if(action==='notebook.search')return {items:[],total:0};
  if(action.startsWith('notebook.')||action==='source.import'||action==='legacy.import'||action==='restore'||action.startsWith('blog.lookup')||action==='card.translate')throw new Error(message());
  if(action==='assist.start'){
    const request=normalizeAssistRequest(args.mode,String(args.text||''),args.helpChoices);
    if(args.mode!=='ask')throw new Error(message());
    const {card}=await service.call('card.get',args);
    if(!sampleCards.some(c=>c.prompt===card.prompt))throw new Error(message());
    const en=getUiLanguage()==='en', question=en?'Preset explanation · '+(request.question||request.choices.join(', ')):'预置讲解 · '+(request.question||request.choices.join('、'));
    const answer=(en?'This is a prerecorded reference, not an AI response to your request.\n\n':'以下是预置参考，不是针对你的请求生成的 AI 回答。\n\n')+card.explanation;
    const task={id:crypto.randomUUID(),mode:'ask',deckId:args.deckId,cardId:args.cardId,prompt:card.prompt,label:en?'Preset help':'预置帮助',status:'done',startedAt:new Date().toISOString(),finishedAt:new Date().toISOString()};
    await service.call('card.followup.add',{deckId:args.deckId,cardId:args.cardId,question,answer,source:'assistant'});assist.push(task);return task;
  }
  if(action==='generate'){
    if(args.language && args.language !== 'English')throw new Error(getUiLanguage()==='en'?'This demo has English preset questions only. Select English; the installed plugin supports other content languages.':'体验版只提供英文预置题，请选择 English；插件本体支持其他出题语言。');

    if(args.sourceIds?.some(id=>id!=='patterns-notes'))throw new Error(message());
    const stamp=Date.now(), id=`demo-generated-${stamp}`;
    const kind=args.kind||'mixed';
    const eligible=sampleCards.filter(c=>kind==='mixed'||kind===c.kind);
    if(!eligible.length)throw new Error(getUiLanguage()==='en'?'The preset generation supports single choice, flashcards and mixed decks.':'预置出题支持单选、闪卡和混合题组。');
    const deck=await service.call('draft.save',{deck:{id,title:getUiLanguage()==='en'?'Preset generation · sample deck':'预置出题 · 示例题组',folder:'Design patterns',cards:eligible.slice(0,Math.min(7,Number(args.count)||7)).map(c=>({...structuredClone(c),id:`demo-${stamp}-${c.id}`}))}});
    const job={id:`demo-job-${stamp}`,status:'completed',draftId:id,title:deck.title,requested:Number(args.count)||7,generated:deck.cards.length,stage:'complete',createdAt:new Date().toISOString(),completedAt:new Date().toISOString()};jobs.push(job);
    return {jobId:job.id,status:'completed',draftId:id};
  }
  const result=await service.call(action,args);
  if(action==='snapshot'&&!result.unchanged){result.jobs=[...(result.jobs||[]),...jobs];result.assist=[...assist];}
  return result;
}
