/* Login, company routing and declarative Markdown workspaces. */
let platform={chains:[],categories:[],companies:[],news:[]};
let companyId=null,chainId=null,categoryId=null,companyTab='home',testMode='mqtt';
let authMode='login',templateDraft=null,templates={},templateErrors={};
const registeredKey='iot-registered-customers-v1',templateKey='iot-company-templates-v1';
const isAdmin=()=>currentUser?.role==='admin';
const company=()=>platform.companies.find(c=>c.id===companyId);
const companyDevices=()=>devices.filter(d=>d.companyId===companyId && (isAdmin()||d.companyId===currentUser?.companyId));
const warningDevices=()=>companyDevices().filter(d=>d.online&&alarms(deviceScene(d),effective(d)).length);
/* Browser-local device inventory; all mutations stay within the developer's company. */
const inventoryKey='iot-device-inventory-v1';
let baseDevices=[],pendingDeleteId=null;
const canManageDevices=()=>['company_admin','developer'].includes(currentUser?.role)&&currentUser.companyId===companyId&&!!company();
function availableDeviceScenes(ownerId=companyId){
 if(platformBackend)return scenes;
 const owner=platform.companies.find(c=>c.id===ownerId),category=platform.categories.find(c=>c.id===owner?.categoryId);
 const ids=category?.sceneIds||baseDevices.filter(d=>d.companyId===ownerId).map(d=>d.sceneId);
 return scenes.filter(s=>ids.includes(s.id));
}
function normalizeNewDevice(input,ownerId){
 const id=typeof input?.id==='string'?input.id.trim():'',name=typeof input?.name==='string'?input.name.trim():'',location=typeof input?.location==='string'?input.location.trim():'';
 const interval=Number(input?.sampleInterval),s=availableDeviceScenes(ownerId).find(s=>s.id===input?.sceneId);
 if(!/^[A-Za-z0-9][A-Za-z0-9_-]{2,39}$/.test(id))throw new Error('设备 ID 请使用 3–40 位字母、数字、短横线或下划线。');
 if(!name||name.length>40||!location||location.length>80)throw new Error('请填写设备名称（最多 40 字）和安装位置（最多 80 字）。');
 if(!s)throw new Error('请选择本公司业务场景支持的设备类型。');
 if(!Number.isInteger(interval)||interval<1||interval>3600)throw new Error('采样周期应为 1–3600 秒的整数。');
 const d={id,companyId:ownerId,sceneId:s.id,name,location,sampleInterval:interval,online:false,values:Object.fromEntries(s.metrics.map(m=>[m.key,null])),history:Object.fromEntries(s.metrics.map(m=>[m.key,[]])),diagnostics:[{type:'WAITING_FOR_DATA',level:'info',message:'尚未接入数据，请配置实际设备采集。',source:'本地设备登记'}]};
 if(input.mqtt){
  const binding=input.mqtt,row=telemetryCandidate({topic:binding.topic,text:binding.sample});
  if(!row||row.key!==binding.key)throw new Error('MQTT 设备绑定信息无效。');
  d.mqtt={key:row.key,topic:row.topic,sample:row.text};d.metrics=row.metrics;
  d.values=Object.fromEntries(row.metrics.map(m=>[m.key,null]));d.history=Object.fromEntries(row.metrics.map(m=>[m.key,[]]));
  d.diagnostics=[];
 }
 return d;
}
function inventoryState(){
 const raw=readStorage(inventoryKey,{}),added=[],removed=[],ids=new Set(baseDevices.map(d=>d.id.toLowerCase()));
 for(const input of Array.isArray(raw?.added)?raw.added:[]){
  try{const d=normalizeNewDevice(input,input.companyId);if(ids.has(d.id.toLowerCase()))continue;ids.add(d.id.toLowerCase());added.push(d);}catch{}
 }
 for(const row of Array.isArray(raw?.removed)?raw.removed:[]){
  if(!row||removed.some(x=>x.id===row.id))continue;
  if([...baseDevices,...added].some(d=>d.id===row.id&&d.companyId===row.companyId))removed.push({id:row.id,companyId:row.companyId});
 }
 return {added,removed};
}
function reloadInventory(){if(platformBackend){devices=devices.filter(d=>d.provisioned);return;}const registered=devices.filter(d=>d.provisioned);const state=inventoryState(),previous=new Map(devices.map(d=>[d.id,d]));devices=[...baseDevices,...state.added].filter(d=>!state.removed.some(r=>r.id===d.id&&r.companyId===d.companyId));for(const d of devices)if(d.mqtt){const old=previous.get(d.id);if(old?.mqtt?.key===d.mqtt.key){d.history=old.history;d.historyTimes=old.historyTimes;d.lastMessage=old.lastMessage;}applyTelemetry(d,mqttCandidates.get(d.mqtt.key));}devices.push(...registered);}
function saveInventory(state){localStorage.setItem(inventoryKey,JSON.stringify(state));reloadInventory();}
function addCompanyDevice(input){
 if(!canManageDevices())throw new Error('仅本公司客户开发者可以管理设备。');
 const row=mqttCandidates.get(input?.mqttKey);
 if(!mqttFresh(row,Number(input?.sampleInterval)))throw new Error('请先读取 MQTT 设备，并选择最近实际收到上报的设备。');
 const d=normalizeNewDevice({...input,mqtt:{key:row.key,topic:row.topic,sample:row.text}},currentUser.companyId),state=inventoryState();
 if([...baseDevices,...state.added].some(d=>d.mqtt?.key===row.key))throw new Error('该 MQTT 设备已存在，请查看或恢复原设备。');
 if([...baseDevices,...state.added].some(row=>row.id.toLowerCase()===d.id.toLowerCase()))throw new Error('设备 ID 已存在（含已删除设备），请使用新 ID 或恢复原设备。');
 state.added.push(d);saveInventory(state);return devices.find(row=>row.id===d.id);
}
function removeCompanyDevice(id){
 if(!canManageDevices()||!companyDevices().some(d=>d.id===id))throw new Error('只能删除本公司的设备。');
 const state=inventoryState();state.removed.push({id,companyId});saveInventory(state);if(overviewDeviceId===id)overviewDeviceId=null;
}
function restoreCompanyDevice(id){
 if(!canManageDevices())throw new Error('仅本公司客户开发者可以管理设备。');
 const state=inventoryState();if(!state.removed.some(r=>r.id===id&&r.companyId===companyId))throw new Error('未找到本公司已删除的设备。');
 state.removed=state.removed.filter(r=>!(r.id===id&&r.companyId===companyId));saveInventory(state);
}
function deviceManagementPage(){
 if(!canManageDevices())return '';
 if(platformBackend)return provisionedManagementPage();
 const state=inventoryState(),deleted=[...baseDevices,...state.added].filter(d=>state.removed.some(r=>r.id===d.id&&r.companyId===companyId)),pending=companyDevices().find(d=>d.id===pendingDeleteId);
 return heading('COMPANY / DEVICE MANAGEMENT','设备管理',`${safe(company()?.name)} · 添加、删除和维护本公司设备。`,'<button class="secondary" data-route="company">返回工作台</button>')+`<div class="inventory-layout"><section class="panel inventory-form-panel"><h2>发现并添加设备</h2><div id="mqtt-discovery">${mqttDiscoveryHtml()}</div><p id="mqtt-selection" role="status">先选择已上报的设备，再填写归属信息。</p><form id="add-device-form"><input type="hidden" name="mqttKey"><fieldset disabled><label for="new-device-id">设备 ID</label><input id="new-device-id" name="id" required minlength="3" maxlength="40" pattern="[A-Za-z0-9][A-Za-z0-9_-]{2,39}" placeholder="例如 AGR-A-004"><label for="new-device-name">设备名称</label><input id="new-device-name" name="name" maxlength="40" required placeholder="请输入设备名称"><label for="new-device-scene">设备类型</label><select id="new-device-scene" name="sceneId" required>${availableDeviceScenes().map(s=>`<option value="${safe(s.id)}">${safe(s.name)}</option>`).join('')}</select><label for="new-device-location">安装位置</label><input id="new-device-location" name="location" required maxlength="80" placeholder="例如 4 号温室 · 采集点 1"><label for="new-device-interval">采样周期（秒）</label><input id="new-device-interval" name="sampleInterval" type="number" min="1" max="3600" step="1" value="30" required><p id="inventory-error" class="error" role="alert"></p><button class="primary" type="submit">添加到本公司</button></fieldset></form><p class="settings-note">监测指标由设备实际上报自动识别；保留消息仅作预览，收到新上报后才能添加。</p></section><div class="inventory-lists"><section class="panel inventory-list-panel"><div class="section-heading"><h2>公司设备 <small>${companyDevices().length} 台</small></h2><button class="secondary" id="export-inventory">导出 JSON</button></div>${pending?`<section class="inventory-confirm" role="alertdialog" aria-label="确认删除设备"><strong>删除 ${safe(effective(pending).name)}？</strong><p>设备将从当前浏览器的监测列表移除，可在下方恢复。</p><button class="danger-button" id="confirm-delete-device">确认删除</button><button class="secondary" id="cancel-delete-device">取消</button></section>`:''}<div class="table-wrap"><table class="inventory-table"><thead><tr><th>设备 / ID</th><th>类型 / 位置</th><th>操作</th></tr></thead><tbody>${companyDevices().map(raw=>{const d=effective(raw);return `<tr><td><strong>${safe(d.name)}</strong><small>${safe(d.id)}</small></td><td>${safe(deviceScene(d)?.name)}<small>${safe(d.location)}</small></td><td><button class="dashboard-text-link" data-device="${safe(d.id)}">配置</button><button class="danger-button" data-delete-device="${safe(d.id)}">删除</button></td></tr>`;}).join('')||'<tr><td colspan="3">暂无设备，请先添加设备。</td></tr>'}</tbody></table></div></section><section class="panel inventory-list-panel"><h2>已删除设备 <small>${deleted.length} 台</small></h2>${deleted.map(d=>`<div class="inventory-deleted"><span>${safe(effective(d).name)}<small>${safe(d.id)}</small></span><button class="secondary" data-restore-device="${safe(d.id)}">恢复设备</button></div>`).join('')||'<p class="muted">暂无已删除设备。</p>'}</section></div></div><p class="settings-note">添加、删除及恢复仅保存于当前浏览器，刷新后保留。导出 devices.json 并替换项目文件、重新部署后，其他浏览器才能读取更新。</p>`;
}
function bindDeviceManagement(){
 if(platformBackend){bindProvisioning();return;}
 const form=document.querySelector('#add-device-form');
 if(view==='device-manage')updateMqttDiscovery();
 if(form)form.onsubmit=event=>{event.preventDefault();try{const fields=new FormData(form);addCompanyDevice(Object.fromEntries(fields));notice='设备已绑定 MQTT，将按实际上报动态更新监测数据。';render();}catch(e){document.querySelector('#inventory-error').textContent=e.message;}};
 document.querySelectorAll('[data-delete-device]').forEach(b=>b.onclick=()=>{if(!canManageDevices())return;pendingDeleteId=b.dataset.deleteDevice;render();document.querySelector('.inventory-confirm')?.scrollIntoView({block:'center'});});
 const confirm=document.querySelector('#confirm-delete-device');if(confirm)confirm.onclick=()=>{try{removeCompanyDevice(pendingDeleteId);pendingDeleteId=null;notice='设备已移除，可在已删除设备中恢复。';render();}catch(e){notice=e.message;render();}};
 const cancel=document.querySelector('#cancel-delete-device');if(cancel)cancel.onclick=()=>{pendingDeleteId=null;render();};
 document.querySelectorAll('[data-restore-device]').forEach(b=>b.onclick=()=>{try{restoreCompanyDevice(b.dataset.restoreDevice);notice='设备已恢复。';render();}catch(e){notice=e.message;render();}});
 const exportButton=document.querySelector('#export-inventory');if(exportButton)exportButton.onclick=()=>{if(canManageDevices())downloadDeviceConfig();};
}

