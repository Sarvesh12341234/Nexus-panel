/* NexusPanel 4.2 Safe Custom UI Editor */
(function(){
'use strict'; const MAX=50,KEY='nexus.custom-ui.draft.v2',allowed=new Set(['root','section','panel','text','button','metric','spacer']);
const state={tree:{type:'root',children:[]},history:[],future:[]},listeners=new Set();
const clone=x=>JSON.parse(JSON.stringify(x));
function sanitize(n){if(!n||typeof n!=='object')return {type:'text',text:''};const o={type:allowed.has(n.type)?n.type:'text'};if(n.id)o.id=String(n.id).replace(/[^\w-]/g,'').slice(0,64);if(typeof n.text==='string')o.text=n.text.slice(0,500);if(Array.isArray(n.children))o.children=n.children.slice(0,100).map(sanitize);if(n.props&&typeof n.props==='object'){o.props={};for(const [k,v] of Object.entries(n.props).slice(0,30))if(!/^on/i.test(k)&&k!=='innerHTML'&&k!=='outerHTML')o.props[k]=String(v).slice(0,300)}return o}
function emit(){try{localStorage.setItem(KEY,JSON.stringify(state.tree))}catch(_){}listeners.forEach(fn=>{try{fn(clone(state.tree))}catch(_){}})}
function setTree(t){state.history.push(clone(state.tree));if(state.history.length>MAX)state.history.shift();state.future=[];state.tree=sanitize(t);emit()}
function undo(){if(!state.history.length)return;state.future.push(clone(state.tree));state.tree=state.history.pop();emit()}
function redo(){if(!state.future.length)return;state.history.push(clone(state.tree));state.tree=state.future.pop();emit()}
function load(){try{const x=JSON.parse(localStorage.getItem(KEY)||'null');if(x)state.tree=sanitize(x)}catch(_){}}
window.NexusUIEditor={getTree:()=>clone(state.tree),setTree,undo,redo,load,subscribe:fn=>(listeners.add(fn),()=>listeners.delete(fn))};load();
})();