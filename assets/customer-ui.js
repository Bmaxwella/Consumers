(function(global){
  'use strict';
  const U = global.OmniUtils;

  function toast(message, type=''){
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = message;
    document.getElementById('toastStack').appendChild(el);
    setTimeout(() => el.remove(), 3600);
  }

  function shell(){
    const app = document.getElementById('app');
    app.className = 'app';
    app.innerHTML = `
      <aside class="side">
        <div class="brand"><div class="brand-mark">OM</div><div>OMNI<br><span class="muted">MARKET</span></div></div>
        <nav class="nav" data-nav>
          <button class="active" data-view="market">Marketplace</button>
          <button data-view="cart">Cart</button>
          <button data-view="orders">My Orders</button>
          <button data-view="credit">Credit</button>
          <button data-view="profile">Profile</button>
        </nav>
        <div class="sync"><span id="syncDot" class="dot"></span><span id="syncText">Connecting securely</span><small class="relay-url">Secure cloud service</small></div>
      </aside>
      <main class="main">
        <div class="mobile-tabs" data-nav><button class="btn primary" data-view="market">Market</button><button class="btn" data-view="cart">Cart</button><button class="btn" data-view="orders">Orders</button><button class="btn" data-view="credit">Credit</button><button class="btn" data-view="profile">Profile</button></div>
        <header class="top">
          <div class="search"><span>⌕</span><input id="search" placeholder="Search vendors, products, services"></div>
          <span id="userMode" class="pill">Guest</span>
          <button id="locateBtn" class="btn">Use GPS</button>
          <button id="logoutBtn" class="btn ghost">Switch user</button>
          <button class="btn primary" data-view="cart">Cart <span id="cartBadge" class="badge">0</span></button>
        </header>
        <section class="content">
          <div id="market" class="view active"></div>
          <div id="cart" class="view"></div>
          <div id="orders" class="view"></div>
          <div id="credit" class="view"></div>
          <div id="profile" class="view"></div>
        </section>
      </main>`;
  }

  function bindNav(render){
    document.querySelectorAll('[data-view]').forEach(btn => btn.onclick = () => {
      document.querySelectorAll('.view').forEach(view => view.classList.toggle('active', view.id === btn.dataset.view));
      document.querySelectorAll('[data-nav] button').forEach(item => item.classList.toggle('active', item.dataset.view === btn.dataset.view));
      render();
    });
  }

  function activeView(){ return document.querySelector('.view.active')?.id || 'market'; }
  function setStatus(status){
    document.getElementById('syncDot')?.classList.toggle('online', status.online);
    document.getElementById('authRelayDot')?.classList.toggle('online', status.online);
    const text=document.getElementById('syncText');
    const authText=document.getElementById('authRelayState');
    if(text) text.textContent=status.text || 'Connecting';
    if(authText) authText.textContent=status.online ? 'Connected' : (status.text || 'Connecting');
  }
  function table(rows, columns){
    if(!rows.length) return '<div class="card empty">No records found</div>';
    return `<div class="table-wrap"><table class="table"><thead><tr>${columns.map(c=>`<th>${U.esc(c.label)}</th>`).join('')}</tr></thead><tbody>${rows.map(row=>`<tr>${columns.map(c=>`<td>${U.esc(c.format?c.format(row):row[c.key])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  }

  global.CustomerUI = { toast, shell, bindNav, activeView, setStatus, table };
})(window);