function registeredUsers(){
 const rows=readStorage(registeredKey,[]);
 return Array.isArray(rows)?rows.filter(u=>u&&typeof u.username==='string'&&platform.companies.some(c=>c.id===u.companyId)&&!users.some(v=>v.username===u.username||v.id===u.id)).map(u=>({...u,role:'customer'})):[];
}
function allUsers(){return [...users,...registeredUsers()];}
function normalizeUser(u){return {...u,role:validRole(u.role)};}
function logo(){return `<span class="brand-mark">${icon('device')}</span><span class="brand-name">供应链物联网平台</span>`;}
function heading(kicker,title,description,extra=''){return `<div class="page-heading"><div><div class="eyebrow">${kicker}</div><h1 tabindex="-1">${title}</h1><p>${description}</p></div>${extra}</div>`;}
function navigate(next){view=next;notice='';templateDraft=null;render();window.scrollTo(0,0);if(next==='organization'&&canOrganize())refreshOrganizationView();}
function openCompany(id){
 const c=platform.companies.find(c=>c.id===id);
 if(!c||(!isAdmin()&&id!==currentUser?.companyId))return;
 companyId=id;categoryId=c.categoryId;chainId=platform.categories.find(x=>x.id===categoryId)?.chainId;companyTab='home';navigate('company');
}
function openDevice(id){
 const d=companyDevices().find(d=>d.id===id);if(!d)return;
 deviceId=d.id;sceneId=d.sceneId;navigate('detail');
}
function openAdminDevice(id){
 if(!isAdmin())return;const d=devices.find(d=>d.id===id);
 if(!d||!platform.companies.some(c=>c.id===d.companyId))return;
 openCompany(d.companyId);openDevice(d.id);
}
function openWarnings(){const list=warningDevices();if(list.length===1)return openDevice(list[0].id);navigate('alerts');}
function parseTemplate(raw){
 const blocks=[...raw.matchAll(/```dashboard\s*\n([\s\S]*?)```/g)];
 if(blocks.length!==1)throw new Error('需要且只能有一个 dashboard JSON 配置块。');
 let cfg;try{cfg=JSON.parse(blocks[0][1]);}catch{throw new Error('dashboard 配置必须是有效的 JSON。');}
 if(!cfg||Array.isArray(cfg)||typeof cfg!=='object')throw new Error('dashboard 必须是配置对象。');
 if(typeof cfg.title!=='string'||!cfg.title.trim()||typeof cfg.subtitle!=='string')throw new Error('请填写 title 和 subtitle 字符串。');
 if(!['green','blue','purple','orange'].includes(cfg.accent))throw new Error('accent 支持 green、blue、purple、orange。');
 if(!Array.isArray(cfg.widgets)||cfg.widgets.some(w=>!['total','online','alerts'].includes(w))||new Set(cfg.widgets).size!==cfg.widgets.length)throw new Error('widgets 仅支持不重复的 total、online、alerts。');
 if(typeof cfg.showDevices!=='boolean')throw new Error('showDevices 必须为 true 或 false。');
 return {config:cfg,body:raw.replace(blocks[0][0],'').trim()};
}
function markdown(raw){
 const inline=t=>safe(t).replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>');
 let list=false,html='';
 for(const line of raw.split('\n')){
  if(line.startsWith('- ')){if(!list){html+='<ul>';list=true;}html+=`<li>${inline(line.slice(2))}</li>`;continue;}
  if(list){html+='</ul>';list=false;}
  const h=line.match(/^(#{1,3})\s+(.+)$/);
  if(h){const level=h[1].length+1;html+=`<h${level}>${inline(h[2])}</h${level}>`;}
  else if(line.trim())html+=`<p>${inline(line)}</p>`;
 }
 return html+(list?'</ul>':'');
}
function rawTemplate(id){const saved=readStorage(templateKey,{});return typeof saved[id]==='string'?saved[id]:templates[id];}
function workspaceTemplate(){if(platformBackend&&typeof templates[companyId]==='string')return parseTemplate(templates[companyId]);if(platformBackend)return {config:{title:company()?.name||'公司工作台',subtitle:'设备与运行状态',accent:'blue',widgets:['total','online','alerts'],showDevices:true},body:''};const raw=rawTemplate(companyId);if(typeof raw!=='string')throw new Error(templateErrors[companyId]||'未找到公司 Markdown 配置。');return parseTemplate(raw);}
function accountPage(){
 const register=authMode==='register';
 return `<main class="login portal-login"><section class="login-story"><a class="brand" href="./">${logo()}</a><div class="story-body"><div class="eyebrow">CONNECT EVERY LINK. SEE EVERY DETAIL.</div><h1>连接每一环，<br>看见每一步<span>。</span></h1><p>从田间生长，到工业运转。<br>在同一个平台，掌握属于你的设备与数据。</p><div class="supply-preview"><div class="supply-line"><span class="feature-icon green">${icon('environment')}</span><div><strong>农牧链</strong><small>种植园 / 养殖场</small></div><span class="badge green">持续感知</span></div><div class="supply-line"><span class="feature-icon blue">${icon('power')}</span><div><strong>工业链</strong><small>生产 / 维保 / 仓储</small></div><span class="badge blue">协同运行</span></div><div class="supply-preview-foot">${icon('shield')} 每家公司，拥有自己的监测空间。</div></div></div><footer>物联空间 · 供应链物联网平台</footer></section><section class="login-panel"><div class="login-form-wrap"><div class="auth-switch"><button data-auth="login" class="${!register?'active':''}">登录</button><button data-auth="register" class="${register?'active':''}">注册</button></div><span class="eyebrow blue-text">${register?'CREATE YOUR ACCOUNT':'WELCOME BACK'}</span><h2>${register?'注册账号':'欢迎回来'}</h2><p class="muted">${register?(platformBackend?'使用公司邀请码，创建你的设备监测账号。':'创建当前浏览器的演示监测账号。'):'登录后，自动进入与你身份对应的空间。'}</p><form id="auth-form">${register?'<label for="display-name">姓名</label><input id="display-name" name="displayName" placeholder="请输入姓名" maxlength="30" required>':''}<label for="username">账号</label><input id="username" name="username" placeholder="请输入账号" autocomplete="username" minlength="3" maxlength="40" required><label for="password">密码</label><div class="password-wrap"><input id="password" name="password" type="password" placeholder="${register?(platformBackend?'至少 12 位密码':'至少 6 位密码'):'请输入密码'}" autocomplete="${register?'new-password':'current-password'}" ${register?`minlength="${platformBackend?12:6}"`:''} maxlength="100" required><button type="button" id="toggle-password" aria-label="显示密码">${icon('eye')}</button></div>${register?`${platformBackend?'<label for="register-invite">公司邀请码</label><input id="register-invite" name="inviteCode" autocomplete="off" maxlength="128" placeholder="请输入公司管理员提供的邀请码" required>':`<label for="register-company">所属公司</label><select id="register-company" name="companyId" required>${platform.companies.map(c=>`<option value="${safe(c.id)}">${safe(c.name)}</option>`).join('')}</select>`}<label for="confirm-password">确认密码</label><input id="confirm-password" type="password" autocomplete="new-password" placeholder="请再次输入密码" required>`:''}<p id="auth-error" class="error" role="alert">${safe(notice)}</p><button class="primary login-submit" type="submit">${register?'注册并进入公司':'登录平台'} ${icon('arrow')}</button></form>${register&&platformBackend?'<p class="settings-note">公司与身份由邀请码确定，平台管理员不开放注册。</p>':''}<p class="login-disclaimer">${platformBackend?'本机平台 · 注册账号和设备保存在服务器':'静态演示 · 注册账号仅保存于当前浏览器'}</p></div></section></main>`;
}
function dashboardCards(){
 const list=companyDevices(),warnings=warningDevices();
 const data={total:['device','设备总数',list.length,'公司所属监测设备','blue'],online:['check','在线设备',list.filter(d=>d.online).length,platformBackend?'按最近有效上报判断':'当前模拟设备状态','green'],alerts:['bell','预警设备',warnings.length,warnings.length===1?'点击直达异常设备 →':'查看预警设备列表 →','orange']};
 const cfg=workspaceTemplate().config;
 return `<div class="stats-grid company-stats">${cfg.widgets.map(w=>{const [i,label,n,desc,color]=data[w];return `<${w==='alerts'?'button':'div'} class="stat-card ${w==='alerts'?'stat-action':''}" ${w==='alerts'?'type="button" id="warning-devices" aria-label="查看预警设备"':''}><span class="feature-icon ${color}">${icon(i)}</span><span class="stat-label">${label}</span><strong>${n}<small>台</small></strong><p>${desc}</p></${w==='alerts'?'button':'div'}>`;}).join('')}</div>`;
}
function deviceCards(list){return `<div class="device-grid">${list.map(raw=>{const d=effective(raw),s=deviceScene(d),[label,color]=status(s,d);return `<button class="device-card" data-device="${safe(d.id)}"><div class="card-top"><span class="project-symbol ${s.color}">${icon('device')}</span><span class="badge ${color}"><i class="dot"></i>${label}</span></div><span class="device-code">${safe(d.id)}</span><h2>${safe(d.name)}</h2><p>${safe(d.location)}</p><div class="device-sensors">${s.metrics.map(m=>`<span class="${alarms(s,d).some(a=>a.key===m.key)&&d.online?'warning-metric':''}">${safe(m.name)}</span>`).join('')}</div><div class="device-readings">${s.metrics.map(m=>`<div class="${d.online&&alarms(s,d).some(a=>a.key===m.key)?'reading-alert':''}"><small>${safe(m.name)}</small><strong>${Number.isFinite(d.values[m.key])?safe(d.values[m.key]):'—'}<em>${safe(m.unit)}</em></strong></div>`).join('')}</div>${!d.online?`<span class="last-reading-note">${d.mqtt?'离线 / 等待新上报 · 最后接收值':'离线 · 最后一次模拟采样'}</span>`:''}<div class="device-action"><span>查看传感器数据</span>${icon('arrow')}</div></button>`;}).join('')}</div>`;}
function workspaceSparkline(metric,d){
 const values=(d.history?.[metric.key]||[]).filter(Number.isFinite);
 if(!values.length)return '<div class="spark-empty">暂无历史采样</div>';
 const lo=Math.min(...values),range=Math.max(...values)-lo||1;
 const points=values.map((v,i)=>`${8+i*304/Math.max(1,values.length-1)},${64-(v-lo)/range*48}`).join(' ');
 return `<svg viewBox="0 0 320 80" role="img" aria-label="${safe(metric.name)}最近 ${values.length} 次${d.mqtt?'实际':'模拟'}采样"><path d="M8 20H312M8 45H312M8 70H312" stroke="currentColor" opacity=".08"/><polygon points="8,78 ${points} 312,78" fill="currentColor" opacity=".07"/><polyline points="${points}" stroke="currentColor" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}
let overviewDeviceId=null;
function companyInsights(){
 const list=companyDevices(),warnings=warningDevices(),offline=list.filter(d=>!d.online),healthy=list.length-warnings.length-offline.length;
 const raw=list.find(d=>d.id===overviewDeviceId)||list.find(d=>d.online)||list[0],d=raw?effective(raw):null,s=d?deviceScene(d):null;
 const total=list.length,green=total?healthy/total*100:0,amber=total?(healthy+warnings.length)/total*100:0;
 return `<div class="insight-grid"><section class="insight-panel sampling-panel"><div class="insight-heading"><div><span class="dashboard-kicker">SENSOR OVERVIEW</span><h2>采样数据概览</h2></div>${d?`<label class="overview-select"><span class="sr-only">概览设备</span><select id="overview-device">${list.map(row=>`<option value="${safe(row.id)}" ${row.id===d.id?'selected':''}>${safe(effective(row).name)}</option>`).join('')}</select></label>`:''}</div>${d?`<div class="sampling-context"><span>${safe(d.location)}</span><span>${d.mqtt?(d.online?'MQTT 实时采样':'离线 / 等待新上报'):d.online?'模拟采样快照':Object.values(d.values).some(Number.isFinite)?'离线 · 最后一次模拟采样':'离线 · 暂无采样数据'}</span></div><div class="sampling-grid">${s.metrics.map(m=>{const warning=d.online&&alarms(s,d).some(a=>a.key===m.key);return `<div class="sampling-metric ${warning?'is-alert':''}"><span>${icon(m.icon)} ${safe(m.name)}</span><strong>${Number.isFinite(d.values[m.key])?safe(d.values[m.key]):'—'}<small>${safe(m.unit)}</small></strong>${workspaceSparkline(m,d)}<small>最近 ${(d.history?.[m.key]||[]).filter(Number.isFinite).length} 次${d.mqtt?'实际':'模拟'}采样</small></div>`;}).join('')}</div><button class="dashboard-text-link" data-device="${safe(d.id)}">查看设备详情 ${icon('arrow')}</button>`:'<p class="dashboard-empty">尚未配置监测设备</p>'}</section><section class="insight-panel health-panel"><div class="insight-heading"><div><span class="dashboard-kicker">DEVICE STATUS</span><h2>设备状态分布</h2></div>${icon('device')}</div><div class="health-content"><div class="health-ring" style="--healthy:${green}%;--warning:${amber}%" role="img" aria-label="${healthy} 台正常，${warnings.length} 台预警，${offline.length} 台离线"><div><strong>${total}</strong><span>设备总数</span></div></div><div class="health-legend">${[['normal','运行正常',healthy],['warn','在线预警',warnings.length],['off','设备离线',offline.length]].map(([cls,label,n])=>`<div><span><i class="${cls}"></i>${label}</span><strong>${n}<small> 台</small></strong></div>`).join('')}</div></div><p class="health-foot">${total?`在线率 ${Math.round((total-offline.length)/total*100)}% · 根据设备状态统计`:'暂无设备数据'}</p></section></div>`;
}
function companyAttention(){
 const list=companyDevices(),attention=list.filter(d=>!d.online||alarms(deviceScene(d),effective(d)).length);
 const articles=visibleNews().slice(0,2);
 return `<div class="dashboard-bottom"><section class="insight-panel attention-panel"><div class="insight-heading"><div><span class="dashboard-kicker">NEEDS ATTENTION</span><h2>需要关注 <small>${attention.length}</small></h2></div>${icon('bell')}</div>${attention.map(raw=>{const d=effective(raw),s=deviceScene(d);return `<button class="attention-row" data-device="${safe(d.id)}"><span class="attention-symbol ${d.online?'warn':'off'}">${icon(d.online?'bell':'device')}</span><span><strong>${safe(d.name)}</strong><small>${d.online?alarms(s,d).map(m=>safe(m.name)+'超出范围').join('、'):'设备离线 · 请检查供电与网络'}</small></span>${icon('arrow')}</button>`;}).join('')||'<p class="dashboard-empty">'+icon('check')+' 当前没有预警或离线设备</p>'}</section><section class="insight-panel dashboard-news"><div class="insight-heading"><div><span class="dashboard-kicker">LATEST NEWS</span><h2>公司与平台动态</h2></div><button class="dashboard-text-link" data-tab="news">全部新闻 ${icon('arrow')}</button></div>${articles.map(a=>`<a class="dashboard-news-item" href="#article/${encodeURIComponent(a.id)}" data-article="${safe(a.id)}"><time>${safe(a.date)}</time><strong>${safe(a.title)}</strong>${icon('arrow')}</a>`).join('')||'<p class="dashboard-empty">暂无最新动态</p>'}</section></div>`;
}
function consoleAlertPanel(){
 const rows=companyDevices().filter(d=>!d.online||alarms(deviceScene(d),effective(d)).length);
 return `<section class="insight-panel console-alerts" id="console-alerts"><div class="insight-heading"><h2>告警与离线</h2><span class="console-count">${rows.length} 项待关注</span></div>${rows.map(raw=>{const d=effective(raw),s=deviceScene(d);return `<button class="console-alert-row" data-device="${safe(d.id)}"><span class="console-alert-icon ${d.online?'warning':'offline'}">${icon(d.online?'bell':'device')}</span><span><strong>${d.online?alarms(s,d).map(m=>safe(m.name)+'超出范围').join('、'):'设备离线'}</strong><small>${safe(d.name)} · ${safe(d.id)}</small><em>${safe(d.location)}</em></span>${icon('arrow')}</button>`;}).join('')||'<p class="dashboard-empty">'+icon('check')+' 当前设备无异常</p>'}<p class="console-panel-note">点击异常信息，直接查看对应设备</p></section>`;
}
function consoleDeviceRows(query=''){
 const rows=companyDevices().filter(raw=>{const d=effective(raw);return (!platformBackend||!deviceSceneFilter||d.workspaceSceneId===deviceSceneFilter)&&[d.name,d.id,d.location].join(' ').toLowerCase().includes(query.trim().toLowerCase());});
 return rows.map(raw=>{const d=effective(raw),s=deviceScene(d),[label,color]=status(s,d);return `<tr><td><button data-device="${safe(d.id)}">${icon('device')} ${safe(d.name)}</button></td><td><code>${safe(d.id)}</code></td><td><span class="badge ${color}"><i></i>${label}</span></td><td>${safe(d.location)}${platformBackend?`<small>${safe(companyScenes.find(s=>s.id===d.workspaceSceneId)?.name||'未分组')}</small>`:''}</td><td><button class="dashboard-text-link" data-device="${safe(d.id)}">查看 ${icon('arrow')}</button></td></tr>`;}).join('')||'<tr><td colspan="5" class="console-no-results">未找到匹配设备</td></tr>';
}
function consoleDeviceArea(){
 const list=companyDevices();
 return `<div class="console-device-area" id="dashboard-devices"><section class="insight-panel console-map"><div class="insight-heading"><h2>采集点分布</h2><span class="console-count">${list.length} 个设备</span></div><div class="site-schematic"><svg viewBox="0 0 600 300" preserveAspectRatio="none" aria-hidden="true"><defs><pattern id="site-grid" width="40" height="40" patternUnits="userSpaceOnUse" patternTransform="rotate(-25)"><path d="M40 0H0V40" fill="none" stroke="#d7e6ed" stroke-width="1"/></pattern></defs><rect width="600" height="300" fill="#eef5f7"/><rect width="600" height="300" fill="url(#site-grid)"/><path d="M-20 240 150 180 250 190 400 100 640 20" stroke="#c6e9f5" stroke-width="38" fill="none"/><path d="M-20 100 250 300M200-30 600 260M0 250 440 0" stroke="#fff" stroke-width="13"/><path d="m65 72 78-35 63 48-78 35Z" fill="#c6e4d7" stroke="#b3d7c9"/><path d="m343 199 65-32 83 59-65 32Z" fill="#d2dfea" stroke="#bfcede"/><path d="m360 30 72-20 51 40-72 20Z" fill="#d5e8d3" stroke="#b9d4b6"/></svg>${list.map((d,i)=>{const [label,color]=status(deviceScene(d),effective(d));return `<button class="site-pin ${color}" style="left:${22+(i%3)*27}%;top:${29+(Math.floor(i/3)%3)*22+(i%2)*26}%" data-device="${safe(d.id)}" aria-label="${safe(d.name)}，${label}，查看详情">${icon('device')}<span>${safe(effective(d).name)}</span></button>`;}).join('')}<span class="site-map-label">采集点布局示意 · 非地理坐标</span></div><div class="site-legend"><span><i></i>正常</span><span><i></i>预警</span><span><i></i>离线</span></div></section><section class="insight-panel console-device-table"><div class="insight-heading"><h2>设备列表</h2>${platformBackend?`<label>场景<select id="console-scene-filter"><option value="">全部场景</option>${companyScenes.filter(s=>s.company===companyId).map(s=>`<option value="${safe(s.id)}" ${s.id===deviceSceneFilter?'selected':''}>${safe(s.name)}</option>`).join('')}</select></label>`:''}<label class="table-search">${icon('eye')}<input type="search" id="console-device-search" aria-label="搜索设备" placeholder="搜索名称 / ID / 位置"></label></div><div class="table-wrap"><table><thead><tr><th>设备名称</th><th>设备 ID</th><th>状态</th><th>位置</th><th>操作</th></tr></thead><tbody id="console-device-rows">${consoleDeviceRows()}</tbody></table></div><div class="console-table-footer"><span>仅显示 ${safe(company()?.name)} 的设备</span><span>共 ${list.length} 台</span></div></section></div>`;
}
function consoleQuickActions(){return `<section class="insight-panel console-quick"><div class="insight-heading"><h2>快捷操作</h2></div><div>${[['devices','device','查看设备'],['monitor','grid','数据监测'],['alerts','bell','查看告警']].map(([section,i,text])=>`<button data-console-section="${section}"><span>${icon(i)}</span>${text}</button>`).join('')}<button data-tab="news"><span>${icon('chat')}</span>公司新闻</button></div><p>${icon('shield')} ${safe(company()?.name)} · ${safe(roles[currentUser.role].label)}工作空间</p></section>`;}
function customerConsoleHome(t){
 const list=companyDevices(),news=visibleNews().slice(0,2);
 return `${canManageDevices()?'<div class="inventory-toolbar"><span>公司设备维护</span><button class="primary" data-route="device-manage">管理设备 · 添加 / 删除</button></div>':''}<div class="company-dashboard cockpit-dashboard"><div class="console-top-grid"><section class="console-welcome"><div><span>${safe(platform.categories.find(c=>c.id===company()?.categoryId)?.name||'公司空间')} · 运营概览</span><h1>你好，${safe(currentUser.name)}</h1><p>${safe(t.config.subtitle)}</p></div>${dashboardCards()}<div class="console-hero-landscape" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i></div></section>${consoleQuickActions()}</div><div class="console-analytics" id="console-monitor">${companyInsights()}${consoleAlertPanel()}</div>${t.config.showDevices?consoleDeviceArea():''}<div class="console-bottom-grid"><section class="insight-panel"><div class="insight-heading"><h2>平台与公司动态</h2><button class="dashboard-text-link" data-tab="news">全部新闻 ${icon('arrow')}</button></div>${news.map(a=>`<a class="dashboard-news-item" href="#article/${encodeURIComponent(a.id)}" data-article="${safe(a.id)}"><time>${safe(a.date)}</time><strong>${safe(a.title)}</strong>${icon('arrow')}</a>`).join('')||'<p class="dashboard-empty">暂无新闻</p>'}</section><section class="insight-panel console-notes">${markdown(t.body)}</section></div><p class="console-data-note">${icon('help')} ${platformBackend?'仅显示你有权访问的设备；监测值来自设备实际采样上报。':'当前读数、历史曲线及在线状态来自公司 JSON 模拟数据。'}</p></div>`;
}
function companyHome(){
 try{const t=workspaceTemplate();if(!isAdmin())return customerConsoleHome(t);const list=companyDevices(),warningCount=warningDevices().length,online=list.filter(d=>d.online).length;return `<div class="company-dashboard"><section class="dashboard-welcome accent-${t.config.accent}"><div class="welcome-copy"><span class="welcome-eyebrow">${safe(platform.categories.find(c=>c.id===company()?.categoryId)?.name||'公司空间')} / 设备监测工作台</span><h1>${safe(company()?.name)} · 设备管理</h1><p>查看公司设备、定位异常，统一维护监测页面配置。</p><div class="welcome-actions">${t.config.showDevices?'<button data-scroll-devices>查看公司设备 '+icon('arrow')+'</button>':''}${isAdmin()&&!platformBackend?'<button class="welcome-outline" data-route="template">'+icon('code')+' 配置页面</button>':'<span>'+icon('shield')+' '+safe(roles[currentUser.role].label)+'专属工作空间</span>'}</div></div><div class="welcome-status"><div class="welcome-radar">${icon('device')}<i></i><i></i></div><div><span>运行概况</span><strong>${warningCount?'有 '+warningCount+' 台设备需要关注':online<list.length?'有离线设备待检查':list.length?'在线设备运行正常':'等待添加监测设备'}</strong><small>${online} 台在线 / ${list.length} 台设备 · ${platformBackend?'实际采样':'模拟快照'}</small></div></div></section>`+dashboardCards()+companyInsights()+`${t.config.showDevices?'<div class="section-heading dashboard-devices-heading" id="dashboard-devices"><div><span class="dashboard-kicker">COMPANY DEVICES</span><h2>公司设备</h2></div><span class="device-count">'+list.length+' 台设备 · 点击查看详情</span></div>'+deviceCards(list):''}`+companyAttention()+`<section class="panel markdown-panel dashboard-notes">${markdown(t.body)}</section></div>`;}catch(e){return heading('COMPANY / CONFIGURATION',safe(company()?.name||'公司空间'),'公司页面配置暂不可用。')+`<div class="offline-note">${safe(e.message)}</div>${isAdmin()?'<button class="primary" data-route="template">修复 Markdown 配置</button>':''}`;}
}
function newsPage(){return newsListPage();}
function profilePage(){return heading('ACCOUNT / PROFILE','我的','查看账号身份与所属公司。')+`<section class="panel profile-card"><span class="profile-avatar">${safe(currentUser.name?.slice(0,1)||'用')}</span><h2>${safe(currentUser.name)}</h2><span class="badge ${roles[currentUser.role].color}">${roles[currentUser.role].label}</span><dl class="device-info">${[['姓名',currentUser.name],['账号',currentUser.username],['公司',isAdmin()?'平台管理员（跨公司管理）':platform.companies.find(c=>c.id===currentUser.companyId)?.name||'未分配'],['设备数',isAdmin()?devices.length:companyDevices().length],['身份',roles[currentUser.role].label]].map(([k,v])=>`<div><dt>${k}</dt><dd>${safe(v)}</dd></div>`).join('')}</dl><button class="secondary" id="profile-logout">退出登录 ${icon('logout')}</button></section>${typeof accountPasswordPanel==='function'?accountPasswordPanel():''}`;}
function navigationCard({title,description,iconName,color='blue',attr,meta=''}){return `<button class="portal-card" ${attr}><span class="portal-card-icon ${color}">${icon(iconName)}</span><span class="portal-card-body"><strong>${safe(title)}</strong><span>${safe(description)}</span><small>${safe(meta)}</small></span><span class="portal-card-arrow">${icon('arrow')}</span></button>`;}
function platformHealth(list=devices){
 const offline=list.filter(d=>!d.online).length;
 const warning=list.filter(d=>d.online&&alarms(deviceScene(d),effective(d)).length).length;
 return {total:list.length,online:list.length-offline,offline,warning,normal:list.length-offline-warning};
}
function platformPage(){
 if(platformBackend)return serverPlatformPage();
 const h=platformHealth(),attention=devices.filter(d=>!d.online||alarms(deviceScene(d),effective(d)).length);
 return `<div class="admin-dashboard"><section class="admin-hero"><div><span class="admin-kicker">PLATFORM / OPERATIONS</span><h1>平台管理总览</h1><p>供应链物联网平台</p><div class="admin-hero-tags"><span>${icon('shield')} 跨公司管理</span><span>${platform.chains.length} 条产业链 · ${platform.categories.length} 个业务场景</span></div></div><div class="admin-network" aria-hidden="true"><span>${icon('grid')}</span><i>${icon('environment')}</i><i>${icon('power')}</i><i>${icon('device')}</i></div></section><div class="admin-metrics">${[['users','接入公司',platform.companies.length,'家','按产业与场景独立管理','blue'],['device','设备总数',h.total,'台',h.normal+' 台正常运行','purple'],['check','在线设备',h.online,'台',(h.total?Math.round(h.online/h.total*100):0)+'% 在线率','green'],['bell','待关注设备',attention.length,'台',h.warning+' 台预警 · '+h.offline+' 台离线','orange']].map(([i,label,n,unit,note,color])=>`<section class="admin-metric ${color}"><span class="feature-icon ${color}">${icon(i)}</span><span>${label}</span><strong>${n}<small>${unit}</small></strong><p>${note}</p></section>`).join('')}</div><div class="admin-section-title"><div><span class="admin-kicker">INDUSTRY SPACES</span><h2>产业工作空间</h2></div><button class="secondary" data-route="tests">${icon('code')} 设备接入测试</button></div><div class="admin-industries">${platform.chains.map(c=>{const categories=platform.categories.filter(x=>x.chainId===c.id),companies=platform.companies.filter(x=>categories.some(k=>k.id===x.categoryId)),rows=devices.filter(d=>companies.some(k=>k.id===d.companyId)),health=platformHealth(rows);return `<button class="admin-industry ${safe(c.color)}" data-chain="${safe(c.id)}"><div class="admin-industry-top"><span class="feature-icon ${safe(c.color)}">${icon(c.icon)}</span><span>${companies.length} 家公司 / ${rows.length} 台设备</span>${icon('arrow')}</div><h3>${safe(c.name)}</h3><p>${safe(c.description)}</p><div class="admin-category-tags">${categories.map(k=>`<span>${safe(k.name)}</span>`).join('')}</div><div class="admin-status-track" aria-hidden="true"><i style="width:${rows.length?health.normal/rows.length*100:0}%"></i><i style="width:${rows.length?health.warning/rows.length*100:0}%"></i><i style="width:${rows.length?health.offline/rows.length*100:0}%"></i></div><small>正常 ${health.normal} · 预警 ${health.warning} · 离线 ${health.offline}</small></button>`;}).join('')}</div><div class="admin-management-grid"><section class="admin-panel"><div class="admin-section-title"><h2>公司管理</h2><span>${platform.companies.length} 家公司</span></div><div class="table-wrap"><table class="admin-company-table"><thead><tr><th>公司 / 场景</th><th>设备</th><th>运行状态</th><th>管理</th></tr></thead><tbody>${platform.companies.map(c=>{const h=platformHealth(devices.filter(d=>d.companyId===c.id));return `<tr><td><button data-company="${safe(c.id)}">${safe(c.name)}</button><small>${safe(platform.categories.find(k=>k.id===c.categoryId)?.name||'未分类')}</small></td><td>${h.total} 台</td><td><span class="admin-table-state ${h.warning||h.offline?'attention':'healthy'}">${h.warning||h.offline?h.warning+' 预警 / '+h.offline+' 离线':'运行正常'}</span></td><td><button class="dashboard-text-link" data-company="${safe(c.id)}">管理 ${icon('arrow')}</button></td></tr>`;}).join('')}</tbody></table></div></section><section class="admin-panel admin-attention"><div class="admin-section-title"><h2>待关注设备</h2><span>${attention.length} 台</span></div>${attention.map(raw=>{const d=effective(raw),c=platform.companies.find(c=>c.id===d.companyId);return `<button class="admin-alert" data-admin-device="${safe(d.id)}"><span class="feature-icon ${d.online?'orange':'blue'}">${icon(d.online?'bell':'device')}</span><span><strong>${safe(d.name)}</strong><small>${safe(c?.name||'未分配公司')} · ${d.online?'指标超出范围':'设备离线'}</small></span>${icon('arrow')}</button>`;}).join('')||'<p class="dashboard-empty">当前设备无异常</p>'}</section></div><p class="admin-data-note">统计来自当前 JSON 演示数据；点击异常设备可直接查看详情。</p></div>`;
}

function chainPage(){const c=platform.chains.find(c=>c.id===chainId);return heading('SUPPLY CHAIN / CATEGORIES',safe(c?.name),'选择业务场景，进入公司管理。','<button class="secondary" data-route="platform">返回平台</button>')+`<div class="portal-grid">${platform.categories.filter(x=>x.chainId===chainId).map(x=>navigationCard({title:x.name,description:'查看所属公司及其设备工作台',iconName:x.icon,color:c?.color,attr:`data-category="${x.id}"`,meta:platform.companies.filter(v=>v.categoryId===x.id).length+' 家公司'})).join('')}</div>`;}
function companiesPage(){const category=platform.categories.find(c=>c.id===categoryId);return heading('SCENARIO / COMPANIES',safe(category?.name),'选择公司，进入专属监测页面。','<button class="secondary" data-route="chain">返回产业链</button>')+`<div class="portal-grid">${platform.companies.filter(c=>c.categoryId===categoryId).map(c=>navigationCard({title:c.name,description:c.description,iconName:'users',color:'green',attr:`data-company="${c.id}"`,meta:devices.filter(d=>d.companyId===c.id).length+' 台设备 · Markdown 配置页面'})).join('')}</div>`;}
function testsPage(){return heading('PLATFORM / TESTING','测试','USB 采集与本地联网测试独立于公司业务。','<button class="secondary" data-route="platform">返回平台</button>')+`<div class="portal-grid">${navigationCard({title:'USB 测试',description:'按行显示本机串口接收到的原始信息。',iconName:'device',attr:'data-route="usb"',meta:'/dev/ttyUSB0 · 9600 baud'})}${navigationCard({title:'本地联网测试',description:'订阅本机 MQTT Broker，接收 WiFi 设备消息。',iconName:'code',color:'green',attr:'data-route="mqtt"',meta:'MQTT · 1883 · rd-web/test/#'})}</div><p class="settings-note">测试需通过本地 Python 接收服务打开。GitHub Pages 仅提供静态公司页面，不会模拟测试连接成功。</p>`;}
function templatePage(){const raw=templateDraft??rawTemplate(companyId)??'';return heading('ADMIN / MARKDOWN CONFIGURATION','公司页面配置',`${safe(company()?.name)} · 编辑 Markdown，自动生成首页统计与设备布局。`,'<button class="secondary" data-route="company">返回公司</button>')+`<section class="panel template-panel"><div class="section-heading"><h2>Markdown 页面源文件</h2><span class="muted small">${safe(company()?.template)}</span></div><label class="sr-only" for="template-editor">Markdown 配置</label><textarea id="template-editor" spellcheck="false">${safe(raw)}</textarea><p id="template-error" class="error" role="alert"></p><div class="template-actions"><button class="primary" id="save-template">保存并生成首页</button><button class="secondary" id="preview-template">预览</button><button class="secondary" id="download-template">导出 .md</button><button class="text-button" id="reset-template">恢复文件配置</button></div><p class="settings-note">保存仅影响当前浏览器；导出并替换上方 .md 文件后，重新部署可让其他浏览器读取。</p></section><section class="panel markdown-panel" id="template-preview"><p class="muted">点击预览检查配置和正文。</p></section>`;}
function renderAlerts(){const list=warningDevices();return heading('COMPANY / ALERTS','预警设备',`${safe(company()?.name)} · ${list.length} 台设备需要关注`,'<button class="secondary" data-route="company">返回公司首页</button>')+(list.length?deviceCards(list):'<section class="panel read-only-panel"><span class="feature-icon green">'+icon('check')+'</span><h2>当前没有预警设备</h2><p>在线设备读数均在配置范围内。</p></section>');}
/* Background telemetry updates reuse DOM nodes so entrance animations and drafts stay intact. */
function liveNodeKey(node){
 if(node.nodeType!==1)return String(node.nodeType);
 return [node.namespaceURI,node.localName,node.id||node.getAttribute('data-live-key')||node.getAttribute('data-device')||node.classList[0]||''].join(':');
}
function patchLiveNode(current,next){
 if(current.nodeType!==1){if(current.nodeValue!==next.nodeValue)current.nodeValue=next.nodeValue;return;}
 // Keep form drafts and the native selection/caret even after the field loses focus.
 if(current.matches('form,input,textarea,select'))return;
 for(const attr of [...current.attributes])if(!next.hasAttribute(attr.name)){
  if(attr.name!=='class'||!current.classList.contains('will-reveal'))current.removeAttribute(attr.name);
 }
 for(const attr of next.attributes){
  let value=attr.value;
  if(attr.name==='class')for(const name of ['will-reveal','is-visible'])if(current.classList.contains(name)&&!next.classList.contains(name))value+=' '+name;
  if(current.getAttribute(attr.name)!==value)current.setAttribute(attr.name,value);
 }
 patchLiveChildren(current,next);
}
function patchLiveChildren(current,next){
 const previous=[...current.childNodes],used=new Set();let cursor=current.firstChild;
 for(const desired of next.childNodes){
  const key=liveNodeKey(desired),existing=previous.find(node=>!used.has(node)&&liveNodeKey(node)===key);
  const node=existing||desired.cloneNode(true);
  if(existing){used.add(existing);patchLiveNode(existing,desired);}
  if(node!==cursor)current.insertBefore(node,cursor);
  cursor=node.nextSibling;
 }
 for(const node of previous)if(!used.has(node))node.remove();
}
function updateWorkspaceHtml(html,live){
 if(!live){app.innerHTML=html;return;}
 const template=document.createElement('template');template.innerHTML=html;
 patchLiveChildren(app,template.content);
}
function render(live=false){
 stopSerialPolling();
 if(!currentUser)syncMqttPolling();
 if(!currentUser){app.innerHTML=authPage();bindAuth();bindExperience();return;}
 if(!isAdmin()){
  companyId=currentUser.companyId;
  if(!company()){notice='账号尚未分配有效公司，请联系平台管理员分配公司。';view='unassigned';}
  else if(!['company','detail','alerts','profile','article','device-manage','organization'].includes(view))view='company';
 }
 if(view==='device-manage'&&!canManageDevices())view=isAdmin()?'platform':'company';
 if(view==='detail'&&!companyDevices().some(d=>d.id===deviceId)){view='company';notice='设备不属于当前公司，已返回公司首页。';}
 if(platformBackend&&view==='template')view='company';
 if(view==='organization'&&!canOrganize())view=isAdmin()?'platform':'company';
 const r=roles[currentUser.role],c=company();
 const labels={organization:'组织管理','device-manage':'设备管理',platform:'供应链物联网平台',chain:platform.chains.find(x=>x.id===chainId)?.name,companies:platform.categories.find(x=>x.id===categoryId)?.name,company:c?.name,detail:effective(device()||{}).name,alerts:'预警设备',profile:'我的',template:'页面配置',tests:'测试',usb:'USB 测试',mqtt:'本地联网测试',news:'新闻',article:'文章',unassigned:'公司待分配'};
 const adminNav=[['platform','grid','平台总览'],['tests','code','测试'],['news','chat','新闻'],['profile','users','我的']];
 if(platformBackend)adminNav.splice(1,0,['organization','users','公司与管理员']);
 const companyNav=[['home','grid','首页'],['news','chat','新闻'],['profile','users','我的']];
 const consoleNav=[['overview','grid','概览'],['devices','device',canManageDevices()?'设备管理':'我的设备'],['monitor','task','数据监测'],['alerts','bell','告警中心']];
 if(isCompanyAdmin()&&platformBackend)consoleNav.push(['organization','users','公司管理']);
 const nav=isAdmin()?adminNav.map(([v,i,t])=>`<button class="nav-item ${view===v?'active':''}" data-route="${v}" aria-label="${t}" title="${t}">${icon(i)}<span>${t}</span></button>`).join(''):consoleNav.map(([section,i,t])=>`<button class="nav-item ${((view==='company'&&companyTab==='home'&&section==='overview')||(view==='device-manage'&&section==='devices')||(view==='organization'&&section==='organization'))?'active':''}" data-console-section="${section}">${icon(i)}<span>${t}</span></button>`).join('')+companyNav.filter(([v])=>v!=='home').map(([v,i,t])=>`<button class="nav-item ${(v==='profile'?view==='profile':view==='company'&&companyTab===v)?'active':''}" data-tab="${v}" aria-label="${t}" title="${t}">${icon(i)}<span>${t}</span></button>`).join('');
 let body;
 if(view==='organization')body=organizationPage();else if(view==='device-manage')body=deviceManagementPage();else if(view==='platform')body=platformPage();else if(view==='chain')body=chainPage();else if(view==='companies')body=companiesPage();else if(view==='tests')body=testsPage();else if(view==='news')body=newsListPage();else if(view==='article')body=articlePage();else if(view==='profile')body=profilePage();else if(view==='template')body=templatePage();else if(['usb','mqtt'].includes(view))body=renderSerialTest();else if(view==='detail')body=renderDetail();else if(view==='alerts')body=renderAlerts();else if(view==='unassigned')body='<div class="offline-note">'+safe(notice)+'</div>';else body=companyTab==='news'?newsPage():companyHome();
 const tabs=['company','detail','alerts','article'].includes(view)&&c?`<div class="company-topline"><div><span class="company-initial">${safe(c?.name?.slice(0,1)||'公')}</span><strong>${safe(c?.name)}</strong></div><nav aria-label="公司页面">${companyNav.map(([v,i,t])=>`<button data-tab="${v}" class="${(view==='company'&&companyTab===v)||(view==='article'&&v==='news')?'active':''}">${icon(i)}${t}</button>`).join('')}</nav></div>`:'';
 updateWorkspaceHtml(`<div class="workspace ${!isAdmin()?'customer-console':'admin-console'}"><aside class="sidebar"><a href="./" class="brand">${logo()}</a><div class="workspace-label">${isAdmin()?'平台管理':'公司工作空间'} <span>${isAdmin()?'ADMIN':'WORKSPACE'}</span></div><nav aria-label="主导航">${nav}</nav><div class="sidebar-bottom"><div class="help-card"><span class="help-icon">${icon('shield')}</span><strong>${isAdmin()?'统一管理，独立配置':'专属空间，清晰可见'}</strong><p>${isAdmin()?'管理公司与公司管理员，查看平台运行情况。':'查看本公司设备与预警，让每一项数据有迹可循。'}</p><span class="badge ${r.color}">${r.label}</span></div><div class="sidebar-user"><span class="user-avatar">${safe(currentUser.name?.slice(0,1)||'用')}</span><div><strong>${safe(currentUser.name)}</strong><small>${r.label}</small></div><button class="icon-button" id="logout" aria-label="退出登录" title="退出登录">${icon('logout')}</button></div></div></aside><div class="main-shell"><header class="topbar">${!isAdmin()?`<div class="console-header-search">${icon('eye')}<input id="console-global-search" type="search" aria-label="搜索公司设备" placeholder="搜索设备、设备 ID、位置…"></div><div class="console-header-meta"><span>仅本公司数据</span><button class="icon-button" data-console-section="alerts" aria-label="查看告警中心">${icon('bell')}${warningDevices().length?'<i></i>':''}</button><button class="console-account" data-tab="profile"><span>${safe(currentUser.name?.slice(0,1)||'用')}</span>${safe(currentUser.name)}</button></div>`:''}<div class="legacy-breadcrumb"><button class="crumb-button" data-route="${isAdmin()?'platform':'company'}">${isAdmin()?'平台管理':'公司空间'}</button><span class="slash">/</span><strong>${safe(labels[view]||'工作台')}</strong></div><div class="topbar-right"><span class="environment"><i></i> ${platformBackend?'平台服务':(['usb','mqtt'].includes(view)||companyDevices().some(d=>d.mqtt)?'MQTT / 本地接收':'演示空间')}</span><span class="badge ${r.color}">${icon('shield')}${r.label}</span></div></header><main class="main-content">${notice&&view!=='unassigned'?`<div class="notice" role="status">${safe(notice)}</div>`:''}${tabs}${body}<footer class="main-footer"><span>物联空间 · 连接供应链的每一环</span><span>${platformBackend?'设备与配置由服务器统一管理，监测值来自实际接收的上报':(['usb','mqtt'].includes(view)||companyDevices().some(d=>d.mqtt)?'MQTT 设备显示实际接收值；其他设备为演示快照':'公司设备数据为演示快照')}</span></footer></main></div></div>`,live);
 bindPortal();bindOrganization();bindDeviceManagement();bindNews();if(typeof bindPlatformFeatures==='function')bindPlatformFeatures();if(!live)bindExperience();syncMqttPolling();syncRegistryPolling();if(['usb','mqtt'].includes(view))startSerialPolling();
}
async function readJson(path){const response=await fetch(path,{cache:'no-store'});if(!response.ok)throw new Error(`无法读取 ${path}（${response.status}）`);return response.json();}
async function passwordHash(text){const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));return Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');}
function enterUser(user){currentUser=normalizeUser(user);sessionStorage.setItem('workspace-user',currentUser.id);notice='';organizationError='';deviceSceneFilter='';companyTab='home';companyId=currentUser.companyId||null;view=isAdmin()?'platform':'company';render();window.scrollTo({top:0,behavior:'instant'});}
async function logout(){if(platformBackend)await platformRequest('logout',{method:'POST',body:'{}'}).catch(()=>{});resetRegistry();if(typeof historyQuery!=='undefined'){historyQuery=null;historyRequest++;}stopSerialPolling();sessionStorage.removeItem('workspace-user');currentUser=null;companyId=null;deviceId=null;companyMembers=[];companyScenes=[];organizationError='';notice='';authMode='login';render();window.scrollTo({top:0,behavior:'instant'});}
function bindAuth(){
 document.querySelectorAll('[data-auth]').forEach(b=>b.onclick=()=>{authMode=b.dataset.auth;notice='';render();document.querySelector('#account').scrollIntoView({block:'start'});});
 document.querySelector('#toggle-password').onclick=e=>{const p=document.querySelector('#password');p.type=p.type==='password'?'text':'password';e.currentTarget.setAttribute('aria-label',p.type==='password'?'显示密码':'隐藏密码');};
 document.querySelector('#auth-form').onsubmit=async e=>{
  e.preventDefault();const form=e.currentTarget,button=form.querySelector('[type=submit]');button.disabled=true;
  try{
   if(!platformBackend)users=(await readJson('./users.json')).users.map(normalizeUser);
   const username=form.elements.username.value.trim(),password=form.elements.password.value,hash=platformBackend?'':await passwordHash(password);
   if(authMode==='login'){
    if(platformBackend){const {user}=await platformRequest('login',{method:'POST',body:JSON.stringify({username,password})});resetRegistry();await refreshBeforeEnter(user);routeArticleHash();return;}
    const user=allUsers().find(u=>u.username===username&&u.passwordHash===hash);if(!user)throw new Error('账号或密码错误。');enterUser(user);routeArticleHash();
   }else{
    if(platformBackend){
     if(password!==document.querySelector('#confirm-password').value)throw new Error('两次输入的密码不一致。');
     const {user}=await platformRequest('register',{method:'POST',body:JSON.stringify({username,password,name:form.elements.displayName.value.trim(),inviteCode:form.elements.inviteCode.value.trim()})});
     resetRegistry();await refreshBeforeEnter(user);routeArticleHash();return;
    }
    const name=form.elements.displayName.value.trim(),assigned=form.elements.companyId.value;
    if(username.length<3||username.length>40||!name||password.length<6)throw new Error('请填写姓名、3–40 位账号和至少 6 位密码。');
    if(password!==document.querySelector('#confirm-password').value)throw new Error('两次输入的密码不一致。');
    if(!platform.companies.some(c=>c.id===assigned))throw new Error('请选择有效公司。');
    if(allUsers().some(u=>u.username===username))throw new Error('该账号已存在。');
    const user={id:'local-'+crypto.randomUUID(),username,name,passwordHash:hash,role:'customer',companyId:assigned};
    localStorage.setItem(registeredKey,JSON.stringify([...registeredUsers(),user]));enterUser(user);routeArticleHash();
   }
  }catch(error){const target=document.querySelector('#auth-error');if(target)target.textContent=error.message;}finally{button.disabled=false;}
 };
}
function bindPortal(){
 const on=(selector,fn)=>{const el=document.querySelector(selector);if(el)el.onclick=fn;};
 document.querySelectorAll('[data-route]').forEach(b=>b.onclick=()=>{
  const next=b.dataset.route;if(!isAdmin()&&!['company','profile'].includes(next)&&!(next==='device-manage'&&canManageDevices()))return;
  if(next==='device-manage')pendingDeleteId=null;
  if(['usb','mqtt'].includes(next)){testMode=next;serialPaused=false;serialCursor=0;serialLines=[];serialDropped=false;serialState={source:next==='usb'?'serial':'mqtt',device:'/dev/ttyUSB0',baudrate:9600,host:'127.0.0.1',port:1883,topic:'rd-web/test/#',total:0,status:'connecting',error:''};}
  if(next==='news'){companyId=null;navigate('news');refreshNews();return;}if(next==='company')companyTab='home';navigate(next);
 });
 document.querySelectorAll('[data-chain]').forEach(b=>b.onclick=()=>{if(isAdmin()){chainId=b.dataset.chain;navigate('chain');}});
 document.querySelectorAll('[data-category]').forEach(b=>b.onclick=()=>{if(isAdmin()){categoryId=b.dataset.category;navigate('companies');}});
 document.querySelectorAll('[data-admin-device]').forEach(b=>b.onclick=()=>openAdminDevice(b.dataset.adminDevice));
 document.querySelectorAll('[data-company]').forEach(b=>b.onclick=()=>openCompany(b.dataset.company));
 document.querySelectorAll('[data-device]').forEach(b=>b.onclick=()=>openDevice(b.dataset.device));
 document.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>{companyTab=b.dataset.tab;navigate(companyTab==='profile'?'profile':'company');if(companyTab==='news')refreshNews();});
 document.querySelectorAll('[data-console-section]').forEach(button=>button.onclick=()=>{
  const section=button.dataset.consoleSection;if(section==='organization'&&canOrganize()){navigate('organization');return;}if(section==='devices'&&canManageDevices()){pendingDeleteId=null;navigate('device-manage');return;}const needsHome=view!=='company'||companyTab!=='home';companyTab='home';if(needsHome)navigate('company');
  const target={devices:'#dashboard-devices',monitor:'#console-monitor',alerts:'#console-alerts'}[section];
  document.querySelectorAll('.sidebar [data-console-section]').forEach(b=>b.classList.toggle('active',b.dataset.consoleSection===section));
  if(target)document.querySelector(target)?.scrollIntoView({block:'start',behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});else window.scrollTo({top:0,behavior:'instant'});
 });
 const bindRowButtons=()=>document.querySelectorAll('#console-device-rows [data-device]').forEach(b=>b.onclick=()=>openDevice(b.dataset.device));
 const searchDevices=query=>{const rows=document.querySelector('#console-device-rows');if(rows){rows.innerHTML=consoleDeviceRows(query);bindRowButtons();}};
 const sceneFilter=document.querySelector('#console-scene-filter');if(sceneFilter)sceneFilter.onchange=()=>{deviceSceneFilter=sceneFilter.value;searchDevices(document.querySelector('#console-device-search')?.value||'');};
 const tableSearch=document.querySelector('#console-device-search');if(tableSearch)tableSearch.oninput=()=>searchDevices(tableSearch.value);
 const globalSearch=document.querySelector('#console-global-search');if(globalSearch)globalSearch.onkeydown=event=>{if(event.key!=='Enter')return;event.preventDefault();const query=globalSearch.value,needsHome=view!=='company'||companyTab!=='home';companyTab='home';if(needsHome)navigate('company');const input=document.querySelector('#console-device-search');if(input){input.value=query;searchDevices(query);input.scrollIntoView({block:'center'});input.focus();}};
 on('#logout',logout);on('#profile-logout',logout);on('#warning-devices',openWarnings);on('#back-devices',()=>{companyTab='home';navigate('company');});
 const overview=document.querySelector('#overview-device');if(overview)overview.onchange=()=>{overviewDeviceId=overview.value;render();};
 on('[data-scroll-devices]',()=>document.querySelector('#dashboard-devices')?.scrollIntoView({block:'start',behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'}));
 const settings=document.querySelector('#settings-form');if(settings)settings.onsubmit=saveSettings;
 on('#reset-settings',()=>{if(!canEdit()||device()?.provisioned)return;const overrides=readStorage(storageKey,{});delete overrides[deviceId];localStorage.setItem(storageKey,JSON.stringify(overrides));notice='已恢复设备默认配置。';render();});on('#export-config',exportConfig);
 on('#pause-serial',()=>{serialPaused=!serialPaused;document.querySelector('#pause-serial').textContent=serialPaused?'继续显示':'暂停显示';startSerialPolling();});
 on('#clear-serial',()=>{serialLines=[];serialDropped=false;updateSerialPanel();});on('#retry-serial',()=>{serialPaused=false;document.querySelector('#pause-serial').textContent='暂停显示';startSerialPolling();});
 function editTemplate(action){
  if(!isAdmin()||!company())return;
  try{
   const raw=document.querySelector('#template-editor').value,t=parseTemplate(raw);templateDraft=raw;
   document.querySelector('#template-error').textContent='';
   if(action==='preview'){document.querySelector('#template-preview').innerHTML=`<h2>${safe(t.config.title)}</h2><p>${safe(t.config.subtitle)}</p><p>统计组件：${t.config.widgets.map(safe).join(' / ')} · 设备列表：${t.config.showDevices?'显示':'隐藏'}</p>`+markdown(t.body);}
   if(action==='save'){const overrides=readStorage(templateKey,{});overrides[companyId]=raw;localStorage.setItem(templateKey,JSON.stringify(overrides));companyTab='home';view='company';notice='公司页面已由 Markdown 生成并保存到当前浏览器。';render();}
   if(action==='download'){const url=URL.createObjectURL(new Blob([raw],{type:'text/markdown;charset=utf-8'})),a=document.createElement('a');a.href=url;a.download=companyId+'.md';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  }catch(error){document.querySelector('#template-error').textContent=error.message;}
 }
 on('#preview-template',()=>editTemplate('preview'));on('#save-template',()=>editTemplate('save'));on('#download-template',()=>editTemplate('download'));
 on('#reset-template',()=>{if(!isAdmin())return;const overrides=readStorage(templateKey,{});delete overrides[companyId];localStorage.setItem(templateKey,JSON.stringify(overrides));templateDraft=null;render();});
}
async function init(){
 try{
  await detectPlatform();
  const results=await Promise.all([platformBackend?Promise.resolve({users:[]}):readJson('./users.json'),readJson('./devices.json'),readJson('./platform.json')]);
  users=results[0].users.map(normalizeUser);scenes=results[1].scenes;baseDevices=results[1].devices;platform=results[2];reloadInventory();
  await Promise.all(platform.companies.map(async c=>{try{if(!/^content\/companies\/[a-z0-9-]+\.md$/.test(c.template))throw new Error('公司模板路径无效。');const r=await fetch('./'+c.template,{cache:'no-store'});if(!r.ok)throw new Error(`无法读取 ${c.template}`);templates[c.id]=await r.text();}catch(error){templateErrors[c.id]=error.message;}}));
  await loadNews();window.addEventListener('hashchange',routeArticleHash);
  let u;if(platformBackend){try{u=(await platformRequest('session')).user;await refreshBeforeEnter(u,false);}catch{sessionStorage.removeItem('workspace-user');currentUser=null;}}else{const saved=sessionStorage.getItem('workspace-user');u=allUsers().find(u=>u.id===saved);}if(u){enterUser(u);routeArticleHash();}else render();
 }catch(error){app.innerHTML=`<main class="load-error"><h1>页面加载失败</h1><p>${safe(error.message)}</p><p>请通过本地预览服务或 GitHub Pages 打开。</p><button class="primary" onclick="location.reload()">重试</button></main>`;}
}
init();
