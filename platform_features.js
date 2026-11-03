/* Server account settings and historical readings; static demos keep their existing flow. */
let historyQuery=null,historyRequest=0;
function localDateInput(date){
 const local=new Date(date.getTime()-date.getTimezoneOffset()*60000);
 return local.toISOString().slice(0,19);
}
function accountPasswordPanel(){
 if(!platformBackend)return '';
 return `<section class="panel account-password"><h2>修改登录密码</h2><p class="settings-note">密码需为 12–100 个字符。修改后所有已登录会话失效，需要重新登录。</p><form id="account-password-form"><label for="current-account-password">当前密码</label><input id="current-account-password" name="currentPassword" type="password" autocomplete="current-password" maxlength="100" required><label for="new-account-password">新密码</label><input id="new-account-password" name="newPassword" type="password" autocomplete="new-password" minlength="12" maxlength="100" required><label for="confirm-account-password">确认新密码</label><input id="confirm-account-password" name="confirmPassword" type="password" autocomplete="new-password" minlength="12" maxlength="100" required><p class="error" id="account-password-error" role="alert"></p><button class="primary" type="submit">修改密码并退出登录</button></form></section>`;
}
function historyPanel(d){
 if(!platformBackend||!d.provisioned)return '';
 const query=historyQuery?.deviceId===d.id&&historyQuery?.userId===currentUser.id?historyQuery:null;
 const end=new Date(),start=new Date(end.getTime()-86400000);
 return `<section class="panel history-panel"><div class="section-heading"><h2>历史数据</h2><span class="muted small">接收时间 · 本地时区</span></div><form id="history-query-form"><div><label for="history-start">开始时间</label><input id="history-start" name="start" type="datetime-local" step="1" value="${safe(query?.startInput||localDateInput(start))}" required></div><div><label for="history-end">结束时间</label><input id="history-end" name="end" type="datetime-local" step="1" value="${safe(query?.endInput||localDateInput(end))}" required></div><button class="primary" type="submit">查询历史</button></form><p class="settings-note">保留最近 ${safe(platformInfo?.retentionDays||90)} 天；每页 200 条。时间是服务器收到消息的时间。</p><div id="history-results" aria-live="polite">${query?historyResults(query):'<p class="muted">选择时间范围后查询，实时监测继续更新。</p>'}</div></section>`;
}
function historyResults(query){
 if(query.error)return `<p class="error" role="alert">${safe(query.error)}</p>`;
 if(query.busy&&!query.readings.length)return '<p class="muted">正在查询历史数据…</p>';
 if(!query.readings.length)return '<p class="muted">此时间范围内没有收到消息。</p>';
 const chronological=[...query.readings].reverse(),parsed=chronological.map(r=>({...parseTelemetry(r.payload),time:new Date(r.received*1000).toISOString()}));
 const metrics=[...new Map(parsed.flatMap(r=>r.metrics).map(m=>[m.key,m])).values()];
 const d={history:{},historyTimes:{}};
 for(const m of metrics){
  const readings=parsed.filter(r=>Number.isFinite(r.values[m.key]));
  // Keep actual timestamps and endpoints while bounding the number of SVG controls.
  const selected=readings.length>200?Array.from({length:200},(_,i)=>readings[Math.round(i*(readings.length-1)/199)]):readings;
  d.history[m.key]=selected.map(r=>r.values[m.key]);d.historyTimes[m.key]=selected.map(r=>r.time);
 }
 return `<p class="muted">已读取 ${query.readings.length} 条消息（表格按时间从新到旧排列）。${query.readings.length>200?'曲线每项最多选取 200 个原始采样点，保留最早和最新点。':''}</p><div class="history-charts">${metrics.map(m=>`<section class="history-metric"><h3>${safe(m.name)}</h3>${trend(m,d)}</section>`).join('')}</div><div class="table-wrap"><table class="inventory-table"><thead><tr><th>接收时间（本地）</th><th>上报内容</th></tr></thead><tbody>${query.readings.map(r=>`<tr><td><time datetime="${safe(new Date(r.received*1000).toISOString())}">${safe(sampleTimeLabel(new Date(r.received*1000).toISOString()))}</time></td><td class="history-payload">${safe(r.payload)}</td></tr>`).join('')}</tbody></table></div>${query.cursor&&query.readings.length<2000?`<button class="secondary" id="history-load-more" ${query.busy?'disabled':''}>${query.busy?'正在读取…':'读取更早记录'}</button>`:query.cursor?'<p class="settings-note">已显示 2000 条，请缩小时间范围继续查询。</p>':''}`;
}
function updateHistoryResults(){
 const results=document.querySelector('#history-results');if(results&&historyQuery){results.innerHTML=historyResults(historyQuery);bindHistoryMore();}
}
async function fetchHistory(query,append=false){
 const request=++historyRequest;
 query.busy=true;query.error='';updateHistoryResults();
 try{
  const params=new URLSearchParams({start:String(query.start),end:String(query.end),limit:'200'});
  if(append&&query.cursor)params.set('before',query.cursor);
  const result=await platformRequest(`devices/${encodeURIComponent(query.deviceId)}/history?${params}`);
  if(historyQuery!==query||historyRequest!==request||currentUser?.id!==query.userId)return;
  query.readings=append?[...query.readings,...result.readings]:result.readings;query.cursor=result.nextBefore;
 }catch(error){if(historyQuery===query&&historyRequest===request)query.error=error.message;}
 finally{if(historyQuery===query&&historyRequest===request){query.busy=false;if(view==='detail'&&deviceId===query.deviceId&&currentUser?.id===query.userId)updateHistoryResults();}}
}
function bindHistoryMore(){
 const more=document.querySelector('#history-load-more');if(more)more.onclick=()=>{if(historyQuery&&!historyQuery.busy)fetchHistory(historyQuery,true);};
}
function bindPlatformFeatures(){
 const historyForm=document.querySelector('#history-query-form');
 if(historyForm)historyForm.onsubmit=event=>{
  event.preventDefault();const form=event.currentTarget,startInput=form.elements.start.value,endInput=form.elements.end.value;
  historyQuery={userId:currentUser.id,deviceId,startInput,endInput,start:new Date(startInput).getTime()/1000,end:new Date(endInput).getTime()/1000,readings:[],cursor:null};
  if(!Number.isFinite(historyQuery.start)||!Number.isFinite(historyQuery.end)||historyQuery.end<=historyQuery.start){historyQuery.error='结束时间必须晚于开始时间。';updateHistoryResults();return;}
  fetchHistory(historyQuery);
 };
 bindHistoryMore();
 const form=document.querySelector('#account-password-form');
 if(form)form.onsubmit=async event=>{
  event.preventDefault();const button=form.querySelector('[type=submit]'),error=document.querySelector('#account-password-error');
  if(form.elements.newPassword.value!==form.elements.confirmPassword.value){error.textContent='两次新密码不一致。';return;}
  button.disabled=true;error.textContent='';
  try{
   await platformRequest('account/password',{method:'POST',body:JSON.stringify({currentPassword:form.elements.currentPassword.value,newPassword:form.elements.newPassword.value})});
   form.reset();await logout();notice='密码已修改，请使用新密码登录。';render();
  }catch(problem){error.textContent=problem.message;}
  finally{button.disabled=false;}
 };
}
