/**
 * Serve-time overlay injection (RFC §4, D-042, D-067). Response-transform that
 * injects the overlay bootstrap into the served iframe document WITHOUT
 * mutating the saved artifact file. The overlay mounts once into a persistent
 * host (`#__lucid_overlay_root`) that lives outside the artifact subtree, so a
 * subtree-only live-reload preserves it.
 */

import { randomUUID } from "node:crypto";
import { closeIndexOf, maskHiddenText } from "../core/html-scan.ts";

/**
 * A classic inline bootstrap runs immediately after the doctype, before any
 * artifact-authored script. It creates and transfers the private outline port,
 * starts the module import, then removes its nonce-bearing element before the
 * artifact can inspect or reuse that nonce. The port retained in this closure
 * is never published on the shared WindowProxy.
 */
const overlayBootstrapMarkup = (
  base: string,
  nonce?: string,
  origin?: string,
  hasDeclarativeShadow = false,
): string => {
  const attr = nonce === undefined ? "" : ` nonce="${nonce}"`;
  const moduleUrl = `${origin ?? ""}${base}/__lucid/client.js`;
  const boot = `(()=>{
window.__LUCID__={mode:"overlay"};
const apply=Reflect.apply,from=Array.from,descriptor=Object.getOwnPropertyDescriptor,parentPrototype=Object.getPrototypeOf;
const getter=(prototype,name)=>{let current=prototype;while(current){const found=descriptor(current,name)?.get;if(found)return found;current=parentPrototype(current)}};
const nodeParent=getter(Node.prototype,"parentElement"),nodeChildNodes=getter(Node.prototype,"childNodes"),nodeType=getter(Node.prototype,"nodeType"),nodeValue=getter(Node.prototype,"nodeValue"),nodeConnected=getter(Node.prototype,"isConnected"),nodeRoot=Node.prototype.getRootNode,nodeAppend=Node.prototype.appendChild;
const elementTag=getter(Element.prototype,"tagName"),elementShadowRoot=getter(Element.prototype,"shadowRoot"),elementClientWidth=getter(Element.prototype,"clientWidth"),elementClientHeight=getter(Element.prototype,"clientHeight"),elementScrollWidth=getter(Element.prototype,"scrollWidth"),elementScrollHeight=getter(Element.prototype,"scrollHeight"),elementRect=Element.prototype.getBoundingClientRect,elementAnimate=Element.prototype.animate,elementAttribute=Element.prototype.getAttribute,elementSetAttribute=Element.prototype.setAttribute,elementRemoveAttribute=Element.prototype.removeAttribute;
const documentQuery=Document.prototype.querySelectorAll,documentWalker=Document.prototype.createTreeWalker,documentCreate=Document.prototype.createElement,walkerNext=TreeWalker.prototype.nextNode,showElement=NodeFilter.SHOW_ELEMENT,showText=NodeFilter.SHOW_TEXT,documentRoot=getter(Document.prototype,"documentElement"),documentBody=getter(Document.prototype,"body"),documentReady=getter(Document.prototype,"readyState");
const shadowSheets=getter(ShadowRoot.prototype,"adoptedStyleSheets");
const sheetRules=getter(CSSStyleSheet.prototype,"cssRules"),groupRules=globalThis.CSSGroupingRule?getter(CSSGroupingRule.prototype,"cssRules"):undefined,ruleStyle=globalThis.CSSStyleRule?getter(CSSStyleRule.prototype,"style"):undefined,ruleStyleMap=globalThis.CSSStyleRule?getter(CSSStyleRule.prototype,"styleMap"):undefined;
const animationEffect=getter(Animation.prototype,"effect"),keyframeTarget=getter(KeyframeEffect.prototype,"target");
const rectTop=getter(DOMRectReadOnly.prototype,"top"),rectRight=getter(DOMRectReadOnly.prototype,"right"),rectBottom=getter(DOMRectReadOnly.prototype,"bottom"),rectLeft=getter(DOMRectReadOnly.prototype,"left");
const styleValue=CSSStyleDeclaration.prototype.getPropertyValue,computed=window.getComputedStyle;
const windowWidth=getter(window,"innerWidth"),windowHeight=getter(window,"innerHeight");
const eventAdd=EventTarget.prototype.addEventListener,eventRemove=EventTarget.prototype.removeEventListener,eventTarget=getter(Event.prototype,"target"),defineProperty=Object.defineProperty,freeze=Object.freeze,ownNames=Object.getOwnPropertyNames,setAdd=Set.prototype.add,setDelete=Set.prototype.delete,weakGet=WeakMap.prototype.get,weakSet=WeakMap.prototype.set,weakDelete=WeakMap.prototype.delete,weakSetAdd=WeakSet.prototype.add,weakSetDelete=WeakSet.prototype.delete,weakSetHas=WeakSet.prototype.has;
const customDefine=CustomElementRegistry.prototype.define;
const TrustedMutationObserver=MutationObserver,TrustedResizeObserver=ResizeObserver,mutationObserve=MutationObserver.prototype.observe,mutationDisconnect=MutationObserver.prototype.disconnect,mutationTakeRecords=MutationObserver.prototype.takeRecords,resizeObserve=ResizeObserver.prototype.observe,resizeDisconnect=ResizeObserver.prototype.disconnect;
const mutationAddedNodes=getter(MutationRecord.prototype,"addedNodes"),nodeListLength=getter(NodeList.prototype,"length"),nodeListItem=NodeList.prototype.item,ruleListLength=getter(CSSRuleList.prototype,"length"),ruleListItem=CSSRuleList.prototype.item;
const setTimer=window.setTimeout.bind(window),clearTimer=window.clearTimeout.bind(window),requestFrame=window.requestAnimationFrame.bind(window),cancelFrame=window.cancelAnimationFrame.bind(window),enqueueMicrotask=window.queueMicrotask.bind(window),clock=performance.now.bind(performance),promiseThen=Promise.prototype.then;
const imageComplete=getter(HTMLImageElement.prototype,"complete"),fonts=document.fonts,fontStatus=globalThis.FontFaceSet?getter(FontFaceSet.prototype,"status"):undefined,fontReady=globalThis.FontFaceSet?getter(FontFaceSet.prototype,"ready"):undefined;
const value=(style,name)=>apply(styleValue,style,[name]),style=(element,pseudo)=>apply(computed,window,[element,pseudo]);
const rect=(element)=>{const box=apply(elementRect,element,[]);return{top:apply(rectTop,box,[]),right:apply(rectRight,box,[]),bottom:apply(rectBottom,box,[]),left:apply(rectLeft,box,[])}};
const listen=(target,type,callback,options)=>{apply(eventAdd,target,[type,callback,options]);return()=>apply(eventRemove,target,[type,callback,options])};
const ownedElements=new WeakSet(),ownedShadowTargets=new WeakSet(),ownedStyleObjects=new WeakSet(),ownedProtectedMethods=[],ownedRoot=apply(documentCreate,document,["div"]);let ownedOverlay=null,ownedOverlayConstructor=null,ownedShadowRoot=null,ownedBasePerformUpdate=null,ownedSealed=false;apply(elementSetAttribute,ownedRoot,["id","__lucid_overlay_root"]);apply(elementSetAttribute,ownedRoot,["data-lucid-ignore","true"]);apply(weakSetAdd,ownedElements,[ownedRoot]);
let styleRealmTrusted=${JSON.stringify(!hasDeclarativeShadow)},realmBudgetObserver,ownedMutationObserver,ownedParentObserver,ownedShadowObserver;const rejectStyleRealm=()=>{styleRealmTrusted=false;for(const observer of [realmBudgetObserver,ownedMutationObserver,ownedParentObserver,ownedShadowObserver])if(observer)apply(mutationDisconnect,observer,[])};realmBudgetObserver=new TrustedMutationObserver((records)=>{if(ownedSealed&&!ownedIdentityTrusted()){rejectStyleRealm();quarantineOwnedStructure();return}let inspected=0;const spend=()=>{inspected+=1;if(inspected<=2000)return true;rejectStyleRealm();return false};for(let recordIndex=0;recordIndex<records.length;recordIndex+=1){if(!spend())return;const added=apply(mutationAddedNodes,records[recordIndex],[]),addedLength=apply(nodeListLength,added,[]);for(let nodeIndex=0;nodeIndex<addedLength;nodeIndex+=1){if(!spend())return;const node=apply(nodeListItem,added,[nodeIndex]);if(!node)continue;const walker=apply(documentWalker,document,[node,showElement]);let current=apply(nodeType,node,[])===1?node:apply(walkerNext,walker,[]);while(current){if(!spend())return;if(apply(elementTag,current,[])==="IFRAME"){rejectStyleRealm();return}current=apply(walkerNext,walker,[])}}}});const budgetRoot=apply(documentRoot,document,[]);if(styleRealmTrusted&&budgetRoot)apply(mutationObserve,realmBudgetObserver,[budgetRoot,{childList:true,subtree:true}]);
const walk=(root,what,limit,deadline)=>{const elements=[],walker=apply(documentWalker,document,[root,what]);let current=root;while(current&&elements.length<limit&&clock()<=deadline){elements.push(current);current=apply(walkerNext,walker,[])}return{complete:current===null,elements}};
const walkDescendants=(root,what,limit,deadline)=>{const elements=[],walker=apply(documentWalker,document,[root,what]);let current=apply(walkerNext,walker,[]);while(current&&elements.length<limit&&clock()<=deadline){elements.push(current);current=apply(walkerNext,walker,[])}return{complete:current===null,elements}};
const boundedText=(element,limit,maxNodes,deadline)=>{const walker=apply(documentWalker,document,[element,showText]);let result="",visited=0,current=apply(walkerNext,walker,[]);while(current&&result.length<limit&&visited<maxNodes&&clock()<=deadline){const currentValue=apply(nodeValue,current,[])??"";result+=currentValue.slice(0,limit-result.length);visited+=1;current=apply(walkerNext,walker,[])}return{complete:current===null||result.length>=limit,examinedNodes:visited,value:result}};
const styleCallbacks=new Set();let styleNotificationPending=false;const notifyStyle=()=>{if(styleNotificationPending)return;styleNotificationPending=true;enqueueMicrotask(()=>{styleNotificationPending=false;for(const callback of from(styleCallbacks))callback()})};
const wrapMethod=(prototype,name,after)=>{const original=prototype[name],originalDescriptor=descriptor(prototype,name);if(typeof original!=="function"||!originalDescriptor)return;apply(defineProperty,Object,[prototype,name,{...originalDescriptor,value:function(...args){const result=apply(original,this,args);after(result,this);return result}}])};
for(const name of ["insertRule","deleteRule","replace","replaceSync"])wrapMethod(CSSStyleSheet.prototype,name,(result,target)=>{if(apply(weakSetHas,ownedStyleObjects,[target]))rejectStyleRealm();notifyStyle();if(name==="replace"&&result)apply(promiseThen,result,[notifyStyle])});
for(const name of ["setProperty","removeProperty"])wrapMethod(CSSStyleDeclaration.prototype,name,(_result,target)=>{if(apply(weakSetHas,ownedStyleObjects,[target]))rejectStyleRealm();notifyStyle()});
for(const name of ownNames(CSSStyleDeclaration.prototype)){const current=descriptor(CSSStyleDeclaration.prototype,name);if(!current||typeof current.set!=="function")continue;const original=current.set;apply(defineProperty,Object,[CSSStyleDeclaration.prototype,name,{...current,set:function(value){apply(original,this,[value]);if(apply(weakSetHas,ownedStyleObjects,[this]))rejectStyleRealm();notifyStyle()}}])}
const findProperty=(prototype,name)=>{let current=prototype;while(current){const found=descriptor(current,name);if(found)return{descriptor:found,owner:current};current=parentPrototype(current)}return null};
for(const prototype of [Document.prototype,ShadowRoot.prototype]){const adoptedProperty=findProperty(prototype,"adoptedStyleSheets");if(adoptedProperty&&typeof adoptedProperty.descriptor.set==="function"){const original=adoptedProperty.descriptor.set;apply(defineProperty,Object,[prototype,"adoptedStyleSheets",{...adoptedProperty.descriptor,set:function(value){apply(original,this,[value]);if(this===ownedShadowRoot)rejectStyleRealm();notifyStyle()}}])}}
const instrumentBrowserMethod=(prototype,name,current,kind)=>{const original=current.value;if(typeof original!=="function")return;apply(defineProperty,Object,[prototype,name,{...current,value:function(...args){const result=apply(original,this,args);if(kind==="animation"){if(name==="cancel")untrackAnimation(this);else trackAnimation(this)}else if(kind==="style"&&apply(weakSetHas,ownedStyleObjects,[this]))rejectStyleRealm();notifyStyle();if(name==="replace"&&result)apply(promiseThen,result,[notifyStyle]);return result}}])};
const instrumentBrowserSetter=(prototype,name,current,kind)=>{const original=current.set;if(typeof original!=="function")return;apply(defineProperty,Object,[prototype,name,{...current,set:function(value){apply(original,this,[value]);if(kind==="animation")trackAnimation(this);else if(kind==="effect"||kind==="style"&&apply(weakSetHas,ownedStyleObjects,[this]))rejectStyleRealm();notifyStyle()}}])};
const instrumentBrowserPrototype=(prototype,kind)=>{const names=ownNames(prototype);if(names.length>512){rejectStyleRealm();return}for(const name of names){if(name==="constructor")continue;const current=descriptor(prototype,name);if(!current)continue;if(typeof current.set==="function")instrumentBrowserSetter(prototype,name,current,kind);if(typeof current.value==="function")instrumentBrowserMethod(prototype,name,current,kind)}};
const globalNames=ownNames(window);if(globalNames.length>4096)rejectStyleRealm();else for(const name of globalNames){if(!(name.startsWith("CSS")||name==="StyleSheet"||name==="MediaList"||name==="StylePropertyMap"||name==="HTMLStyleElement"||name==="HTMLLinkElement"||name==="Animation"||name==="AnimationEffect"||name==="KeyframeEffect"))continue;const candidate=descriptor(window,name)?.value,prototype=typeof candidate==="function"?candidate.prototype:undefined,kind=name==="Animation"?"animation":name==="AnimationEffect"||name==="KeyframeEffect"?"effect":"style";if(prototype)instrumentBrowserPrototype(prototype,kind)}
for(const [surface,name] of [[Document,"parseHTML"],[Document,"parseHTMLUnsafe"],[Element.prototype,"setHTML"],[Element.prototype,"setHTMLUnsafe"],[ShadowRoot.prototype,"setHTML"],[ShadowRoot.prototype,"setHTMLUnsafe"]])wrapMethod(surface,name,()=>{rejectStyleRealm();notifyStyle()});
const motionCounts=new WeakMap(),motionCount=(target)=>apply(weakGet,motionCounts,[target])??0,motionStart=(target)=>{if(target)apply(weakSet,motionCounts,[target,motionCount(target)+1])},motionEnd=(target)=>{if(target)apply(weakSet,motionCounts,[target,Math.max(0,motionCount(target)-1)])};
const animationTargets=new WeakMap(),trackedAnimations=new WeakSet(),animationTarget=(animation)=>{const effect=apply(animationEffect,animation,[]);if(!effect)return null;try{return apply(keyframeTarget,effect,[])}catch{rejectStyleRealm();return null}},untrackAnimation=(animation)=>{const previous=apply(weakGet,animationTargets,[animation]);if(previous)motionEnd(previous);apply(weakDelete,animationTargets,[animation])},trackAnimation=(animation)=>{const target=animationTarget(animation),previous=apply(weakGet,animationTargets,[animation]);if(previous!==target){if(previous)motionEnd(previous);if(target){motionStart(target);apply(weakSet,animationTargets,[animation,target])}else apply(weakDelete,animationTargets,[animation])}if(!apply(weakSetHas,trackedAnimations,[animation])){apply(weakSetAdd,trackedAnimations,[animation]);apply(eventAdd,animation,["cancel",()=>{untrackAnimation(animation);notifyStyle()}]);apply(eventAdd,animation,["finish",()=>{untrackAnimation(animation);notifyStyle()}])}};
const onMotionStart=(event)=>{motionStart(apply(eventTarget,event,[]));notifyStyle()},onMotionEnd=(event)=>{motionEnd(apply(eventTarget,event,[]));notifyStyle()};
for(const type of ["animationstart","transitionrun"])apply(eventAdd,window,[type,onMotionStart,true]);for(const type of ["animationend","animationcancel","transitionend","transitioncancel"])apply(eventAdd,window,[type,onMotionEnd,true]);
if(typeof elementAnimate==="function")wrapMethod(Element.prototype,"animate",(animation,target)=>{motionStart(target);notifyStyle();let done=false;const finish=()=>{if(done)return;done=true;motionEnd(target);notifyStyle()};apply(eventAdd,animation,["finish",finish,{once:true}]);apply(eventAdd,animation,["cancel",finish,{once:true}])});
wrapMethod(Element.prototype,"attachShadow",(_root,target)=>{if(apply(weakSetHas,ownedShadowTargets,[target])){apply(weakSetDelete,ownedShadowTargets,[target]);return}rejectStyleRealm();notifyStyle()});
const noGeneratedPaint=(element)=>{const before=value(style(element,"::before"),"content"),after=value(style(element,"::after"),"content");return(before==="none"||before==="normal")&&(after==="none"||after==="normal")};
const commonOwnedPaint=(current)=>value(current,"background-color")==="rgba(0, 0, 0, 0)"&&value(current,"background-image")==="none"&&value(current,"border-top-width")==="0px"&&value(current,"border-right-width")==="0px"&&value(current,"border-bottom-width")==="0px"&&value(current,"border-left-width")==="0px"&&value(current,"box-shadow")==="none"&&value(current,"filter")==="none"&&value(current,"backdrop-filter")==="none"&&value(current,"outline-style")==="none"&&value(current,"text-shadow")==="none"&&value(current,"transform")==="none"&&value(current,"clip-path")==="none"&&value(current,"mask-image")==="none"&&value(current,"mix-blend-mode")==="normal"&&value(current,"opacity")==="1"&&value(current,"visibility")==="visible";
const ownedPaintTrusted=()=>{if(!ownedOverlay)return false;const rootStyle=style(ownedRoot),overlayStyle=style(ownedOverlay),overlayRect=rect(ownedOverlay);return commonOwnedPaint(rootStyle)&&commonOwnedPaint(overlayStyle)&&noGeneratedPaint(ownedRoot)&&noGeneratedPaint(ownedOverlay)&&value(rootStyle,"display")==="block"&&value(rootStyle,"position")==="static"&&value(rootStyle,"overflow-x")==="visible"&&value(rootStyle,"overflow-y")==="visible"&&value(overlayStyle,"position")==="fixed"&&value(overlayStyle,"top")==="0px"&&value(overlayStyle,"right")==="0px"&&value(overlayStyle,"bottom")==="0px"&&value(overlayStyle,"left")==="0px"&&value(overlayStyle,"pointer-events")==="none"&&value(overlayStyle,"z-index")==="2147483646"&&overlayRect.top===0&&overlayRect.left===0&&overlayRect.right===apply(windowWidth,window,[])&&overlayRect.bottom===apply(windowHeight,window,[])&&motionCount(ownedRoot)===0&&motionCount(ownedOverlay)===0};
const ownedIdentityTrusted=()=>{if(!ownedOverlay)return false;const body=apply(documentBody,document,[]),children=apply(nodeChildNodes,ownedRoot,[]);return apply(nodeParent,ownedRoot,[])===body&&apply(nodeListLength,children,[])===1&&apply(nodeListItem,children,[0])===ownedOverlay&&apply(nodeParent,ownedOverlay,[])===ownedRoot};
const clearPresentationAttributes=(element)=>{for(const name of ["style","class","hidden","inert","aria-hidden"])apply(elementRemoveAttribute,element,[name])};
const installOwnedStructure=()=>{if(!ownedOverlay)return;clearPresentationAttributes(ownedRoot);apply(elementSetAttribute,ownedRoot,["id","__lucid_overlay_root"]);apply(elementSetAttribute,ownedRoot,["data-lucid-ignore","true"]);clearPresentationAttributes(ownedOverlay);apply(elementRemoveAttribute,ownedOverlay,["id"]);if(apply(nodeParent,ownedOverlay,[])!==ownedRoot)apply(nodeAppend,ownedRoot,[ownedOverlay]);const body=apply(documentBody,document,[]);if(body&&apply(nodeParent,ownedRoot,[])!==body)apply(nodeAppend,body,[ownedRoot])};
const quarantineOwnedStructure=()=>{if(!ownedOverlay)return;clearPresentationAttributes(ownedOverlay);apply(elementRemoveAttribute,ownedOverlay,["id"]);const body=apply(documentBody,document,[]);if(body&&apply(nodeParent,ownedOverlay,[])!==body)apply(nodeAppend,body,[ownedOverlay])};
const rejectOwnedMutation=()=>{rejectStyleRealm();quarantineOwnedStructure();notifyStyle()};
const collectOwnedStyleObjects=()=>{if(!styleRealmTrusted||!ownedShadowRoot||!shadowSheets||!sheetRules||!ruleListLength||!ruleListItem)return;let inspected=0;const spend=()=>{inspected+=1;if(inspected<=512)return true;rejectStyleRealm();return false},stacks=[];const sheets=apply(shadowSheets,ownedShadowRoot,[]);for(let sheetIndex=0;sheetIndex<sheets.length;sheetIndex+=1){if(!spend())return;const sheet=sheets[sheetIndex];if(!sheet)continue;apply(weakSetAdd,ownedStyleObjects,[sheet]);stacks.push({index:0,list:apply(sheetRules,sheet,[])})}while(stacks.length>0){const frame=stacks[stacks.length-1],length=apply(ruleListLength,frame.list,[]);if(frame.index>=length){stacks.pop();continue}if(!spend())return;const rule=apply(ruleListItem,frame.list,[frame.index]);frame.index+=1;if(!rule)continue;apply(weakSetAdd,ownedStyleObjects,[rule]);if(ruleStyle){try{const declaration=apply(ruleStyle,rule,[]);if(declaration){if(!spend())return;apply(weakSetAdd,ownedStyleObjects,[declaration])}}catch{}}if(ruleStyleMap){try{const map=apply(ruleStyleMap,rule,[]);if(map){if(!spend())return;apply(weakSetAdd,ownedStyleObjects,[map])}}catch{}}if(groupRules){try{const nested=apply(groupRules,rule,[]);if(nested)stacks.push({index:0,list:nested})}catch{}}}};
const pinOwnedFrameworkState=(element)=>{if(!ownedOverlayConstructor||!ownedShadowRoot)return false;const pin=(name,value,writable)=>{const current=descriptor(element,name);apply(defineProperty,Object,[element,name,{configurable:false,enumerable:current?.enumerable??false,value,writable}])};const renderOptions=apply(freeze,Object,[{isConnected:true,renderBefore:null}]);pin("constructor",ownedOverlayConstructor,false);pin("renderOptions",renderOptions,false);pin("renderRoot",ownedShadowRoot,false);pin("hasUpdated",true,false);pin("isUpdatePending",element.isUpdatePending,true);/* Lit 3.3.3 production names. test/inject.test.ts locks these to the generated bundle before a dependency update can change them silently. */pin("_$AL",element._$AL,true);pin("_$Do",element._$Do,true);pin("_$ES",element._$ES,true);pin("_$Em",null,false);pin("_$Ep",undefined,false);pin("_$Eq",undefined,false);pin("_$EO",undefined,false);return true};
const performOwnedUpdate=(element)=>{if(element!==ownedOverlay||!ownedBasePerformUpdate)return;if(!ownedShadowObserver||!ownedShadowRoot){apply(ownedBasePerformUpdate,element,[]);return}for(const [lookupPrototype,ownerPrototype,name,method] of ownedProtectedMethods)if(lookupPrototype[name]!==method||descriptor(ownerPrototype,name)?.value!==method){rejectStyleRealm();notifyStyle();apply(ownedBasePerformUpdate,element,[]);return}const pending=apply(mutationTakeRecords,ownedShadowObserver,[]);if(pending.length>0){rejectStyleRealm();notifyStyle();apply(ownedBasePerformUpdate,element,[]);return}apply(mutationDisconnect,ownedShadowObserver,[]);try{apply(ownedBasePerformUpdate,element,[])}finally{collectOwnedStyleObjects();apply(mutationTakeRecords,ownedShadowObserver,[]);if(styleRealmTrusted)apply(mutationObserve,ownedShadowObserver,[ownedShadowRoot,{attributes:true,characterData:true,childList:true,subtree:true}])}};
const capabilities={
allElements:(limit,deadline)=>{const root=apply(documentRoot,document,[]);if(!root)return{complete:true,elements:[]};const light=walk(root,showElement,limit,deadline);if(!light.complete||!ownedShadowRoot)return light;const shadow=walkDescendants(ownedShadowRoot,showElement,Math.max(0,limit-light.elements.length),deadline);return{complete:shadow.complete,elements:[...light.elements,...shadow.elements]}},
ariaHidden:(element)=>apply(elementAttribute,element,["aria-hidden"])==="true",
clientHeight:(element)=>apply(elementClientHeight,element,[]),clientWidth:(element)=>apply(elementClientWidth,element,[]),
constructCustomElement:(constructor)=>{const element=new constructor();for(const name of ["createRenderRoot","performUpdate","shouldUpdate","willUpdate","update","_$AE","_$EM","firstUpdated","updated","render"]){const found=findProperty(constructor.prototype,name),method=found?.descriptor.value;if(typeof method!=="function")continue;ownedProtectedMethods.push([constructor.prototype,found.owner,name,method]);apply(defineProperty,Object,[element,name,{configurable:false,value:method,writable:false}])}const baseLookup=parentPrototype(constructor.prototype),basePerform=findProperty(baseLookup,"performUpdate");ownedBasePerformUpdate=typeof basePerform?.descriptor.value==="function"?basePerform.descriptor.value:null;if(basePerform&&ownedBasePerformUpdate)ownedProtectedMethods.push([baseLookup,basePerform.owner,"performUpdate",ownedBasePerformUpdate]);apply(defineProperty,Object,[element,"addController",{configurable:false,value:()=>{rejectStyleRealm();notifyStyle()},writable:false}]);ownedOverlay=element;ownedOverlayConstructor=constructor;apply(weakSetAdd,ownedElements,[element]);apply(weakSetAdd,ownedShadowTargets,[element]);return element},
defineCustomElement:(name,constructor)=>apply(customDefine,customElements,[name,constructor]),
hidden:(element)=>apply(elementAttribute,element,["hidden"])!==null,inert:(element)=>apply(elementAttribute,element,["inert"])!==null,
hasActiveMotion:(element)=>motionCount(element)>0,
installOverlay:(element)=>{if(element!==ownedOverlay||ownedSealed)return;installOwnedStructure();ownedShadowRoot=elementShadowRoot?apply(elementShadowRoot,element,[]):null;performOwnedUpdate(element);if(!pinOwnedFrameworkState(element)){rejectStyleRealm();return}ownedSealed=true;ownedMutationObserver=new TrustedMutationObserver(rejectOwnedMutation);ownedParentObserver=new TrustedMutationObserver(()=>{if(!ownedIdentityTrusted())rejectOwnedMutation()});ownedShadowObserver=new TrustedMutationObserver(()=>{rejectStyleRealm();notifyStyle()});apply(mutationObserve,ownedMutationObserver,[ownedRoot,{attributes:true,childList:true}]);apply(mutationObserve,ownedMutationObserver,[ownedOverlay,{attributes:true}]);if(ownedShadowRoot)apply(mutationObserve,ownedShadowObserver,[ownedShadowRoot,{attributes:true,characterData:true,childList:true,subtree:true}]);const body=apply(documentBody,document,[]);if(body)apply(mutationObserve,ownedParentObserver,[body,{childList:true}])},
isConnected:(element)=>apply(nodeConnected,element,[]),isLightDom:(element)=>apply(nodeRoot,element,[])===document,
isOwned:(element)=>apply(weakSetHas,ownedElements,[element]),
overlayRoot:()=>ownedRoot,
isSettled:()=>{const images=from(apply(documentQuery,document,["img"]));return apply(documentReady,document,[])==="complete"&&(!fontStatus||apply(fontStatus,fonts,[])==="loaded")&&images.every(image=>apply(imageComplete,image,[]))},
now:clock,
observeMutations:(callback)=>{const observer=new TrustedMutationObserver(callback),root=apply(documentRoot,document,[]);if(root)apply(mutationObserve,observer,[root,{attributes:true,characterData:true,childList:true,subtree:true}]);return()=>apply(mutationDisconnect,observer,[])},
observeResize:(callback)=>{const observer=new TrustedResizeObserver(callback),root=apply(documentRoot,document,[]),body=apply(documentBody,document,[]);if(root)apply(resizeObserve,observer,[root]);if(body)apply(resizeObserve,observer,[body]);return()=>apply(resizeDisconnect,observer,[])},
observeStyleActivity:(callback)=>{apply(setAdd,styleCallbacks,[callback]);return()=>apply(setDelete,styleCallbacks,[callback])},
onDocumentLoad:(callback)=>listen(document,"load",callback,true),
onFontsSettled:(callback)=>{if(!fontReady)return()=>{};let active=true;const notify=()=>{if(active)callback()},stopLoading=listen(fonts,"loading",notify),stopDone=listen(fonts,"loadingdone",notify),stopError=listen(fonts,"loadingerror",notify);apply(promiseThen,apply(fontReady,fonts,[]),[notify]);return()=>{active=false;stopLoading();stopDone();stopError()}},
onFrameDetach:(callback)=>listen(window,"pagehide",callback,{once:true}),
onWindowResize:(callback)=>listen(window,"resize",callback,{passive:true}),onWindowScroll:(callback)=>listen(window,"scroll",callback,{capture:true,passive:true}),
parentElement:(element)=>apply(nodeParent,element,[]),
pseudoContent:(element)=>({before:value(style(element,"::before"),"content"),after:value(style(element,"::after"),"content")}),
rect,
scheduleFrame:(callback)=>{const id=requestFrame(callback);return()=>cancelFrame(id)},scheduleQuiet:(delay,callback)=>{const id=setTimer(callback,delay);return()=>clearTimer(id)},
scrollHeight:(element)=>apply(elementScrollHeight,element,[]),scrollWidth:(element)=>apply(elementScrollWidth,element,[]),
style:(element)=>{const current=style(element);return{boxShadow:value(current,"box-shadow"),clipPath:value(current,"clip-path"),display:value(current,"display"),filter:value(current,"filter"),opacity:value(current,"opacity"),outlineStyle:value(current,"outline-style"),outlineWidth:value(current,"outline-width"),overflowX:value(current,"overflow-x"),overflowY:value(current,"overflow-y"),position:value(current,"position"),textShadow:value(current,"text-shadow"),transform:value(current,"transform"),visibility:value(current,"visibility")}},
styleRealmTrusted:()=>{if(styleRealmTrusted&&ownedSealed&&(!ownedIdentityTrusted()||!ownedPaintTrusted())){rejectStyleRealm();if(!ownedIdentityTrusted())quarantineOwnedStructure()}return styleRealmTrusted},
tagName:(element)=>apply(elementTag,element,[]),text:boundedText,
viewport:()=>{const root=apply(documentRoot,document,[]);return{clientWidth:root?apply(elementClientWidth,root,[]):0,height:apply(windowHeight,window,[]),width:apply(windowWidth,window,[])}},
performOverlayUpdate:performOwnedUpdate
};
const channel=new MessageChannel(),tag="lucid-overlay-"+crypto.randomUUID().replaceAll("-","");
window.parent.postMessage({source:"lucid-overlay-bootstrap",type:"private-channel",version:1},"*",[channel.port2]);
const launch=(module)=>{const run=()=>module.bootOverlay(channel.port1,tag,capabilities);if(apply(documentReady,document,[])==="loading")listen(document,"DOMContentLoaded",run,{once:true});else run()};
const current=document.currentScript;apply(promiseThen,import(${JSON.stringify(moduleUrl)}),[launch]);current?.remove()
})();`;
  return `<script${attr}>${boot}</script>\n`;
};

