// The only page the user sees outside Claude, served by the local engine on 127.0.0.1.
// mode=login: sign in with the master wallet (their account on PaperQuants).
// mode=wallet: connect an external wallet (e.g. a MetaMask account) as ONE agent's wallet: link it to the master
// account and authorize a trade-only Papertrade key for it.
export const connectPage = (token: string, mode: 'login' | 'wallet', label: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PaperQuants</title>
<style>
:root{--bg:#f6f5f1;--ink:#141414;--mu:#6b6b6b;--card:#fff;--line:#e3e1da;--solid:#141414;--solid-fg:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#121212;--ink:#f1f1f1;--mu:#9a9a9a;--card:#1b1b1b;--line:#2c2c2c;--solid:#f1f1f1;--solid-fg:#121212}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif}
main{max-width:560px;margin:0 auto;padding:40px 16px 80px;display:flex;flex-direction:column;gap:16px}
h1{font-size:28px;letter-spacing:-.8px;margin:0}.mu{color:var(--mu)}.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px;display:flex;flex-direction:column;gap:10px}
.label{font:600 11px ui-monospace,monospace;letter-spacing:.08em;color:var(--mu)}button{font:inherit;border:0;border-radius:10px;padding:12px 16px;background:var(--solid);color:var(--solid-fg);cursor:pointer}
button[disabled]{opacity:.4;cursor:default}.mono{font-family:ui-monospace,monospace;font-size:13px;word-break:break-all}.ok{font-weight:600}.err{color:#b3261e}
</style></head><body><main>
<span class="label">PAPERQUANTS</span>
${mode === 'login' ? `
<h1>Sign in with your wallet</h1>
<p class="mu">This wallet is your PaperQuants account. Your agents' wallets are linked to it and shown on your account page. Free, no transaction.</p>
<div class="card"><button id="b1">Connect wallet and sign in</button><span id="s1" class="mono"></span></div>
` : `
<h1>Connect a wallet for ${label ? label.replace(/[<>&"]/g, '') : 'an agent'}</h1>
<p class="mu">Pick the account in your wallet that this agent will trade (one agent per wallet). Two signatures: link it to your PaperQuants account, and authorize a trade-only Papertrade key that <b>cannot withdraw</b>, expires in 30 days and stays on this computer. Papertrade needs a deposit on this wallet first.</p>
<div class="card"><button id="b2">Connect wallet</button><span id="s2" class="mono"></span></div>
`}
<p class="mu">Done? Go back to Claude. You can close this tab.</p>
<script>
const T=${JSON.stringify(token)}, LABEL=${JSON.stringify(label)};
const call=(p,b)=>fetch(p,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+T},body:JSON.stringify(b||{})}).then(async r=>{const j=await r.json();if(!r.ok)throw Object.assign(new Error(j.error||r.status),j);return j});
const say=(id,t,c)=>{const e=document.getElementById(id);e.textContent=t;e.className='mono '+(c||'')};
const need=()=>{if(!window.ethereum)throw new Error('No wallet found in this browser. Open this page in a browser with your wallet extension.')};
const b1=document.getElementById('b1');if(b1)b1.onclick=async()=>{try{need();
 const [W]=await ethereum.request({method:'eth_requestAccounts'});const ts=Date.now();
 const sig=await ethereum.request({method:'personal_sign',params:['PaperQuants\\nAction: login\\nWallet:'+W.toLowerCase()+'\\nTimestamp:'+ts,W]});
 const r=await call('/connect/login',{wallet:W,ts,sig});say('s1','Signed in as '+W+'. Your account: '+r.accountPage,'ok');
}catch(e){say('s1',e.message,'err')}};
const b2=document.getElementById('b2');if(b2)b2.onclick=async()=>{try{need();
 const [W]=await ethereum.request({method:'eth_requestAccounts'});
 const lm=await call('/connect/link-message',{wallet:W});
 const lsig=await ethereum.request({method:'personal_sign',params:[lm.message,W]});
 const {typedData}=await call('/connect/wallet/start',{wallet:W,ts:lm.ts,sig:lsig,label:LABEL});
 const sig=await ethereum.request({method:'eth_signTypedData_v4',params:[W,JSON.stringify(typedData)]});
 say('s2','Registering with Papertrade…');await call('/connect/wallet/confirm',{wallet:W,sig});say('s2','Connected '+W+'. Tell Claude it is done.','ok');
}catch(e){say('s2',e.message+(e.depositAddress?' Papertrade deposit address for this wallet: '+e.depositAddress:''),'err')}};
</script></main></body></html>`;
