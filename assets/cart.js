(function(global){
  'use strict';
  const Cart = {
    lines: [],
    save(){},
    add(product, vendor){
      if(Cart.lines.length && Cart.lines[0].vendorId !== product.vendorId) {
        if(!confirm('Your cart has items from another vendor. Clear it?')) return false;
        Cart.lines = [];
      }
      const line = Cart.lines.find(x => x.productId === product.id);
      if(line) line.qty += 1;
      else Cart.lines.push({productId:product.id, vendorId:product.vendorId, vendorName:vendor?.crName || '', name:product.name, price:Number(product.price||0), qty:1});
      Cart.save();
      return true;
    },
    remove(productId){
      const line = Cart.lines.find(x => x.productId === productId);
      if(!line) return;
      line.qty -= 1;
      if(line.qty <= 0) Cart.lines = Cart.lines.filter(x => x.productId !== productId);
      Cart.save();
    },
    total(){ return Cart.lines.reduce((sum,line)=>sum+line.price*line.qty,0); },
    clear(){ Cart.lines = []; Cart.save(); }
  };
  global.CustomerCart = Cart;
})(window);