/** After a conventional doctype when present, else at byte zero. A script in
 * this parser position is assigned to the implicit head and executes before a
 * later explicit head or body is parsed. */
const earlyBootstrapIndex = (html: string): number =>
  /^(?:(?:\s+)|(?:<!--[\s\S]*?-->))*<!doctype\b(?:[^>"']|"[^"]*"|'[^']*')*>/i.exec(html)?.[0]
    .length ?? 0;

/** The source index of the true `</body>`, or -1 when the document has none. */
export const bodyCloseIndex = (html: string): number => closeIndexOf(html, "body");

/** Inject the overlay bootstrap into an artifact HTML document. */
export const injectOverlay = (
  artifactHtml: string,
  base = "",
  nonce?: string,
  origin?: string,
): string => {
  const early = earlyBootstrapIndex(artifactHtml);
  const hasDeclarativeShadow = /\bshadowrootmode\s*=/i.test(maskHiddenText(artifactHtml));
  return (
    artifactHtml.slice(0, early) +
    overlayBootstrapMarkup(base, nonce, origin, hasDeclarativeShadow) +
    artifactHtml.slice(early)
  );
};

/** A CSP meta in the VISIBLE source: its whole-tag span and its policy. */
interface CspMeta {
  readonly start: number;
  readonly end: number;
  readonly policy: string;
}

const CSP_META = /<meta\b[^>]*http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi;
/** `content="…"` as its OWN attribute: a boundary before the name, so a
 *  `data-content="decoy"` never stands in for the policy. */
const CONTENT_ATTR = /(?:^|[\s"'/])content\s*=\s*("([^"]*)"|'([^']*)')/i;

/** The named character references a policy can plausibly arrive escaped in
 *  (an escaper that ran over the attribute value). The browser decodes before
 *  parsing the policy, so the lift must too. */
const decodeEntities = (s: string): string =>
  s
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, "&");

const findCspMetas = (html: string): CspMeta[] => {
  if (!/content-security-policy/i.test(html)) return []; // the common fast path
  const mask = maskHiddenText(html);
  const metas: CspMeta[] = [];
  for (const m of html.matchAll(CSP_META)) {
    // Real markup only: a CSP meta quoted inside a comment, a textarea, or an
    // attribute value is text, and the mask has blanked it there. Case-
    // insensitively - `<META>` is ordinary hand-written HTML, and a
    // case-sensitive check here left the meta in the document and the
    // bootstrap blocked (the exact defect this closes).
    if (!/^<meta/i.test(mask.slice(m.index, m.index + 5))) continue;
    const content = CONTENT_ATTR.exec(m[0]);
    const raw = content?.[2] ?? content?.[3];
    if (raw === undefined) continue;
    // Newlines are legal in the attribute and illegal in a header value.
    const policy = decodeEntities(raw).replace(/\s+/g, " ").trim();
    if (policy !== "") metas.push({ start: m.index, end: m.index + m[0].length, policy });
  }
  return metas;
};

/** Directives a `<meta>` policy is REQUIRED to ignore (CSP3 §3.3): lifting
 *  them into a real header would turn them on for the first time. `report-uri`
 *  is the sharp one - it is a network egress the document declared inert, and
 *  a violation report carries the document URI and a sample. `frame-ancestors`
 *  and `sandbox` would blank or de-script the viewer's own iframe. */
const META_IGNORED = new Set(["report-uri", "report-to", "frame-ancestors", "sandbox"]);

/** The directive that actually governs an ELEMENT of this kind: the `-elem`
 *  form takes precedence over the plain one when present. */
const governingDirective = (parts: readonly string[], kind: "script" | "style"): string =>
  parts.some((p) => p.toLowerCase().startsWith(`${kind}-src-elem`))
    ? `${kind}-src-elem`
    : `${kind}-src`;

interface Granted {
  readonly policy: string;
  /** A nonce was added, so the bootstrap markup must carry it. */
  readonly nonce: boolean;
}

/**
 * Permit Lucid's bootstrap under one policy, changing as little as possible.
 *
 * The rule that makes this safe: a nonce-source in a list makes the browser
 * IGNORE `'unsafe-inline'` (CSP3 §6.7.3.2). An artifact that granted itself
 * `'unsafe-inline'` is relying on it - self-contained artifacts are inline
 * `<style>` and inline `<script>` by construction - so a nonce there would
 * silently strip the page's own styling and scripts. In that case the inline
 * bootstrap is ALREADY permitted, and only the module element needs a source:
 * the serving ORIGIN, added without touching anything else.
 */
const grantBootstrap = (policy: string, origin: string, nonce: string): Granted => {
  const parts = policy
    .split(";")
    .map((p) => p.trim())
    .filter((p) => p !== "" && !META_IGNORED.has(p.split(/\s+/)[0]?.toLowerCase() ?? ""));
  const directive = governingDirective(parts, "script");
  const at = parts.findIndex((p) => {
    const name = p.split(/\s+/)[0]?.toLowerCase();
    return name === directive;
  });
  // Nothing constrains scripts (no directive AND no default-src): the
  // bootstrap already runs; leave the policy exactly as written.
  const dflt = parts.find((p) => (p.split(/\s+/)[0]?.toLowerCase() ?? "") === "default-src");
  if (at === -1 && dflt === undefined) return { policy: parts.join("; "), nonce: false };

  const existing = at === -1 ? (dflt as string) : (parts[at] as string);
  const sources = existing
    .split(/\s+/)
    .slice(1)
    .filter((src) => src.toLowerCase() !== "'none'");
  const keepsInline = sources.some((src) => src.toLowerCase() === "'unsafe-inline'");
  const granted = keepsInline ? [...sources, origin] : [...sources, `'nonce-${nonce}'`, origin];
  const rebuilt = [directive, ...granted].join(" ");
  if (at === -1) parts.push(rebuilt);
  else parts[at] = rebuilt;
  return { policy: parts.join("; "), nonce: !keepsInline };
};

export interface InjectedDocument {
  readonly body: string;
  /** Extra response headers: the lifted CSP, when the document declared one. */
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * The one injection path both servers share (#42, D-005).
 *
 * A document-authored CSP meta and an injected bootstrap cannot coexist as-is:
 * header and meta policies INTERSECT, so the meta blocks the injected module
 * no matter what a header allows. The meta is therefore LIFTED into the
 * response header - minus the directives a meta is required to ignore, so the
 * lift never turns on something the document could not have meant - with the
 * script directive granting the bootstrap the narrowest thing that works: the
 * serving origin when the author kept `'unsafe-inline'` (so their own inline
 * content keeps working), a nonce otherwise. Styles are not touched at all:
 * the overlay adopts constructed stylesheets, which `style-src` does not
 * govern. No meta, no header: an unrestricted artifact stays unrestricted.
 */
export const renderInjected = (artifactHtml: string, base = "", origin = ""): InjectedDocument => {
  const metas = findCspMetas(artifactHtml);
  if (metas.length === 0) {
    return { body: injectOverlay(artifactHtml, base, undefined, origin), headers: {} };
  }
  const nonce = randomUUID().replace(/-/g, "");
  let stripped = artifactHtml;
  for (const m of [...metas].sort((a, b) => b.start - a.start)) {
    stripped = stripped.slice(0, m.start) + stripped.slice(m.end);
  }
  const granted = metas.map((m) => grantBootstrap(m.policy, origin || "'self'", nonce));
  // Comma-joined is the field-combining form: several policies all enforce,
  // exactly as several metas did.
  const lifted = granted.map((g) => g.policy).join(", ");
  return {
    body: injectOverlay(stripped, base, granted.some((g) => g.nonce) ? nonce : undefined, origin),
    headers: { "content-security-policy": lifted },
  };
};
