(async () => {
 document.querySelector('#clear').click();
 const originalFetch = window.fetch;
 const requests = [];
 let mode = 'length';
 window.fetch = async (url, options) => {
  if (!String(url).includes('/chat/completions')) return originalFetch(url, options);
  requests.push(JSON.parse(options.body));
  if (mode === 'error') return new Response(JSON.stringify({error:{message:'Fixture unavailable'}}), {status:503});
  if (mode === 'pending') return new Promise((resolve,reject) => options.signal.addEventListener('abort', () => reject(new DOMException('Stopped','AbortError'))));
  const chunk = JSON.stringify({choices:[{delta:{content:mode === 'length' ? 'First' : ' second'},finish_reason:mode === 'length' ? 'length' : 'stop'}]});
  const bytes = new TextEncoder().encode(`data: ${chunk}\r\n\r\ndata: [DONE]\r\n\r\n`);
  return new Response(new ReadableStream({start(c){ const split=bytes.indexOf(13)+1; c.enqueue(bytes.slice(0,split)); c.enqueue(bytes.slice(split)); c.close(); }}));
 };
 const wait = () => new Promise(r => setTimeout(r,150));
 const submit = text => {document.querySelector('#prompt').value=text;document.querySelector('#composer').requestSubmit();};
 try {
 submit('Original question'); await wait();
 if (!document.querySelector('.btn-continue')) throw Error('No continuation');
 mode='stop';document.querySelector('.btn-continue').click();await wait();
 if (requests[1].messages.map(m=>m.role).join(',') !== 'user,assistant,user') throw Error('Duplicated user turn');
 if (document.querySelector('.assistant .body').textContent.trim() !== 'First second') throw Error('Continuation not appended');
 document.querySelector('#clear').click();mode='error';submit('Retry me');await wait();
 if(document.querySelector('#prompt').value !== 'Retry me') throw Error('Prompt not restored');
 mode='length';document.querySelector('#composer').requestSubmit();await wait();
 if(requests.at(-1).messages.length!==1) throw Error('Failed turn retained');
 const oldContinue=document.querySelector('.btn-continue');mode='pending';submit('Another question');await wait();
 const count=requests.length;oldContinue.click();await wait();
 if(requests.length!==count) throw Error('Concurrent continuation');
 document.querySelector('#stop').click();await wait();
 if(document.querySelector('#send').hidden || !document.querySelector('#stop').hidden) throw Error('Controls not restored');
 return {passed:['CRLF split across chunks','continuation ordering and append','HTTP error recovery','failed turn removed','concurrent continuation blocked','stop controls restored'],overlay:!!document.querySelector('vite-error-overlay')};
 } finally {window.fetch=originalFetch;document.querySelector('#clear').click();}
})()
