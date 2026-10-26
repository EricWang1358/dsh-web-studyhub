/* The deck's behaviour, as the text of two inline <script>s (no libraries, no network).
   THEME_SNIPPET runs in <head> so the saved choice is applied before the first paint; DECK_SCRIPT runs at the end of <body>:
   keyboard (←/→/PageUp/PageDown/Home/End, f for fullscreen), the counter and progress bar, the theme toggle, buttons for touch.
   The current slide is always the one under the middle of the window, worked out again on every scroll, so the counter cannot get stuck
   and ← / → always step from where the reader really is (or from the slide they are already being taken to). */

export const THEME_SNIPPET = `try{var t=localStorage.getItem("dk-theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;

export const DECK_SCRIPT = `(function(){
  var root=document.documentElement;
  var slides=Array.prototype.slice.call(document.querySelectorAll(".dk-slide"));
  var count=document.getElementById("dk-count"), fill=document.querySelector(".dk-progress i"), progress=document.querySelector(".dk-progress");
  var reduce=window.matchMedia("(prefers-reduced-motion: reduce)");
  var current=-1, pending=null, idle=0, frame=0;
  function top(slide){return slide.getBoundingClientRect().top+window.pageYOffset}
  function indexAt(){
    var middle=window.pageYOffset+window.innerHeight/2, found=0;
    for(var i=0;i<slides.length;i++){if(top(slides[i])<=middle)found=i;else break}
    return found;
  }
  function show(i){
    if(i===current)return;
    current=i;
    count.textContent=(i+1)+" / "+slides.length;
    fill.style.transform="scaleX("+(slides.length>1?i/(slides.length-1):1)+")";
    progress.setAttribute("aria-valuenow",String(i+1));
    try{history.replaceState(null,"","#"+slides[i].id)}catch(e){}
  }
  function update(){frame=0;show(indexAt())}
  function onScroll(){
    if(!frame)frame=window.requestAnimationFrame(update);
    clearTimeout(idle);
    idle=setTimeout(function(){pending=null;update()},160);
  }
  function go(i){
    i=Math.max(0,Math.min(slides.length-1,i));
    pending=i;
    clearTimeout(idle);
    idle=setTimeout(function(){pending=null;update()},400);
    slides[i].scrollIntoView({behavior:reduce.matches?"auto":"smooth",block:"start"});
  }
  function base(){return pending===null?indexAt():pending}
  window.addEventListener("scroll",onScroll,{passive:true});
  window.addEventListener("resize",onScroll);
  window.addEventListener("pageshow",update);
  update();
  function fullscreen(){
    try{
      if(document.fullscreenElement)document.exitFullscreen();
      else if(root.requestFullscreen)root.requestFullscreen();
    }catch(e){}
  }
  function theme(){
    var dark=root.dataset.theme?root.dataset.theme==="dark":window.matchMedia("(prefers-color-scheme: dark)").matches;
    var next=dark?"light":"dark";
    root.dataset.theme=next;
    try{localStorage.setItem("dk-theme",next)}catch(e){}
  }
  document.addEventListener("keydown",function(e){
    if(e.ctrlKey||e.metaKey||e.altKey)return;
    var t=e.target;
    if(t&&(t.isContentEditable||/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)))return;
    var k=e.key, handled=true;
    if(k==="ArrowRight"||k==="PageDown")go(base()+1);
    else if(k==="ArrowLeft"||k==="PageUp")go(base()-1);
    else if(k==="Home")go(0);
    else if(k==="End")go(slides.length-1);
    else if(k==="f"||k==="F")fullscreen();
    else handled=false;
    if(handled)e.preventDefault();
  });
  document.getElementById("dk-prev").addEventListener("click",function(){go(base()-1)});
  document.getElementById("dk-next").addEventListener("click",function(){go(base()+1)});
  document.getElementById("dk-theme").addEventListener("click",theme);
  var fs=document.getElementById("dk-full");
  if(root.requestFullscreen)fs.addEventListener("click",fullscreen);else fs.hidden=true;
})();`;
