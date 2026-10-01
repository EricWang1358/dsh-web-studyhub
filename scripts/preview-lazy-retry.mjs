import { build } from 'esbuild';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

// Browser regression fixture: a rejected feature must recover without
// unmounting an unrelated live view. No provider or microphone is used.
const result = await build({ absWorkingDir: fileURLToPath(new URL('../', import.meta.url)), write: false,
  stdin: { resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'jsx', contents: `
    import React, {useEffect,useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {deferredView} from './ui/deferred-view.jsx';
    import StudyBoundary from './ui/host/StudyBoundary.jsx';
    let imports=0, mounts=0;
    const Feature=deferredView(async()=>{
      imports++;
      if(imports===1) throw new Error('Transient chunk load failure');
      return {default:()=> <p>Recovered feature</p>};
    });
    function LiveProbe(){
      const [mount]=useState(()=>++mounts),[beats,setBeats]=useState(0);
      useEffect(()=>{const timer=setInterval(()=>setBeats(value=>value+1),100);return()=>clearInterval(timer);},[]);
      return <p>Live mount {mount}, beats {beats}</p>;
    }
    createRoot(document.getElementById('root')).render(<StudyBoundary><Feature/><LiveProbe/></StudyBoundary>);
  ` }, bundle: true, platform: 'browser', format: 'iife', define: { 'process.env.NODE_ENV': '"production"' } });
const javascript = result.outputFiles[0].text;
const server = createServer((_request, response) => {
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(`<!doctype html><html><meta charset="utf-8"><title>Lazy retry regression</title><div id="root"></div><script>${javascript.replaceAll('</script', '<\\/script')}</script></html>`);
});
const port = Number(process.env.PORT || 4189);
server.listen(port, '127.0.0.1', () => console.log(`Lazy retry fixture: http://127.0.0.1:${port}`));
