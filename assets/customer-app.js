(function(global){
  'use strict';
  const U = global.OmniUtils;
  const DB = global.OmniDB;
  const UI = global.CustomerUI;
  const Cart = global.CustomerCart;
  const state = DB.state.cache;
  const maps = { market:null };
  let location = U.parseJson(localStorage.getItem('omni_v2_customer_location') || 'null', null);
  let dropMode = false;
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
    if(location) { row.lat = location.lat; row.lng = location.lng; row.locationSource = location.source || 'manual'; }
    localStorage.setItem('omni_v2_customer_profile', JSON.stringify(row));
    await DB.put('customers', row.id, row, {userId:row.userId || row.id});
    return row;
  }

  function rows(name){ return (state[name] || []).filter(row => row.deleted !== true); }

  function parseProducts(vendor){
    const mirrored = U.parseJson(vendor.products || '[]', []);
    if(Array.isArray(mirrored) && mirrored.length) return mirrored.map(p => ({...p, vendorId:vendor.id}));
    return rows('products').filter(p => p.vendorId === vendor.id && p.active !== false);
  }

  function approvedVendor(v){
    return v && v.active !== false && v.suspended !== true && (
      (v.public === true && v.status === 'approved') ||
      v.adminApproved === true ||
      v.status === 'active'
    );
  }

  function sourceVendors(){
    const merged = new Map();
    rows('vendors').forEach(v => merged.set(v.id, v));
    rows('publicVendors').forEach(v => merged.set(v.id, {...(merged.get(v.id) || {}), ...v}));
    return [...merged.values()];
  }

  function visibleVendors(){
    return sourceVendors()
      .filter(approvedVendor)
      .sort((a,b) => {
        if(location && a.lat && a.lng && b.lat && b.lng) return U.distanceKm(location, a) - U.distanceKm(location, b);
        return Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0);
      });
  }

  function vendorById(id){ return sourceVendors().find(v => v.id === id); }
  function updateBadge(){ const el=document.getElementById('cartBadge'); if(el) el.textContent = Cart.lines.reduce((s,l)=>s+l.qty,0); }
  function imageFor(title){ return `https://placehold.co/480x320/e8f3ee/102033?text=${encodeURIComponent(title || 'OMNI')}`; }
  function distanceText(v){ return location && v.lat && v.lng ? `${U.distanceKm(location,{lat:+v.lat,lng:+v.lng}).toFixed(1)} km` : 'Latest'; }
  function locationText(){ return location ? `${location.source === 'gps' ? 'GPS' : 'Pinned'} location: ${Number(location.lat).toFixed(5)}, ${Number(location.lng).toFixed(5)}` : 'Showing latest approved vendors. Use GPS or drop a pin to sort nearby.'; }

  function vendorMatches(v, query){
    if(!query) return true;
    const products = parseProducts(v);
    return `${v.crName || ''} ${v.businessType || ''} ${v.whatsapp || ''}`.toLowerCase().includes(query)
      || products.some(p => `${p.name || ''} ${p.category || ''} ${p.description || ''}`.toLowerCase().includes(query));
  }

  function vendorIcon(v){
    const src = v.logo || v.shopfront || '';
    const label = U.esc(String(v.crName || 'V').slice(0,1).toUpperCase());
    return L.divIcon({
      className:'',
      iconSize:[40,40],
      iconAnchor:[20,40],
      popupAnchor:[0,-36],
      html:`<div class="vendor-map-icon">${src ? `<img src="${U.esc(src)}" alt="">` : label}</div>`
    });
  }

  function ensureMap(){
    if(maps.market) { maps.market.invalidateSize(); return maps.market; }
    L.Icon.Default.mergeOptions({
      iconRetinaUrl:'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
      iconUrl:'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
      shadowUrl:'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png'
    });
    maps.market = L.map('marketMap').setView([26.0667,50.5577], 11);
    maps.market._omniUserMoved = false;
    maps.market._omniAutoFramed = false;
    maps.market.on('zoomstart dragstart', () => { maps.market._omniUserMoved = true; });
    maps.market.on('click', event => {
      if(!dropMode) return;
      setLocation({lat:event.latlng.lat, lng:event.latlng.lng, source:'pin'});
      dropMode = false;
      UI.toast('Location pin dropped','ok');
    });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {maxZoom:19, attribution:'&copy; OpenStreetMap contributors'}).addTo(maps.market);
    return maps.market;
  }

  function setLocation(next){
    location = next;
    localStorage.setItem('omni_v2_customer_location', JSON.stringify(next));
    if(maps.market) { maps.market._omniUserMoved = false; maps.market._omniAutoFramed = false; }
    render();
  }

  function renderMarketMap(vendors){
    const mapEl = document.getElementById('marketMap');
    if(!mapEl || !global.L) return;
    const map = ensureMap();
    if(map._omniMarkers) map._omniMarkers.forEach(marker => map.removeLayer(marker));
    map._omniMarkers = [];
    if(location) {
      map._omniMarkers.push(L.circleMarker([location.lat, location.lng], {radius:8, color:'#1fc996', fillColor:'#1fc996', fillOpacity:.9}).addTo(map).bindPopup('Your location'));
    }
    vendors.filter(v => v.lat && v.lng).forEach(v => {
      const marker = L.marker([+v.lat, +v.lng], {icon:vendorIcon(v)}).addTo(map).bindPopup(`<b>${U.esc(v.crName || 'Vendor')}</b><br>${U.esc(v.businessType || '')}`);
      marker.on('click', () => renderVendorMenu(v.id));
      map._omniMarkers.push(marker);
    });
    if(!map._omniUserMoved && !map._omniAutoFramed) {
      if(map._omniMarkers.length > 1) map.fitBounds(L.featureGroup(map._omniMarkers).getBounds().pad(.2));
      else if(location) map.setView([location.lat, location.lng], 13);
      else if(vendors[0]?.lat && vendors[0]?.lng) map.setView([+vendors[0].lat, +vendors[0].lng], 12);
      map._omniAutoFramed = true;
    }
    setTimeout(() => map.invalidateSize(), 80);
  }

  function renderMarket(){
    const q = (document.getElementById('search')?.value || '').trim().toLowerCase();
    const vendors = visibleVendors().filter(v => vendorMatches(v, q));
    document.getElementById('market').innerHTML = `
      <div class="toolbar">
        <button id="dropPinBtn" class="btn">Drop pin</button>
        <button id="clearLocationBtn" class="btn ghost" ${location ? '' : 'disabled'}>Clear location</button>
        <button id="fullMapBtn" class="btn ghost">Full screen map</button>
        <span class="location-note">${U.esc(locationText())}</span>
      </div>
      <div class="grid market-layout">
        <div id="marketMapCard" class="card pad map-card">
          <div class="head"><h2>Vendor Map</h2><span class="pill">${vendors.length} vendors</span><div class="spacer"></div><button id="closeMapBtn" class="btn danger small map-close">Close</button></div>
          <div id="marketMap" class="market-map"></div>
        </div>
        <div class="card pad"><div class="head"><h2>Nearby List</h2></div><div id="vendorList" class="vendor-list"></div></div>
      </div>
      <div class="grid cols-3">${vendors.map(vendorCard).join('') || emptyMarket(q)}</div>
      <div id="vendorMenu"></div>`;
    document.getElementById('vendorList').innerHTML = vendors.length ? vendors.map(vendorRow).join('') : '<div class="empty">No approved vendors found.</div>';
    document.querySelectorAll('[data-open-vendor]').forEach(btn => btn.onclick = () => renderVendorMenu(btn.dataset.openVendor));
    document.getElementById('dropPinBtn').onclick = () => { dropMode = true; UI.toast('Tap the map to drop your delivery location','ok'); ensureMap(); };
    document.getElementById('clearLocationBtn').onclick = () => { location = null; localStorage.removeItem('omni_v2_customer_location'); if(maps.market){ maps.market._omniAutoFramed = false; maps.market._omniUserMoved = false; } render(); };
    document.getElementById('fullMapBtn').onclick = () => { document.getElementById('marketMapCard').classList.add('map-fullscreen'); setTimeout(() => maps.market?.invalidateSize(), 120); };
    document.getElementById('closeMapBtn').onclick = () => { document.getElementById('marketMapCard').classList.remove('map-fullscreen'); setTimeout(() => maps.market?.invalidateSize(), 120); };
    renderMarketMap(vendors);
  }

  function vendorCard(v){
    const img = v.shopfront || v.logo || imageFor(v.crName || 'Vendor');
    return `<article class="card vendor-tile"><img src="${U.esc(img)}" alt="${U.esc(v.crName || 'Vendor')}"><div class="body"><h3>${U.esc(v.crName || 'Vendor')}</h3><p class="muted">${U.esc(v.businessType || 'Vendor')} · ${U.esc(distanceText(v))}</p><span class="pill ok">Approved</span><button class="btn primary" data-open-vendor="${U.esc(v.id)}">View menu</button></div></article>`;
  }

  function vendorRow(v){
    return `<button class="mini-row" data-open-vendor="${U.esc(v.id)}" style="text-align:left"><img src="${U.esc(v.logo || v.shopfront || imageFor(v.crName || 'Vendor'))}" alt=""><span class="info"><h4>${U.esc(v.crName || 'Vendor')}</h4><p>${U.esc(v.businessType || '')} · ${U.esc(distanceText(v))}</p></span></button>`;
  }

  function emptyMarket(query){
    return `<div class="card empty" style="grid-column:1/-1"><h3>${query ? 'No matching vendors or products' : 'No approved vendors found yet'}</h3><p>${query ? 'Try another vendor, product, or service name.' : 'Approved public vendors will appear here automatically.'}</p></div>`;
  }

  function renderVendorMenu(vendorId){
    const vendor = vendorById(vendorId);
    const products = vendor ? parseProducts(vendor).filter(p => p.active !== false) : [];
    document.getElementById('vendorMenu').innerHTML = `<div class="card pad" style="margin-top:18px"><div class="head"><h2>${U.esc(vendor?.crName || 'Menu')}</h2><span class="pill">${products.length} items</span><div class="spacer"></div><button class="btn ghost small" data-close-menu>Close</button></div><div class="product-grid">${products.map(p=>`<article class="card product"><img src="${U.esc(p.image || imageFor(p.name || 'Product'))}" alt="${U.esc(p.name || 'Product')}"><div class="body"><h3>${U.esc(p.name)}</h3><p class="muted">${U.esc(p.category || p.description || 'Product')}</p><b>${U.money(p.price)}</b><button class="btn primary" data-add="${U.esc(p.id)}">Add to cart</button></div></article>`).join('') || '<div class="empty">No products yet.</div>'}</div></div>`;
    document.querySelector('[data-close-menu]').onclick = () => { document.getElementById('vendorMenu').innerHTML = ''; };
    document.querySelectorAll('[data-add]').forEach(btn => btn.onclick = () => {
      const product = products.find(p=>p.id===btn.dataset.add);
      if(product && Cart.add(product, vendor)) { UI.toast('Added to cart','ok'); updateBadge(); }
    });
    document.getElementById('vendorMenu').scrollIntoView({behavior:'smooth', block:'start'});
  }

  function renderCart(){
    const p = customerProfile();
    document.getElementById('cart').innerHTML = `<div class="grid split"><div class="card pad"><div class="head"><h2>Your Cart</h2><span class="pill">${Cart.lines.length} lines</span></div>${Cart.lines.map(line=>`<div class="cart-line"><span>${U.esc(line.name)} x ${line.qty}</span><button class="btn small danger" data-remove="${U.esc(line.productId)}">−</button><b>${U.money(line.price*line.qty)}</b></div>`).join('') || '<div class="empty">Cart is empty</div>'}<div class="total"><span>Total</span><span>${U.money(Cart.total())}</span></div></div><div class="card pad"><h2>Checkout</h2><div class="form"><div class="field"><label>Name</label><input id="coName" autocomplete="name" value="${U.esc(p.name||'')}"></div><div class="field"><label>Phone</label><input id="coPhone" inputmode="tel" autocomplete="tel" value="${U.esc(p.phone||'')}"></div><div class="field"><label>Address</label><textarea id="coAddress">${U.esc(p.defaultAddress||'')}</textarea></div><div class="location-note">${U.esc(locationText())}</div><div class="toolbar"><button id="checkoutGpsBtn" class="btn" type="button">Use GPS</button><button id="checkoutPinBtn" class="btn ghost" type="button">Drop pin on map</button></div><select id="coPayment" class="input"><option value="cash">Cash</option><option value="benefit">Benefit</option><option value="credit">Credit</option></select><button id="placeOrderBtn" class="btn primary">Place order</button></div></div></div>`;
    document.querySelectorAll('[data-remove]').forEach(btn => btn.onclick = () => { Cart.remove(btn.dataset.remove); updateBadge(); renderCart(); });
    document.getElementById('checkoutGpsBtn').onclick = locate;
    document.getElementById('checkoutPinBtn').onclick = () => { document.querySelector('[data-view="market"]').click(); setTimeout(() => document.getElementById('dropPinBtn')?.click(), 80); };
    document.getElementById('placeOrderBtn').onclick = placeOrder;
  }

  async function placeOrder(){
    if(placingOrder) return;
    if(!Cart.lines.length) return UI.toast('Cart is empty','bad');
    const profile = {id:customerId(), name:document.getElementById('coName').value.trim(), phone:document.getElementById('coPhone').value.trim(), defaultAddress:document.getElementById('coAddress').value.trim()};
    if(!profile.phone) return UI.toast('Phone is required','bad');
    if(!profile.defaultAddress && !location) return UI.toast('Add an address, use GPS, or drop a pin for delivery','bad');
    const paymentMethod = document.getElementById('coPayment').value;
    if(paymentMethod === 'credit') {
      const account = rows('creditAccounts').find(c => c.vendorId === Cart.lines[0].vendorId && c.status === 'active' && (c.customerId === profile.id || c.phone === profile.phone));
      if(!account) return UI.toast('Credit is not active for this vendor yet','bad');
      if(Number(account.balance || 0) + Cart.total() > Number(account.creditLimit || 0)) return UI.toast('This order exceeds your credit limit','bad');
    }
    placingOrder = true;
    const submit = document.getElementById('placeOrderBtn');
    if(submit) { submit.disabled = true; submit.textContent = 'Placing order...'; }
    try {
      await saveCustomerProfile(profile);
      const orderId = U.uid('order');
      const vendorId = Cart.lines[0].vendorId;
      const locationId = location ? U.uid('location') : '';
      const order = {id:orderId, vendorId, customerId:profile.id, customerName:profile.name || 'Guest', customerPhone:profile.phone, customerLocationId:locationId, customerAddress:profile.defaultAddress, customerLat:location?.lat || 0, customerLng:location?.lng || 0, status:'pending', paymentMethod, total:Cart.total(), source:'customer', createdAt:Date.now()};
      if(location) await DB.put('customerLocations', locationId, {id:locationId, customerId:profile.id, label:'Order location', address:profile.defaultAddress, lat:location.lat, lng:location.lng, source:location.source || 'pin'}, {userId:profile.id});
      await DB.put('orders', orderId, order, {userId:profile.id, vendorId});
      for(const line of Cart.lines) await DB.put('orderItems', U.uid('item'), {orderId, vendorId, productId:line.productId, nameSnapshot:line.name, priceSnapshot:line.price, qty:line.qty, total:line.price*line.qty}, {userId:profile.id, vendorId});
      await DB.event('customer_order_created','order',orderId,{vendorId, summary:`Customer order ${U.money(order.total)}`},{userId:profile.id, vendorId});
      const ids = U.parseJson(localStorage.getItem('omni_v2_order_ids') || '[]', []); ids.push(orderId); localStorage.setItem('omni_v2_order_ids', JSON.stringify(ids));
      Cart.clear(); updateBadge(); UI.toast('Order placed and synced','ok'); renderOrders();
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
    document.getElementById('orders').innerHTML = `<div class="card pad"><div class="head"><h2>My Orders</h2></div>${UI.table(myOrders, [{key:'id',label:'Order'}, {key:'status',label:'Status'}, {key:'paymentMethod',label:'Payment'}, {key:'total',label:'Total',format:r=>U.money(r.total)}, {key:'customerAddress',label:'Address'}, {key:'createdAt',label:'Placed',format:r=>r.createdAt?new Date(Number(r.createdAt)).toLocaleString():'-'}])}</div>`;
  }

  function renderCredit(){
    const profile = customerProfile();
    const accounts = rows('creditAccounts').filter(c => c.customerId === customerId() || (profile.phone && c.phone === profile.phone));
    const vendors = visibleVendors();
    document.getElementById('credit').innerHTML = `<div class="grid split"><div class="card pad"><div class="head"><h2>My Credit</h2></div>${UI.table(accounts, [{key:'vendorId',label:'Vendor',format:r=>vendorById(r.vendorId)?.crName || r.vendorId}, {key:'status',label:'Status'}, {key:'creditLimit',label:'Limit',format:r=>U.money(r.creditLimit)}, {key:'balance',label:'Balance',format:r=>U.money(r.balance)}])}</div><div class="card pad"><h2>Request credit</h2><div class="form"><div class="field"><label>Vendor</label><select id="creditVendor">${vendors.map(v=>`<option value="${U.esc(v.id)}">${U.esc(v.crName||v.id)}</option>`).join('')}</select></div><div class="field"><label>Phone</label><input id="creditPhone" value="${U.esc(profile.phone||'')}" inputmode="tel"></div><button id="requestCreditBtn" class="btn primary" ${vendors.length?'':'disabled'}>Send request</button></div><p class="muted">The selected vendor reviews your limit and payment terms.</p></div></div>`;
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
    document.getElementById('profile').innerHTML = `<div class="card pad"><div class="head"><h2>Profile</h2><span class="pill">Optional account</span></div><div class="form-grid"><div class="field"><label>Name</label><input id="pName" value="${U.esc(p.name||'')}"></div><div class="field"><label>Phone</label><input id="pPhone" value="${U.esc(p.phone||'')}"></div><div class="field full"><label>Address</label><textarea id="pAddress">${U.esc(p.defaultAddress||'')}</textarea></div><div class="full location-note">${U.esc(locationText())}</div><button id="profileGpsBtn" class="btn full" type="button">Use GPS location</button><button id="saveProfileBtn" class="btn primary full">Save profile</button></div></div>`;
    document.getElementById('profileGpsBtn').onclick = locate;
    document.getElementById('saveProfileBtn').onclick = async () => {
      try {
        await saveCustomerProfile({name:document.getElementById('pName').value.trim(), phone:document.getElementById('pPhone').value.trim(), defaultAddress:document.getElementById('pAddress').value.trim()});
        UI.toast('Profile saved and synced','ok');
      } catch(error) { UI.toast(error.message || 'Profile could not be synced','bad'); }
    };
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
    navigator.geolocation.getCurrentPosition(pos => {
      setLocation({lat:pos.coords.latitude, lng:pos.coords.longitude, source:'gps'});
      UI.toast('Location updated','ok');
    }, err => UI.toast(err.message || 'Location denied','bad'), {enableHighAccuracy:true, timeout:12000, maximumAge:60000});
  }

  function boot(){
    UI.shell(); UI.bindNav(render); DB.init(UI.setStatus);
    global.OmniConfig.collections.forEach(name => DB.subscribe(name, render, {includeDeleted:true}));
    document.getElementById('search').oninput = render;
    document.getElementById('locateBtn').onclick = locate;
    window.addEventListener('resize', () => Object.values(maps).forEach(map => map?.invalidateSize()));
    render();
  }
  boot();
})(window);
