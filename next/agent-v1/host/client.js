window.__ModuleLoader__.load({
  id: '@local/dsh-juebot',
  factory(require) {
    const React = require('react'), h = React.createElement;
    const PANEL = 'juebot', NS = 'juebot-agent';
    const DICTIONARIES = { zh: { nav: '撅撅', title: '撅撅 · 会话与审核', empty: '暂无已授权数据', unconfigured: '尚未配置或当前服务不可用', refresh: '刷新' },
      en: { nav: 'juebot', title: 'juebot · Conversations and review', empty: 'No authorized data', unconfigured: 'Not configured or unavailable', refresh: 'Refresh' } };
    const style = `.juebot-agent{height:100%;overflow:auto;box-sizing:border-box;padding:20px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);font:inherit}.juebot-agent *{box-sizing:border-box}.juebot-agent .columns{display:grid;grid-template-columns:minmax(180px,24%) minmax(250px,1fr) minmax(230px,30%);gap:16px}.juebot-agent section{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:12px;min-width:0;margin-bottom:12px;background:var(--dsw-alias-bg-layer-1)}.juebot-agent button,.juebot-agent input,.juebot-agent textarea,.juebot-agent select{font:inherit;color:inherit;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:7px;margin:3px;max-width:100%}.juebot-agent button{cursor:pointer}.juebot-agent button:disabled{opacity:.5;cursor:not-allowed}.juebot-agent button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary)}.juebot-agent textarea{width:100%;min-height:70px}.juebot-agent pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:300px;overflow:auto;font:inherit;font-size:12px}.juebot-agent .muted{color:var(--dsw-alias-label-secondary)}.juebot-agent .error{color:var(--dsw-alias-state-error-primary)}@media(max-width:900px){.juebot-agent .columns{grid-template-columns:1fr}}`;
    const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
    const items = value => Array.isArray(value?.items) ? value.items : [];
    const pretty = value => JSON.stringify(value, null, 2);
    function PanelIcon({ size = 22, active }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: active ? 2 : 1.5, 'aria-hidden': true },
        h('rect', { x: 4, y: 6, width: 16, height: 15, rx: 4 }), h('path', { d: 'M12 6V2M8 13h1m6 0h1M8 17h8' }));
    }
    return { inject: ['slots', 'locale', 'layout'], apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, DICTIONARIES), 'juebot: agent locale');
      const label = ctx.locale.bind(NS);
      function AgentPage({ t = label }) {
        const [view, setView] = React.useState({ status: null, conversations: null, creations: null, outbox: null, code: null,
          events: null, settings: null, memory: null, self: null, creation: null, identity: null, learning: null, growth: null, mediaReady: {}, subtitleText: {}, bodies: {}, error: null, notice: null });
        const [selected, select] = React.useState(null), [tab, setTab] = React.useState('消息');
        const [prompt, setPrompt] = React.useState(''), [localText, setLocalText] = React.useState(''), [reason, setReason] = React.useState(''), [phrase, setPhrase] = React.useState('');
        const [profile, setProfile] = React.useState({ name: '', mode: 'juejue', roleCore: '' });
        const [restoreVersion, setRestoreVersion] = React.useState('');
        const [search,setSearch]=React.useState(''),[memoryEdit,setMemoryEdit]=React.useState(null),[memoryConfirm,setMemoryConfirm]=React.useState(null);
        const [ruleEdit,setRuleEdit]=React.useState({scope:'local',kind:'expressionRules',id:'',text:'',match:'contains',action:'blocked'}),[previewText,setPreviewText]=React.useState('');
        const [growthDraft,setGrowthDraft]=React.useState({id:'',warmth:50,curiosity:50,initiative:50,sources:[],suiteId:'',suiteVersion:1,checks:'privacy\nconversation'});
        const [creationDraft,setCreationDraft]=React.useState({intentionId:'',action:'bili.comment',accountId:'',objectId:'',parentId:'',visibility:'public',category:''});
        const [contactDraft,setContactDraft]=React.useState({start:'08:00',end:'22:00',timeZoneOffsetMinutes:480,cooldownMinutes:60,dailyLimit:3,unansweredLimit:2});
        const [creationTopic,setCreationTopic]=React.useState(''),[biliDraft,setBiliDraft]=React.useState({id:'',accountCanonical:'',bvid:'',itemId:'',proposalId:''});
        const [busy, setBusy] = React.useState(false);
        const conversationQuery=React.useRef({}),activeBili=React.useRef(null);
        const mounted = React.useRef(false), controllers = React.useRef(new Set()), activeKey = React.useRef(null), activeWork = React.useRef(null), versions = React.useRef(new Map());
        const call = async (name, options = {}) => {
          const { query = {}, body = null, method = 'GET' } = options;
          const serial = (versions.current.get(name) ?? 0) + 1; versions.current.set(name, serial);
          const controller = new AbortController(); controllers.current.add(controller);
          const timeout = setTimeout(() => {
            if (mounted.current && method !== 'GET') setView(previous => ({ ...previous, notice: '写入结果未确认，请刷新核对；不会自动重试。' }));
            controller.abort();
          }, 8000);
          // Only locally assigned diagnostics may reach the visible error text.
          let httpStatus = null, diagnosticCode = 'REQUEST_FAILED';
          try {
            const qs = new URLSearchParams(query).toString();
            const response = await fetch('api/juebot/agent/' + name + (qs ? '?' + qs : ''), { method,
              credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal,
              headers: { Accept: 'application/json', ...(body === null ? {} : { 'Content-Type': 'application/json' }) },
              ...(body === null ? {} : { body: JSON.stringify(body) }) });
            if (controller.signal.aborted || !mounted.current || versions.current.get(name) !== serial) return null;
            httpStatus = Number.isInteger(response.status) && response.status >= 100 && response.status <= 599 ? response.status : null;
            diagnosticCode = 'INVALID_RESPONSE';
            if (response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') throw Error();
            const envelope = await response.json();
            if (!response.ok || !object(envelope) || envelope.ok !== true || !Object.hasOwn(envelope, 'data')) {
              const code = envelope?.error?.code;
              diagnosticCode = typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) && code === code.trim()
                ? code : response.ok ? 'INVALID_RESPONSE' : 'REQUEST_FAILED';
              throw Error();
            }
            if (controller.signal.aborted || !mounted.current || versions.current.get(name) !== serial) return null;
            return envelope.data;
          } catch {
            if (mounted.current && !controller.signal.aborted && versions.current.get(name) === serial) setView(previous => ({ ...previous,
              error: (['AGENT_UNAVAILABLE', 'STORAGE_FAILURE', 'NOT_CONFIGURED'].includes(diagnosticCode) ? t('unconfigured')
                : diagnosticCode === 'INTENTION_UNAVAILABLE' ? '原意愿已过期或其依据已失效，不能恢复；需形成新的有效意愿。'
                : ['CREATION_WORKFLOW_INVALID', 'CREATION_SOURCE_REVOKED', 'CREATION_SOURCE_CHANGED', 'CREATION_PUBLISH_NOT_AUTHORIZED', 'POLICY_CHANGED'].includes(diagnosticCode)
                  ? '来源、身份或权限已变化，恢复被拒绝。请核对当前授权。' : '请求未完成，请刷新核对。')
                + `（${httpStatus === null ? '' : 'HTTP ' + httpStatus + ' · '}${diagnosticCode}）`,
              ...(method !== 'GET' ? { notice: '写入结果未确认；不会自动重试。' } : {}) }));
            return null;
          } finally { clearTimeout(timeout); controllers.current.delete(controller); }
        };
        const load = async (name, query = {}, key = null) => {
          if (name === 'creation') activeWork.current = query.id;
          const data = await call(name, { query });
          if (data === null || !mounted.current || (key !== null && activeKey.current !== key)) return;
          if (name === 'creation' && activeWork.current !== query.id) return;
          setView(previous => ({ ...previous, [name]: data }));
          if (name === 'settings') {setPrompt(data.local?.prompt ?? '');const contact=data.local?.contactPolicy;
            if(contact?.windows?.length){const clock=minute=>String(Math.floor(minute/60)).padStart(2,'0')+':'+String(minute%60).padStart(2,'0');
              setContactDraft({start:clock(contact.windows[0].startMinute),end:clock(contact.windows[0].endMinute===1440?0:contact.windows[0].endMinute),timeZoneOffsetMinutes:contact.timeZoneOffsetMinutes,cooldownMinutes:contact.cooldownMs/60000,dailyLimit:contact.dailyLimit,unansweredLimit:contact.unansweredLimit});}
            else setContactDraft({start:'08:00',end:'22:00',timeZoneOffsetMinutes:480,cooldownMinutes:60,dailyLimit:3,unansweredLimit:2});}
          if (name === 'identity' && object(data.profile)) setProfile(data.profile);
        };
        const refresh = async () => {
          if (!mounted.current) return;
          setView(previous => ({ ...previous, error: null }));
          const key = activeKey.current;
          await Promise.all([...['status', 'conversations', 'creations', 'outbox', 'code', 'identity', 'learning'].map(name => load(name,name==='conversations'?conversationQuery.current:{})),
            ...(activeWork.current === null ? [] : [load('creation', { id: activeWork.current })]),
            ...(key === null ? [] : ['settings', 'events', 'memory', 'self', 'growth', 'trace'].map(name => load(name, { key }, key)))]);
        };
        React.useEffect(() => {
          mounted.current = true; void refresh();
          return () => { mounted.current = false; for (const controller of controllers.current) controller.abort(); controllers.current.clear(); };
        }, []);
        React.useEffect(() => {
          activeKey.current = selected;
          setView(previous => ({ ...previous, events: null, settings: null, memory: null, self: null, growth: null, trace:null, expressionPreview:null,bodies: {} }));
          setMemoryEdit(null);setMemoryConfirm(null);setGrowthDraft(previous=>({...previous,sources:[]}));
          setCreationTopic('');setCreationDraft(previous=>({...previous,intentionId:''}));
          if (selected !== null) for (const name of ['events', 'settings', 'memory', 'self', 'growth','trace']) void load(name, { key: selected }, selected);
        }, [selected]);
        const mutate = async (name, body) => {
          if (busy) return;
          setBusy(true); setView(previous => ({ ...previous, error: null, notice: null }));
          try {
            const data = await call(name, { method: 'POST', body });
            if (data !== null && mounted.current) {
              setView(previous => ({ ...previous, notice: name==='creation-intention'&&!data.intention?'尚未形成可用意愿：'+(data.reason??'UNAVAILABLE'):name === 'creation-recovery' && data.status === 'failed'
                ? '恢复未完成；草稿已保留，请核对失败状态。不会自动重试。' : '操作已确认；已重新读取当前状态。' }));
              await refresh();
            }
          } finally { if (mounted.current) setBusy(false); }
        };
        const button = (text, onClick, disabled = false) => h('button', { type: 'button', onClick, disabled: disabled || busy }, text);
        const selectConversation = key => {
          activeKey.current = key;
          setView(previous => ({ ...previous, events: null, settings: null, memory: null, self: null, growth: null, bodies: {} }));
          select(key);
        };
        const section = (title, ...children) => h('section', null, h('h3', null, title), ...children);
        const empty = () => h('p', { className: 'muted' }, t('empty'));
        const field=(label,value,onChange,type='text')=>h('label',null,label,h('input',{'aria-label':label,type,value,onChange:event=>onChange(event.target.value)}));
        const choosePage=offset=>{conversationQuery.current={q:search,offset:String(offset),limit:'20'};void load('conversations',conversationQuery.current);};
        const biliRead=async id=>{activeBili.current=id;const data=await call('bili-source',{query:{id}});if(data&&mounted.current&&activeBili.current===id)setView(previous=>({...previous,biliSource:data}));};
        const biliWrite=async body=>{if(busy)return;activeBili.current=body.id;setBusy(true);try{const result=await call('bili-source',{method:'POST',body});if(result&&mounted.current){if(activeBili.current===body.id)await biliRead(body.id);await refresh();}}finally{if(mounted.current)setBusy(false);}};
        const memoryControls=()=>!view.memory?.canReviewMemory?null:h('div',null,h('h4',null,'记忆人工复核'),
          ...items(view.memory).map(item=>button('复核记忆 '+item.id,()=>{setMemoryEdit({id:item.id,revision:item.revision,text:item.text,action:'correct',reason:'',targets:[],purposes:['read','learn','draft'],hours:24,includePrivate:false});setMemoryConfirm(null);})),
          !memoryEdit?null:h('div',null,h('p',null,`记忆 ${memoryEdit.id} · v${memoryEdit.revision}`),
            h('label',null,'复核操作',h('select',{'aria-label':'复核操作',value:memoryEdit.action,onChange:event=>{setMemoryEdit({...memoryEdit,action:event.target.value});setMemoryConfirm(null);}},
              ...[['correct','纠正摘要'],['share','分享摘要'],['unshare','撤回分享'],['revoke','撤销记忆'],['prepare-summary','用于公开创作（仅摘要）']].map(([value,title])=>h('option',{value,key:value},title)))),
            memoryEdit.action==='correct'?h('textarea',{'aria-label':'纠正摘要',maxLength:4000,value:memoryEdit.text,onChange:event=>setMemoryEdit({...memoryEdit,text:event.target.value})}):null,
            memoryEdit.action==='share'?h('div',null,h('p',null,'仅选择当前可见目标。分享摘要不授权原文或发布。'),
              ...items(view.conversations).filter(item=>item.key!==selected).map(item=>h('label',{key:item.key},h('input',{type:'checkbox',checked:memoryEdit.targets.includes(item.key),onChange:event=>setMemoryEdit({...memoryEdit,targets:event.target.checked?[...memoryEdit.targets,item.key]:memoryEdit.targets.filter(key=>key!==item.key)})}),item.label||item.key)),
              ...['read','learn','draft'].map(purpose=>h('label',{key:purpose},h('input',{type:'checkbox',checked:memoryEdit.purposes.includes(purpose),onChange:event=>setMemoryEdit({...memoryEdit,purposes:event.target.checked?[...memoryEdit.purposes,purpose]:memoryEdit.purposes.filter(value=>value!==purpose)})}),purpose)),
              field('分享期限（小时，1–720）',memoryEdit.hours,value=>setMemoryEdit({...memoryEdit,hours:Number(value)}),'number'),
              h('label',null,h('input',{'aria-label':'明确允许私密摘要',type:'checkbox',checked:memoryEdit.includePrivate,onChange:event=>setMemoryEdit({...memoryEdit,includePrivate:event.target.checked})}),'明确允许私密摘要')):null,
            memoryEdit.action==='prepare-summary'?h('div',null,
              h('p',null,'只授权这张具体摘要用于下方账号和目标的创作准备；原始聊天不开放，最终成品仍需单独人审。请先在创作区填写账号和目标。'),
              h('pre',null,pretty({text:items(view.memory).find(item=>item.id===memoryEdit.id)?.text,action:creationDraft.action,accountId:creationDraft.accountId,
                target:{objectId:creationDraft.objectId||null,parentId:creationDraft.parentId||null,visibility:creationDraft.visibility,category:creationDraft.category||null}})),
              field('摘要创作期限（小时，1–720）',memoryEdit.hours,value=>setMemoryEdit({...memoryEdit,hours:Number(value)}),'number'),
              h('label',null,h('input',{'aria-label':'明确授权私密摘要创作',type:'checkbox',checked:memoryEdit.includePrivate,onChange:event=>setMemoryEdit({...memoryEdit,includePrivate:event.target.checked})}),'明确授权所选私密摘要用于该作品')):null,
            h('textarea',{'aria-label':'记忆复核理由',value:memoryEdit.reason,maxLength:1000,onChange:event=>setMemoryEdit({...memoryEdit,reason:event.target.value})}),
            button('预览记忆变更',()=>{const e=memoryEdit;if(e.action==='prepare-summary'){
              setMemoryConfirm({route:'summary-creation',key:selected,memoryId:e.id,expectedMemoryRevision:e.revision,expectedPolicyRevision:view.memory.policyRevision,
                reason:e.reason,expiresAt:Date.now()+e.hours*3600000,...(e.includePrivate?{includePrivate:true}:{}),
                summaryText:items(view.memory).find(item=>item.id===e.id)?.text,
                request:{action:creationDraft.action,accountId:creationDraft.accountId,target:{objectId:creationDraft.objectId||null,parentId:creationDraft.parentId||null,visibility:creationDraft.visibility,category:creationDraft.category||null}}});return;
            }setMemoryConfirm({key:selected,id:e.id,action:e.action,reason:e.reason,expectedMemoryRevision:e.revision,expectedPolicyRevision:view.memory.policyRevision,
              ...(e.action==='correct'?{text:e.text}:{}),...(e.action==='share'?{targets:e.targets,purposes:e.purposes,expiresAt:Date.now()+e.hours*3600000,...(e.includePrivate?{includePrivate:true}:{})}:{})});},
              !memoryEdit.reason.trim()||!Number.isSafeInteger(memoryEdit.revision)||(memoryEdit.action==='prepare-summary'&&(!creationDraft.accountId.trim()||!creationDraft.visibility.trim()||!Number.isFinite(memoryEdit.hours)||memoryEdit.hours<1||memoryEdit.hours>720))||(memoryEdit.action==='correct'&&!memoryEdit.text.trim())||(memoryEdit.action==='share'&&(!memoryEdit.targets.length||!memoryEdit.purposes.length||memoryEdit.hours<1||memoryEdit.hours>720))),
            memoryConfirm?.key===selected?h('div',null,h('h4',null,'确认以下具体变更'),h('pre',null,pretty(memoryConfirm)),
              button('确认提交记忆变更',()=>{const {route,summaryText,...body}=memoryConfirm;setMemoryConfirm(null);setMemoryEdit(null);void mutate(route??'memory',body);}),button('取消记忆变更',()=>setMemoryConfirm(null))):null),
          h('h4',null,'复核记录'),...(view.memory.reviews??[]).map((review,index)=>h('p',{key:index},pretty(review))));
        const expressionControls=()=>{
          if(!view.settings)return null;const keyFor=scope=>scope==='global'?{}:{key:selected};
          const saveList=(scope,kind,list)=>void mutate('settings',{...keyFor(scope),expectedRevision:view.settings.revision,patch:{[kind]:list}});
          return h('div',null,h('h4',null,'表达规则与自然风格'),...['global','local'].map(scope=>h('div',{key:scope},h('h5',null,scope==='global'?'全局规则':'本会话规则'),
            ...['expressionRules','styleContracts'].flatMap(kind=>(view.settings[scope]?.[kind]??[]).map(item=>h('article',{key:kind+(item.ruleId??item.contractId)},h('p',null,`${item.ruleId??item.contractId} · ${item.phrase??item.policyText}`),
              button('编辑 '+(item.ruleId??item.contractId),()=>setRuleEdit({scope,kind,id:item.ruleId??item.contractId,text:item.phrase??item.policyText,match:item.match??'contains',action:item.action??'blocked'}),scope==='global'&&!view.settings.canManage),
              button('删除 '+(item.ruleId??item.contractId),()=>saveList(scope,kind,(view.settings[scope]?.[kind]??[]).filter(row=>(row.ruleId??row.contractId)!==(item.ruleId??item.contractId))),scope==='global'&&!view.settings.canManage)))))),
            h('select',{'aria-label':'规则范围',value:ruleEdit.scope,onChange:event=>setRuleEdit({...ruleEdit,scope:event.target.value,id:''})},h('option',{value:'local'},'本会话'),h('option',{value:'global'},'全局')),
            h('select',{'aria-label':'规则类型',value:ruleEdit.kind,onChange:event=>setRuleEdit({...ruleEdit,kind:event.target.value,id:''})},h('option',{value:'expressionRules'},'字面规则'),h('option',{value:'styleContracts'},'自然风格')),
            h('textarea',{'aria-label':'规则内容',value:ruleEdit.text,maxLength:ruleEdit.kind==='styleContracts'?4000:256,onChange:event=>setRuleEdit({...ruleEdit,text:event.target.value})}),
            ruleEdit.kind==='expressionRules'?h('div',null,h('select',{'aria-label':'规则匹配',value:ruleEdit.match,onChange:event=>setRuleEdit({...ruleEdit,match:event.target.value})},h('option',{value:'contains'},'包含'),h('option',{value:'exact'},'完全一致')),
              h('select',{'aria-label':'规则动作',value:ruleEdit.action,onChange:event=>setRuleEdit({...ruleEdit,action:event.target.value})},h('option',{value:'blocked'},'阻止'),h('option',{value:'rewrite'},'重写'))):null,
            button('保存表达规则',()=>{const e=ruleEdit,id=e.id||'ui-'+Date.now();const list=view.settings[e.scope]?.[e.kind]??[];const old=list.find(row=>(row.ruleId??row.contractId)===id);
              const next=e.kind==='styleContracts'?{contractId:id,policyText:e.text,counterexamples:old?.counterexamples??[]}:{ruleId:id,phrase:e.text,match:e.match,action:e.action};saveList(e.scope,e.kind,[...list.filter(row=>(row.ruleId??row.contractId)!==id),next]);setRuleEdit({...e,id:'',text:''});},!ruleEdit.text.trim()||(ruleEdit.scope==='global'&&!view.settings.canManage)),
            field('表达预览文本',previewText,setPreviewText),button('检查当前表达',async()=>{const key=activeKey.current;const result=await call('expression-preview',{method:'POST',body:{key,text:previewText,kind:'social'}});if(result&&activeKey.current===key)setView(previous=>({...previous,expressionPreview:result}));},!previewText.trim()),
            view.expressionPreview?h('p',null,'表达检查：'+pretty(view.expressionPreview)):null);};
        const selectedRecord = items(view.conversations).find(item => item.key === selected);
        const growthControls=()=>!view.growth?empty():h('div',null,h('p',null,`当前版本：${view.growth.value?.growthVersion??'未知'}`),
          ...['warmth','curiosity','initiative'].map(name=>field('成长 '+name,growthDraft[name],value=>setGrowthDraft({...growthDraft,[name]:Number(value)}),'number')),
          field('成长候选编号',growthDraft.id,value=>setGrowthDraft({...growthDraft,id:value})),
          h('p',null,'选择当前有效事件作为来源（最多16条）'),...Object.entries(view.growth.value?.evidence??{}).filter(([,proof])=>!proof.revoked).map(([eventId,proof])=>h('label',{key:eventId},
            h('input',{type:'checkbox',checked:growthDraft.sources.some(source=>source.eventId===eventId),onChange:event=>setGrowthDraft({...growthDraft,sources:event.target.checked?[...growthDraft.sources,{eventId,revision:proof.revision}]:growthDraft.sources.filter(source=>source.eventId!==eventId)})}),eventId)),
          button('提出成长候选',()=>{void mutate('growth',{key:selected,command:'propose',id:growthDraft.id,adaptation:{warmth:growthDraft.warmth,curiosity:growthDraft.curiosity,initiative:growthDraft.initiative},sources:growthDraft.sources});},!growthDraft.id.trim()||!growthDraft.sources.length||growthDraft.sources.length>16||['warmth','curiosity','initiative'].some(name=>!Number.isSafeInteger(growthDraft[name])||growthDraft[name]<0||growthDraft[name]>100)),
          field('评测套件编号',growthDraft.suiteId,value=>setGrowthDraft({...growthDraft,suiteId:value})),field('评测套件版本',growthDraft.suiteVersion,value=>setGrowthDraft({...growthDraft,suiteVersion:Number(value)}),'number'),
          h('textarea',{'aria-label':'评测检查项（每行一个）',value:growthDraft.checks,onChange:event=>setGrowthDraft({...growthDraft,checks:event.target.value})}),
          button('冻结评测检查项',()=>{void mutate('growth',{key:selected,command:'freeze',suite:{id:growthDraft.suiteId,version:growthDraft.suiteVersion,checks:[...new Set(growthDraft.checks.split(/\r?\n/).map(value=>value.trim()).filter(Boolean))].map(id=>({id,required:true}))}});},!growthDraft.suiteId.trim()||!growthDraft.checks.trim()||!Number.isSafeInteger(growthDraft.suiteVersion)||growthDraft.suiteVersion<1),
          h('h4',null,'已冻结套件'),...(view.growth.suites??[]).map(row=>h('p',{key:row.value.id+row.value.version},`${row.value.id} v${row.value.version}：${row.value.checks.map(check=>check.id).join(' / ')}`)),
          view.growth.evaluatorConfigured?null:h('p',{className:'muted'},'可信 Host 评测器未配置，不能生成或自报成绩。'),
          ...(view.growth.candidates??[]).map(row=>h('article',{key:row.value.id},h('h4',null,`${row.value.id} · ${row.value.status}`),h('pre',null,pretty({adaptation:row.value.adaptation,sources:row.value.sources,evaluation:row.value.evaluation,reviewer:row.value.reviewer})),
            button('可信评测 '+row.value.id,()=>{void mutate('growth',{key:selected,command:'evaluate',id:row.value.id,expectedRevision:row.revision});},!view.growth.evaluatorConfigured||!['proposed','evaluated'].includes(row.value.status)),
            button('批准成长 '+row.value.id,()=>{void mutate('growth',{key:selected,command:'review',id:row.value.id,expectedRevision:row.revision,accepted:true});},row.value.status!=='evaluated'),
            button('拒绝成长 '+row.value.id,()=>{void mutate('growth',{key:selected,command:'review',id:row.value.id,expectedRevision:row.revision,accepted:false});},row.value.status!=='evaluated'),
            button('启用成长 '+row.value.id,()=>{void mutate('growth',{key:selected,command:'activate',id:row.value.id,expectedCandidateRevision:row.revision,expectedStateRevision:view.growth.revision});},row.value.status!=='approved'))),
          h('label',null,'恢复已存在的成长版本',h('select',{'aria-label':'恢复成长版本',value:restoreVersion,onChange:event=>setRestoreVersion(event.target.value)},h('option',{value:''},'选择已存在版本'),...(view.growth.versions??[]).map(version=>h('option',{value:version.id,key:version.id},version.id)))),
          button('恢复指定成长版本',()=>{void mutate('growth',{key:selected,command:'restore',version:restoreVersion,expectedStateRevision:view.growth.revision});},selected===null||!restoreVersion||!(view.growth.versions??[]).some(version=>version.id===restoreVersion)),
          h('p',{className:'muted'},'仅恢复已有适应层；来源和当前权限仍需有效，不回退已发送内容。'));
        const creationControls=()=>!view.self?null:h('div',null,h('h4',null,'将当前意愿准备为创作草稿'),
          field('创作主题',creationTopic,setCreationTopic),
          button('评估创作意愿',()=>{void mutate('creation-intention',{key:selected,topic:creationTopic.trim()});},!creationTopic.trim()||creationTopic.length>128),
          h('label',null,'创作意愿',h('select',{'aria-label':'创作意愿',value:creationDraft.intentionId,onChange:event=>setCreationDraft({...creationDraft,intentionId:event.target.value})},h('option',{value:''},'选择有效意愿'),
            ...(view.self.value?.intents??[]).filter(intent=>intent.status==='pending'&&intent.expiresAt>Date.now()).map(intent=>h('option',{key:intent.id,value:intent.id},`${intent.id} · ${intent.topic}`)))),
          h('label',null,'创作动作',h('select',{'aria-label':'创作动作',value:creationDraft.action,onChange:event=>setCreationDraft({...creationDraft,action:event.target.value})},...['qqspace','bili.comment','bili.reply','bili.dynamic','bili.video'].map(action=>h('option',{value:action,key:action},action)))),
          ...[['accountId','创作账号ID'],['objectId','目标对象ID'],['parentId','父回复ID'],['visibility','可见范围'],['category','视频分类']].map(([key,title])=>field(title,creationDraft[key],value=>setCreationDraft({...creationDraft,[key]:value}))),
          h('p',{className:'muted'},'账号与目标需来自实际授权。准备只生成草稿，完整成品仍需人工审核与显式提交。'),
          button('准备创作草稿',()=>{const draft=creationDraft;void mutate('creation-start',{key:selected,intentionId:draft.intentionId,action:draft.action,accountId:draft.accountId,
            target:{objectId:draft.objectId||null,parentId:draft.parentId||null,visibility:draft.visibility,category:draft.category||null}});},!creationDraft.intentionId||!creationDraft.accountId.trim()||!creationDraft.visibility.trim()||(['bili.comment','bili.reply'].includes(creationDraft.action)&&!creationDraft.objectId.trim())||(creationDraft.action==='bili.video'&&!creationDraft.category.trim())));
        const eventRows = items(view.events);
        const readBody = async event => {
          const key = activeKey.current;
          const data = await call('body', { query: { key, sequence: String(event.bodyRef ?? event.sequence) } });
          if (data !== null && mounted.current && activeKey.current === key) setView(previous => ({ ...previous, bodies: { ...previous.bodies, [event.sequence]: data.body } }));
        };
        const work = view.creation?.value;
        const canRecover = work?.workflow && ['planning', 'producing', 'failed'].includes(work.workflow.phase)
          && work.workflow.reasonCode !== 'HUMAN_ABANDONED' && !work.approval && !work.submission;
        const manifest = work?.final?.manifest;
        const references = manifest ? [manifest.video, manifest.cover, ...(manifest.audio ?? []), ...(manifest.subtitles ?? []), ...(manifest.attachments ?? [])].filter(Boolean) : [];
        const mediaKey = reference => `${work?.id}:${work?.version}:${reference.previewRef}:${reference.sha256}`;
        const mediaUrl = reference => /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(reference?.previewRef ?? '') && /^[a-f0-9]{64}$/.test(reference?.sha256 ?? '')
          ? 'api/juebot/agent/media?ref=' + encodeURIComponent(reference.previewRef) : null;
        const markMedia = (reference, ready) => { if (mounted.current) setView(previous => ({ ...previous, mediaReady: { ...previous.mediaReady, [mediaKey(reference)]: ready } })); };
        React.useEffect(() => {
          const controller = new AbortController(); controllers.current.add(controller);
          const timeout = setTimeout(() => controller.abort(), 8000);
          const pending = references.filter(reference => view.creation?.assetKinds?.[reference.previewRef] === 'subtitles');
          void Promise.all(pending.map(async reference => {
            let reader;
            try {
              const url = mediaUrl(reference); if (!url) return;
              const response = await fetch(url, { method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal });
              if (!response.ok || response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'text/vtt' || !response.body) throw Error('INVALID_SUBTITLE');
              reader = response.body.getReader(); const parts = []; let size = 0;
              for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 262144) throw Error('SUBTITLE_TOO_LARGE'); parts.push(part.value); }
              const bytes = new Uint8Array(size); let offset = 0; for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
              const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); if (!text.startsWith('WEBVTT')) throw Error('INVALID_SUBTITLE');
              if (!mounted.current || controller.signal.aborted) return;
              setView(previous => ({ ...previous, subtitleText: { ...previous.subtitleText, [mediaKey(reference)]: text }, mediaReady: { ...previous.mediaReady, [mediaKey(reference)]: true } }));
            } catch { if (!controller.signal.aborted) markMedia(reference, false); }
            finally { try { void reader?.cancel().catch(() => {}); reader?.releaseLock(); } catch {} }
          })).finally(() => { clearTimeout(timeout); controllers.current.delete(controller); });
          return () => { clearTimeout(timeout); controller.abort(); controllers.current.delete(controller); };
        }, [work?.id, work?.version]);
        const mediaVerified = references.every(reference => mediaUrl(reference) && view.creation?.assetKinds?.[reference.previewRef] && view.mediaReady[mediaKey(reference)] === true);
        const assetPreview = reference => {
          if (!reference) return null;
          const url = mediaUrl(reference), kind = view.creation?.assetKinds?.[reference.previewRef];
          if (!url || !['video', 'audio', 'image', 'subtitles'].includes(kind)) return h('p', { className: 'error' }, '媒体类型或受控预览不可用，不能批准。');
          const common = { key: mediaKey(reference), src: url, onError: () => markMedia(reference, false), style: { maxWidth: '100%' } };
          let preview;
          if (kind === 'image') preview = h('img', { ...common, alt: '审核作品图片', onLoad: () => markMedia(reference, true) });
          else if (kind === 'audio') preview = h('audio', { ...common, controls: true, preload: 'metadata', onLoadedMetadata: () => markMedia(reference, true) });
          else if (kind === 'video') preview = h('video', { ...common, controls: true, preload: 'metadata', onLoadedMetadata: () => markMedia(reference, true) },
            ...(manifest?.subtitles ?? []).filter(item => mediaUrl(item)).map(item => h('track', { key: item.previewRef, kind: 'subtitles', label: item.previewRef, src: mediaUrl(item), srcLang: 'zh', default: true, onError: () => markMedia(item, false) })));
          else preview = h('pre', null, view.subtitleText[mediaKey(reference)] ?? '正在读取受控字幕预览…');
          return h('div', { key: mediaKey(reference) }, h('p', null, `${kind} · SHA-256：${reference.sha256}`), preview,
            view.mediaReady[mediaKey(reference)] === false ? h('p', { className: 'error' }, '预览加载失败，不能批准。') : null);
        };
        return h('div', { className: 'juebot-agent' }, h('style', null, style),
          h('h2', null, t('title')), button(t('refresh'), () => { void refresh(); }),
          button('返回对话', () => ctx.layout.selectPanel('conversation')),
          view.error ? h('p', { className: 'error', role: 'alert' }, view.error) : null,
          view.notice ? h('p', { role: 'status' }, view.notice) : null,
          h('p', { className: 'muted' }, '候选控制台；能力与数据按实际接线显示。没有接入时不显示虚构会话。'),
          section('撅撅状态', view.status ? h('div', null,
            h('p', null, `${view.status.name ?? '未配置'} · ${view.status.mode ?? '未配置'} · ${view.status.runtime ?? '未知'}`),
            h('p', null, `模型：${view.status.modelConfigured ? '已配置' : '未配置'}；出站：${view.status.paused ? '暂停' : '按权限控制'}`),
            h('pre', null, pretty(view.status.capabilities ?? [])),
            button(view.status.paused ? '解除出站暂停' : '暂停全部出站', () => { void mutate('pause', { expectedRevision: view.status.pauseRevision, paused: !view.status.paused }); }, !Number.isSafeInteger(view.status.pauseRevision))) : empty()),
          section('身份与角色核心', !view.identity ? empty() : h('div', null,
            h('label', null, '名字', h('input', { value: profile.name ?? '', maxLength: 128, onChange: event => setProfile(previous => ({ ...previous, name: event.target.value })) })),
            h('label', null, '模式', h('select', { value: profile.mode ?? 'juejue', onChange: event => {
              const mode = event.target.value; if (!['juejue', 'persona'].includes(mode)) return;
              const saved = view.identity?.profiles?.[mode];
              setProfile(previous => object(saved) && saved.mode === mode ? { ...saved } : { ...previous, mode });
              setView(previous => ({ ...previous, notice: object(saved) && saved.mode === mode
                ? '已载入目标模式的已保存档案；点击保存身份后才切换。' : '目标模式尚无保存档案，当前内容仅作草稿；请核对并显式保存。' }));
            } }, h('option', { value: 'juejue' }, '撅撅'), h('option', { value: 'persona' }, '人格'))),
            h('label', null, '角色核心', h('textarea', { value: profile.roleCore ?? '', onChange: event => setProfile(previous => ({ ...previous, roleCore: event.target.value })) })),
            button('保存身份', () => { void mutate('identity', { expectedRevision: view.identity.revision, profile }); }))),
          h('div', { className: 'columns' },
            h('div', null, section('会话列表',field('过滤会话',search,setSearch),button('筛选会话',()=>choosePage(0)),
              h('p',{className:'muted'},`可见会话：${view.conversations?.total??items(view.conversations).length}`),
              button('上一页会话',()=>choosePage(Math.max(0,Number(conversationQuery.current.offset??0)-20)),Number(conversationQuery.current.offset??0)<=0),
              button('下一页会话',()=>choosePage(view.conversations.nextOffset),!Number.isSafeInteger(view.conversations?.nextOffset)),
              ...(!items(view.conversations).length ? [empty()] : items(view.conversations).map(item =>
              h('div', { key: item.key }, button(`${item.synthetic ? '[合成] ' : ''}${item.label || item.kind || '会话'} · ${item.status ?? '未知'}`, () => selectConversation(item.key)),
                h('small', null, `${item.connector ?? ''} / ${item.kind ?? ''}`))))),
              section('创作审核', ...(!items(view.creations).length ? [empty()] : items(view.creations).map(item =>
                h('div', { key: item.id }, button(`${item.id} · ${item.action} · ${item.stage} · v${item.version}`, () => { void load('creation', { id: item.id }); })))))),
            h('div', null, section(selectedRecord?.label || '当前会话',
              ...['消息', '轨迹', '记忆'].map(name => button(name, () => setTab(name), selected === null)),
              selected === null ? empty() : tab==='轨迹'?h('div',null,h('h4',null,'可核对的运行轨迹'),
                h('p',{className:'muted'},'仅显示决定、记忆编号、等待与回执；不显示隐藏思维。'),
                ...(view.trace?.turns??[]).map(turn=>h('article',{key:turn.id},h('p',null,`${turn.id} · ${turn.status} · ${turn.reason}`),h('p',null,`记忆编号：${turn.memoryIds.join(' / ')||'无'}`))),
                ...(view.trace?.deliveries??[]).map(row=>h('p',{key:row.id},`${row.kind} · ${row.status} · ${row.reason} · 等待${row.waitMs}ms · 回执${row.receipt??'无'}`))):tab === '记忆'
                ? h('div', null, ...(!items(view.memory).length ? [empty()] : items(view.memory).map(item => h('article', { key: item.id }, h('h4', null, `${item.kind} · ${item.status}`), h('pre', null, item.text)))),
                  memoryControls(),h('h4', null, '当前会话来源'), h('p', { className: 'muted' }, '撤销后将停止使用该来源及其派生记忆。'),
                  ...(Array.isArray(view.memory?.sources) && view.memory.sources.length ? view.memory.sources.map(source => h('article', { key: source.id },
                    h('p', null, `${source.id} · v${source.revision} · ${source.domain} · ${source.status}`),
                    h('p', null, `用途：${(source.purposes ?? []).join(' / ')}；期限：${source.expiresAt ?? '无固定期限'}`),
                    view.memory.canManageSources ? button(`撤销来源 ${source.id}`, () => { void mutate('memory', { key: selected, action: 'revoke-source', sourceId: source.id,
                      expectedPolicyRevision: view.memory.policyRevision, nextSourceRevision: source.revision + 1 }); }, source.status !== 'active'
                        || !Number.isSafeInteger(source.revision) || source.revision === Number.MAX_SAFE_INTEGER || !Number.isSafeInteger(view.memory.policyRevision)) : null)) : [empty()]))
                : h('div', null, ...(!eventRows.length ? [empty()] : eventRows.map(event => h('article', { key: event.sequence },
                  h('p', null, `#${event.sequence} · ${event.eventType} · ${event.reasonCode} · ${event.occurredAt}`),
                  tab === '消息' && event.bodyRef ? button('按权限读取正文', () => { void readBody(event); }) : null,
                  Object.hasOwn(view.bodies, event.sequence) ? h('pre', null, view.bodies[event.sequence] ?? '无正文') : null))),
              view.events?.nextCursor ? button('加载后续事件', () => { void load('events', { key: selected, cursor: view.events.nextCursor }, selected); }) : null,
              h('p', { className: 'muted' }, '本地聊天仅供 local-test 会话；由配置的合成/测试模型处理。'),
              h('textarea', { 'aria-label': '本地测试消息', value: localText, disabled: selectedRecord?.connector !== 'local-test' || !view.status?.modelConfigured || busy, onChange: event => setLocalText(event.target.value) }),
              button('发送本地测试', () => { void mutate('local-message', { key: selected, text: localText }); }, selectedRecord?.connector !== 'local-test' || !view.status?.modelConfigured || !localText.trim())),
              work ? section('最终作品审核', h('p', null, `${work.id} · ${work.action} · ${work.stage} · v${work.version}`),
                h('pre', null, pretty(work.final?.manifest ?? { intention: work.intention, brief: work.brief, script: work.script })),
                h('pre', null, pretty({ sources: work.sources, finalHash: work.final?.manifestHash, approval: work.approval, review: work.review, submission: work.submission,
                  workflow: work.workflow, recoveryAudit: view.creation.recoveryAudit })),
                assetPreview(work.final?.manifest?.video), assetPreview(work.final?.manifest?.cover),
                ...(work.final?.manifest?.audio ?? []).map(assetPreview), ...(work.final?.manifest?.subtitles ?? []).map(assetPreview), ...(work.final?.manifest?.attachments ?? []).map(assetPreview),
                h('textarea', { 'aria-label': '审核理由', value: reason, maxLength: 4000, onChange: event => setReason(event.target.value) }),
                canRecover ? h('div', null,
                  h('p', { className: 'muted' }, '恢复须填写理由，并重新执行本地方案和制作；原意愿须仍有效，来源和权限须保持授权。恢复成品须再次人工审核，不会自动发布或自动重试。'),
                  button('人工恢复并重做本地准备', () => { void mutate('creation-recovery', { id: work.id, expectedRevision: view.creation.revision, action: 'recover', reason }); }, !reason.trim()),
                  button('放弃本次创作（不可恢复）', () => { void mutate('creation-recovery', { id: work.id, expectedRevision: view.creation.revision, action: 'abandon', reason }); }, !reason.trim())) : null,
                h('p', { className: 'muted' }, '逐项检查完整作品、来源、账号和目标；全部媒体预览加载后方可批准。脚本不能替代成片审核。'),
                button('批准最终作品（有效30分钟）', () => { void mutate('review', { id: work.id, expectedRevision: view.creation.revision, action: 'approve', expiresAt: Date.now() + 1800000 }); }, work.stage !== 'final-review' || !work.final || !mediaVerified || (work.workflow && work.workflow.phase !== 'ready')),
                button('拒绝', () => { void mutate('review', { id: work.id, expectedRevision: view.creation.revision, action: 'reject', reason }); }, !reason.trim() || work.stage === 'submission'),
                button('要求修改', () => { void mutate('review', { id: work.id, expectedRevision: view.creation.revision, action: 'changes', reason }); }, !reason.trim() || work.stage === 'submission'),
                button('提交已批准作品', () => { void mutate('submit', { id: work.id, expectedRevision: view.creation.revision }); }, work.stage !== 'approved' || !work.approval || work.approval.expiresAt <= Date.now())) : null),
            h('div', null, section('当前会话设置', !view.settings ? empty() : h('div', null,
              h('h4', null, '全局默认 / 局部值 / 最终值'), h('pre', null, pretty(view.settings)),
              h('h4', null, '全局权限（管理者显式设置）'),
              ...['receive', 'save', 'learn', 'reply', 'proactive'].map(permission => h('label', { key: 'global-' + permission },
                h('input', { type: 'checkbox', 'aria-label': '全局权限 ' + permission, checked: view.settings.global?.permissions?.[permission] === true, disabled: busy || view.settings.canManage !== true,
                  onChange: event => { void mutate('settings', { expectedRevision: view.settings.revision, patch: { permissions: { [permission]: event.target.checked } } }); } }),
                ({ receive: '全局接收', save: '全局保存', learn: '全局学习', reply: '全局回复', proactive: '全局主动联系' })[permission])),
              h('h4', null, '当前会话限制（不能突破全局禁用）'),
              h('label', null, '额外语气 Prompt', h('textarea', { value: prompt, onChange: event => setPrompt(event.target.value) })),
              h('p', { className: 'muted' }, '最终生效 Prompt（只读）'), h('pre', null, view.settings.effective?.prompt ?? ''),
              button('保存本会话 Prompt', () => { void mutate('settings', { key: selected, expectedRevision: view.settings.revision, patch: { prompt } }); }),
              ...['receive', 'save', 'learn', 'reply', 'proactive'].map(permission => h('label', { key: permission },
                h('input', { type: 'checkbox', checked: view.settings.effective?.permissions?.[permission] === true, disabled: busy,
                  onChange: event => { void mutate('settings', { key: selected, expectedRevision: view.settings.revision, patch: { permissions: { [permission]: event.target.checked } } }); } }),
                ({ receive: '接收', save: '保存', learn: '学习', reply: '回复', proactive: '主动联系' })[permission])),
              h('label', null, '参与程度（0–1）', h('input', { type: 'number', min: 0, max: 1, step: 0.1,
                value: view.settings.effective?.participation ?? 0, disabled: busy, onChange: event => { void mutate('settings', { key: selected, expectedRevision: view.settings.revision, patch: { participation: Number(event.target.value) } }); } })),
              h('h4',null,'本会话主动联系限制'),h('p',{className:'muted'},'与 Host 及全局限制取交集，不能放宽时段或额度。此表单保存一个时段；结束早于开始表示跨午夜。'),
              field('主动时段开始',contactDraft.start,value=>setContactDraft({...contactDraft,start:value}),'time'),field('主动时段结束',contactDraft.end,value=>setContactDraft({...contactDraft,end:value}),'time'),
              ...[['timeZoneOffsetMinutes','时区偏移（分钟）'],['cooldownMinutes','主动冷却（分钟）'],['dailyLimit','每日主动额度'],['unansweredLimit','未回应上限']].map(([key,title])=>field(title,contactDraft[key],value=>setContactDraft({...contactDraft,[key]:Number(value)}),'number')),
              button('保存本会话主动限制',()=>{const minute=value=>Number(value.slice(0,2))*60+Number(value.slice(3));void mutate('settings',{key:selected,expectedRevision:view.settings.revision,patch:{contactPolicy:{timeZoneOffsetMinutes:contactDraft.timeZoneOffsetMinutes,windows:[{startMinute:minute(contactDraft.start),endMinute:minute(contactDraft.end)===0?1440:minute(contactDraft.end)}],cooldownMs:Math.round(contactDraft.cooldownMinutes*60000),dailyLimit:contactDraft.dailyLimit,unansweredLimit:contactDraft.unansweredLimit}}});},!/^\d\d:\d\d$/.test(contactDraft.start)||!/^\d\d:\d\d$/.test(contactDraft.end)||contactDraft.start===contactDraft.end||!Number.isSafeInteger(contactDraft.timeZoneOffsetMinutes)||Math.abs(contactDraft.timeZoneOffsetMinutes)>840||contactDraft.cooldownMinutes<0||contactDraft.cooldownMinutes>1440||!Number.isSafeInteger(contactDraft.dailyLimit)||contactDraft.dailyLimit<0||!Number.isSafeInteger(contactDraft.unansweredLimit)||contactDraft.unansweredLimit<0),
              button('重置本会话主动限制',()=>{void mutate('settings',{key:selected,expectedRevision:view.settings.revision,patch:{contactPolicy:null}});}),
              h('label', null, h('input', { type: 'checkbox', checked: view.settings.effective?.typing?.enabled === true, disabled: busy,
                onChange: event => { void mutate('settings', { key: selected, expectedRevision: view.settings.revision, patch: { typing: { enabled: event.target.checked } } }); } }), '拟人打字等待'),
              h('label', null, '打字速度（字素/秒）', h('input', { type: 'number', min: 0.1, max: 1000, step: 1,
                value: view.settings.effective?.typing?.charsPerSecond ?? 12, disabled: busy, onChange: event => { void mutate('settings', { key: selected, expectedRevision: view.settings.revision, patch: { typing: { charsPerSecond: Number(event.target.value) } } }); } })),
              expressionControls(),
              button('本会话进一步隔离', () => { void mutate('settings', { key: selected, expectedRevision: view.settings.revision, patch: { memoryMode: 'isolated' } }); }),
              button('本会话继承全局记忆规则', () => { void mutate('settings', { key: selected, expectedRevision: view.settings.revision, patch: { memoryMode: 'inherit' } }); }),
              h('p', null, '隔离模式'), button('全局隔离', () => { void mutate('settings', { expectedRevision: view.settings.revision, patch: { mode: 'isolated' } }); }),
              button('受来源授权的共享', () => { void mutate('settings', { expectedRevision: view.settings.revision, patch: { mode: 'shared' } }); })))),
              section('当前会话自我状态', view.self ? h('pre', null, pretty(view.self.value)) : empty(),creationControls()),
              section('B站授权材料',h('p',{className:'muted'},'读取只查看本地有界快照。捕获按钮才请求已授权 Host 读取材料；未配置或未授权时拒绝，不会自动访问外网。'),
                field('B站材料编号',biliDraft.id,value=>{activeBili.current=value;setBiliDraft({...biliDraft,id:value,itemId:''});setView(previous=>({...previous,biliSource:null}));}),
                field('B站账号规范键',biliDraft.accountCanonical,value=>setBiliDraft({...biliDraft,accountCanonical:value})),field('B站BV号',biliDraft.bvid,value=>setBiliDraft({...biliDraft,bvid:value})),
                button('读取本地材料快照',()=>{void biliRead(biliDraft.id);},!biliDraft.id.trim()),
                h('p',{className:'muted'},'新编号从版本0开始；更新已有编号前先读取当前快照，冲突将拒绝。捕获不授予学习或发布权。'),
                button('明确捕获授权B站材料',()=>{void biliWrite({action:'capture',id:biliDraft.id,expectedRevision:view.biliSource?.source?.revision??0,request:{account:biliDraft.accountCanonical,bvid:biliDraft.bvid}});},!biliDraft.id.trim()||!biliDraft.accountCanonical.trim()||!biliDraft.bvid.trim()||view.biliSource?.status==='revoked'),
                view.biliSource?h('div',null,h('p',null,`${view.biliSource.source?.id??biliDraft.id} · v${view.biliSource.source?.revision??view.biliSource.revision} · ${view.biliSource.status}`),
                  h('p',null,`内容哈希：${view.biliSource.snapshot?.contentHash??'未知'}；标题：${view.biliSource.snapshot?.content?.title??''}；覆盖：${view.biliSource.snapshot?.content?.coverage??''}`),
                  h('label',null,'选择材料条目',h('select',{'aria-label':'选择材料条目',value:biliDraft.itemId,onChange:event=>setBiliDraft({...biliDraft,itemId:event.target.value})},h('option',{value:''},'选择条目'),
                    ...(view.biliSource.snapshot?.items??[]).slice(0,64).map(item=>h('option',{key:item.id,value:item.id},item.id)))),
                  h('pre',null,(view.biliSource.snapshot?.items??[]).find(item=>item.id===biliDraft.itemId)?.text??''),
                  field('材料学习候选编号',biliDraft.proposalId,value=>setBiliDraft({...biliDraft,proposalId:value})),
                  button('提出材料学习候选',()=>{void biliWrite({action:'learning',key:selected,id:biliDraft.id,revision:view.biliSource.revision,itemId:biliDraft.itemId,proposalId:biliDraft.proposalId});},selected===null||!biliDraft.itemId||!biliDraft.proposalId.trim()||view.biliSource.status!=='active'),
                  button('撤销当前B站材料',()=>{void biliWrite({action:'revoke',id:biliDraft.id,expectedRevision:view.biliSource.source.revision});},view.biliSource.status!=='active'),
                  h('p',{className:'muted'},'学习候选仍需人工接受；原材料撤销后其派生状态和候选不再可用。')):null),
              section('学习候选', ...(!items(view.learning).length ? [empty()] : items(view.learning).map(item => h('article', { key: item.id },
                h('pre', null, pretty(item)), button('接受学习候选 ' + item.id, () => { void mutate('learning', { id: item.id, accepted: true }); }, item.status !== 'pending'),
                button('拒绝学习候选 ' + item.id, () => { void mutate('learning', { id: item.id, accepted: false }); }, item.status !== 'pending'))))),
              section('成长版本',growthControls()),
              section('Code 状态', view.code ? h('div', null, h('p', null, view.code.enabled ? '允许新任务' : '新任务关闭；已有任务及结果保留'),
                button(view.code.enabled ? '关闭新 Code 任务' : '开启新 Code 任务', () => { void mutate('code', { enabled: !view.code.enabled }); }), h('pre', null, pretty(view.code.tasks ?? []))) : empty()),
              section('出站日志', h('p', { className: 'muted' }, '结果不明时仅核对可信平台证据；此操作不会重发或更换账号。'),
                ...(items(view.outbox).length ? items(view.outbox).map(item => h('article', { key: item.id }, h('pre', null, pretty(item)),
                  item.status === 'unknown' ? button('核对发送结果', () => { void mutate('reconcile', { id: item.id, expectedRevision: view.outbox.revision }); }, !Number.isSafeInteger(view.outbox.revision)) : null)) : [empty()])))));
      }
      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL, locale: NS }, AgentPage));
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL, order: 40, label: () => label('nav') }, PanelIcon));
    } };
  }
});
