const app = document.querySelector('#app');
const roles = { company_admin: {label:'公司管理员',color:'purple'}, customer: {label:'客户',color:'green'}, admin: {label:'平台管理员',color:'purple'}, developer: {label:'客户开发者',color:'blue'} };
const paths = {
 grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
 folder: '<path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3z"/>', check: '<path d="m6 12 4 4 8-8"/>', task: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="m8 12 3 3 5-6"/>', users: '<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3m1-16a3 3 0 0 1 0 6m2 4a5 5 0 0 1 3 5"/>', arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>', bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9m-11 12h4"/>', logout: '<path d="M9 4H4v16h5m0-8h12m-4-4 4 4-4 4"/>', lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 4v3"/>', clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', code: '<path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-14-2 18"/>', chat: '<path d="M21 4H3v14h4v4l5-4h9z"/><path d="M7 9h10M7 13h6"/>', eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12"/><circle cx="12" cy="12" r="3"/>', help: '<circle cx="12" cy="12" r="9"/><path d="M9 9a3 3 0 1 1 4 3v2m-1 3h.01"/>', shield: '<path d="m12 2 8 4v6c0 5-8 10-8 10S4 17 4 12V6z"/><path d="m8 11 3 3 5-5"/>'
};
const icon = (name, cls = '') => `<svg class="icon ${cls}" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.grid}</svg>`;

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
Object.assign(paths, {
 truck:'<path d="M3 6h11v11H3zM14 10h4l3 4v3h-7"/><circle cx="7" cy="18" r="2"/><circle cx="18" cy="18" r="2"/>',
 environment:'<path d="M4 19V9l8-6 8 6v10H4Zm4 0v-6h8v6"/><path d="M9 8h6"/>',
 temperature:'<path d="M9 14V5a3 3 0 0 1 6 0v9a5 5 0 1 1-6 0Z"/><path d="M12 8v10"/>',
 humidity:'<path d="M12 2S4 11 4 15a8 8 0 0 0 16 0c0-4-8-13-8-13Z"/><path d="M8 15a4 4 0 0 0 4 4"/>',
 power:'<path d="m13 2-9 12h7l-1 8 10-13h-7z"/>',
 device:'<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 8h8v8H8zM1 8h3m-3 8h3m16-8h3m-3 8h3M8 1v3m8-3v3M8 20v3m8-3v3"/>',
 settings:'<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3" fill="currentColor"/><circle cx="15" cy="17" r="3" fill="currentColor"/>'
});
const validRole = role => Object.hasOwn(roles, role) ? role : 'customer';
const canEdit = () => ['company_admin','developer'].includes(currentUser?.role) && device()?.companyId === currentUser.companyId;
let users=[], scenes=[], devices=[], currentUser=null, sceneId=null, deviceId=null, view='scenes', notice='';
const storageKey='iot-device-overrides-v1';
const scene = () => device()?.mqtt?deviceScene(device()):scenes.find(s=>s.id===sceneId);
const device = () => devices.find(d=>d.id===deviceId);
const safe = escapeHtml;
function readStorage(key, fallback) { try {return JSON.parse(localStorage.getItem(key)) ?? fallback;}catch{return fallback;} }
function effective(d) {
 if(d?.provisioned)return d;
 const override=readStorage(storageKey,{})[d.id];
 if(!override || typeof override!=='object')return d;
 return {...d,name:typeof override.name==='string'?override.name:d.name,location:typeof override.location==='string'?override.location:d.location,sampleInterval:Number.isFinite(override.sampleInterval)?override.sampleInterval:d.sampleInterval,thresholds:override.thresholds};
}
function metricConfig(s,d,m) { const limit=d.thresholds?.[m.key]; return {...m,min:Number.isFinite(limit?.min)?limit.min:m.min,max:Number.isFinite(limit?.max)?limit.max:m.max}; }
function alarms(s,d) {return s.metrics.filter(m=>{const c=metricConfig(s,d,m),v=d.values[m.key];return Number.isFinite(v)&&(v<c.min||v>c.max);});}
function status(s,d) { return !d.online?[d.provisioned&&!d.lastSeen?'待激活':'离线',d.provisioned&&!d.lastSeen?'blue':'gray']:alarms(s,d).length?['预警','orange']:['运行正常','green']; }
function sampleTimeLabel(time){
 if(!time)return '未记录时间';
 const date=new Date(time);if(!Number.isFinite(date.getTime()))return '未记录时间';
 const pad=n=>String(n).padStart(2,'0');
 return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
function trend(m,d){
 const samples=(d.history?.[m.key]||[]).map((value,i)=>({value,time:d.historyTimes?.[m.key]?.[i]})).filter(s=>Number.isFinite(s.value));
 if(!samples.length)return '<p class="spark-empty">暂无采样数据</p>';
 const values=samples.map(s=>s.value),lo=Math.min(...values)-1,hi=Math.max(...values)+1;
 const x=i=>20+i*460/Math.max(1,samples.length-1),y=v=>112-(v-lo)/(hi-lo)*82;
 const points=samples.map((s,i)=>`${x(i)},${y(s.value)}`).join(' ');
 return `<svg class="trend-chart" viewBox="0 0 500 140" role="group" aria-label="${safe(m.name)}最近采样趋势"><path d="M20 30h460M20 70h460M20 112h460" stroke="#edf1f7" fill="none"/><polygon points="20,120 ${points} 480,120" fill="#ecf3ff"/><polyline points="${points}" fill="none" stroke="#547ee8" stroke-width="2.5" stroke-linejoin="round"/>${samples.map((s,i)=>{
  const time=sampleTimeLabel(s.time),value=`${m.name}：${s.value}${m.unit?' '+m.unit:''}`,label=`${value} · 接收时间：${time}（本地时间）`;
  return `<g class="trend-point" data-live-key="sample-${safe(s.time||i)}-${i}" tabindex="0" role="button" aria-label="${safe(label)}"><circle cx="${x(i)}" cy="${y(s.value)}" r="10" fill="transparent"/><circle class="trend-dot" cx="${x(i)}" cy="${y(s.value)}" r="3" fill="#547ee8"/><g class="trend-tooltip" aria-hidden="true"><rect x="20" y="2" width="460" height="58" rx="8" fill="#253753"/><text x="34" y="25" fill="white" font-size="24">${safe(value)}</text><text x="34" y="47" fill="#e2eaff" font-size="23">接收时间：${safe(time)}（本地）</text></g></g>`;
 }).join('')}</svg>`;
}
function renderDetail(){const s=scene(),d=effective(device()),r=roles[currentUser.role],[label,color]=status(s,d),warnings=alarms(s,d);return heading('DEVICE / MONITORING',`${safe(d.name)} <span class="badge ${color}">${label}</span>`,`${safe(s.name)} · ${safe(d.location)} · ${safe(d.id)}`,`<button class="secondary" id="back-devices">切换设备 ${icon('arrow')}</button>`)+`<div class="access-banner"><span class="feature-icon ${r.color}">${icon('shield')}</span><div><strong>${r.label}监测空间</strong><p>${!canEdit()?'你可以查看传感器数据、状态与采样趋势。':'你可以查看监测数据，并修改设备名称、位置、采样周期与告警阈值。'}${['company_admin','developer'].includes(currentUser.role)?' 开发诊断已开启。':''}</p></div><span class="badge ${r.color}">${canEdit()?'可读可改':'只读'}</span></div>${!d.online?`<div class="offline-note">${d.provisioned&&!d.lastSeen?'设备已登记，等待首次有效上报；连接板子后，实际指标会自动显示。':'设备当前离线；已有采样显示历史值，无采样的指标显示 —。'}</div>`:''}${d.online&&warnings.length?`<div class="offline-note">${warnings.map(m=>safe(m.name)).join('、')}超出配置范围，请关注设备状态。</div>`:''}<div class="section-heading sensor-heading"><h2>传感器数据 <span>SENSOR DATA</span></h2><span class="muted small">${Object.values(d.values).some(Number.isFinite)?d.mqtt?(d.online?'MQTT 实时采样':'MQTT 最后接收值'):d.online?'模拟采样快照':'最后一次模拟采样':'暂无采样数据'} · ${d.sampleInterval} 秒 / 次</span></div><div class="sensor-grid">${s.metrics.map(m=>{const c=metricConfig(s,d,m),value=d.values[m.key],warning=d.online&&warnings.some(w=>w.key===m.key);return `<section data-live-key="metric-${safe(m.key)}" class="sensor-card ${warning?'sensor-warning':''}"><div class="sensor-title"><span class="feature-icon ${warning?'orange':'blue'}">${icon(m.icon)}</span><span>${safe(m.name)}</span><span class="badge ${!d.online?'gray':warning?'orange':'green'}">${!Number.isFinite(value)?'待接入':!d.online?'历史值':warning?'超出范围':'正常'}</span></div><div class="sensor-value">${Number.isFinite(value)?safe(value):'—'}<small>${safe(m.unit)}</small></div><p>${Number.isFinite(c.min)&&Number.isFinite(c.max)?`正常范围 ${c.min}–${c.max} ${safe(m.unit)}`:'尚未配置告警阈值'}</p>${trend(m,d)}<div class="chart-caption"><span>最近 ${(d.history?.[m.key]||[]).filter(Number.isFinite).length} 次${d.mqtt?'实际':'模拟'}采样</span><span>${Number.isFinite(value)?'最新':'待接入'}</span></div></section>`;}).join('')}</div><div class="detail-grid"><section class="panel"><div class="section-heading"><h2>设备信息</h2><span class="badge blue">PCB 采集终端</span></div><dl class="device-info"><div><dt>设备编号</dt><dd>${safe(d.id)}</dd></div><div><dt>所属场景</dt><dd>${safe(s.name)}</dd></div><div><dt>安装位置</dt><dd>${safe(d.location)}</dd></div><div><dt>采样周期</dt><dd>${d.sampleInterval} 秒</dd></div><div><dt>数据来源</dt><dd>${d.mqtt?`MQTT · ${safe(d.mqtt.topic)}`:'JSON 模拟数据'}</dd></div><div><dt>连接状态</dt><dd>${d.mqtt?(d.online?'最近收到上报':d.provisioned&&!d.lastSeen?'已登记 / 等待首次上报':'离线 / 等待新上报'):d.online?'模拟在线':'模拟离线'}</dd></div></dl></section>${canEdit()?renderSettings(s,d):`<section class="panel read-only-panel"><span class="feature-icon green">${icon('eye')}</span><h2>专注数据，一目了然</h2><p>当前为只读视图。设备参数与告警阈值由本公司开发者维护。</p><div class="readonly-tags"><span>${icon('check')} 监测读数</span><span>${icon('check')} 采样趋势</span><span>${icon('check')} 设备状态</span></div></section>`}</div>${typeof historyPanel==='function'?historyPanel(d):''}${['company_admin','developer'].includes(currentUser.role)?renderDiagnostics(s,d):''}`;}
function renderSettings(s,d){return `<section class="panel"><div class="section-heading"><h2>设备配置</h2><span class="badge purple">${icon('settings')} 可编辑</span></div><form id="settings-form" class="settings-form"><div class="form-grid"><div><label for="device-name">设备名称</label><input id="device-name" name="deviceName" value="${safe(d.name)}" maxlength="40" required></div><div><label for="device-location">安装位置</label><input id="device-location" name="location" value="${safe(d.location)}" maxlength="80" required></div></div>${d.provisioned?`<label for="settings-scene">所属场景</label><select id="settings-scene" name="workspaceSceneId">${sceneOptions(d.workspaceSceneId)}</select>`:''}<label for="sample-interval">预期上报周期（秒）</label><input id="sample-interval" name="sampleInterval" type="number" min="1" max="3600" step="1" value="${d.sampleInterval}" required><div class="threshold-title">告警阈值 <span>最小值 / 最大值</span></div>${s.metrics.map(m=>{const c=metricConfig(s,d,m);return `<div class="threshold-row"><span>${safe(m.name)} <small>${safe(m.unit)}</small></span><input aria-label="${safe(m.name)}最小值" name="${m.key}-min" type="number" step="0.1" min="-100000" max="100000" value="${c.min??-100000}" required><span>至</span><input aria-label="${safe(m.name)}最大值" name="${m.key}-max" type="number" step="0.1" min="-100000" max="100000" value="${c.max??100000}" required></div>`;}).join('')}<p class="error" id="settings-error" role="alert"></p><div class="settings-actions"><button class="primary" type="submit">保存配置</button>${d.provisioned?'':'<button class="secondary" type="button" id="reset-settings">恢复默认</button>'}<button class="text-button" type="button" id="export-config">导出 JSON</button></div><p class="settings-note">${d.provisioned?'配置保存到服务器，本公司成员读取相同配置；预期上报周期用于判断离线，不会下发到硬件。':'演示配置仅保存在当前浏览器。'}</p></form></section>`;}
function renderDiagnostics(s,d){const errors=d.online?alarms(s,d).map(m=>({type:d.values[m.key]>metricConfig(s,d,m).max?'SENSOR_THRESHOLD_HIGH':'SENSOR_THRESHOLD_LOW',level:'warning',message:`${m.name}超出配置范围`,source:`${m.key} / threshold check`})):d.diagnostics;return `<section class="panel diagnostics"><div class="section-heading"><h2>${icon('code')} 开发诊断</h2><span class="badge blue">仅开发人员可见</span></div><div class="diagnostic-summary"><span>设备协议 <strong>${d.mqtt?'MQTT':'MQTT（预留）'}</strong></span><span>采集终端 <strong>${safe(d.id)}</strong></span><span>数据模式 <strong>${d.mqtt?'实际接收':'模拟快照'}</strong></span></div>${errors.length?`<div class="table-wrap"><table><thead><tr><th>报错类型</th><th>级别</th><th>说明</th><th>来源</th></tr></thead><tbody>${errors.map(e=>`<tr><td><code>${safe(e.type)}</code></td><td><span class="badge orange">${safe(e.level)}</span></td><td>${safe(e.message)}</td><td>${safe(e.source)}</td></tr>`).join('')}</tbody></table></div>`:'<div class="diagnostic-empty">'+icon('check')+' 当前设备无报错 · 错误类型：NONE</div>'}</section>`;}
function parseSettings(form,s){const fields=new FormData(form),name=String(fields.get('deviceName')).trim(),location=String(fields.get('location')).trim(),sampleInterval=Number(fields.get('sampleInterval'));if(!name||!location)throw new Error('设备名称和安装位置不能为空。');if(!Number.isInteger(sampleInterval)||sampleInterval<1||sampleInterval>3600)throw new Error('采样周期应为 1–3600 秒的整数。');const thresholds={};for(const m of s.metrics){const min=Number(fields.get(`${m.key}-min`)),max=Number(fields.get(`${m.key}-max`));if(!Number.isFinite(min)||!Number.isFinite(max)||min>=max)throw new Error(`${m.name}最小值必须小于最大值。`);thresholds[m.key]={min,max};}return {name,location,sampleInterval,thresholds};}
async function saveSettings(event){
 event.preventDefault();if(!canEdit())return;
 const form=event.currentTarget;
 try{
  const config=parseSettings(form,scene());
  if(device().provisioned){
   config.workspaceSceneId=new FormData(form).get('workspaceSceneId')||null;
   const id=deviceId,userId=currentUser.id;
   await platformRequest(`devices/${encodeURIComponent(id)}/settings`,{method:'POST',body:JSON.stringify(config)});
   if(currentUser?.id!==userId)return;
   await refreshRegistry();notice='设备配置已保存到服务器。';
  }else{
   const overrides=readStorage(storageKey,{});overrides[deviceId]=config;
   localStorage.setItem(storageKey,JSON.stringify(overrides));notice='演示配置已保存到当前浏览器。';
  }
  render();
 }catch(error){const target=document.querySelector('#settings-error');if(target)target.textContent=error.message;}
}
function exportConfig(){if(!canEdit())return;downloadDeviceConfig();}
function downloadDeviceConfig(){if(!canManageDevices())return;const content={scenes,devices:devices.map(d=>d.companyId===currentUser.companyId?effective(d):d)};const url=URL.createObjectURL(new Blob([JSON.stringify(content,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='devices.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}

let serialTimer=null, serialController=null, serialGeneration=0, serialPaused=false;
let serialCursor=0, serialLines=[], serialDropped=false;
let serialState={source:'mqtt',status:'connecting',error:'',host:'127.0.0.1',port:1883,topic:'rd-web/test/#',total:0};
function renderSerialTest() {
 return heading(testMode==='usb'?'LOCAL / USB MONITOR':'LOCAL / MQTT MONITOR',testMode==='usb'?'USB 测试':'本地联网测试',testMode==='usb'?'通过本机服务读取 USB 串口原始消息。':'通过本机 MQTT 服务接收 WiFi 设备消息。') +
 `<section class="access-banner"><span class="feature-icon blue">${icon('device')}</span><div><strong id="stream-source-title">MQTT 设备消息接收</strong><p id="stream-source-info">正在读取本地接收配置…</p></div><span class="badge gray" id="serial-status" role="status">正在连接</span></section>
 <div id="serial-error" class="offline-note" role="status" hidden></div>
 <div class="serial-summary"><section class="panel"><span>累计接收</span><strong id="serial-total">0<small> 条</small></strong></section><section class="panel"><span>最近接收时间</span><strong id="serial-time">等待数据</strong></section></div>
 <section class="panel serial-panel"><div class="section-heading"><h2>接收信息 <span>LIVE SERIAL DATA</span></h2><div class="serial-actions"><button type="button" class="secondary" id="pause-serial">${serialPaused?'继续显示':'暂停显示'}</button><button type="button" class="secondary" id="clear-serial">清空显示</button><button type="button" class="text-button" id="retry-serial">重新连接</button></div></div>
 <div id="serial-log" class="serial-log" role="region" aria-label="设备接收信息" tabindex="0"></div>
 <div class="panel-foot" id="serial-foot">仅显示实际接收内容，最多保留最近 500 条；不会向设备发送指令。</div></section>
 <p class="settings-note">${testMode==='usb'?'请连接 USB 设备，并确认串口与波特率；接收服务可通过启动参数修改配置。':'先启动本地 MQTT Broker 和接收服务，再让设备连入同一 WiFi 上报。保留消息会明确标记；收到消息不代表设备当前仍在线。'}</p>`;
}
function stopSerialPolling() {
 serialGeneration++;
 clearTimeout(serialTimer);
 serialTimer=null;
 serialController?.abort();
 serialController=null;
}
function updateSerialPanel() {
 const log=document.querySelector('#serial-log');
 if(!log)return;
 const status=document.querySelector('#serial-status');
 const [label,color]=serialPaused?['显示已暂停','orange']:serialState.status==='connected'?[serialState.source==='mqtt'?'已订阅 MQTT':'串口已连接','green']:['connecting','subscribing'].includes(serialState.status)?['正在连接 / 订阅','blue']:['连接异常','orange'];
 document.querySelector('#stream-source-title').textContent=serialState.source==='mqtt'?'MQTT 设备消息接收':'USB 串口读取';
 document.querySelector('#stream-source-info').textContent=serialState.source==='mqtt'?`Broker ${serialState.host}:${serialState.port} · 订阅 ${serialState.topic}`:`串口 ${serialState.device} · ${serialState.baudrate} baud`;
 status.textContent=label;status.className=`badge ${color}`;
 document.querySelector('#serial-total').textContent=`${serialState.total} 条`;
 const last=serialLines.at(-1);
 document.querySelector('#serial-time').textContent=last?new Date(last.time).toLocaleTimeString('zh-CN',{hour12:false}):'等待数据';
 const error=document.querySelector('#serial-error');
 error.hidden=!serialState.error;
 error.textContent=serialState.error;
 const follow=log.scrollHeight-log.scrollTop-log.clientHeight<70;
 if(serialLines.length) {
  log.innerHTML=serialLines.map(line=>`<div class="serial-line"><time>${safe(new Date(line.time).toLocaleTimeString('zh-CN',{hour12:false}))}</time><span>${line.topic?`<b class="mqtt-topic">${safe(line.topic)}${line.retained?' · 保留消息':''}</b>`:''}${safe(line.text)}</span></div>`).join('');
 }else{
  log.innerHTML=`<p class="serial-empty">${serialState.status==='connected'?'接收连接已建立，等待设备发送信息…':'等待接收服务连接与设备消息…'}</p>`;
 }
 if(follow)log.scrollTop=log.scrollHeight;
 document.querySelector('#serial-foot').textContent=serialDropped?'部分较早数据已超出缓冲区，当前显示最近接收的信息。':'最多保留最近 500 条；暂停、清空仅影响网页显示，服务继续接收，不会向设备发送指令。';
}
function startSerialPolling() {
 stopSerialPolling();
 updateSerialPanel();
 if(serialPaused||!['usb','mqtt'].includes(view))return;
 const generation=serialGeneration;
 async function poll() {
  if(generation!==serialGeneration||!['usb','mqtt'].includes(view))return;
  const controller=new AbortController();serialController=controller;
  const timeout=setTimeout(()=>controller.abort(),5000);
  try {
   const response=await fetch(`./api/messages?source=${testMode}&after=${serialCursor}`,{cache:'no-store',signal:controller.signal});
   if(!response.ok)throw new Error('本地接收源不可用。请运行 .venv/bin/python serial_server.py --source both，再通过本地预览地址登录管理员进入测试。');
   const data=await response.json();
   if(!Array.isArray(data.lines)||!Number.isFinite(data.total))throw new Error('接收服务返回的数据格式不正确。');
   if(generation!==serialGeneration)return;
   serialState=data;
   if(data.total<serialCursor){serialCursor=0;serialLines=[];}else{
    serialLines=serialLines.concat(data.lines).slice(-500);
    serialCursor=data.total;
   }
   serialDropped=serialDropped||data.dropped;
   if(data.status==='error')serialState.error=data.source==='mqtt'?`${data.error} 请检查本地 Broker 是否运行；服务会自动重试。`:`无法打开 ${data.device}：${data.error}。请检查设备连接、串口权限及是否被其他程序占用；服务会自动重试。`;
  } catch(error) {
   if(generation!==serialGeneration)return;
   serialState={...serialState,status:'error',error:error.name==='AbortError'?'本地接收服务响应超时，正在重试。':error.message};
  } finally {
   clearTimeout(timeout);
   if(generation===serialGeneration&&['usb','mqtt'].includes(view)&&!serialPaused){updateSerialPanel();serialTimer=setTimeout(poll,500);}
  }
 }
 poll();
}
