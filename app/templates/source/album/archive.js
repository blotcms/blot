!function(e){if("object"==typeof exports&&"undefined"!=typeof module)module.exports=e();else if("function"==typeof define&&define.amd)define([],e);else{("undefined"!=typeof window?window:"undefined"!=typeof global?global:"undefined"!=typeof self?self:this).HyperList=e()}}(function(){return function(){return function e(t,i,r){function n(s,a){if(!i[s]){if(!t[s]){var l="function"==typeof require&&require;if(!a&&l)return l(s,!0);if(o)return o(s,!0);var h=new Error("Cannot find module '"+s+"'");throw h.code="MODULE_NOT_FOUND",h}var c=i[s]={exports:{}};t[s][0].call(c.exports,function(e){return n(t[s][1][e]||e)},c,c.exports,e,t,i,r)}return i[s].exports}for(var o="function"==typeof require&&require,s=0;s<r.length;s++)n(r[s]);return n}}()({1:[function(e,t,i){"use strict";Object.defineProperty(i,"__esModule",{value:!0});var r=function(){function e(e,t){for(var i=0;i<t.length;i++){var r=t[i];r.enumerable=r.enumerable||!1,r.configurable=!0,"value"in r&&(r.writable=!0),Object.defineProperty(e,r.key,r)}}return function(t,i,r){return i&&e(t.prototype,i),r&&e(t,r),t}}();function n(e,t,i){return t in e?Object.defineProperty(e,t,{value:i,enumerable:!0,configurable:!0,writable:!0}):e[t]=i,e}var o={width:"100%",height:"100%"},s=function(e){return Number(e)==Number(e)},a="classList"in document.documentElement?function(e,t){e.classList.add(t)}:function(e,t){var i=e.getAttribute("class")||"";e.setAttribute("class",i+" "+t)},l=function(){function e(t,i){var r=this;!function(e,t){if(!(e instanceof t))throw new TypeError("Cannot call a class as a function")}(this,e),this._config={},this._lastRepaint=null,this._maxElementHeight=e.getMaxBrowserHeight(),this.refresh(t,i);var n=this._config;!function e(){var t=r._getScrollPosition(),i=r._lastRepaint;if(r._renderAnimationFrame=window.requestAnimationFrame(e),t!==i){var o=i?t-i:0;if(!i||o<0||o>r._averageHeight){var s=r._renderChunk();r._lastRepaint=t,!1!==s&&"function"==typeof n.afterRender&&n.afterRender()}}}()}return r(e,null,[{key:"create",value:function(t,i){return new e(t,i)}},{key:"mergeStyle",value:function(e,t){for(var i in t)e.style[i]!==t[i]&&(e.style[i]=t[i])}},{key:"getMaxBrowserHeight",value:function(){var t=document.createElement("div"),i=document.createElement("div");e.mergeStyle(t,{position:"absolute",height:"1px",opacity:0}),e.mergeStyle(i,{height:"1e7px"}),t.appendChild(i),document.body.appendChild(t);var r=i.offsetHeight;return document.body.removeChild(t),r}}]),r(e,[{key:"destroy",value:function(){window.cancelAnimationFrame(this._renderAnimationFrame)}},{key:"refresh",value:function(t,i){var r;if(Object.assign(this._config,o,i),!t||1!==t.nodeType)throw new Error("HyperList requires a valid DOM Node container");this._element=t;var a=this._config,l=this._scroller||a.scroller||document.createElement(a.scrollerTagName||"tr");if("boolean"!=typeof a.useFragment&&(this._config.useFragment=!0),!a.generate)throw new Error("Missing required `generate` function");if(!s(a.total))throw new Error("Invalid required `total` value, expected number");if(!Array.isArray(a.itemHeight)&&!s(a.itemHeight))throw new Error("\n        Invalid required `itemHeight` value, expected number or array\n      ".trim());s(a.itemHeight)?this._itemHeights=Array(a.total).fill(a.itemHeight):this._itemHeights=a.itemHeight,Object.keys(o).filter(function(e){return e in a}).forEach(function(e){var t=a[e],i=s(t);if(t&&"string"!=typeof t&&"number"!=typeof t)throw new Error("Invalid optional `"+e+"`, expected string or number");i&&(a[e]=t+"px")});var h=Boolean(a.horizontal),c=a[h?"width":"height"];if(c){var u=s(c),f=!u&&"%"===c.slice(-1),m=u?c:parseInt(c.replace(/px|%/,""),10),d=window[h?"innerWidth":"innerHeight"];this._containerSize=f?d*m/100:s(c)?c:m}var g=a.scrollContainer,p=a.itemHeight*a.total,_=this._maxElementHeight;p>_&&console.warn(["HyperList: The maximum element height",_+"px has","been exceeded; please reduce your item height."].join(" "));var v={width:""+a.width,height:g?p+"px":""+a.height,overflow:g?"none":"auto",position:"relative"};e.mergeStyle(t,v),g&&e.mergeStyle(a.scrollContainer,{overflow:"auto"});var y=(n(r={opacity:"0",position:"absolute"},h?"height":"width","1px"),n(r,h?"width":"height",p+"px"),r);e.mergeStyle(l,y),this._scroller||t.appendChild(l);var w=this._computeScrollPadding();this._scrollPaddingBottom=w.bottom,this._scrollPaddingTop=w.top,this._scroller=l,this._scrollHeight=this._computeScrollHeight(),this._itemPositions=this._itemPositions||Array(a.total).fill(0),this._computePositions(0),this._renderChunk(null!==this._lastRepaint),"function"==typeof a.afterRender&&a.afterRender()}},{key:"_getRow",value:function(t){var i=this._config,r=i.generate(t),o=r.height;if(void 0!==o&&s(o)?(r=r.element,o!==this._itemHeights[t]&&(this._itemHeights[t]=o,this._computePositions(t),this._scrollHeight=this._computeScrollHeight(t))):o=this._itemHeights[t],!r||1!==r.nodeType)throw new Error("Generator did not return a DOM Node for index: "+t);a(r,i.rowClassName||"vrow");var l=this._itemPositions[t]+this._scrollPaddingTop;return e.mergeStyle(r,n({position:"absolute"},i.horizontal?"left":"top",l+"px")),r}},{key:"_getScrollPosition",value:function(){var e=this._config;return"function"==typeof e.overrideScrollPosition?e.overrideScrollPosition():this._element[e.horizontal?"scrollLeft":"scrollTop"]}},{key:"_renderChunk",value:function(e){var t=this._config,i=this._element,r=this._getScrollPosition(),n=t.total,o=t.reverse?this._getReverseFrom(r):this._getFrom(r)-1;if((o<0||o-this._screenItemsLen<0)&&(o=0),!e&&this._lastFrom===o)return!1;this._lastFrom=o;var s=o+this._cachedItemsLen;(s>n||s+this._cachedItemsLen>n)&&(s=n);var a=t.useFragment?document.createDocumentFragment():[],l=this._scroller;a[t.useFragment?"appendChild":"push"](l);for(var h=o;h<s;h++){var c=this._getRow(h);a[t.useFragment?"appendChild":"push"](c)}if(t.applyPatch)return t.applyPatch(i,a);i.innerHTML="",i.appendChild(a)}},{key:"_computePositions",value:function(){var e=arguments.length>0&&void 0!==arguments[0]?arguments[0]:1,t=this._config,i=t.total,r=t.reverse;e<1&&!r&&(e=1);for(var n=e;n<i;n++)r?0===n?this._itemPositions[0]=this._scrollHeight-this._itemHeights[0]:this._itemPositions[n]=this._itemPositions[n-1]-this._itemHeights[n]:this._itemPositions[n]=this._itemHeights[n-1]+this._itemPositions[n-1]}},{key:"_computeScrollHeight",value:function(){var t,i=this,r=this._config,o=Boolean(r.horizontal),s=r.total,a=this._itemHeights.reduce(function(e,t){return e+t},0)+this._scrollPaddingBottom+this._scrollPaddingTop;e.mergeStyle(this._scroller,(n(t={opacity:0,position:"absolute",top:"0px"},o?"height":"width","1px"),n(t,o?"width":"height",a+"px"),t));var l=this._itemHeights.slice(0).sort(function(e,t){return e-t}),h=Math.floor(s/2),c=s%2==0?(l[h]+l[h-1])/2:l[h],u=o?"clientWidth":"clientHeight",f=r.scrollContainer?r.scrollContainer:this._element,m=f[u]?f[u]:this._containerSize;return this._screenItemsLen=Math.ceil(m/c),this._containerSize=m,this._cachedItemsLen=Math.max(this._cachedItemsLen||0,3*this._screenItemsLen),this._averageHeight=c,r.reverse&&window.requestAnimationFrame(function(){o?i._element.scrollLeft=a:i._element.scrollTop=a}),a}},{key:"_computeScrollPadding",value:function(){var e=this._config,t=Boolean(e.horizontal),i=e.reverse,r=window.getComputedStyle(this._element),n=function(e){var t=r.getPropertyValue("padding-"+e);return parseInt(t,10)||0};return t&&i?{bottom:n("left"),top:n("right")}:t?{bottom:n("right"),top:n("left")}:i?{bottom:n("top"),top:n("bottom")}:{bottom:n("bottom"),top:n("top")}}},{key:"_getFrom",value:function(e){for(var t=0;this._itemPositions[t]<e;)t++;return t}},{key:"_getReverseFrom",value:function(e){for(var t=this._config.total-1;t>0&&this._itemPositions[t]<e+this._containerSize;)t--;return t}}]),e}();i.default=l,t.exports=i.default},{}]},{},[1])(1)});
  var articles = [
    {{#archives}}
    {{#months}}
    {{#entries}}
    { 
      "title": "{{title}}",
      "url": "{{{url}}}",
      "thumbnail": "{{{thumbnail.small.url}}}",
      "date": "{{date}}"
    },
    {{/entries}}
    {{/months}}
    {{/archives}}
  ];

const container = document.getElementById('hyperlist');

// Pass the container element and configuration to the HyperList constructor.
// You can optionally use the create method if you prefer to avoid `new`.
const list = HyperList.create(container, {
  // All items must be the exact same height currently. Although since there is
  // a generate method, in the future this should be configurable.
  itemHeight: 80,

  width: "100vw",

  height: window.innerHeight - 120,

  useFragment: false,

  // Specify the total amount of items to render the virtual height.
  total: articles.length,

  applyPatch: function applyPatch(element, fragment) {
    // console.log('Applying patch');
    // console.log('element', element);
    // console.log('fragment', fragment);
    fragment.forEach((node)=> {
      if (!node.innerHTML.trim()) return;
      
      console.log(node.innerHTML)

      if (element.querySelector('#' + node.id)) {
      
      } else {
        element.appendChild(node);
      }
    });
    // element.innerHTML = '';
    // 
  },

  // Wire up the data to the index. The index is then mapped to a Y position
  // in the container.
  generate(index) {
    const el = document.createElement('a');
    el.id = "row-" + index;
    el.href= articles[index].url;
    el.innerHTML = `
      <span class="thumbnail">
          ${articles[index].thumbnail ? `<img src="${articles[index].thumbnail}" class="pre-loaded" onload="this.className+=' loaded';" />
          <noscript>  
          <img src="${articles[index].thumbnail}">
          </noscript>` : ''}
      </span>
      <span class="title">${articles[index].title}</span>
      {{^hide_dates}}<span class="date">${articles[index].date}</span>{{/hide_dates}}
    `;
    return el;
  },
});

