/* NexusPanel 4.2 Clean UI Guard */
(function(){
'use strict'; const KEY='nexus.ui.preferences.v1',defaults={density:'comfortable',animations:true,reducedMotion:false,editorPreview:true,sidebar:'auto'};
function load(){try{return {...defaults,...JSON.parse(localStorage.getItem(KEY)||'{}')}}catch(_){return {...defaults}}}
function apply(){const p=load(),r=p.reducedMotion||matchMedia('(prefers-reduced-motion: reduce)').matches;document.documentElement.dataset.nexusDensity=p.density;document.documentElement.dataset.nexusMotion=p.animations&&!r?'full':'reduced';document.documentElement.dataset.nexusSidebar=p.sidebar}
window.NexusUI={getPreferences:load,setPreferences:p=>{try{localStorage.setItem(KEY,JSON.stringify({...load(),...p}))}catch(_){}apply()},apply}; if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',apply);else apply();
})();