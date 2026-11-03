/* Server-backed device registration. Static previews keep the original demo inventory. */
let platformBackend=false,platformInfo=null,serverDevices=[],connectionResult=null,registryError='',registryLoaded=false;
let registryTimer=null,registryController=null,registrySession='',registryRequest=0,registryBusy=false;
async function platformRequest(path,options={}){
 let response;
 try{response=await fetch(`./api/${path}`,{cache:'no-store',credentials:'same-origin',signal:AbortSignal.timeout(10000),...options,headers:{'Content-Type':'application/json',...options.headers}});}catch(error){throw new Error(error.name==='TimeoutError'||error.name==='AbortError'?'服务器响应超时，请稍后重试。':'无法连接平台服务，请确认本机服务已启动，再重试。');}
 let data;try{data=await response.json();}catch{throw new Error('本机平台未响应，请确认 platform_server.py 正在运行。');}
 if(!response.ok){const error=new Error(data.error||`平台请求失败（${response.status}）。`);error.status=response.status;throw error;}
 return data;
}
async function detectPlatform(){
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),2500);
 try{const r=await fetch('./api/platform',{cache:'no-store',signal:controller.signal});if(r.ok){const data=await r.json();platformBackend=data.enabled===true;platformInfo=data;}}catch{}finally{clearTimeout(timer);}
 if(!platformBackend&&document.querySelector('meta[name="platform-mode"]')?.content==='backend')throw new Error('平台服务暂时不可用，请稍后重试。');
}
function mergeServerDevices(rows){
 serverDevices=rows;
 const legacy=platformBackend?[]:devices.filter(d=>!d.provisioned),previous=new Map(devices.filter(d=>d.provisioned).map(d=>[d.id,d]));
 const registered=rows.filter(d=>!d.deleted).map(raw=>{
  const d={...raw,metrics:[],values:{},history:{},online:false};
  for(const reading of raw.readings||[]){
   const parsed=parseTelemetry(reading.payload);if(!parsed.metrics.length)continue;
   applyTelemetry(d,{...parsed,time:new Date(reading.received*1000).toISOString(),sequence:reading.sequence,retained:false});
  }
  if(!d.metrics.length)d.diagnostics=[{type:'WAITING_FOR_DATA',level:'info',message:raw.readings?.length?'已收到消息，但未识别到数值指标，请检查上报格式。':'设备已登记，等待板子首次上报。',source:'设备接入'}];
  // A local settings override may alter the online timeout, but never supply sensor readings.
  const last=raw.readings?.filter(r=>parseTelemetry(r.payload).metrics.length).at(-1);
  d.online=!!last&&last.received>=(raw.activationAfter||0)&&Date.now()-last.received*1000<Math.max(15000,effective(d).sampleInterval*3000);
  const old=previous.get(d.id);if(old&&old.lastSeen===d.lastSeen&&old.lastMessage===d.lastMessage){d.history=old.history;d.historyTimes=old.historyTimes||d.historyTimes;}
  return d;
 });
 devices=[...legacy,...registered];
}
function resetRegistry(){
 clearTimeout(registryTimer);registryController?.abort();registrySession='';registryRequest++;serverDevices=[];registryLoaded=false;registryError='';connectionResult=null;
 devices=devices.filter(d=>!d.provisioned);
}
async function refreshRegistry(){
 const userId=currentUser?.id,generation=registryRequest;
 const data=await platformRequest('devices');
 if(currentUser?.id===userId&&registryRequest===generation){mergeServerDevices(data.devices);registryLoaded=true;registryError='';}
}
function syncRegistryPolling(){
 const session=platformBackend&&currentUser?currentUser.id:'';
 if(session===registrySession)return;
 clearTimeout(registryTimer);registryController?.abort();registrySession=session;
 if(!session)return;
 async function poll(){
  registryController=new AbortController();const timer=setTimeout(()=>registryController?.abort(),5000);
  try{
   const data=await platformRequest('devices',{signal:registryController.signal});
   if(registrySession!==session)return;
   mergeServerDevices(data.devices);registryLoaded=true;registryError='';
  }catch(error){
   if(registrySession!==session)return;
   if(error.status===401){resetRegistry();sessionStorage.removeItem('workspace-user');currentUser=null;companyId=null;notice='登录已过期，请重新登录。';render();return;}
   registryError=error.name==='AbortError'?'平台响应超时，正在重试。':error.message;
   for(const d of devices)if(d.provisioned)d.online=false;
  }finally{
   clearTimeout(timer);
   if(registrySession===session){
    updateProvisioningStatus();
    if(!registryBusy&&['company','detail','alerts'].includes(view)&&!document.activeElement?.closest('input,select,textarea'))render(true);
    registryTimer=setTimeout(poll,2000);
   }
  }
 }
 poll();
}
function provisioningStatus(d){
 if(d.online)return ['在线','green'];
 return d.lastSeen?['离线','gray']:['待激活','blue'];
}
function provisioningRows(){
 return companyDevices().map(d=>{
  const [label,color]=d.provisioned?provisioningStatus(d):status(deviceScene(d),effective(d));
  return `<tr><td><strong>${safe(d.name)}</strong><small>${safe(d.id)}</small></td><td>${safe(deviceScene(d)?.name)}<small>${safe(d.location)}</small></td><td><span class="badge ${color}">${label}</span><small>${d.provisioned?(d.lastSeen?'最近上报 '+safe(new Date(d.lastSeen).toLocaleTimeString('zh-CN')):'等待板子连接并上报'):'原有演示 / 本地设备'}</small></td><td><button class="dashboard-text-link" data-device="${safe(d.id)}">查看</button>${d.provisioned?`<button class="secondary" data-device-access="${safe(d.id)}">接入配置</button><button class="danger-button" data-server-delete="${safe(d.id)}">删除</button>`:''}</td></tr>`;
 }).join('')||'<tr><td colspan="4">暂无设备，请先创建设备。</td></tr>';
}
function connectionInstructions(d){
 if(!d)return '';
 return `<p class="settings-note">服务器：${safe(platformInfo.mqttHost)}:${safe(platformInfo.mqttPort)} · ${platformInfo.mqttTls?'MQTT over TLS':'MQTT 3.1.1'}</p><p>设备 ID / 用户名 / Client ID：<code>${safe(d.id)}</code></p><p>上报 Topic：<code>${safe(d.mqtt.topic)}</code></p><p class="settings-note">设备密钥只在创建或重置时显示一次。丢失时可重置，旧密钥会立即失效。</p><button class="secondary" type="button" data-reset-access="${safe(d.id)}">重置密钥并生成新配置</button>`;
}
function connectionResultHtml(){
 if(!connectionResult)return '';
 const {device:d,connection:c}=connectionResult;
 return `<section class="panel access-result" aria-label="设备接入配置"><div class="section-heading"><h2>设备已登记：${safe(d.name)}</h2><span class="badge blue">等待首次上报</span></div><ol class="access-steps"><li>下载板端配置，填写 Wi-Fi 名称和密码。</li><li>将配置放入支持 MQTT 账号认证的固件并烧录。</li><li>板子连接网络后，平台自动显示实际读数。</li></ol><p>接入服务器：<code>${safe(c.host)}:${safe(c.port)}</code> · ${c.tls?'TLS 加密，校验服务器证书':'本机明文 MQTT'}</p><p>设备 ID：<code>${safe(c.clientId)}</code></p><p>上报 Topic：<code>${safe(c.topic)}</code></p><label for="device-secret">设备密钥（仅本次显示，请保存）</label><input id="device-secret" type="password" value="${safe(c.password)}" readonly autocomplete="off"><div class="settings-actions"><button type="button" class="secondary" id="toggle-device-secret">显示密钥</button><button type="button" class="primary" id="download-device-header">下载 secrets.h</button><button type="button" class="secondary" id="download-device-json">下载 JSON</button><button type="button" class="text-button" id="close-device-access">已保存，关闭</button></div><p class="settings-note">secrets.h 可直接用于本项目 Mega → ESP8266 桥接固件；其他板型按 JSON 配置相同的接入参数。</p></section>`;
}
function provisionedManagementPage(){
 const deleted=serverDevices.filter(d=>d.companyId===companyId&&d.deleted);
 return heading('COMPANY / DEVICE ACCESS','设备接入',`${safe(company()?.name)} · 创建设备，配置板子，自动接收数据。`,'<button class="secondary" data-route="company">返回工作台</button>')+`<div class="access-flow"><span><b>1</b>创建设备</span><i>→</i><span><b>2</b>下载配置并烧录</span><i>→</i><span><b>3</b>联网自动上报</span></div>${platformInfo.localOnly?'<div class="offline-note">当前接收服务仅本机可访问，可使用本机 MQTT 客户端测试。连接真实板子时，请按使用说明启用局域网接入。</div>':''}<p id="registry-status" role="status">${safe(registryError||(registryLoaded?'设备列表已与本机平台同步':'正在读取设备列表…'))}</p><div class="inventory-layout"><section class="panel inventory-form-panel"><h2>创建设备</h2><p class="settings-note">不需要先连接板子，也不用选择上报消息。设备创建后自动归属本公司。</p><form id="provision-device-form"><label for="new-device-name">设备名称</label><input id="new-device-name" name="name" maxlength="40" placeholder="例如 1 号温室温湿度终端" required><label for="new-device-id">设备 ID（可选）</label><input id="new-device-id" name="id" maxlength="40" pattern="[A-Za-z0-9][A-Za-z0-9_-]{2,39}" placeholder="留空自动生成"><label for="new-device-scene">设备类型</label><select id="new-device-scene" name="sceneId" required>${availableDeviceScenes().map(s=>`<option value="${safe(s.id)}">${safe(s.name)}</option>`).join('')}</select><label for="new-workspace-scene">所属场景</label><select id="new-workspace-scene" name="workspaceSceneId">${sceneOptions()}</select><label for="new-device-location">安装位置</label><input id="new-device-location" name="location" maxlength="80" required placeholder="例如 1 号温室"><label for="new-device-interval">预期上报周期（秒）</label><input id="new-device-interval" name="sampleInterval" type="number" min="1" max="3600" step="1" value="30" required><p class="settings-note">用于判断离线；实际采集周期由板端程序决定。</p><p id="provision-error" class="error" role="alert"></p><button type="submit" class="primary">创建设备并生成接入配置</button></form></section><div class="inventory-lists">${connectionResultHtml()}<section class="panel inventory-list-panel"><div class="section-heading"><h2>公司设备</h2><span class="badge blue">自动更新</span></div><p id="device-operation-error" class="error" role="alert"></p><div class="table-wrap"><table class="inventory-table"><thead><tr><th>设备 / ID</th><th>类型 / 位置</th><th>状态</th><th>操作</th></tr></thead><tbody id="provision-device-rows">${provisioningRows()}</tbody></table></div><div id="existing-device-access"></div></section><section class="panel inventory-list-panel"><h2>已删除设备</h2><div id="server-deleted-devices">${deletedDevicesHtml(deleted)}</div></section></div></div><p class="settings-note">新创建设备保存在本机服务器，公司管理员分配设备后，客户才能读取对应设备和数据。电脑与板子需网络可达；本机测试时通常连接同一路由器。</p>`;
}
function deletedDevicesHtml(deleted){return deleted.map(d=>`<div class="inventory-deleted"><span>${safe(d.name)}<small>${safe(d.id)}</small></span><button class="secondary" data-server-restore="${safe(d.id)}">恢复</button></div>`).join('')||'<p class="muted">暂无已删除设备。</p>';}
function updateProvisioningStatus(){
 if(!platformBackend||view!=='device-manage')return;
 const status=document.querySelector('#registry-status');if(status)status.textContent=registryError||(registryLoaded?'设备列表已与本机平台同步':'正在读取设备列表…');
 const rows=document.querySelector('#provision-device-rows');if(rows){rows.innerHTML=provisioningRows();bindProvisioningRows();}
 const deleted=document.querySelector('#server-deleted-devices');if(deleted){deleted.innerHTML=deletedDevicesHtml(serverDevices.filter(d=>d.companyId===companyId&&d.deleted));bindProvisioningRestore();}
}
function deviceAccessHeader(c){
 return `#pragma once\n// Generated device identity. Keep this file private.\n#define WIFI_SSID "YOUR_2_4_GHZ_WIFI"\n#define WIFI_PASSWORD "YOUR_WIFI_PASSWORD"\n#define MQTT_HOST ${JSON.stringify(c.host)}\n${c.fallbackHost?`#define MQTT_HOST_FALLBACK ${JSON.stringify(c.fallbackHost)}\n`:''}#define MQTT_PORT ${c.port}\n#define MQTT_USE_TLS ${c.tls?1:0}\n${c.tls?`#define MQTT_CA_CERT ${JSON.stringify(c.caCert)}\n`:''}#define MQTT_DEVICE_ID ${JSON.stringify(c.clientId)}\n#define MQTT_USERNAME ${JSON.stringify(c.username)}\n#define MQTT_PASSWORD ${JSON.stringify(c.password)}\n#define MQTT_TOPIC ${JSON.stringify(c.topic)}\n`;
}
function downloadAccess(format){
 if(!connectionResult)return;
 const c=connectionResult.connection;
 const content=format==='json'?JSON.stringify({wifi:{ssid:'YOUR_2_4_GHZ_WIFI',password:'YOUR_WIFI_PASSWORD'},mqtt:c},null,2):deviceAccessHeader(c);
 const url=URL.createObjectURL(new Blob([content],{type:format==='json'?'application/json':'text/plain'})),a=document.createElement('a');a.href=url;a.download=format==='json'?`${c.clientId}-connection.json`:'secrets.h';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
async function serverDeviceAction(id,action){
 if(!canManageDevices()||registryBusy)return;
 if(action==='delete'&&!window.confirm('删除设备后将拒绝其连接和上报，确认删除？'))return;
 if(action==='reset-secret'&&!window.confirm('重置后旧密钥立即失效，板子需更新配置。继续？'))return;
 const userId=currentUser.id,generation=registryRequest;
 registryBusy=true;
 try{
  const result=await platformRequest(`devices/${encodeURIComponent(id)}/${action}`,{method:'POST',body:'{}'});
  if(currentUser?.id!==userId||registryRequest!==generation)return;
  if(result.connection)connectionResult=result;
  else if(action==='delete'&&connectionResult?.device.id===id)connectionResult=null;
  try{await refreshRegistry();}catch(error){registryError=error.message;}render();
 }catch(error){const target=document.querySelector('#device-operation-error');if(target)target.textContent=error.message;}
 finally{registryBusy=false;}
}
function bindProvisioningRestore(){document.querySelectorAll('[data-server-restore]').forEach(b=>b.onclick=()=>serverDeviceAction(b.dataset.serverRestore,'restore'));}
function bindProvisioningRows(){
 document.querySelectorAll('#provision-device-rows [data-device]').forEach(b=>b.onclick=()=>openDevice(b.dataset.device));
 document.querySelectorAll('[data-server-delete]').forEach(b=>b.onclick=()=>serverDeviceAction(b.dataset.serverDelete,'delete'));
 document.querySelectorAll('[data-device-access]').forEach(b=>b.onclick=()=>{const d=companyDevices().find(d=>d.id===b.dataset.deviceAccess);document.querySelector('#existing-device-access').innerHTML=connectionInstructions(d);document.querySelector('[data-reset-access]').onclick=()=>serverDeviceAction(d.id,'reset-secret');});
}
function bindProvisioning(){
 const form=document.querySelector('#provision-device-form');
 if(form)form.onsubmit=async event=>{
  event.preventDefault();if(!canManageDevices()||registryBusy)return;
  const button=form.querySelector('[type=submit]'),userId=currentUser.id,generation=registryRequest;button.disabled=true;registryBusy=true;
  try{
   const result=await platformRequest('devices',{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(form)))});
   if(currentUser?.id!==userId||registryRequest!==generation)return;
   connectionResult=result;try{await refreshRegistry();}catch(error){registryError=error.message;}notice='设备已创建，接入配置仅本次显示，请下载保存。';render();
  }catch(error){const target=document.querySelector('#provision-error');if(target)target.textContent=error.message;}
  finally{button.disabled=false;registryBusy=false;}
 };
 bindProvisioningRows();bindProvisioningRestore();
 const bind=(selector,callback)=>{const b=document.querySelector(selector);if(b)b.onclick=callback;};
 bind('#download-device-header',()=>downloadAccess('header'));bind('#download-device-json',()=>downloadAccess('json'));
 bind('#toggle-device-secret',()=>{const input=document.querySelector('#device-secret');input.type=input.type==='password'?'text':'password';document.querySelector('#toggle-device-secret').textContent=input.type==='password'?'显示密钥':'隐藏密钥';});
 bind('#close-device-access',()=>{connectionResult=null;render();});
}

async function refreshBeforeEnter(user,enter=true){
 currentUser=normalizeUser(user);
 try{await refreshWorkspace();}catch(error){currentUser=null;companyMembers=[];companyScenes=[];throw error;}
 try{await refreshRegistry();}catch(error){registryError=error.message;}
 if(enter)enterUser(user);
}
