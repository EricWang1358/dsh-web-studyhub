import test from 'node:test';
import assert from 'node:assert/strict';
import {classComponents, layoutClasses, visibleClasses} from '../ui/skeleton-diagrams.js';
const node = (id, parent) => ({id, term:id, parent, attributes:['trait'], cards:[]});
const overlap = (a,b) => a.x < b.x+b.w && b.x < a.x+a.w && a.y < b.y+b.h && b.y < a.y+a.h;

test('components include all relation kinds, keep isolated nodes, and ignore missing endpoints', () => {
  const graph = {nodes:[node('a'),node('b','a'),node('c'),node('d'),node('e')], relations:[{from:'b',to:'c',type:'contrasts'},{from:'d',to:'missing',type:'related'}]};
  assert.deepEqual(classComponents(graph).map(g=>g.nodes.map(n=>n.id)), [['a','b','c'],['d'],['e']]);
  const result = layoutClasses(graph);
  assert.equal(result.boxes.length,5);
  assert.equal(result.edges.length,2);
  for (const a of result.components) for (const b of result.components) if(a.id!==b.id) assert.ok(!overlap(a,b));
});

test('causal chains and wide branches retain their ranks in both directions', () => {
  const graph = {nodes:[node('root'),node('middle'),...Array.from({length:24},(_,i)=>node('child'+i))], relations:[{from:'root',to:'middle',type:'causes'},...Array.from({length:24},(_,i)=>({from:'middle',to:'child'+i,type:'prerequisite'}))]};
  for (const direction of ['down','right']) {
    const result=layoutClasses(graph,{direction}), axis=direction==='down'?'y':'x';
    const map=new Map(result.boxes.map(b=>[b.id,b]));
    assert.ok(map.get('root')[axis]<map.get('middle')[axis]);
    for(let i=0;i<24;i++) assert.ok(map.get('child'+i)[axis]>map.get('middle')[axis]);
    assert.equal(new Set(result.boxes.filter(b=>b.id.startsWith('child')).map(b=>b[axis])).size,1);
    for(const a of result.boxes) for(const b of result.boxes) if(a.id!==b.id) assert.ok(!overlap(a,b));
    for(const b of result.boxes) {assert.ok(b.x+b.w<=result.width);assert.ok(b.y+b.h<=result.height);}
  }
});

test('deep chains and cycles are finite, deterministic and retain every node and edge', () => {
  const nodes=Array.from({length:2000},(_,i)=>node('n'+i, i?'n'+(i-1):undefined)).reverse();
  const result=layoutClasses({nodes,relations:[]});
  assert.equal(result.boxes.length,2000);
  assert.equal(result.edges.length,1999);
  assert.equal(new Set(result.boxes.map(b=>b.y)).size,2000);
  const cycle={nodes:[node('a','b'),node('b','c'),node('c','a')],relations:[]};
  const first=layoutClasses(cycle);
  assert.equal(first.edges.length,3);
  assert.ok(Number.isFinite(first.height));
  assert.deepEqual(first,layoutClasses(cycle));
});

test('association-only network branches from a connected hub', () => {
  const nodes=Array.from({length:20},(_,i)=>node('n'+i));
  const result=layoutClasses({nodes,relations:nodes.slice(1).map(n=>({from:'n0',to:n.id,type:'related'}))});
  assert.equal(result.components.length,1);
  assert.equal(new Set(result.boxes.map(b=>b.y)).size,2);
});

test('viewport culling preserves crossing edges and the selected node without changing layout', () => {
  const boxes=new Map(Array.from({length:1000},(_,i)=>['n'+i,{id:'n'+i,x:i*300,y:0,w:224,h:70}]));
  const edges=[{x1:-1000,y1:30,x2:2000,y2:30},{x1:2000,y1:30,x2:3000,y2:30}];
  const visible=visibleClasses(boxes,edges,{k:1,x:0,y:0},{w:800,h:500},'n999',0);
  assert.deepEqual(visible.boxes.map(b=>b.id),['n0','n1','n2','n999']);
  assert.equal(visible.edges.length,1);
  assert.equal(boxes.size,1000);
});

test('a causal merge follows the longer branch, while explicit siblings keep class hierarchy', () => {
  const nodes=['a','b','c','d'].map(id=>node(id));
  const graph={nodes,relations:[['a','d'],['a','b'],['b','c'],['c','d']].map(([from,to])=>({from,to,type:'causes'}))};
  const boxes=new Map(layoutClasses(graph,{direction:'right'}).boxes.map(b=>[b.id,b]));
  assert.ok(boxes.get('d').x>boxes.get('c').x);
  const normal=layoutClasses(graph), loose=layoutClasses(graph,{spacing:1.6});
  assert.ok(loose.height>normal.height);
});

test('narrow focus preserves neighbours with side routes that avoid intermediate boxes', async () => {
  const {layoutFocus, routeClassEdge}=await import('../ui/skeleton-diagrams.js');
  const graph={nodes:['root','hub','a','b','c'].map(id=>node(id)),relations:[['root','hub'],['hub','a'],['hub','b'],['hub','c']].map(([from,to])=>({from,to,type:'causes'}))};
  const result=layoutFocus(graph,'hub',{narrow:true,compact:true});
  assert.equal(result.neighbours,4);
  assert.equal(new Set(result.boxes.map(b=>b.x)).size,1);
  const long=result.edges.find(e=>e.from==='hub'&&e.to==='c');
  assert.equal(long.routeSide,'right');
  const boxes=new Map(result.boxes.map(b=>[b.id,b]));
  assert.ok(long.labelX>boxes.get('hub').x+boxes.get('hub').w);
  assert.ok(long.d.includes(' V '));
  boxes.set('c',{...boxes.get('c'),x:120});
  const moved=routeClassEdge(long,boxes);
  assert.equal(moved.x2,120+boxes.get('c').w);
  assert.notEqual(moved.d,long.d);
});

test('compact layouts retain all concepts and relationships while saving vertical space', () => {
  const graph={nodes:[node('a'),node('b','a')],relations:[]};
  const expanded=layoutClasses(graph), compact=layoutClasses(graph,{compact:true});
  assert.equal(compact.boxes.length,expanded.boxes.length);
  assert.equal(compact.edges.length,expanded.edges.length);
  assert.ok(compact.height<expanded.height);
});
