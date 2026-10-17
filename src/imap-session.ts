interface ImapConnection {
  on(event:'error',listener:(error:Error)=>void):unknown;
  close():void;
}
const guarded=new WeakMap<ImapConnection,{error?:Error}>();

/** Keep the error listener for the object's lifetime: sockets can fail after cleanup. */
export function guardImapClient<T extends ImapConnection>(client:T):T {
  if(guarded.has(client))return client;
  const state:{error?:Error}={};guarded.set(client,state);
  client.on('error',error=>{
    if(state.error)return;
    state.error=error??new Error('IMAP connection failed');
    // Closing rejects pending commands/downloads; never throw from an event listener.
    try{client.close();}catch{}
  });
  return client;
}

export function assertImapHealthy(client:ImapConnection):void {
  if(guarded.get(client)?.error)throw new Error('Почтовое соединение прервано; чтение будет повторено');
}
