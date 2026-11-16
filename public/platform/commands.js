import {COMMANDS,parseCommand} from './command-catalog.js';
export {parseCommand};
export function createCommandMenu({input,menu,toggle,enabled,onChange}){
 let selected=0,explicit=false,dismissed=false,lastQuery='',matches=[];
 function hide(){menu.hidden=true;input.setAttribute('aria-expanded','false');input.removeAttribute('aria-activedescendant');}
 function choose(command){input.value='/'+command.name+(['help','tasks','task','remind'].includes(command.name)?' ':'');explicit=false;dismissed=true;hide();input.focus();input.setSelectionRange(input.value.length,input.value.length);onChange();}
 function refresh(){
  if(!enabled()){hide();return;}
  const query=input.value.trim(),isPrefix=/^\/[a-z?_-]*$/i.test(query);
  if((!isPrefix&&!explicit)||dismissed){hide();return;}
  if(query!==lastQuery){selected=0;lastQuery=query;}
  matches=COMMANDS.filter(c=>explicit||c.name.startsWith(query.slice(1).toLowerCase()));
  if(!matches.length){hide();return;}
  selected=Math.min(selected,matches.length-1);
  menu.replaceChildren(...matches.map((c,i)=>{
   const button=document.createElement('button');button.type='button';button.role='option';button.id='command-option-'+c.name;button.tabIndex=-1;button.setAttribute('aria-selected',String(i===selected));
   const title=document.createElement('strong'),detail=document.createElement('span');title.textContent='/'+c.name;detail.textContent=c.summary;button.append(title,detail);button.title=c.usage;button.onmousedown=e=>e.preventDefault();button.onclick=()=>choose(c);return button;
  }));menu.hidden=false;input.setAttribute('aria-expanded','true');input.setAttribute('aria-activedescendant','command-option-'+matches[selected].name);
 }
 input.addEventListener('input',()=>{dismissed=false;explicit=false;refresh();onChange();});
 input.addEventListener('keydown',e=>{
  if(e.isComposing||menu.hidden)return;
  if(['ArrowDown','ArrowUp','Tab','Escape'].includes(e.key)){
   if(e.key==='Tab'&&e.shiftKey)return;
   e.preventDefault();e.stopImmediatePropagation();
   if(e.key==='Escape'){dismissed=true;explicit=false;hide();}
   else if(e.key==='Tab')choose(matches[selected]);
   else{selected=(selected+(e.key==='ArrowDown'?1:-1)+matches.length)%matches.length;refresh();menu.querySelector('[aria-selected=true]')?.scrollIntoView({block:'nearest'});}
  }
 });
 toggle.onclick=()=>{if(!enabled())return;explicit=menu.hidden;dismissed=false;if(explicit)refresh();else{dismissed=true;hide();}input.focus();};
 document.addEventListener('pointerdown',e=>{if(!menu.contains(e.target)&&e.target!==input&&e.target!==toggle){explicit=false;hide();}});
 return {refresh,reset(){explicit=false;dismissed=false;selected=0;hide();}};
}
