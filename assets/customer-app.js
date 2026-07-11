(function(global){
  'use strict';
  const U = global.OmniUtils;
  const DB = global.OmniDB;
  const UI = global.CustomerUI;
  const Cart = global.CustomerCart;
  const state = DB.state.cache;
  let location = null;
  let placingOrder = false;

  function customerId(){
    let id = localStorage.getItem('omni_v2_customer_id');
    if(!id){ id = U.uid('customer'); localStorage.setItem('omni_v2_customer_id', id); }
    return id;
  }

  function customerProfile(){
    return U.parseJson(localStorage.getItem('omni_v2_customer_profile') || '{}', {});
  }

  async function saveCustomerProfile(profile){
    const row = {...profile, id:customerId(), active:true};
    localStorage.setItem('omni_v2_customer_profile', JSON.stringify(row));
    await DB.put('customers', row.id, row, {userId:row.userId || row.id});
    return row;
  }

  function rows(name){ return (state[name] || []).filter(row => row.deleted !== true); }
  function visibleVendors(){ return rows('vendors').filter(v => v.public === true && v.status === 'approved' && v.active !== false); }
  function vendorProducts(vendorId){ return rows('products').filter(p => p.vendorId === vendorId && p.active !== false); }
  function updateBadge(){ const el=document.getElementById('cartBadge'); if(el) el.textContent = Cart.lines.reduce((s,l)=>s+l.qty,0); }

  function renderMarket(){
    const q = (document.getElementById('search')?.value || '').toLowerCase();
    const vendors = visibleVendors().filter(v => {
      const ps = vendorProducts(v.id);
      return !q || `${v.crName} ${v.businessType}`.toLowerCase().includes(q) || ps.some(p => `${p.name} ${p.category}`.toLowerCase().includes(q));
    });
    document.getElementById('market').innerHTML = `
      <div class="grid cols-3">${vendors.map(v => `<article class="card product"><div class="body"><h3>${U.esc(v.crName || 'Vendor')}</h3><p class="muted">${U.esc(v.businessType || 'Vendor')} ${location && v.lat ? ' · '+U.distanceKm(location,{lat:+v.lat,lng:+v.lng}).toFixed(1)+' km' : ' · Latest'}</p><span class="pill ok">Approved</span><button class="btn primary" data-open-vendor="${v.id}">View menu</button></div></article>`).join('') || '<div class="card empty">No approved vendors found yet.</div>'}</div>
      <div id="vendorMenu"></div>`;
    document.querySelectorAll('[data-open-vendor]').forEach(btn => btn.onclick = () => renderVendorMenu(btn.dataset.openVendor));
  }

  function renderVendorMenu(vendorId){
    const vendor = rows('vendors').find(v=>v.id===vendorId);
    const products = vendorProducts(vendorId);
    document.getElementById('vendorMenu').innerHTML = `<div class="card pad" style="margin-top:18px"><div class="head"><h2>${U.esc(vendor?.crName || 'Menu')}</h2><span class="pill">${products.length} items</span></div><div class="product-grid">${products.map(p=>`<article class="card product"><div class="body"><h3>${U.esc(p.name)}</h3><p class="muted">${U.esc(p.category||'Product')}</p><b>${U.money(p.price)}</b><button class="btn primary" data-add="${p.id}">Add to cart</button></div></article>`).join('') || '<div class="empty">No products yet.</div>'}</div></div>`;
    document.querySelectorAll('[data-add]').forEach(btn => btn.onclick = () => {
      const product = products.find(p=>p.id===btn.dataset.add);
      if(Cart.add(product, vendor)) { UI.toast('Added to cart','ok'); updateBadge(); }
    });
  }

  function renderCart(){
    document.getElementById('cart').innerHTML = `<div class="grid split"><div class="card pad"><div class="head"><h2>Your Cart</h2></div>${Cart.lines.map(line=>`<div class="cart-line"><span>${U.esc(line.name)} x ${line.qty}</span><button class="btn small danger" data-remove="${line.productId}">−</button><b>${U.money(line.price*line.qty)}</b></div>`).join('') || '<div class="empty">Cart is empty</div>'}<div class="total"><span>Total</span><span>${U.money(Cart.total())}</span></div></div><div class="card pad"><h2>Checkout</h2><div class="form"><div class="field"><label>Name</label><input id="coName" value="${U.esc(customerProfile().name||'')}"></div><div class="field"><label>Phone</label><input id="coPhone" value="${U.esc(customerProfile().phone||'')}"></div><div class="field"><label>Address</label><textarea id="coAddress">${U.esc(customerProfile().defaultAddress||'')}</textarea></div><select id="coPayment" class="input"><option value="cash">Cash</option><option value="benefit">Benefit</option><option value="credit">Credit</option></select><button id="placeOrderBtn" class="btn primary">Place order</button></div></div></div>`;
    document.querySelectorAll('[data-remove]').forEach(btn => btn.onclick = () => { Cart.remove(btn.dataset.remove); updateBadge(); renderCart(); });
    document.getElementById('placeOrderBtn').onclick = placeOrder;
  }

  async function placeOrder(){
    if(placingOrder) return;
    if(!Cart.lines.length) return UI.toast('Cart is empty','bad');
    const profile = {id:customerId(), name:document.getElementById('coName').value.trim(), phone:document.getElementById('coPhone').value.trim(), defaultAddress:document.getElementById('coAddress').value.trim()};
    if(!profile.phone) return UI.toast('Phone is required','bad');
    if(!profile.defaultAddress && !location) return UI.toast('Add an address or use GPS for delivery','bad');
    placingOrder = true;
    const submit = document.getElementById('placeOrderBtn');
    if(submit) { submit.disabled = true; submit.textContent = 'Placing order...'; }
    try {
    await saveCustomerProfile(profile);
    const orderId = U.uid('order');
    const vendorId = Cart.lines[0].vendorId;
    const order = {id:orderId, vendorId, customerId:profile.id, customerName:profile.name || 'Guest', customerPhone:profile.phone, customerLocationId:'', status:'pending', paymentMethod:document.getElementById('coPayment').value, total:Cart.total(), source:'customer', createdAt:Date.now()};
    await DB.put('orders', orderId, order, {userId:profile.id, vendorId});
    for(const line of Cart.lines) await DB.put('orderItems', U.uid('item'), {orderId, vendorId, productId:line.productId, nameSnapshot:line.name, priceSnapshot:line.price, qty:line.qty, total:line.price*line.qty}, {userId:profile.id, vendorId});
    if(location) await DB.put('customerLocations', U.uid('location'), {customerId:profile.id, label:'Order location', address:profile.defaultAddress, lat:location.lat, lng:location.lng, source:'gps'}, {userId:profile.id});
    await DB.event('customer_order_created','order',orderId,{vendorId, summary:`Customer order ${U.money(order.total)}`},{userId:profile.id, vendorId});
    const ids = U.parseJson(localStorage.getItem('omni_v2_order_ids') || '[]', []); ids.push(orderId); localStorage.setItem('omni_v2_order_ids', JSON.stringify(ids));
    Cart.clear(); updateBadge(); UI.toast('Order placed','ok'); renderOrders();
    document.querySelector('[data-view="orders"]').click();
    } catch(error) {
      UI.toast(error.message || 'Order could not be saved','bad');
    } finally {
      placingOrder = false;
      if(submit?.isConnected) { submit.disabled = false; submit.textContent = 'Place order'; }
    }
  }

  function renderOrders(){
    const ids = U.parseJson(localStorage.getItem('omni_v2_order_ids') || '[]', []);
    const myOrders = rows('orders').filter(o => ids.includes(o.id) || o.customerId === customerId()).sort((a,b)=>Number(b.createdAt||0)-Number(a.createdAt||0));
    document.getElementById('orders').innerHTML = `<div class="card pad"><div class="head"><h2>My Orders</h2></div>${UI.table(myOrders, [{key:'id',label:'Order'}, {key:'status',label:'Status'}, {key:'paymentMethod',label:'Payment'}, {key:'total',label:'Total',format:r=>U.money(r.total)}, {key:'createdAt',label:'Placed',format:r=>r.createdAt?new Date(Number(r.createdAt)).toLocaleString():'-'}])}</div>`;
  }

  function renderCredit(){
    const profile = customerProfile();
    const accounts = rows('creditAccounts').filter(c => c.customerId === customerId() || (profile.phone && c.phone === profile.phone));
    const vendors = visibleVendors();
    document.getElementById('credit').innerHTML = `<div class="grid split"><div class="card pad"><div class="head"><h2>My Credit</h2></div>${UI.table(accounts, [{key:'vendorId',label:'Vendor'}, {key:'status',label:'Status'}, {key:'creditLimit',label:'Limit',format:r=>U.money(r.creditLimit)}, {key:'balance',label:'Balance',format:r=>U.money(r.balance)}])}</div><div class="card pad"><h2>Request credit</h2><div class="form"><div class="field"><label>Vendor</label><select id="creditVendor">${vendors.map(v=>`<option value="${U.esc(v.id)}">${U.esc(v.crName||v.id)}</option>`).join('')}</select></div><div class="field"><label>Phone</label><input id="creditPhone" value="${U.esc(profile.phone||'')}" inputmode="tel"></div><button id="requestCreditBtn" class="btn primary" ${vendors.length?'':'disabled'}>Send request</button></div><p class="muted">The selected vendor reviews your limit and payment terms.</p></div></div>`;
    document.getElementById('requestCreditBtn').onclick = async () => {
      const vendorId = document.getElementById('creditVendor').value;
      const phone = document.getElementById('creditPhone').value.trim();
      if(!vendorId || !phone) return UI.toast('Choose a vendor and add your phone','bad');
      if(accounts.some(a=>a.vendorId===vendorId && a.status!=='rejected')) return UI.toast('A credit account or request already exists for this vendor','bad');
      try {
        await DB.put('creditAccounts', U.uid('credit'), {vendorId, customerId:customerId(), phone, status:'pending', creditLimit:0, balance:0}, {userId:customerId(), vendorId});
        UI.toast('Credit request sent','ok');
      } catch(error) { UI.toast(error.message || 'Request could not be saved','bad'); }
    };
  }

  function renderProfile(){
    const p = customerProfile();
    document.getElementById('profile').innerHTML = `<div class="card pad"><div class="head"><h2>Profile</h2><span class="pill">Optional account</span></div><div class="form-grid"><div class="field"><label>Name</label><input id="pName" value="${U.esc(p.name||'')}"></div><div class="field"><label>Phone</label><input id="pPhone" value="${U.esc(p.phone||'')}"></div><div class="field full"><label>Address</label><textarea id="pAddress">${U.esc(p.defaultAddress||'')}</textarea></div><button id="saveProfileBtn" class="btn primary full">Save profile</button></div></div>`;
    document.getElementById('saveProfileBtn').onclick = async () => { try { await saveCustomerProfile({name:document.getElementById('pName').value.trim(), phone:document.getElementById('pPhone').value.trim(), defaultAddress:document.getElementById('pAddress').value.trim()}); UI.toast('Profile saved and synced','ok'); } catch(error) { UI.toast(error.message || 'Profile could not be synced','bad'); } };
  }

  function render(){
    updateBadge();
    const view = UI.activeView();
    if(view==='market') renderMarket();
    if(view==='cart') renderCart();
    if(view==='orders') renderOrders();
    if(view==='credit') renderCredit();
    if(view==='profile') renderProfile();
  }

  function locate(){
    if(!navigator.geolocation) return UI.toast('GPS unavailable','bad');
    navigator.geolocation.getCurrentPosition(pos => { location = {lat:pos.coords.latitude, lng:pos.coords.longitude}; UI.toast('Location updated','ok'); render(); }, err => UI.toast(err.message || 'Location denied','bad'), {enableHighAccuracy:true, timeout:12000});
  }

  function boot(){
    UI.shell(); UI.bindNav(render); DB.init(UI.setStatus);
    global.OmniConfig.collections.forEach(name => DB.subscribe(name, render, {includeDeleted:true}));
    document.getElementById('search').oninput = render;
    document.getElementById('locateBtn').onclick = locate;
    render();
  }
  boot();
})(window);
