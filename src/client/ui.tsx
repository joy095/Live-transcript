import {useEffect,useRef,useState} from 'react';
import {Mic,Square,Play,Pause,Trash2,LogOut,Github,AudioLines,Clock3,FileText,CloudUpload,Radio,Headphones,Plus,LoaderCircle} from 'lucide-react';
import {authClient} from './auth-client';
type Recording={id:string;title:string;duration_ms:number;transcript:string;created_at:string};
type MeResponse={user:any|null};
type RecordingsResponse={recordings:Recording[]};
type ApiErrorResponse={error?:string};
const api=(path:string,init?:RequestInit)=>fetch(path,{...init,credentials:'include'});
const fmt=(ms:number)=>`${Math.floor(ms/60000)}:${String(Math.floor(ms/1000)%60).padStart(2,'0')}`;
const pickMime=()=>['audio/webm;codecs=opus','audio/webm','audio/mp4'].find(t=>MediaRecorder.isTypeSupported(t))||'';
export default function App(){
 const [user,setUser]=useState<any>(null),[items,setItems]=useState<Recording[]>([]),[active,setActive]=useState<Recording|null>(null),[recording,setRecording]=useState(false),[busy,setBusy]=useState(false),[elapsed,setElapsed]=useState(0),[transcript,setTranscript]=useState(''),[title,setTitle]=useState('Meeting notes'),[playing,setPlaying]=useState(false),[error,setError]=useState('');
 const recorder=useRef<MediaRecorder|null>(null), stream=useRef<MediaStream|null>(null), audioChunks=useRef<Blob[]>([]), started=useRef(0), transcriptRef=useRef(''), idRef=useRef(''), socket=useRef<WebSocket|null>(null), audioRef=useRef<HTMLAudioElement|null>(null), timer=useRef<number|undefined>(undefined), finishTimer=useRef<number|undefined>(undefined), pendingBlob=useRef<Blob|null>(null), queuedChunks=useRef<Blob[]>([]), finalized=useRef(false), stopping=useRef(false);
 const refresh=async()=>{const r=await api('/api/recordings');if(r.ok){const d=await r.json() as RecordingsResponse;setItems(d.recordings||[]);}};
 useEffect(()=>{api('/api/me').then(r=>r.json() as Promise<MeResponse>).then(d=>{setUser(d.user);if(d.user)refresh()}).catch(()=>{});return()=>{if(timer.current)clearInterval(timer.current);if(finishTimer.current)clearTimeout(finishTimer.current);stream.current?.getTracks().forEach(t=>t.stop())}},[]);
 // Play whichever recording became active (fixes audioRef being null right after setActive).
 useEffect(()=>{const a=audioRef.current;if(active&&a){a.src=`/api/recordings/${active.id}/audio`;a.load();a.play().then(()=>setPlaying(true)).catch(()=>setPlaying(false))}else setPlaying(false)},[active]);
 const loginGithub=async()=>{await authClient.signIn.social({provider:'github',callbackURL:location.origin});};
 const guest=async()=>{
  setError('');
  try{
   // Reuse this browser's existing Better Auth session before creating a guest.
   const existing=await authClient.getSession();
   if(existing.data?.user){
    setUser(existing.data.user);
    await refresh();
    return;
   }
   const res=await authClient.signIn.anonymous();
   if(res.error)throw new Error(res.error.message||'Guest sign-in failed');
   const me=await api('/api/me').then(r=>r.json() as Promise<MeResponse>);
   setUser(me.user);
   await refresh();
  }catch(err:any){setError(err.message||'Guest sign-in failed. Check that the Worker is running.')}
 };
 const logout=async()=>{
  // Keep anonymous sessions on this browser so the same guest account and its
  // recordings can be resumed. A GitHub account is fully signed out.
  if(!user?.isAnonymous)await authClient.signOut();
  setUser(null);setItems([]);setActive(null);
 };
 // Exactly-once upload of the final blob to the cloud (R2 via /finalize).
 const finalizeRecording=async()=>{if(finalized.current)return;finalized.current=true;const blob=pendingBlob.current;pendingBlob.current=null;if(!blob)return;setBusy(true);try{const fd=new FormData();fd.append('audio',blob,'recording.'+(blob.type.includes('mp4')?'m4a':'webm'));fd.append('title',title);fd.append('durationMs',String(Date.now()-started.current));const response=await api(`/api/recordings/${idRef.current}/finalize`,{method:'POST',body:fd});if(!response.ok){const d=await response.json().catch(()=>({})) as ApiErrorResponse;throw new Error(d.error||'Save failed')}await refresh();}catch(err:any){finalized.current=false;pendingBlob.current=blob;setError(err.message||'Could not save recording')}finally{setBusy(false);if(finishTimer.current)clearTimeout(finishTimer.current);finishTimer.current=undefined;try{socket.current?.close()}catch{}socket.current=null;}};
 const sendChunk=(ws:WebSocket,b:Blob)=>{if(ws.readyState===WebSocket.OPEN)ws.send(b);else queuedChunks.current.push(b)};
 // Ask the same endpoint over HTTP to surface the real reason (401/404/426/unreachable).
 const diagnoseLive=async(_id:string)=>{try{const r=await api('/api/health');if(r.status===401){setError('Session expired — sign out and sign in again');return}if(!r.ok){setError(`Worker health check failed (${r.status}). Check that Wrangler is running on port 8787 and Vite proxies /api to it.`);return}setError('The Worker is reachable, but the WebSocket handshake failed. Restart both dev servers, open the app through http://localhost:5173 (not the Worker port), and verify the browser Network → WS request to /api/live/<id> returns 101 Switching Protocols. If deployed, confirm run_worker_first includes /api/* and deploy the latest Worker.')}catch{setError('Worker is unreachable. Start it with: npx wrangler dev --port 8787, then restart Vite.')}};
 const start=async()=>{if(recording||busy)return;setError('');try{
 const s=await navigator.mediaDevices.getUserMedia({audio:true});stream.current=s;
 audioChunks.current=[];queuedChunks.current=[];transcriptRef.current='';setTranscript('');
 idRef.current=crypto.randomUUID();finalized.current=false;stopping.current=false;started.current=Date.now();
 const mime=pickMime();
 const create=await api('/api/recordings/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:idRef.current,title,mimeType:mime||'audio/webm'})});if(!create.ok)throw new Error('Could not create recording session');
 const wsProtocol=location.protocol==='https:'?'wss:':'ws:';
 const wsUrl=`${wsProtocol}//${location.host}/api/live/${idRef.current}`;
 const ws=new WebSocket(wsUrl);socket.current=ws;ws.binaryType='arraybuffer';
 // Recorder starts immediately; chunks are queued until the socket opens.
 const mr=mime?new MediaRecorder(s,{mimeType:mime}):new MediaRecorder(s);recorder.current=mr;
 ws.onmessage=event=>{try{const message=JSON.parse(event.data);if(message.type==='transcript'){const next=String(message.transcript||'').trim();if(next){transcriptRef.current=next;setTranscript(next)}}else if(message.type==='error'){setError(message.error||'Transcription failed')}else if(message.type==='finished'){if(finishTimer.current)clearTimeout(finishTimer.current);finishTimer.current=undefined;const finalText=String(message.transcript||'').trim();if(finalText){transcriptRef.current=finalText;setTranscript(finalText)}void finalizeRecording()}}catch{}};
 ws.onopen=()=>{for(const b of queuedChunks.current.splice(0))ws.send(b)};
 ws.onerror=()=>{void diagnoseLive(idRef.current)};
 ws.addEventListener('close',()=>{if(!stopping.current&&recorder.current?.state==='recording')setError('Live transcription lost — recording continues, but no live transcript. Audio will still upload when you stop.')});
 ws.onclose=()=>{ // Fallback: if the server never confirmed, still push the final audio to the cloud.
  if(stopping.current&&!finalized.current&&pendingBlob.current)void finalizeRecording()};
 mr.ondataavailable=e=>{if(!e.data||!e.data.size)return;audioChunks.current.push(e.data);sendChunk(ws,e.data)};
 mr.onstop=()=>{s.getTracks().forEach(t=>t.stop());stream.current=null;pendingBlob.current=new Blob(audioChunks.current,{type:mr.mimeType||mime||'audio/webm'});stopping.current=true;if(ws.readyState===WebSocket.OPEN){ws.send(JSON.stringify({type:'finish',durationMs:Date.now()-started.current}));if(finishTimer.current)clearTimeout(finishTimer.current);finishTimer.current=window.setTimeout(()=>{if(!finalized.current&&pendingBlob.current){setError('Live transcription took too long to finish. Saving the audio and the latest transcript…');void finalizeRecording()}},12000)}else void finalizeRecording()};
 mr.start(3000);setRecording(true);setElapsed(0);timer.current=window.setInterval(()=>setElapsed(Date.now()-started.current),250);
 }catch(e:any){stream.current?.getTracks().forEach(t=>t.stop());stream.current=null;setError(e.message||'Microphone permission is required')}};
 const stop=()=>{if(!recording||stopping.current)return;stopping.current=true;if(timer.current)clearInterval(timer.current);setRecording(false);setBusy(true);try{recorder.current?.stop()}catch{setBusy(false);setError('Could not stop the microphone recorder. Please try again.')}};
 const play=(item:Recording)=>setActive(item);
 const remove=async(item:Recording)=>{if(!confirm('Delete this recording and its files?'))return;await api(`/api/recordings/${item.id}`,{method:'DELETE'});if(active?.id===item.id)setActive(null);refresh()};
 return <div className="app"><aside className="sidebar"><div className="brand"><div className="brand-icon"><AudioLines/></div><span>voicetrail</span></div><div className="side-label">WORKSPACE</div><button className="nav active"><Radio size={17}/> Studio</button><button className="nav" onClick={()=>document.getElementById('library')?.scrollIntoView({behavior:'smooth'})}><FileText size={17}/> Recordings <span className="count">{items.length}</span></button><div className="side-bottom"><div className="cloud"><CloudUpload size={18}/><div><b>Cloud storage</b><small>Private to your account</small></div></div>{user&&<button className="nav" onClick={logout}><LogOut size={17}/> {user.isAnonymous?'Exit guest':'Sign out'}</button>}</div></aside>
 <main className="main"><header><div><div className="eyebrow">VOICE WORKSPACE / STUDIO</div><h1>Voice, captured.</h1><p className="sub">Record naturally. Watch your words become text.</p></div><div className="profile">{user?<><span className="avatar">{(user.name||'G').slice(0,1).toUpperCase()}</span><div><b>{user.name||'Guest'}</b><small>{user.isAnonymous?'Guest account':'Signed in'}</small></div></>:<span className="status">Not signed in</span>}</div></header>
 {!user?<section className="auth-card"><div className="auth-icon"><Headphones size={28}/></div><h2>Your voice deserves a home.</h2><p>Sign in with GitHub or continue as a guest to start recording. Guest recordings are private to that temporary account.</p><button className="primary wide" onClick={loginGithub}><Github size={18}/> Continue with GitHub</button><button className="secondary wide" onClick={guest}>Continue as guest</button><small className="muted">Your browser will ask for microphone permission when you record.</small></section>:<>
 <div className="workspace"><section className="recorder-card"><div className="card-head"><div><span className="pill"><span className="dot"/> LIVE STUDIO</span><h2>New recording</h2><p>Speak naturally. Audio streams to the Worker and transcript segments arrive live.</p></div><div className="wave-icon"><AudioLines size={25}/></div></div><label className="field-label">RECORDING TITLE</label><input className="title-input" value={title} onChange={e=>setTitle(e.target.value)} placeholder="e.g. Product strategy meeting" disabled={recording}/><div className="record-center"><div className={`mic-orbit ${recording?'is-recording':''}`}><div className="mic-core"><Mic size={29}/></div></div><div className="clock">{fmt(elapsed)}</div><div className="record-hint">{recording?'Listening to your microphone':busy?'Saving recording…':'Ready when you are'}</div>{!recording?<button className="record-btn" disabled={busy} onClick={start}>{busy?<LoaderCircle className="spin"/>:<Mic size={18}/>} {busy?'Saving…':'Start recording'}</button>:<button className="stop-btn" onClick={stop}><Square size={16} fill="currentColor"/> Stop recording</button>}</div><div className="record-foot"><span><span className="green-dot"/> Microphone {recording?'active':'standby'}</span><span>3-second live audio stream</span></div></section>
 <section className="transcript-card"><div className="transcript-top"><div><span className="eyebrow">LIVE OUTPUT</span><h2>Transcript</h2></div><span className={`live-tag ${recording?'on':''}`}><i/> {recording?'LIVE':busy?'SAVING':'READY'}</span></div><div className="transcript-body">{transcript?<p>{transcript}{recording&&<span className="cursor"/>}</p>:<div className="empty-transcript"><FileText size={28}/><b>{recording?'Listening for your first words…':'Your transcript will appear here'}</b><span>{recording?'Speak naturally. Recognized words will appear here as the audio is processed.':'Start recording and speak. Your transcript will appear here while you talk.'}</span></div>}</div><div className="transcript-bottom"><span>{transcript.trim()?transcript.trim().split(/\s+/).length:0} words</span><button className="text-btn" onClick={()=>{navigator.clipboard.writeText(transcript)}} disabled={!transcript}>Copy text</button></div></section></div>
 {error&&<div className="error">{error}<button onClick={()=>setError('')}>Dismiss</button></div>}
 <section className="library" id="library"><div className="section-head"><div><span className="eyebrow">YOUR LIBRARY</span><h2>Recent recordings</h2></div><span className="total">{items.length} recordings</span></div>{items.length===0?<div className="empty-library"><div className="empty-icon"><Plus/></div><b>No recordings yet</b><span>Your saved audio and transcripts will show up here.</span></div>:<div className="record-list">{items.map(item=><div className={`record-row ${active?.id===item.id?'selected':''}`} key={item.id}><button className="play-small" onClick={()=>play(item)}><Play size={15} fill="currentColor"/></button><div className="row-info"><b>{item.title}</b><span>{new Date(item.created_at+'Z').toLocaleString()} · {fmt(item.duration_ms)}</span></div><span className="transcript-preview">{item.transcript||'No transcript'}</span><button className="icon-btn" title="Delete" onClick={()=>remove(item)}><Trash2 size={16}/></button></div>)}</div>}</section>
 {active&&<section className="player"><div className="player-info"><div className="player-cover"><Headphones/></div><div><b>{active.title}</b><small>Saved recording · {fmt(active.duration_ms)}</small></div></div><audio ref={audioRef} controls onPlay={()=>setPlaying(true)} onPause={()=>setPlaying(false)} onEnded={()=>setPlaying(false)}/><button className="close-player" onClick={()=>{audioRef.current?.pause();setActive(null)}}>Close</button></section>}
 </>}
 <footer>Built on Cloudflare Workers AI <span>·</span> Audio & transcripts stored privately in R2</footer></main></div>
}
