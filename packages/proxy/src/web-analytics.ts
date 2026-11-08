/**
 * The first-party analytics script Caddy serves at `<prefix>/_ls/a.js` on domains with web
 * analytics on. It sends a pageview on load and on SPA navigations, plus `window.lsa(name)`
 * custom events, as GETs to `<prefix>/_ls/e`, which Caddy answers 204; the agent reads them from
 * the access log. Only the path and `utm_source` of the page are sent: no cookies, no storage,
 * nothing from the query string that could be personal.
 */
export const WEB_ANALYTICS_SCRIPT = `(function(){var d=document,l=location,w=window,s=d.currentScript,b=s&&s.src?new URL(s.src).pathname.replace(/a\\.js$/,""):"/_ls/",last,first=1;function send(n){if(w.navigator.webdriver||/^(localhost|127\\.|\\[::1\\])/.test(l.hostname))return;var m=/[?&]utm_source=([^&#]*)/.exec(l.search),u=l.pathname+(m?"?utm_source="+m[1]:"");if(n=="pageview"){if(u==last)return;last=u}var q="n="+encodeURIComponent(n)+"&u="+encodeURIComponent(u)+"&w="+w.innerWidth;if(n=="pageview"&&first){first=0;q+="&r="+encodeURIComponent(d.referrer)}try{fetch(b+"e?"+q,{keepalive:true,credentials:"omit"})}catch(e){}}var h=w.history,p=h.pushState;if(p){h.pushState=function(){p.apply(this,arguments);send("pageview")};w.addEventListener("popstate",function(){send("pageview")})}w.lsa=function(n){send(String(n).slice(0,64))};send("pageview")})();`;
