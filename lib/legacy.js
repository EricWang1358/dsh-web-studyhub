import { readFile, readdir, realpath } from 'node:fs/promises';
import { join, isAbsolute, relative, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { parse } from 'yaml';
import { defaults, initialReview } from './domain.js';

async function markdownFiles(root){
  const files=[];async function visit(dir){for(const e of await readdir(dir,{withFileTypes:true})){if(e.isSymbolicLink())continue;const p=join(dir,e.name);if(e.isDirectory())await visit(p);else if(e.name.endsWith('.md'))files.push(p);if(files.length>1000)throw new Error('Import limited to 1,000 Markdown files');}}
  try{await visit(root);}catch(e){if(e.code!=='ENOENT')throw e;}return files;
}
function document(raw){const match=raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);if(!match)throw new Error('Missing YAML frontmatter');return {meta:parse(match[1]),body:match[2]};}
function section(body,title){return body.match(new RegExp('^## '+title+'\\s*\\r?\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))','mi'))?.[1]?.trim()||'';}
export async function importLegacy(path){
  if(!isAbsolute(path))throw new Error('Legacy library path must be absolute');
  const root=await realpath(path);await readFile(join(root,'study-lib.json'),'utf8');
  const prefix='legacy-'+createHash('sha256').update(root.toLowerCase()).digest('hex').slice(0,12);
  const sources=[],cards=[],warnings=[],nodes=new Map();
  for(const file of await markdownFiles(join(root,'nodes'))){
    const raw=await readFile(file,'utf8'),doc=document(raw),source={id:`${prefix}-node-${doc.meta.id}`,title:doc.meta.title||basename(file),text:doc.body,origin:relative(root,file)};
    sources.push(source);nodes.set(doc.meta.id,source);
  }
  for(const file of await markdownFiles(join(root,'quizzes'))){
    try{
      const raw=await readFile(file,'utf8'),{meta,body}=document(raw),prompt=section(body,'Prompt'),answer=section(body,'Answer');
      if(!prompt||!answer){warnings.push(`${relative(root,file)}: missing Prompt or Answer, skipped`);continue;}
      // Preserve legacy questions as self-assessed recall: never guess option keys from free prose.
      const evidence={id:`${prefix}-quiz-${meta.id}`,title:meta.title||basename(file),text:body,origin:relative(root,file)};sources.push(evidence);
      const review={...initialReview(),...meta.review};
      if(!Number.isInteger(review.repetitions)||review.repetitions<0||!Number.isFinite(review.ease_factor)||review.ease_factor<=0||!Number.isFinite(review.interval_days)||review.interval_days<0||(review.due_at&&!Number.isFinite(Date.parse(review.due_at))))throw new Error('Invalid review state');
      cards.push({id:`${prefix}-${meta.id}`,kind:'flashcard',topic:meta.area||meta.tags?.[0]||'General',objective:meta.summary||meta.title,prompt,answer,hint:section(body,'Hint'),explanation:section(body,'Explanation'),misconception:section(body,'Common Mistake'),rubric:section(body,'Scoring Rubric'),citations:[{sourceId:evidence.id,quote:answer.slice(0,1000)}],linkedNodes:meta.linked_nodes||[],provenance:meta.provenance,review,legacy:true});
    }catch(e){warnings.push(`${relative(root,file)}: ${e.message}`);}
  }
  if(!cards.length)throw new Error('No importable quizzes found in this study library');
  if(new Set(cards.map(q=>q.id)).size!==cards.length)throw new Error('Legacy quiz IDs are not unique');
  return {sources,deck:{id:prefix,title:basename(root)+' · Imported',cards,importedAt:new Date().toISOString()},warnings};
}
