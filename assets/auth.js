(function(global){
  'use strict';

  const KEY = 'omni_v2_customer_session';
  const LEGACY_KEY = 'omni_v2_session';
  const ALLOWED_ROLES = new Set(['customer','guest']);

  function savedSession(){
    const saved = global.OmniUtils.parseJson(localStorage.getItem(KEY) || 'null', null);
    if(saved && ALLOWED_ROLES.has(saved.role)) return saved;
    const legacy = global.OmniUtils.parseJson(localStorage.getItem(LEGACY_KEY) || 'null', null);
    if(!legacy || !ALLOWED_ROLES.has(legacy.role)) return null;
    localStorage.setItem(KEY, JSON.stringify(legacy));
    return legacy;
  }

  function saveSession(user){
    localStorage.setItem(KEY, JSON.stringify({userId:user.id, id:user.id, username:user.username, displayName:user.displayName || user.username, role:user.role, vendorId:user.vendorId || '', customerId:user.customerId || '', guest:user.role === 'guest', at:Date.now()}));
  }

  function clearSession(){
    localStorage.removeItem(KEY);
    const legacy = global.OmniUtils.parseJson(localStorage.getItem(LEGACY_KEY) || 'null', null);
    if(legacy && ALLOWED_ROLES.has(legacy.role)) localStorage.removeItem(LEGACY_KEY);
  }

  function userIdFor(username){
    return `user_${String(username || '').toLowerCase().replace(/[^a-z0-9]+/g,'_')}`;
  }

  async function hashPassword(password){
    const text = `omni-v2:${password || ''}`;
    if(global.crypto?.subtle) {
      const data = new TextEncoder().encode(text);
      const buf = await crypto.subtle.digest('SHA-256', data);
      return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2,'0')).join('');
    }
    let hash = 0;
    for(let i=0;i<text.length;i++) hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
    return `legacy_${Math.abs(hash)}`;
  }

  async function signIn(username, role='customer', vendorId='', extra={}){
    const cleanName = String(username || '').trim().toLowerCase();
    const id = cleanName ? userIdFor(cleanName) : global.OmniUtils.uid('user');
    const user = {id, username:cleanName || id, displayName:extra.displayName || username || 'Guest', role, vendorId, customerId:extra.customerId || '', phone:extra.phone || '', active:true, deleted:false, lastLoginAt:Date.now()};
    await global.OmniDB.put('users', id, user, {userId:id, vendorId});
    saveSession(user);
    await global.OmniDB.event('user_signed_in', 'user', id, {summary:`${user.username} signed in`, vendorId, role}, {userId:id, vendorId});
    return user;
  }

  async function signUpCustomer({name, phone, username, password, customerId}){
    const cleanName = String(username || phone || '').trim().toLowerCase();
    if(!cleanName || !password) throw new Error('Username and password are required.');
    const id = userIdFor(cleanName);
    const existing = await new Promise(resolve => global.OmniDB.node('users', id).once(data => resolve(data ? global.OmniUtils.cleanGun(data) : null)));
    if(existing && existing.deleted !== true) throw new Error('This username already exists.');
    const user = {id, username:cleanName, displayName:name || cleanName, phone:phone || '', role:'customer', customerId, passwordHash:await hashPassword(password), active:true, deleted:false, createdAt:Date.now(), lastLoginAt:Date.now()};
    await global.OmniDB.put('users', id, user, {userId:id});
    saveSession(user);
    await global.OmniDB.event('customer_signed_up', 'user', id, {summary:`${cleanName} signed up`, role:'customer'}, {userId:id});
    return user;
  }

  async function login(username, password){
    const cleanName = String(username || '').trim().toLowerCase();
    const id = userIdFor(cleanName);
    const user = await new Promise(resolve => global.OmniDB.node('users', id).once(data => resolve(data ? {...global.OmniUtils.cleanGun(data), id:data.id || id} : null)));
    if(!user || user.deleted === true || user.active === false) throw new Error('Account was not found.');
    if(!user.passwordHash || user.passwordHash !== await hashPassword(password)) throw new Error('Password is incorrect.');
    const next = {...user, lastLoginAt:Date.now()};
    await global.OmniDB.patch('users', id, {lastLoginAt:next.lastLoginAt}, {userId:id, vendorId:user.vendorId || ''});
    saveSession(next);
    await global.OmniDB.event('user_logged_in', 'user', id, {summary:`${cleanName} logged in`, role:user.role || 'customer'}, {userId:id, vendorId:user.vendorId || ''});
    return next;
  }

  async function continueAsGuest(customerId){
    const id = localStorage.getItem('omni_v2_guest_user_id') || global.OmniUtils.uid('guest');
    localStorage.setItem('omni_v2_guest_user_id', id);
    const user = {id, username:id, displayName:'Guest', role:'guest', customerId, active:true, deleted:false, lastSeenAt:Date.now()};
    await global.OmniDB.put('users', id, user, {userId:id});
    saveSession(user);
    await global.OmniDB.event('guest_continued', 'user', id, {summary:'Guest continued to marketplace', role:'guest'}, {userId:id});
    return user;
  }

  global.OmniAuth = { savedSession, saveSession, clearSession, signIn, signUpCustomer, login, continueAsGuest };
})(window);
