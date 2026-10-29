/** Runs inside the inspected page, including native desktop tabs connected through CDP. */
export const DESIGN_OVERLAY_SCRIPT = String.raw`(() => {
  if (window.__t3Design) return;
  const host = document.createElement('div');
  host.setAttribute('data-t3-design-ui', '');
  host.style.cssText = 'position:fixed;top:0;bottom:0;right:0;z-index:2147483647;width:340px;max-width:70vw;';
  const dockStyle=document.createElement('style');
  dockStyle.textContent='html{width:calc(100% - var(--t3-designer-width,340px))!important;min-width:0!important}';
  const previousWidth=document.documentElement.style.getPropertyValue('--t3-designer-width');
  document.head.append(dockStyle);
  const root = host.attachShadow({mode:'open'});
  root.innerHTML = '<style>:host{color-scheme:light;font:12px system-ui;color:#24262a}*{box-sizing:border-box}section{height:100%;overflow:auto;background:#fafafa;border:1px solid #d5d7dc;border-radius:8px;box-shadow:0 8px 28px #0002}header{padding:16px;border-bottom:1px solid #dedfe3;position:sticky;top:0;background:#fafafa;z-index:2}.tabs{display:flex;gap:6px;margin-top:12px}.tabs button{flex:1}.tabs button[aria-pressed=true]{background:#e8f0ff;border-color:#3277ed;color:#184eaa}.menu{position:relative}.menu>button{width:100%;text-align:left;min-height:32px}.options{position:absolute;top:100%;left:0;right:0;z-index:3;max-height:180px;overflow:auto;background:#fff;border:1px solid #afb5c0;border-radius:5px;box-shadow:0 4px 12px #0002}.options button{display:block;width:100%;border:0;border-radius:0;text-align:left}.options button:hover,.options button:focus-visible{background:#e8f0ff}.swatches{display:flex;gap:4px;margin:4px 0 10px 91px}.swatches button{width:20px;height:20px;padding:0;border:1px solid #91969f;border-radius:4px}.swatches button[disabled]{opacity:.4}[hidden]{display:none!important}h2{font-size:15px;margin:0 0 8px}p{line-height:1.5;margin:6px 0}label{display:grid;grid-template-columns:83px 1fr;align-items:center;gap:8px;margin:9px 0;color:#535660}input,select,textarea,button{font:inherit;color:#24262a;background:#fff;border:1px solid #d5d7dc;border-radius:5px;padding:7px;min-width:0}input,select{width:100%;height:32px}input[type=color]{padding:3px}textarea{width:100%;resize:vertical}button{cursor:pointer}button:disabled,input:disabled,select:disabled{opacity:.5;cursor:default}input:focus-visible,select:focus-visible,textarea:focus-visible,button:focus-visible,summary:focus-visible{outline:2px solid #3277ed;outline-offset:2px}.status{color:#295d37}.scope{color:#60636b;font-size:11px;overflow-wrap:anywhere}.fields{display:none}details{border-bottom:1px solid #dedfe3;padding:0 16px 12px}details:not([open]){padding-bottom:0}summary{font-weight:600;font-size:13px;cursor:pointer;padding:14px 0}.box{position:relative;display:grid;grid-template-columns:48px 1fr 48px;gap:7px;align-items:center;background:#edeef0;border:1px solid #d5d7dc;border-radius:5px;padding:24px 8px 8px}.box .box{background:#fafafa;grid-template-columns:44px 1fr 44px;gap:4px;padding:22px 4px 4px}.box input{text-align:center;padding:4px;font-size:11px}.top,.bottom{grid-column:2}.left{grid-column:1}.right{grid-column:3}.boxname{position:absolute;top:5px;left:8px;font-size:10px;color:#626670}.box label{display:contents}.notearea{padding:16px}.notearea button{width:100%;margin-top:8px}.hint{font-size:11px;color:#60636b;margin-bottom:10px}.picked{font-family:ui-monospace,monospace;font-size:11px;color:#2865bd;overflow-wrap:anywhere}.crumbs{display:flex;flex-wrap:wrap;gap:4px;margin-top:10px}.crumbs button{padding:3px 6px}.resize{position:absolute;left:-5px;top:0;bottom:0;width:10px;cursor:ew-resize;touch-action:none}.segments{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:3px;margin:6px 0}.segments button{flex:1;padding:6px 3px}.segments button[aria-pressed=true]{border-color:#3277ed;background:#e8f0ff}.dimension{display:flex;gap:4px;position:relative}.dimension input{flex:1}.dimension button{padding:3px;min-width:38px}.note-list{padding:0;list-style:none}.note-list button{width:100%;text-align:left;margin:4px 0}.note-list img{max-width:100%;border-radius:4px}.save-actions{display:flex;gap:6px}.save-actions button{padding:4px 8px}.link-spacing{display:flex;align-items:center;gap:6px;margin:8px 0}.link-spacing input{width:auto;height:auto}</style><div class="resize" role="separator" aria-label="Resize Designer" tabindex="0" aria-orientation="vertical"></div><section aria-label="Design inspector"><header><h2>Designer</h2><div class="save-actions"><button class="undo">Undo</button><button class="redo">Redo</button></div><p class="picked">No element selected</p><nav class="crumbs" aria-label="Selected element ancestors"></nav><p class="status" role="status">Select an element on the page.</p><p class="scope">Connected JSX elements · source autosave</p><div class="tabs"><button class="style" aria-pressed="true">Style</button><button class="annotate" aria-pressed="false">Annotate</button></div></header><div class="notearea" hidden><p class="hint">Changes and notes attach to your next prompt. Double-click selected text to edit it.</p><textarea aria-label="Note for agent" placeholder="Describe what else should change…" rows="3"></textarea><button class="note">Attach to prompt</button><h3>Pending notes</h3><ol class="note-list"></ol></div><div class="fields"></div></section>';
  const status = root.querySelector('.status');
  const scope = root.querySelector('.scope');
  const fields = root.querySelector('.fields');
  const notes = root.querySelector('textarea');
  let dockWidth=340;
  const resizeDock=(width)=>{dockWidth=Math.min(innerWidth*.7,Math.max(260,width));host.style.width=dockWidth+'px';document.documentElement.style.setProperty('--t3-designer-width',dockWidth+'px');};
  resizeDock(dockWidth);
  const handle=root.querySelector('.resize');
  handle.onpointerdown=event=>{handle.setPointerCapture(event.pointerId);};
  handle.onpointermove=event=>{if(handle.hasPointerCapture(event.pointerId))resizeDock(innerWidth-event.clientX);};
  handle.onpointerup=event=>handle.releasePointerCapture(event.pointerId);
  handle.onkeydown=event=>{if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();resizeDock(dockWidth+(event.key==='ArrowLeft'?20:-20));}};
  let mode = 'style';
  const showMode = (next) => {
    mode = next;
    fields.style.display=mode==='style'&&element?'block':'none';
    root.querySelector('.notearea').hidden=mode!=='annotate';
    root.querySelector('.style').setAttribute('aria-pressed',String(mode==='style'));
    root.querySelector('.annotate').setAttribute('aria-pressed',String(mode==='annotate'));
    if(mode==='annotate')notes.focus();
  };
  root.querySelector('.style').onclick=()=>showMode('style');
  root.querySelector('.annotate').onclick=()=>showMode('annotate');
  let element = null;
  let selection = null;
  let request = null;
  let originalText = '';
  let originalEditable = null;
  let originalOutline = '';
  let timer = null;
  let rollback = null;
  let wantsTextEdit = false;
  const controls = [];
  const dimensionUnits=new Map();
  const linked={padding:false,margin:false};
  let displayedNotes=[];
  let presented=false;
  const readyId=crypto.randomUUID();
  const markers=document.createElement('div');markers.setAttribute('data-t3-design-ui','');
  markers.style.cssText='position:fixed;inset:0;pointer-events:none;z-index:2147483646';
  const hover=document.createElement('div');hover.style.cssText='position:fixed;pointer-events:none;border:1px dashed #3277ed;background:#3277ed0a;display:none';markers.append(hover);
  const hovered=event=>{const target=event.target;if(!(target instanceof HTMLElement)||host.contains(target)||target===host||markers.contains(target)){hover.style.display='none';return;}const r=target.getBoundingClientRect();Object.assign(hover.style,{display:'block',left:r.left+'px',top:r.top+'px',width:r.width+'px',height:r.height+'px'});};
  const positionPins=()=>{for(const pin of markers.querySelectorAll('button')){const note=displayedNotes.find(n=>n.id===pin.dataset.id);let target;try{target=note?.target?.selector?document.querySelector(note.target.selector):null;}catch{}if(!target||note.pageUrl!==location.href){pin.hidden=true;continue;}const r=target.getBoundingClientRect();pin.hidden=false;pin.style.left=Math.max(0,r.left)+'px';pin.style.top=Math.max(0,r.top)+'px';}};
  const renderNotes=(entries)=>{displayedNotes=entries;root.querySelector('.note-list').replaceChildren();markers.querySelectorAll('button').forEach(pin=>pin.remove());entries.forEach((note,index)=>{const li=document.createElement('li');const button=document.createElement('button');button.textContent=(index+1)+'. '+note.comment;button.onclick=()=>{if(note.pageUrl!==location.href){status.textContent='This note belongs to '+note.pageUrl;return;}let target;try{target=document.querySelector(note.target?.selector||'');}catch{}if(target instanceof HTMLElement){target.scrollIntoView({block:'center'});selectElement(target);}showMode('annotate');};li.append(button);const remove=document.createElement('button');remove.textContent='Remove note';remove.onclick=()=>{if(request)return;request={_tag:'removeNote',id:id(),noteId:note.id};status.textContent='Removing note…';busy(true);};li.append(remove);if(note.screenshot){const img=document.createElement('img');img.src=note.screenshot.dataUrl;img.alt='Page when note '+(index+1)+' was attached';li.append(img);}root.querySelector('.note-list').append(li);if(note.target){const pin=document.createElement('button');pin.dataset.id=note.id;pin.textContent=String(index+1);pin.setAttribute('aria-label','Annotation '+(index+1));pin.style.cssText='all:initial;box-sizing:border-box;font:12px system-ui;text-align:center;position:fixed;pointer-events:auto;background:#3277ed;color:white;border:2px solid white;border-radius:50%;width:26px;height:26px;cursor:pointer';pin.onclick=()=>button.click();markers.append(pin);}});positionPins();};
  const selectorFor = (node) => {
    const parts = [];
    for (let current=node; current && current !== document.documentElement; current=current.parentElement) {
      if (current.id) { parts.unshift('#'+CSS.escape(current.id)); break; }
      let part=current.tagName.toLowerCase();
      const siblings=current.parentElement ? Array.from(current.parentElement.children).filter(other => other.tagName===current.tagName) : [];
      if(siblings.length>1) part+=':nth-of-type('+(siblings.indexOf(current)+1)+')';
      parts.unshift(part);
    }
    return parts.join(' > ');
  };
  const id = () => crypto.randomUUID();
  const busy = (value) => {
    controls.forEach(input => input.disabled = value || !selection);
    root.querySelector('.note').disabled = value;
    root.querySelectorAll('.options button,.swatches button,.segments button,.dimension button').forEach(button=>button.disabled=value||!selection);
  };
  const restoreEditing = () => {
    if (!element) return;
    if(originalEditable===null) element.removeAttribute('contenteditable');
    else element.setAttribute('contenteditable',originalEditable);
    element.style.outline=originalOutline;
  };
  const setText = () => {
    clearTimeout(timer);
    if (!element || !selection || request) return;
    const value=element.textContent || '';
    if(value===originalText) return;
    const before=originalText;
    rollback=() => { if(element) element.textContent=before; };
    request={_tag:'edit',id:id(),selectionId:selection.id,property:'textContent',previousValue:before,value};
    status.textContent='Saving to source…';
    busy(true);
    element.setAttribute('contenteditable','false');
  };
  const input = () => { clearTimeout(timer); timer=setTimeout(setText,700); };
  const blur = () => setText();
  const detach = () => {
    clearTimeout(timer);
    if(element) {element.removeEventListener('input',input);element.removeEventListener('blur',blur);}
    restoreEditing();
  };
  const showValues = () => {
    if(!element) return;
    const style=getComputedStyle(element);
    for(const control of controls) {
      const value=style[control.dataset.property] || '';
      control.value=value;
      const unit=dimensionUnits.get(control);
      if(unit){const match=value.match(/^(-?(?:\d+\.?\d*|\.\d+))(px|rem|em|%|vh|vw)?$/);control.value=match?match[1]:value;unit.textContent=match?.[2]||'px';}
      root.querySelectorAll('[data-for="'+control.dataset.property+'"]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.value===value)));
      if(control.tagName==='BUTTON')control.textContent=value||'Choose…';
    }
  };
  const groups = [
    ['Typography', [['fontFamily','Font',['system-ui','sans-serif','serif','monospace']],['fontWeight','Weight',['300','400','500','600','700','800']],['fontSize','Size'],['lineHeight','Line height'],['color','Color'],['textAlign','Align',['left','center','right','justify']],['fontStyle','Style',['normal','italic']],['textDecoration','Decoration',['none','underline','line-through']],['letterSpacing','Tracking'],['textTransform','Case',['none','uppercase','lowercase','capitalize']]]],
    ['Layout', [['display','Display',['block','flex','grid','inline-block','inline','none']],['flexDirection','Direction',['row','column','row-reverse','column-reverse']],['justifyContent','Justify',['normal','flex-start','center','flex-end','space-between','space-around','space-evenly']],['alignItems','Align items',['normal','stretch','flex-start','center','flex-end','baseline']],['gap','Gap'],['alignSelf','Align self',['auto','stretch','flex-start','center','flex-end','baseline']],['flexGrow','Grow'],['flexShrink','Shrink'],['order','Order']]],
    ['Spacing', []],
    ['Size', [['width','Width'],['height','Height'],['minWidth','Min width'],['maxWidth','Max width'],['minHeight','Min height'],['maxHeight','Max height'],['overflow','Overflow',['visible','hidden','clip','scroll','auto']],['boxSizing','Box sizing',['border-box','content-box']]]],
    ['Image', [['objectFit','Image fit',['fill','contain','cover','none','scale-down']],['objectPosition','Image position']]],
    ['Appearance', [['backgroundColor','Background'],['borderRadius','Radius'],['borderWidth','Border width'],['borderStyle','Border style',['none','solid','dashed','dotted']],['borderColor','Border color']]]
  ];
  const addControl = (parent, property, label, options) => {
    const row=document.createElement('label');row.textContent=label;
    const control=document.createElement(options?'button':'input');
    let container=control;
    if(options){
      container=document.createElement('div');container.className='menu';
      const menu=document.createElement('div');menu.className='options';menu.hidden=true;menu.setAttribute('role','listbox');menu.setAttribute('aria-label',label+' options');
      control.type='button';control.setAttribute('aria-haspopup','listbox');control.setAttribute('aria-expanded','false');
      const close=()=>{menu.hidden=true;control.setAttribute('aria-expanded','false');};
      control.onclick=()=>{const open=menu.hidden;root.querySelectorAll('.options').forEach(other=>other.hidden=true);menu.hidden=!open;control.setAttribute('aria-expanded',String(open));};
      menu.onkeydown=event=>{if(event.key==='Escape'){event.stopPropagation();close();control.focus();}};
      for(const value of options){const option=document.createElement('button');option.type='button';option.dataset.value=value;option.setAttribute('role','option');option.textContent=value;option.onclick=()=>{control.value=value;control.textContent=value;close();control.dispatchEvent(new Event('change'));};menu.append(option);}
      container.append(control,menu);
    }
    if(!options&&/^(fontSize|letterSpacing|gap|borderRadius|borderWidth|width|height|minWidth|maxWidth|minHeight|maxHeight)$/.test(property)){
      container=document.createElement('div');container.className='dimension';
      const unit=document.createElement('button');unit.type='button';unit.textContent='px';unit.setAttribute('aria-label',label+' unit');
      const choices=document.createElement('div');choices.className='options';choices.hidden=true;choices.setAttribute('role','listbox');choices.setAttribute('aria-label',label+' units');
      unit.setAttribute('aria-haspopup','listbox');unit.onclick=()=>{choices.hidden=!choices.hidden;unit.setAttribute('aria-expanded',String(!choices.hidden));};
      for(const value of ['px','rem','em','%','vw','vh']){const option=document.createElement('button');option.type='button';option.textContent=value;option.setAttribute('role','option');option.onclick=()=>{unit.textContent=value;choices.hidden=true;unit.setAttribute('aria-expanded','false');control.dispatchEvent(new Event('change'));};choices.append(option);}
      container.append(choices);
      control.inputMode='decimal';dimensionUnits.set(control,unit);container.append(control,unit);
    }
    control.dataset.property=property;control.setAttribute('aria-label',label);control.title=label+' · CSS values such as 16px, 1rem, 100% or auto';
    control.addEventListener('change',()=>{
      if(!element || !selection || request) return;
      const effectiveProperty=(property.startsWith('padding')&&linked.padding)?'padding':(property.startsWith('margin')&&linked.margin)?'margin':property;
      const previousValue=getComputedStyle(element)[effectiveProperty];
      let value=control.value.trim();
      if(dimensionUnits.has(control)&&/^-?(?:\d+\.?\d*|\.\d+)$/.test(value))value+=dimensionUnits.get(control).textContent;
      if(/^(fontSize|letterSpacing|padding|margin|gap|borderRadius|borderWidth|width|height|minWidth|maxWidth|minHeight|maxHeight)/.test(property)&&/^-?(?:\d+\.?\d*|\.\d+)$/.test(value))value+='px';
      if(value===previousValue)return;
      if(!CSS.supports(property.replace(/[A-Z]/g,c=>'-'+c.toLowerCase()),value)) {status.textContent='Enter a valid CSS value, including a unit when needed.';showValues();return;}
      const prior=element.getAttribute('style');
      const editedElement=element;
      element.style[effectiveProperty]=value;
      rollback=()=>{if(prior===null)editedElement.removeAttribute('style');else editedElement.setAttribute('style',prior);};
      request={_tag:'edit',id:id(),selectionId:selection.id,property:effectiveProperty,previousValue,value};
      status.textContent='Saving to source…';busy(true);
    });
    controls.push(control);row.append(container);parent.append(row);
    if(property==='textAlign'||property==='justifyContent'||property==='alignItems'){
      row.hidden=true;const segments=document.createElement('div');segments.className='segments';segments.setAttribute('aria-label',label);const caption=document.createElement('p');caption.textContent=label;parent.append(caption);
      for(const value of options){const button=document.createElement('button');button.type='button';button.dataset.for=property;button.dataset.value=value;button.textContent=({'flex-start':'Start','flex-end':'End','space-between':'Between','space-around':'Around','space-evenly':'Evenly'})[value]||value;button.onclick=()=>{control.value=value;control.dispatchEvent(new Event('change'));};segments.append(button);}parent.append(segments);
    }
    if(property==='color'||property==='backgroundColor'||property==='borderColor'){
      const swatches=document.createElement('div');swatches.className='swatches';
      for(const color of ['#262923','#ffffff','#3277ed','#dc3545','#2a7d46','#f0b429','transparent']){
        const swatch=document.createElement('button');swatch.type='button';swatch.style.background=color;swatch.setAttribute('aria-label',label+' '+color);swatch.title=color;
        if(color==='transparent')swatch.textContent='×';
        swatch.onclick=()=>{control.value=color;control.dispatchEvent(new Event('change'));};swatches.append(swatch);
      }
      parent.append(swatches);
    }
    return control;
  };
  for(const [name, definitions] of groups){
    const group=document.createElement('details');group.open=name==='Typography'||name==='Spacing';group.dataset.group=name;
    const summary=document.createElement('summary');summary.textContent=name;group.append(summary);fields.append(group);
    for(const [property,label,options] of definitions)addControl(group,property,label,options);
    if(name==='Spacing'){
      for(const prefix of ['padding','margin']){const label=document.createElement('label');label.className='link-spacing';const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.setAttribute('aria-label','Link '+prefix+' sides');checkbox.onchange=()=>{linked[prefix]=checkbox.checked;};label.append(checkbox,document.createTextNode('Link '+prefix+' sides'));group.append(label);}
      const margin=document.createElement('div');margin.className='box';margin.innerHTML='<span class="boxname">MARGIN</span>';group.append(margin);
      const padding=document.createElement('div');padding.className='box';padding.innerHTML='<span class="boxname">PADDING</span>';
      for(const [parent,prefix] of [[margin,'margin'],[padding,'padding']]){
        const top=addControl(parent,prefix+'Top',prefix+' top');top.className='top';
        const left=addControl(parent,prefix+'Left',prefix+' left');left.className='left';
        if(prefix==='margin')parent.append(padding);else {const center=document.createElement('span');center.textContent='content';center.style.cssText='text-align:center;font-size:10px;color:#60636b';parent.append(center);}
        const right=addControl(parent,prefix+'Right',prefix+' right');right.className='right';
        const bottom=addControl(parent,prefix+'Bottom',prefix+' bottom');bottom.className='bottom';
        for(const label of parent.querySelectorAll(':scope > label'))label.firstChild.remove();
      }
    }
  }
  const choose = (event) => {
    if(event.composedPath().includes(host)||event.composedPath().includes(markers))return;
    const target=event.target;
    if(!(target instanceof HTMLElement))return;
    if(target===element&&element.isContentEditable)return;
    event.preventDefault();event.stopImmediatePropagation();selectElement(target);
  };
  let selectedSelector=null;
  const selectElement=(target)=>{
    if(request||target===host||target===document.documentElement||(target===element&&selection))return;
    setText();if(request)return;
    root.querySelectorAll('.options').forEach(menu=>menu.hidden=true);
    refreshTarget=null;detach();element=target;selection=null;
    originalText=target.textContent || '';
    originalEditable=target.getAttribute('contenteditable');originalOutline=target.style.outline;
    target.style.outline='2px solid Highlight';
    const sourceHints=[...new Set(Array.from(target.querySelectorAll('[data-source-file]')).map(child=>child.getAttribute('data-source-file')))];
    let mapping=null;try{mapping=JSON.parse(target.getAttribute('data-t3ch-source')||'null');}catch{}
    const mapped=mapping&&typeof mapping.file==='string'&&Number.isSafeInteger(mapping.index)&&mapping.index>=0&&typeof mapping.revision==='string';
    const picked={tagName:target.tagName.toLowerCase(),text:originalText,selector:selectorFor(target),pageUrl:location.href,
      sourceFile:mapped?mapping.file:target.getAttribute('data-source-file') || target.getAttribute('data-file-name') || (sourceHints.length===1?sourceHints[0]:null),
      ...(mapped?{sourceIndex:mapping.index,sourceRevision:mapping.revision}:{})};
    selectedSelector=picked.selector;
    request={_tag:'select',id:id(),target:picked};
    root.querySelector('.picked').textContent=picked.selector;
    hover.style.display='none';
    const crumbs=root.querySelector('.crumbs');crumbs.replaceChildren();
    const ancestors=[];for(let node=target;node&&node!==document.body;node=node.parentElement)ancestors.unshift(node);
    for(const node of ancestors.slice(-5)){const button=document.createElement('button');button.textContent=node.tagName.toLowerCase()+(node.id?'#'+node.id:'');button.setAttribute('aria-label','Select '+button.textContent);button.onclick=()=>selectElement(node);crumbs.append(button);}
    const image=target.tagName==='IMG';const container=target.children.length>0;
    for(const group of fields.querySelectorAll('[data-group]')){group.hidden=(group.dataset.group==='Image'&&!image)||(group.dataset.group==='Typography'&&(image||container));if(group.dataset.group==='Layout')group.open=container;}

    showValues();fields.style.display=mode==='style'?'block':'none';status.textContent='Finding editable source…';scope.textContent='Computed styles · Checking source before enabling edits';busy(true);
  };
  const doubleClick = (event) => {
    if(event.composedPath().includes(host) || !element)return;
    event.preventDefault();event.stopImmediatePropagation();
    if(!selection || request){wantsTextEdit=true;return;}
    if(selection.canEditText===false){status.textContent='This text is generated by code. Style controls are available; use Annotate to request text changes.';return;}
    if(element.children.length){status.textContent='This container has child elements. Select its text child to edit text, or use layout controls.';return;}
    element.setAttribute('contenteditable','plaintext-only');element.focus();
    status.textContent='Editing text. Changes save after a pause.';
  };
  root.querySelector('.note').addEventListener('click',()=>{
    if(request || !notes.value.trim())return;
    request={_tag:'note',id:id(),target:element?{selector:selectorFor(element),tagName:element.tagName.toLowerCase(),text:(element.textContent||'').slice(0,1000),relativePath:selection?.relativePath||null}:null,comment:notes.value.trim()+(element?'\nTarget: '+(selection?.relativePath||'source not mapped')+' · '+selectorFor(element)+' · '+(element.textContent||'').slice(0,120):''),pageUrl:location.href};busy(true);
  });
  let refreshTarget=null;
  const refresh=(restored)=>{
    refreshTarget=element?{selector:selectedSelector,...restored}:null;
    detach();selection=null;request=null;rollback=null;busy(true);
    status.textContent=element?'Source restored. Waiting for the project to hot reload…':'Source restored. Select an element to continue.';
  };
  const reconnect=()=>{
    if(!refreshTarget||request)return;
    const target=document.querySelector(refreshTarget.selector);
    if(!(target instanceof HTMLElement))return;
    let mapping=null;try{mapping=JSON.parse(target.getAttribute('data-t3ch-source')||'null');}catch{}
    if(mapping?.file===refreshTarget.sourceFile&&mapping.revision!==refreshTarget.sourceRevision)return;
    refreshTarget=null;element=null;selectElement(target);positionPins();
  };
  const history=(direction)=>{if(request)return;request={_tag:'history',id:id(),direction};busy(true);status.textContent='Updating source…';};
  root.querySelector('.undo').onclick=()=>history('undo');root.querySelector('.redo').onclick=()=>history('redo');
  const keydown=(event)=>{
    if(event.key==='Escape'&&event.composedPath().includes(host)){root.querySelectorAll('.options').forEach(menu=>menu.hidden=true);root.querySelectorAll('[aria-expanded]').forEach(button=>button.setAttribute('aria-expanded','false'));}
    if(event.key==='Escape' && element && element.isContentEditable){setText();restoreEditing();}
    if(event.key==='Enter' && element && element.isContentEditable && !event.shiftKey){event.preventDefault();setText();restoreEditing();}
    if((event.ctrlKey||event.metaKey) && event.key.toLowerCase()==='z' && !event.composedPath().includes(host) && !element?.isContentEditable) {
      event.preventDefault();event.stopImmediatePropagation();
      if(request)return;request={_tag:'history',id:id(),direction:event.shiftKey?'redo':'undo'};busy(true);
      status.textContent='Updating source…';
    }
  };
  document.addEventListener('click',choose,true);
  document.addEventListener('dblclick',doubleClick,true);
  document.addEventListener('keydown',keydown,true);
  document.addEventListener('pointermove',hovered,true);
  document.addEventListener('scroll',positionPins,true);window.addEventListener('resize',positionPins);
  document.documentElement.append(host,markers);
  window.__t3Design={
    showMode,
    present:(state)=>{presented=true;root.querySelector('.undo').disabled=!state.canUndo||!!request;root.querySelector('.redo').disabled=!state.canRedo||!!request;if(JSON.stringify(displayedNotes)!==JSON.stringify(state.notes))renderNotes(state.notes);},
    poll:()=>{reconnect();return request||(presented?null:{_tag:'ready',id:readyId});},
    flush:()=>{setText();return request;},
    ack:(result)=>{
      if(!request || result.id!==request.id)return;
      const kind=request._tag;
      if(result.error){if(rollback)rollback();selection=null;status.textContent=kind==='select'?'Source lookup failed. '+result.error:result.error;if(element)showValues();fields.style.display=mode==='style'&&element?'block':'none';scope.textContent='Computed styles · Read only until source can be mapped. Use Annotate to request changes.';}
      else if(result.selection){
        selection=result.selection;
        if(!element || !element.isConnected){element=null;selection=null;status.textContent='Saved. Select the updated element to continue.';fields.style.display='none';request=null;rollback=null;busy(false);return;}
        if(element){
          originalText=element.textContent || '';showValues();
          element.addEventListener('input',input);element.addEventListener('blur',blur);
        }
        scope.textContent=selection.relativePath+' · Updates this source component and its instances.';
        status.textContent=kind==='select'?(selection.canEditText===false?'Adjust styles below. Text is generated by code.':'Double-click text to edit, or adjust a value.'):'Saved to source · Context attached';
        fields.style.display=mode==='style'?'block':'none';
        if(wantsTextEdit&&selection.canEditText!==false&&element&&!element.children.length){wantsTextEdit=false;element.setAttribute('contenteditable','plaintext-only');element.focus();status.textContent='Editing text. Changes save after a pause.';}
      } else if(kind==='note'){notes.value='';status.textContent='Note attached to your next message.';}else if(kind==='removeNote'){status.textContent='Note removed.';}
      request=null;rollback=null;busy(false);
    },
    stop:()=>{setText();if(request)return false;detach();document.removeEventListener('click',choose,true);document.removeEventListener('dblclick',doubleClick,true);document.removeEventListener('keydown',keydown,true);host.remove();markers.remove();dockStyle.remove();if(previousWidth)document.documentElement.style.setProperty('--t3-designer-width',previousWidth);else document.documentElement.style.removeProperty('--t3-designer-width');document.removeEventListener('pointermove',hovered,true);document.removeEventListener('scroll',positionPins,true);window.removeEventListener('resize',positionPins);delete window.__t3Design;return true;},
    refresh
  };
})()`;
