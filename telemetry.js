/* MQTT discovery uses received messages, never synthetic readings or IP scans. */
const mqttCandidates=new Map();
let mqttSelected='',mqttCursor=0,mqttTimer=null,mqttController=null,mqttSession='',mqttStatus='等待连接本地 MQTT 接收服务';
const deviceScene=d=>({...scenes.find(s=>s.id===d?.sceneId),...(d?.mqtt?{metrics:d.metrics||[]}: {})});
const mqttFresh=(row,interval=30)=>!!row&&!row.retained&&Number.isFinite(Date.parse(row.time))&&Date.now()-Date.parse(row.time)<Math.max(15000,interval*3000);
function parseTelemetry(text){
 const metrics=[],values=Object.create(null);
 const aliases={temperature:['temperature','温度','℃'],temp:['temperature','温度','℃'],'温度':['temperature','温度','℃'],humidity:['humidity','湿度','%'],'湿度':['humidity','湿度','%']};
 function add(label,input,unit=''){
  label=String(label).trim();if(!label||label.length>40||metrics.length>=32)return;
  const match=String(input).trim().match(/^([-+]?(?:\d+(?:\.\d*)?|\.\d+))\s*([^\d\s,，;；:]*)$/);
  if(!match||!Number.isFinite(Number(match[1])))return;
  const known=aliases[label.toLowerCase()],key=known?.[0]||`field_${Array.from(label).map(c=>c.codePointAt(0).toString(16)).join('_')}`;
  if(Object.hasOwn(values,key))return;
  unit=String(unit||match[2]||known?.[2]||'').slice(0,20).replace(/％/g,'%').replace(/^°\s*c$/i,'℃');
  if(/^oc$/i.test(unit))return;
  metrics.push({key,name:known?.[1]||label,unit,icon:known?.[0]||'device'});values[key]=Number(match[1]);
 }
 let payload;try{payload=JSON.parse(text);}catch{}
 if(payload&&typeof payload==='object'&&!Array.isArray(payload)){
  const fields=payload.metrics||payload.data||payload.values||payload;
  if(fields&&typeof fields==='object'&&!Array.isArray(fields))for(const [label,value] of Object.entries(fields)){
   if(['id','deviceId','device_id','name','timestamp','time','online','status'].includes(label))continue;
   if(value&&typeof value==='object'&&!Array.isArray(value))add(label,value.value,value.unit);
   else if(typeof value==='number'||typeof value==='string')add(label,value);
  }
 }else{
  const pattern=/([\p{L}_][\p{L}\p{N}_ /-]{0,39}?)\s*[:：=]?\s*([-+]?(?:\d+(?:\.\d*)?|\.\d+))\s*(°\s*[CF]|℃|[%％]|[a-zA-Zμµ/³]+)?/gu;
  for(const match of String(text).matchAll(pattern))add(match[1],match[2],match[3]);
 }
 const id=payload?.deviceId??payload?.device_id??payload?.id;
 return {metrics,values,identity:typeof id==='string'||typeof id==='number'?String(id).slice(0,128):'',name:typeof payload?.name==='string'?payload.name.slice(0,40):''};
}
function telemetryCandidate(line){
 if(typeof line?.topic!=='string'||!line.topic||typeof line.text!=='string')return null;
 const parsed=parseTelemetry(line.text);if(!parsed.metrics.length)return null;
 return {...parsed,topic:line.topic,key:JSON.stringify([line.topic,parsed.identity]),time:line.time,retained:!!line.retained,text:line.text};
}
function applyTelemetry(d,row){
 if(!d.mqtt)return;
 d.online=mqttFresh(row,d.sampleInterval);
 if(!row)return;
 d.metrics=row.metrics;d.values={...row.values};d.lastSeen=row.time;
 d.history||={};d.historyTimes||={};
 for(const m of row.metrics){
  if(d.lastMessage!==row.sequence){
   const history=d.history[m.key]||[],times=history.map((_,i)=>d.historyTimes[m.key]?.[i]??null);
   d.history[m.key]=[...history,row.values[m.key]].slice(-30);
   d.historyTimes[m.key]=[...times,row.time||null].slice(-30);
  }
 }
 d.lastMessage=row.sequence;
}
function receiveTelemetry(data){
 if(data.total<mqttCursor){mqttCursor=0;mqttCandidates.clear();for(const d of devices)if(d.mqtt)d.online=false;return;}
 for(const line of data.lines){
  const row=telemetryCandidate(line);if(!row)continue;
  row.sequence=line.id;for(const d of devices)if(d.mqtt?.key===row.key)applyTelemetry(d,row);mqttCandidates.delete(row.key);mqttCandidates.set(row.key,row);
  if(mqttCandidates.size>500)mqttCandidates.delete(mqttCandidates.keys().next().value);
 }
 mqttCursor=data.total;
 for(const d of devices)if(d.mqtt)applyTelemetry(d,data.status==='connected'?mqttCandidates.get(d.mqtt.key):null);
}
function mqttDiscoveryHtml(){
 return `<p role="status">${safe(mqttStatus)}</p><p class="settings-note">监听设备上报，收到可识别的指标后才可添加。请选择设备预览字段。</p>${[...mqttCandidates.values()].map(row=>`<button type="button" class="secondary mqtt-candidate" data-mqtt-candidate="${safe(row.key)}" ${mqttFresh(row)?'':'disabled'}><strong>${safe(row.name||row.identity||row.topic)}</strong><small>${safe(row.topic)} · ${mqttFresh(row)?'最近收到上报':'保留消息或已超时，等待新上报'}</small>${row.metrics.map(m=>`<span>${safe(m.name)}：${safe(row.values[m.key])} ${safe(m.unit)}</span>`).join('')}</button><details><summary>原始上报</summary><pre>${safe(row.text)}</pre></details>`).join('')||'<p class="muted">尚未发现设备，等待设备向订阅的 Topic 上报…</p>'}`;
}
function updateMqttDiscovery(){
 const panel=document.querySelector('#mqtt-discovery');if(!panel)return;
 panel.innerHTML=mqttDiscoveryHtml();
 panel.querySelectorAll('[data-mqtt-candidate]').forEach(button=>button.onclick=()=>{
  mqttSelected=button.dataset.mqttCandidate;const row=mqttCandidates.get(mqttSelected);
  const form=document.querySelector('#add-device-form');form.querySelector('fieldset').disabled=false;
  form.elements.mqttKey.value=mqttSelected;
  const identity=row.identity||row.topic.split('/').at(-1);
  form.elements.id.value=/^[A-Za-z0-9][A-Za-z0-9_-]{2,39}$/.test(identity)?identity:'';
  form.elements.name.value=row.name||row.identity||'MQTT 采集设备';
  document.querySelector('#mqtt-selection').textContent=`已选择：${row.identity||row.topic}，识别到 ${row.metrics.map(m=>m.name).join('、')}`;
 });
}
function syncMqttPolling(){
 const active=!platformBackend&&!!currentUser&&['company','detail','alerts','device-manage'].includes(view)&&(canManageDevices()&&view==='device-manage'||companyDevices().some(d=>d.mqtt));
 const session=active?`${currentUser.id}:${companyId}`:'';
 if(session===mqttSession)return;
 clearTimeout(mqttTimer);mqttTimer=null;mqttController?.abort();mqttSession=session;
 // A new user/company must discover devices again; never reuse another session's selection.
 mqttCandidates.clear();mqttSelected='';mqttCursor=0;
 if(!session)return;
 async function poll(){
  if(mqttSession!==session)return;
  const controller=new AbortController();mqttController=controller;
  const timeout=setTimeout(()=>controller.abort(),5000);
  try{
   const response=await fetch(`./api/messages?source=mqtt&after=${mqttCursor}`,{cache:'no-store',signal:controller.signal});
   if(!response.ok)throw new Error('无法读取 MQTT，请使用本地 serial_server.py 服务，并配置局域网 Broker 和订阅 Topic。');
   const data=await response.json();if(!Array.isArray(data.lines)||!Number.isFinite(data.total))throw new Error('MQTT 接收格式不正确。');
   if(mqttSession!==session)return;
   receiveTelemetry(data);mqttStatus=data.status==='connected'?`正在监听 ${data.host}:${data.port} · ${data.topic}`:data.error||'正在连接 / 订阅 MQTT…';
  }catch(error){
   if(mqttSession!==session)return;
   mqttStatus=error.name==='AbortError'?'MQTT 接收超时，正在重试…':error.message;
   for(const d of devices)if(d.mqtt)d.online=false;
  }finally{
   clearTimeout(timeout);
   if(mqttSession===session){
    updateMqttDiscovery();
    // Preserve edits and focus while the background subscription continues.
    if(view!=='device-manage'&&!document.activeElement?.closest('input,select,textarea'))render(true);
    mqttTimer=setTimeout(poll,1500);
   }
  }
 }
 poll();
}
