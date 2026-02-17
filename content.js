let adblockAllowed = false;
const adblockSafeMode = false;

const POPUP_HOST_PATTERNS = [
    'doubleclick', 'googlesyndication', 'adsystem', 'adservice', 'adnxs', 'taboola',
    'outbrain', 'popads', 'propellerads', 'trafficroots', 'clickadu', 'spoutable',
    'onclick', 'interstitial', 'popunder', 'redir', 'redirect', 'trk.', 'track.',
    'adzerk', 'revcontent', 'megapop', 'adblade', 'exoclick', 'juicyads', 'adsterra',
    'popcash', 'admaven', 'hilltopads', 'monetag', 'richads', 'trafficjunky', 'mgid',
    'zeroredirect', 'pubmatic', 'openx', 'criteo', 'smartadserver', 'amazon-adsystem',
    'media.net', 'bidvertiser', 'adcash', 'adcolony', 'unity3d', 'applovin', 'vungle',
    'inmobi', 'mopub', 'ironsrc', 'chartboost', 'startapp', 'fyber', 'tapjoy',
    'adroll', 'perfectaudience', 'retargeter', 'steelhouse', 'chango', 'triggit',
    'ad.', 'ads.', 'adv.', 'banner.', 'click.', 'pop.', 'tracking.', 'pixel.',
    'syndication', 'adsrv', 'adserver', 'adtech', 'advertising', 'sponsor'
];

const POPUP_PATH_PATTERNS = [
    'popup', 'popunder', 'interstitial', 'advert', 'ads', 'trk', 'redirect',
    'click', 'banner', 'promo', 'sponsor', 'aff', 'partner', 'track', 'pixel',
    'conversion', 'campaign', 'landing', 'offer', 'deal', 'cpa', 'cpc', 'cpm'
];

const MAX_MUTATIONS_PER_BATCH = 150;
let adMutationObserverStarted = false;

const normalizeUrl = (rawUrl) => {
    if (!rawUrl) return '';
    try {
        return new URL(rawUrl, location.href).href;
    } catch (e) {
        return String(rawUrl);
    }
};

const shouldBlockUrl = (rawUrl) => {
    const href = normalizeUrl(rawUrl);
    if (!href) return false;

    try {
        const url = new URL(href);
        if (url.origin === location.origin) return false;

        const host = url.hostname.toLowerCase();
        if (POPUP_HOST_PATTERNS.some((p) => host.includes(p))) return true;
        if (POPUP_PATH_PATTERNS.some((p) => url.pathname.toLowerCase().includes(p))) return true;
        return false;
    } catch (e) {
        return true;
    }
};

function patchWindowOpen() {
    if (!adblockAllowed) return;
    const originalOpen = window.open;
    if (!originalOpen || originalOpen.__gt_patched) return;

    const wrapped = function patchedOpen(url, target, features) {
        if (!url || url === 'about:blank' || url === '' || shouldBlockUrl(url)) {
            chrome.runtime.sendMessage({ action: 'adBlocked' });
            return null;
        }
        if (!window._userInteracting) {
            chrome.runtime.sendMessage({ action: 'adBlocked' });
            return null;
        }
        return originalOpen.apply(this, arguments);
    };

    wrapped.__gt_patched = true;
    window.open = wrapped;

    ['click', 'mousedown', 'keydown', 'touchstart'].forEach(evt => {
        document.addEventListener(evt, () => {
            window._userInteracting = true;
            setTimeout(() => { window._userInteracting = false; }, 1000);
        }, true);
    });
}

function setupClickPopupGuard() {
    if (!adblockAllowed) return;
    const guard = (event) => {
        if (!event.isTrusted) return;
        const anchor = event.target?.closest?.('a');
        const href = anchor?.href || null;
        if (href && shouldBlockUrl(href)) {
            event.preventDefault();
            event.stopPropagation();
            chrome.runtime.sendMessage({ action: 'adBlocked' });
        }
    };
    document.addEventListener('click', guard, true);
}

function scanAndRemoveAds(root = document) {
    if (!adblockAllowed) return;
    try {
        const nodes = root.querySelectorAll(adSelectors.join(','));
        nodes.forEach((node) => {
            node.remove();
            chrome.runtime.sendMessage({ action: 'adBlocked' });
        });
    } catch (e) {}
}

function startAdMutationObserver() {
    if (!adblockAllowed || adMutationObserverStarted || adblockSafeMode) return;
    adMutationObserverStarted = true;

    try {
        const observer = new MutationObserver((mutations) => {
            let processed = 0;
            for (const mutation of mutations) {
                if (processed > MAX_MUTATIONS_PER_BATCH) break;
                mutation.addedNodes.forEach((node) => {
                    if (processed > MAX_MUTATIONS_PER_BATCH) return;
                    if (node.nodeType !== 1) return;
                    const element = node;

                    if (element.tagName === 'IFRAME') {
                        const src = element.src || element.getAttribute('src') || '';
                        const name = element.name || '';
                        const id = element.id || '';
                        if (shouldBlockUrl(src) || /ad|banner|pop|promo|sponsor/i.test(name + id + src)) {
                            element.remove();
                            chrome.runtime.sendMessage({ action: 'adBlocked' });
                            processed += 1;
                            return;
                        }
                    }

                    if (element.tagName === 'SCRIPT') {
                        const src = element.src || '';
                        if (shouldBlockUrl(src)) {
                            element.remove();
                            chrome.runtime.sendMessage({ action: 'adBlocked' });
                            processed += 1;
                            return;
                        }
                    }

                    const style = element.style;
                    if (style && style.zIndex && parseInt(style.zIndex) > 999999 && style.position === 'fixed') {
                        const isOurs = element.id && (element.id.includes('timer') || element.id.includes('fps') || element.id.includes('key'));
                        if (!isOurs) {
                            element.remove();
                            chrome.runtime.sendMessage({ action: 'adBlocked' });
                            processed += 1;
                            return;
                        }
                    }

                    if (element.matches?.(adSelectors.join(','))) {
                        element.remove();
                        chrome.runtime.sendMessage({ action: 'adBlocked' });
                        processed += 1;
                        return;
                    }

                    const childMatch = element.querySelector?.(adSelectors.join(','));
                    if (childMatch) {
                        childMatch.remove();
                        chrome.runtime.sendMessage({ action: 'adBlocked' });
                        processed += 1;
                    }
                });
            }
        });

        observer.observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) {
        adMutationObserverStarted = false;
    }
}

(async () => {
    const { adblockActive } = await chrome.storage.local.get(["adblockActive"]);
    if (adblockActive === false) {
        adblockAllowed = false;
        return;
    }
    adblockAllowed = true;

    patchWindowOpen();
    setupClickPopupGuard();
})();

let lastMouseX=0;let lastMouseY=0;let tripleClickActive=!1;let tripleClickKey="KeyF";
document.addEventListener('mousemove',_0x2ecf90=>{lastMouseX=_0x2ecf90.clientX;lastMouseY=_0x2ecf90.clientY},{passive:!0});
chrome.storage.local.get(['tripleClickActive','tripleClickKey'],_0x39f8b2=>{if(_0x39f8b2.tripleClickActive!==undefined)tripleClickActive=_0x39f8b2.tripleClickActive;if(_0x39f8b2.tripleClickKey)tripleClickKey=_0x39f8b2.tripleClickKey;});
function doTripleClick(){const _0x46e864=document.elementFromPoint(lastMouseX,lastMouseY);if(!_0x46e864){return}[0,40,80].forEach(_0x1918ed=>{setTimeout(()=>{const _0x22f87a={bubbles:!0,cancelable:!0,view:window,clientX:lastMouseX,clientY:lastMouseY};_0x46e864.dispatchEvent(new MouseEvent('mousedown',_0x22f87a));_0x46e864.dispatchEvent(new MouseEvent('mouseup',_0x22f87a));_0x46e864.dispatchEvent(new MouseEvent('click',_0x22f87a))},_0x1918ed)})}
const log=()=>{}; // Désactive totalement les logs pour la prod
log("Gaming Tools Suite Complete - Content script chargé");
const adSelectors = [
    "[id*='google_ads']", "[class*='google-ad']",
    "[id*='ad-']", "[class*='ad-']",
    "[class*='advertisement']", "iframe[src*='doubleclick']",
    "iframe[src*='googlesyndication']", ".adsbygoogle",
    "[id*='banner']", "[class*='banner']",
    "[id*='sponsor']", "[class*='sponsor']",
    "[class*='AdBox']", "[class*='ad_container']",
    "[id*='popup']", "[class*='popup-ad']",
    "ins.adsbygoogle", "div[data-ad-slot]",
    "div[data-google-query-id]", "[id*='dfp-']",
    "[class*='dfp-']", "div[data-freestar-ad]",
    "div[id^='div-gpt-ad']", "div[class*='pub_']",
    "[id*='advert']", "[class*='advert']",
    "[class*='promo']", "[id*='promo']",
    "[class*='overlay-ad']", "[id*='overlay-ad']",
    "[class*='interstitial']", "[id*='interstitial']",
    "[class*='modal-ad']", "[class*='splash-ad']",
    "[class*='sticky-ad']", "[class*='floating-ad']",
    "[class*='bottom-ad']", "[class*='top-ad']",
    "[class*='sidebar-ad']", "[class*='leaderboard']",
    "[class*='skyscraper']", "[class*='rectangle-ad']",
    "[data-ad]", "[data-ads]", "[data-adunit]",
    "[aria-label*='advertisement']", "[aria-label*='sponsored']",
    ".ad-wrapper", ".ad-slot", ".ad-unit", ".ad-block",
    "aside[class*='ad']", "section[class*='ad']",
    "[class*='native-ad']", "[class*='promoted']",
    "[class*='taboola']", "[class*='outbrain']", "[class*='mgid']",
    "a[href*='click.'], a[href*='track.']",
    "iframe[src*='adserver']", "iframe[src*='adsrv']",
    "iframe[id*='google_ads']", "iframe[name*='google_ads']",
    "div[class*='_ad']", "div[id*='_ad']",
    ".pub_300x250", ".pub_728x90", ".text-ad", ".textAd",
    "#carbonads", ".carbon-wrap", "#ad_top", "#ad_bottom"
];

function injectAdblockCSS() {
    const styleId = 'gaming-tools-adblock';
    if (document.getElementById(styleId)) return;
    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = adSelectors.join(',') + ' { display: none !important; visibility: hidden !important; pointer-events: none !important; width: 0 !important; height: 0 !important; position: absolute !important; left: -9999px !important; }';
    document.head.appendChild(style);
    log("AdBlock CSS injecté");
}

async function initAdblock() {
    if (!adblockAllowed) return;
    const response = await chrome.runtime.sendMessage({'action': "getAdblockState"});
    if (response && response.active !== false) {
        injectAdblockCSS();
        scanAndRemoveAds();
        startAdMutationObserver();
        const observer = new MutationObserver(() => {
            if (!document.getElementById('gaming-tools-adblock')) injectAdblockCSS();
        });
        observer.observe(document.head, { childList: true });
    }
}
initAdblock();let timerOverlay=null;let timerState="stopped";let startTime=null;let currentTime=0;let timerInterval=null;let isVisible=!1;let timerDisplayEl=null;let timerMainEl=null;let timerDecimalsEl=null;let lastTimerMain='';let lastTimerDecimals='';let currentHotkey="Control";let zqsdHandler=null;let isResolutionForced=!1;let fpsOverlay=null;let fpsVisible=!1;let fpsAnimationId=null;let fpsLastTimestamp=null;let fpsSamples=[];let storedCustomBackground=null;let storedCustomBackgroundActive=null;let fpsSettings={position:{x:20,y:100},visible:!1};let currentFpsTheme="minimal";const DEFAULT_KEYPRESS_SETTINGS={visible:!1,size:1,layout:'arrows',theme:"default",position:null};let keypressOverlay=null;let keypressVisible=!1;let keypressSettings={...DEFAULT_KEYPRESS_SETTINGS};let keypressKeyMap={};let keyResizeHandle=null;let keySizeIndicator=null;let isKeyResizeActive=!1;let keyResizeState=null;let keypressElementMap=Object.create(null);let keypressActiveKeys=new Set();let keypressBoundsHandle=null;let lastSavedKeypressSettings={...DEFAULT_KEYPRESS_SETTINGS,position:null};(async()=>{const response=await chrome.runtime.sendMessage({action:'getHotkey'});if(response&&response.hotkey){currentHotkey=response.hotkey}})();document.addEventListener("keydown",handleKeydown,!0);document.addEventListener("keyup",handleKeyup,!0);(async()=>{const response=await chrome.runtime.sendMessage({action:"getZqsdState"});if(response&&response.active){log("ZQSD était activé - réactivation automatique");if(window.wasdZqsdHandler){document.removeEventListener("keydown",window.wasdZqsdHandler,!0);document.removeEventListener("keyup",window.wasdZqsdHandler,!0);window.wasdZqsdHandler=null;zqsdHandler=null}
setTimeout(()=>{activateZqsdDirectly();setTimeout(()=>{if(keypressOverlay&&keypressVisible){const layout=keypressSettings.layout||'arrows';renderKeypressLayout(layout)}},100)},1000)}})();(async()=>{const response=await chrome.runtime.sendMessage({action:"getFpsSettings"});if(chrome.runtime.lastError){return}
if(response&&response.settings){const{position,visible}=response.settings;if(position&&typeof position.x==="number"&&typeof position.y==='number'){fpsSettings.position=position}
fpsSettings.visible=!!visible;if(fpsSettings.visible){if(!fpsOverlay)createFpsOverlay();fpsVisible=!0;applyFpsSettings();}}})();(async()=>{const response=await chrome.runtime.sendMessage({action:"getKeypressSettings"});if(chrome.runtime.lastError){return}
if(response&&response.settings){keypressVisible=!!response.settings.visible;keypressSettings.visible=keypressVisible;keypressSettings.size=clampKeypressScale(response.settings.size??1);const layout=typeof response.settings.layout==='string'?response.settings.layout.toLowerCase():"arrows";let needsUpdate=!1;let newLayout="arrows";if(KEY_LAYOUTS[layout]){newLayout=layout}
keypressSettings.layout=newLayout;const theme=typeof response.settings.theme==="string"?response.settings.theme:null;const resolvedTheme=resolveThemeKey(theme);keypressSettings.theme=resolvedTheme;if(response.settings.position&&typeof response.settings.position==='object'){const{x,y}=response.settings.position;if(Number.isFinite(x)&&Number.isFinite(y)){keypressSettings.position={x:Math.round(x),y:Math.round(y)}}else{keypressSettings.position=null}}else{keypressSettings.position=null}
if(needsUpdate){persistKeypressSettings({layout:newLayout})}
if(theme&&resolvedTheme!==theme.toLowerCase()){persistKeypressSettings({theme:resolvedTheme})}
lastSavedKeypressSettings={visible:keypressSettings.visible,size:keypressSettings.size,layout:keypressSettings.layout,theme:keypressSettings.theme,position:keypressSettings.position?{...keypressSettings.position}:null};if(keypressVisible){createKeypressOverlay();setKeypressLayout(keypressSettings.layout);applyKeypressSize(keypressSettings.size);applyKeypressTheme(keypressSettings.theme);keypressOverlay.style.display="block";applyKeypressPosition(keypressSettings.position);scheduleKeypressBoundsCheck()}}})();let currentGlobalVolume=1;let volumePageReady=!1;function injectVolumeScript(){const rootEl=document.documentElement||document.head||document.body;if(!rootEl){window.addEventListener("DOMContentLoaded",injectVolumeScript,{once:!0});return}
if(rootEl.dataset?.["volumeInjected"]==="true"){return}
const script=document.createElement("script");script.type="text/javascript";script.src=chrome.runtime.getURL("volumeInjected.js");script.dataset.channel="GAMING_TOOLS_VOLUME_CHANNEL";script.addEventListener("load",()=>{script.remove()});rootEl.appendChild(script);if(rootEl.dataset){rootEl.dataset.volumeInjected="true"}}
function sendVolumeToPage(type,payload={}){window.postMessage({source:"GAMING_TOOLS_VOLUME_CHANNEL",type,payload,})}
async function initGlobalVolumeControl(){injectVolumeScript();const{globalVolumeLevel}=await chrome.storage.local.get(["globalVolumeLevel"]);if(globalVolumeLevel!==undefined){currentGlobalVolume=Math.min(1,Math.max(0,globalVolumeLevel))}
if(volumePageReady){sendVolumeToPage("EXT_INIT_VOLUME",{volume:currentGlobalVolume})}
window.addEventListener("message",(event)=>{if(event.source!==window||!event.data||event.data.source!=="GAMING_TOOLS_VOLUME_CHANNEL"){return}
const{type,payload}=event.data;if(type==="PAGE_READY"){volumePageReady=!0;sendVolumeToPage("EXT_INIT_VOLUME",{volume:currentGlobalVolume})}else if(type==="PAGE_VOLUME"){const volume=Math.min(1,Math.max(0,payload?.["volume"]||0));currentGlobalVolume=volume;chrome.storage.local.set({globalVolumeLevel:volume})}})}
initGlobalVolumeControl();

(function applyAdvancedStyleV2FromStorage() {
    function applyV2(s) {
        const timerOverlay = document.getElementById('speedrun-timer-overlay');
        const timerDisplayEl = timerOverlay?.querySelector('#timer-display');
        const fpsOverlay = document.getElementById('fps-monitor-overlay');
        const keypressOverlay = document.getElementById('key-display-overlay');
                
                if (s.timer && timerOverlay) {
                    const ts = s.timer;
                    timerOverlay.style.backgroundColor = ts.bgColor || '#000000';
                    timerOverlay.style.borderRadius = ts.borderRadius || '0px';
                    timerOverlay.style.opacity = ts.opacity !== undefined ? ts.opacity : 1;
                    timerOverlay.style.borderWidth = ts.borderWidth || '0px';
                    timerOverlay.style.borderColor = ts.borderColor || '#dc2626';
                    timerOverlay.style.borderStyle = parseInt(ts.borderWidth) > 0 ? 'solid' : 'none';
                    timerOverlay.style.boxShadow = parseInt(ts.shadow) > 0 ? `0 0 ${ts.shadow} rgba(0,0,0,0.5)` : 'none';
                    if (timerDisplayEl) {
                        timerDisplayEl.style.color = ts.textColor || '#dc2626';
                        if (ts.fontFamily) timerDisplayEl.style.fontFamily = ts.fontFamily;
                    }
                }
                if (s.fps && fpsOverlay) {
                    const fs = s.fps;
                    fpsOverlay.style.backgroundColor = fs.bgColor || '#000000';
                    fpsOverlay.style.borderRadius = fs.borderRadius || '4px';
                    fpsOverlay.style.opacity = fs.opacity !== undefined ? fs.opacity : 1;
                    fpsOverlay.style.borderWidth = fs.borderWidth || '0px';
                    fpsOverlay.style.borderColor = fs.borderColor || '#dc2626';
                    fpsOverlay.style.borderStyle = parseInt(fs.borderWidth) > 0 ? 'solid' : 'none';
                    fpsOverlay.style.boxShadow = parseInt(fs.shadow) > 0 ? `0 0 ${fs.shadow} rgba(0,0,0,0.5)` : 'none';
                    const valueEl = fpsOverlay.querySelector('.fps-value');
                    if (valueEl) {
                        valueEl.style.color = fs.textColor || '#dc2626';
                        if (fs.fontFamily) valueEl.style.fontFamily = fs.fontFamily;
                    }
                }
                if (s.keys && keypressOverlay) {
                    const ks = s.keys;
                    keypressOverlay.style.setProperty('--key-bg', ks.bgColor || '#000000');
                    keypressOverlay.style.setProperty('--key-color', ks.textColor || '#dc2626');
                    keypressOverlay.style.setProperty('--key-border', ks.borderColor || '#dc2626');
                    keypressOverlay.style.setProperty('--key-active-bg', ks.activeColor || '#4bc277');
                    keypressOverlay.style.setProperty('--key-active-border', ks.activeColor || '#4bc277');
                    keypressOverlay.style.setProperty('--key-radius', ks.borderRadius || '12px');
                    keypressOverlay.style.setProperty('--key-border-width', ks.borderWidth || '2px');
                    keypressOverlay.style.setProperty('--key-gap', ks.gap || '10px');
                    keypressOverlay.style.opacity = ks.opacity !== undefined ? ks.opacity : 1;
                    
                    const shadowPx = parseInt(ks.shadow) || 0;
                    if (shadowPx > 0) {
                        keypressOverlay.style.setProperty('--key-shadow', `0 ${shadowPx}px ${shadowPx*2}px rgba(0,0,0,0.3)`);
                        keypressOverlay.style.setProperty('--key-active-shadow', `0 ${shadowPx}px ${shadowPx*2}px rgba(75,194,119,0.4)`);
                    } else {
                        keypressOverlay.style.setProperty('--key-shadow', 'none');
                        keypressOverlay.style.setProperty('--key-active-shadow', 'none');
                    }
                    
                    const sizeScale = ks.sizeScale || 1;
                    keypressOverlay.style.setProperty('--key-scale', String(sizeScale));
                    
                    const keys = keypressOverlay.querySelectorAll('.key');
                    const keyContainer = keypressOverlay.querySelector('.key-container');
                    if (keyContainer) {
                        keyContainer.style.gap = `calc(${ks.gap || '10px'} * ${sizeScale})`;
                    }
                    let activeKeyStyle = document.getElementById('key-active-dynamic-style');
                    if (!activeKeyStyle) {
                        activeKeyStyle = document.createElement('style');
                        activeKeyStyle.id = 'key-active-dynamic-style';
                        document.head.appendChild(activeKeyStyle);
                    }
                    const activeColor = ks.activeColor || '#4bc277';
                    activeKeyStyle.textContent = `
                        #key-display-overlay .key.active {
                            background: ${activeColor} !important;
                            border-color: ${activeColor} !important;
                        }
                    `;
                    
                    keys.forEach(key => {
                        key.style.background = ks.bgColor || '#000000';
                        key.style.borderColor = ks.borderColor || '#dc2626';
                        key.style.borderRadius = ks.borderRadius || '12px';
                        key.style.borderWidth = ks.borderWidth || '2px';
                        key.style.borderStyle = 'solid';
                        if (shadowPx > 0) {
                            key.style.boxShadow = `0 ${shadowPx}px ${shadowPx*2}px rgba(0,0,0,0.3)`;
                        } else {
                            key.style.boxShadow = 'none';
                        }
                        const span = key.querySelector('span');
                        if (span) span.style.color = ks.textColor || '#dc2626';
                    });
                }
    }
    (async () => {
        const { advancedStyleV2 } = await chrome.storage.local.get('advancedStyleV2');
        if (advancedStyleV2) {
            applyV2(advancedStyleV2);
            setTimeout(() => applyV2(advancedStyleV2), 500);
        }
    })();
})();
chrome.storage.onChanged.addListener((changes,area)=>{if(area!=="local"){return}
if(Object.prototype.hasOwnProperty.call(changes,"globalVolumeLevel")){currentGlobalVolume=Math.min(1,Math.max(0,changes.globalVolumeLevel.newValue));sendVolumeToPage('EXT_SET_VOLUME',{volume:currentGlobalVolume})}});let blackBarsEnabled=!0;const RESOLUTION_CONFIGS={'608x1080':{width:608,height:1080,indicator:"608×1080 ACTIF"},'890x1080':{width:890,height:1080,indicator:"890×1080 ACTIF"}};let currentResolutionMode=null;(async()=>{const data=await chrome.storage.local.get(["blackBarsEnabled","forcedResolutionMode","verticalResolutionEnabled","barsColor"]);if(data.blackBarsEnabled!==undefined){blackBarsEnabled=data.blackBarsEnabled}
let forcedResolutionMode=data.forcedResolutionMode;if(!forcedResolutionMode&&data.verticalResolutionEnabled){forcedResolutionMode="608x1080"}
const hasPreset=forcedResolutionMode&&RESOLUTION_CONFIGS[forcedResolutionMode];const isCustom=typeof forcedResolutionMode==='string'&&/^\d{2,4}x\d{2,4}$/i.test(forcedResolutionMode||'');if(forcedResolutionMode&&(hasPreset||isCustom)){const resolutionMode=forcedResolutionMode;const barsColor=(typeof data.barsColor==='string'&&data.barsColor)?data.barsColor:'#000000';const applyResolution=()=>{if(document.readyState==="complete"){setTimeout(()=>applyForcedResolution(resolutionMode,blackBarsEnabled,barsColor),500)}else{window.addEventListener("load",()=>{setTimeout(()=>applyForcedResolution(resolutionMode,blackBarsEnabled,barsColor),500)},{once:!0})}};if(document.readyState==="loading"){document.addEventListener('DOMContentLoaded',applyResolution,{once:!0})}else{applyResolution()}}})();function applyForcedResolution(resolutionMode='608x1080',enableBlackBars=!0,barsColor='#000000'){let width,height,indicator;if(RESOLUTION_CONFIGS[resolutionMode]){const cfg=RESOLUTION_CONFIGS[resolutionMode];width=cfg.width;height=cfg.height;indicator=cfg.indicator}else if(typeof resolutionMode==='string'&&/^\d{2,4}x\d{2,4}$/i.test(resolutionMode)){const parts=resolutionMode.toLowerCase().split('x');width=parseInt(parts[0],10);height=parseInt(parts[1],10);if(!Number.isFinite(width)||!Number.isFinite(height)){width=608;height=1080}indicator=`${width}×${height} ACTIF`}else{const cfg=RESOLUTION_CONFIGS['608x1080'];width=cfg.width;height=cfg.height;indicator=cfg.indicator;resolutionMode='608x1080'}log("Application permanente du mode "+resolutionMode);blackBarsEnabled=enableBlackBars;currentResolutionMode=resolutionMode;isResolutionForced=!0;chrome.storage.local.set({blackBarsEnabled:enableBlackBars,verticalResolutionEnabled:resolutionMode==="608x1080",forcedResolutionMode:resolutionMode,selectedResolutionMode:resolutionMode});chrome.runtime.sendMessage({action:"saveResolutionState",active:!0,mode:resolutionMode});let viewportMeta=document.querySelector("meta[name=\"viewport\"]");if(!viewportMeta){viewportMeta=document.createElement("meta");viewportMeta.name="viewport";document.head.appendChild(viewportMeta)}
viewportMeta.content="width="+width+", user-scalable=no";const body=document.body;const docElement=document.documentElement;const timerOverlay=document.getElementById("speedrun-timer-overlay");if(timerOverlay){document.documentElement.appendChild(timerOverlay);timerOverlay.style.position='fixed';timerOverlay.style.zIndex="2147483647"}
body.style.cssText=`
        margin: 0 !important;
        padding: 0 !important;
        width: ${width}px !important;
        min-width: ${width}px !important;
        max-width: ${width}px !important;
        height: ${height}px !important;
        min-height: ${height}px !important;
        overflow: hidden !important;
        position: fixed !important;
        left: 50% !important;
        top: 50% !important;
        transform: translate(-50%, -50%) !important;
        box-sizing: border-box !important;
    `;const backgroundColor=blackBarsEnabled?barsColor:"transparent";docElement.style.cssText=`
        margin: 0 !important;
        padding: 0 !important;
        width: 100vw !important;
        height: 100vh !important;
        overflow: hidden !important;
        background: ${backgroundColor} !important;
        box-sizing: border-box !important;
    `;docElement.style.setProperty("background",backgroundColor,"important");document.body.offsetHeight;docElement.offsetHeight;setTimeout(()=>{window.dispatchEvent(new Event("resize"));document.body.offsetHeight},50);setTimeout(()=>{window.dispatchEvent(new Event("resize"));window.scrollTo(0,0)},150);setTimeout(()=>{window.dispatchEvent(new Event("resize"))},300);setTimeout(()=>{forceResizeToWidth(width)},100);const indicatorDiv=document.createElement('div');indicatorDiv.style.cssText=`
        position: fixed;
        top: 10px;
        left: 50%;
        transform: translateX(-50%);
        background: #44ff44;
        color: black;
        padding: 5px 10px;
        border-radius: 3px;
        font-family: Arial, sans-serif;
        font-size: 12px;
        z-index: 2147483646;
        pointer-events: none;
        opacity: 0.8;
    `;indicatorDiv.textContent=indicator;indicatorDiv.id="resolution-indicator-permanent";document.body.appendChild(indicatorDiv);setTimeout(()=>{if(indicatorDiv&&indicatorDiv.parentNode){indicatorDiv.style.transition="opacity 0.5s";indicatorDiv.style.opacity='0';setTimeout(()=>{if(indicatorDiv&&indicatorDiv.parentNode){indicatorDiv.remove()}},500)}},3000);log("Mode "+resolutionMode+" appliqué de manière permanente")}
function restoreNormalResolution(){log("Restauration de la résolution normale");const body=document.body;const docElement=document.documentElement;body.style.cssText='';docElement.style.cssText='';let viewportMeta=document.querySelector("meta[name=\"viewport\"]");if(viewportMeta){viewportMeta.content="width=device-width, initial-scale=1.0"}
const permanentIndicator=document.getElementById("resolution-indicator-permanent");if(permanentIndicator){permanentIndicator.remove()}
window.dispatchEvent(new Event('resize'));const normalModeIndicator=document.createElement("div");normalModeIndicator.style.cssText=`
        position: fixed;
        top: 10px;
        left: 50%;
        transform: translateX(-50%);
        background: #ff4444;
        color: white;
        padding: 5px 10px;
        border-radius: 3px;
        font-family: Arial, sans-serif;
        font-size: 12px;
        z-index: 2147483646;
        pointer-events: none;
        opacity: 0.8;
    `;normalModeIndicator.textContent="MODE NORMAL";document.body.appendChild(normalModeIndicator);setTimeout(()=>{if(normalModeIndicator&&normalModeIndicator.parentNode){normalModeIndicator.style.transition="opacity 0.5s";normalModeIndicator.style.opacity='0';setTimeout(()=>{if(normalModeIndicator&&normalModeIndicator.parentNode){normalModeIndicator.remove()}},500)}},2000);chrome.storage.local.set({verticalResolutionEnabled:!1});chrome.storage.local.remove("forcedResolutionMode");chrome.runtime.sendMessage({action:'saveResolutionState',active:!1,mode:null});log("Résolution normale restaurée");currentResolutionMode=null;isResolutionForced=!1}
function forceResizeToWidth(width){const allElements=document.querySelectorAll('div, section, main, article, header, footer, img');allElements.forEach(element=>{if(element.id==="speedrun-timer-overlay"){return}
const styles=window.getComputedStyle(element);if(["div","section",'main','article',"header","footer"].includes(element.tagName.toLowerCase())){if(styles.width==="100%"||element.offsetWidth>width){element.style.width="100%";element.style.maxWidth=width+'px'}}
if(element.tagName.toLowerCase()==="img"){element.style.maxWidth='100%';element.style.height="auto"}})}
function activateZqsdDirectly(){if(window.wasdZqsdHandler){log("ZQSD déjà actif");return}
const eventTargets=[document,window,document.activeElement,document.querySelector("canvas")].filter(Boolean);chrome.storage.local.get('zqsdKeys',(data)=>{const zqsdKeys=data.zqsdKeys;const keydownHandler=(event)=>{let key;if(event.code==="Space"||event.key===" "){key="SPACE"}else{key=event.key.toUpperCase()}
let keyMap;if(zqsdKeys){keyMap={[zqsdKeys.up]:["ArrowUp",38],[zqsdKeys.left]:["ArrowLeft",37],[zqsdKeys.down]:["ArrowDown",40],[zqsdKeys.right]:["ArrowRight",39]}}else{keyMap={'W':["ArrowUp",38],'A':["ArrowLeft",37],'S':['ArrowDown',40],'D':["ArrowRight",39],'Z':["ArrowUp",38],'Q':['ArrowLeft',37]}}
if(event.key==='1'){event.preventDefault();event.stopImmediatePropagation();eventTargets.forEach(target=>target.dispatchEvent(new KeyboardEvent(event.type,{key:" ",code:"Space",keyCode:32,which:32,bubbles:!0})));return}
if(event.key===" "&&event.isTrusted){if(currentHotkey==="Space"){event.preventDefault();event.stopImmediatePropagation();controlTimer();return}
const spaceIsMapped=zqsdKeys&&Object.values(zqsdKeys).includes('SPACE');if(!spaceIsMapped){event.preventDefault();event.stopImmediatePropagation();return}}
const mappedKey=keyMap[key];if(mappedKey){event.preventDefault();event.stopImmediatePropagation();eventTargets.forEach(target=>target.dispatchEvent(new KeyboardEvent(event.type,{key:mappedKey[0],code:mappedKey[0],keyCode:mappedKey[1],which:mappedKey[1],bubbles:!0})))}};document.addEventListener("keydown",keydownHandler,!0);document.addEventListener("keyup",keydownHandler,!0);window.wasdZqsdHandler=keydownHandler;zqsdHandler=keydownHandler;log("ZQSD activé automatiquement")})}
let timerColors={'stopped':'#dc2626','running':"#dc2626",'paused':"#dc2626"};chrome.runtime.sendMessage({'action':"getTimerColors"},_0xa8dfbd=>{if(_0xa8dfbd&&_0xa8dfbd.colors){timerColors=_0xa8dfbd.colors;applyTimerColor()}});function applyTimerColor(){if(!timerDisplayEl){return}
let _0x384cac=timerColors.stopped;if(timerState==="running"){_0x384cac=timerColors.running}else{if(timerState==="paused"){_0x384cac=timerColors.paused}}
timerDisplayEl.style.color=_0x384cac}
function applyThemeToTimer(){if(!timerOverlay||!timerDisplayEl){return}
Object.assign(timerOverlay.style,{'background':'#000','border':"none",'borderRadius':'0','boxShadow':"none",'backdropFilter':"none",'padding':'0'});Object.assign(timerDisplayEl.style,{'fontFamily':"'Calibri','Segoe UI',Arial,sans-serif",'fontWeight':"bold",'textShadow':"none",'fontSize':"43px",'letterSpacing':'0','textAlign':"right",'padding':"8px 12px",'lineHeight':'1','position':"relative",'transform':'none','top':"auto",'left':"auto",'width':"100%",'height':"100%",'display':"flex",'alignItems':"center",'justifyContent':"flex-end"});applyTimerColor();const _0x1bf1e5=timerOverlay.getBoundingClientRect();updateFontSize(_0x1bf1e5.width,_0x1bf1e5.height)}
function createTimerOverlay(){if(timerOverlay){return}
timerOverlay=document.createElement("div");timerOverlay.id="speedrun-timer-overlay";timerOverlay.innerHTML="\n        <style>\n            #speedrun-timer-overlay{position:fixed;top:20px;right:20px;width:225px;height:50px;z-index:2147483647;display:none;user-select:none;min-width:180px;min-height:40px;max-width:800px;max-height:200px;overflow:hidden;background:#000;border:none;box-shadow:none;border-radius:0}\n            #timer-content{width:100%;height:100%;position:relative;cursor:move}\n            #timer-display{font-family:'Calibri','Segoe UI',Arial,sans-serif;font-weight:bold;font-size:43px;letter-spacing:0;line-height:1;color:#FFF;text-shadow:none;white-space:nowrap;display:flex;align-items:baseline;justify-content:flex-end;width:100%;height:100%;padding:8px 12px;box-sizing:border-box;position:relative}\n            #timer-display .time-main{font-size:1em;line-height:1;display:inline-block}\n            #timer-display .time-decimals{font-size:.7em;line-height:1;display:inline-block;transform:translateY(0.12em)}\n            .timer-stopped,.timer-running,.timer-paused{color:#FFF}\n            .resize-handle{position:absolute;background:transparent;z-index:2147483648;opacity:0;transition:opacity .2s}\n            #speedrun-timer-overlay:hover .resize-handle{opacity:.3;background:rgba(255,255,255,.1)}\n            .resize-handle:hover{opacity:.6!important;background:rgba(255,255,255,.2)!important}\n            .resize-nw{top:0;left:0;width:12px;height:12px;cursor:nw-resize}\n            .resize-ne{top:0;right:0;width:12px;height:12px;cursor:ne-resize}\n            .resize-sw{bottom:0;left:0;width:12px;height:12px;cursor:sw-resize}\n            .resize-se{bottom:0;right:0;width:12px;height:12px;cursor:se-resize}\n            .resize-n{top:0;left:12px;right:12px;height:8px;cursor:n-resize}\n            .resize-s{bottom:0;left:12px;right:12px;height:8px;cursor:s-resize}\n            .resize-w{left:0;top:12px;bottom:12px;width:8px;cursor:w-resize}\n            .resize-e{right:0;top:12px;bottom:12px;width:8px;cursor:e-resize}\n            .size-indicator{position:absolute;top:-35px;right:0;background:rgba(0,0,0,.9);color:#FFF;padding:6px 12px;font-size:12px;opacity:0;pointer-events:none;font-family:'Segoe UI',Arial,sans-serif;font-weight:400;transition:opacity .2s;border-radius:3px}\n            #speedrun-timer-overlay.resizing .size-indicator{opacity:1}\n        </style>\n        <div id=\"timer-content\">\n            <div id=\"timer-display\" class=\"timer-stopped\">\n                <span class=\"time-main\">0</span><span class=\"time-decimals\">.00</span>\n            </div>\n        </div>\n        <div class=\"resize-handle resize-nw\" data-direction=\"nw\"></div>\n        <div class=\"resize-handle resize-ne\" data-direction=\"ne\"></div>\n        <div class=\"resize-handle resize-sw\" data-direction=\"sw\"></div>\n        <div class=\"resize-handle resize-se\" data-direction=\"se\"></div>\n        <div class=\"resize-handle resize-n\" data-direction=\"n\"></div>\n        <div class=\"resize-handle resize-s\" data-direction=\"s\"></div>\n        <div class=\"resize-handle resize-w\" data-direction=\"w\"></div>\n        <div class=\"resize-handle resize-e\" data-direction=\"e\"></div>\n        <div class=\"size-indicator\">225px × 50px</div>\n    ";timerDisplayEl=timerOverlay.querySelector("#timer-display");timerMainEl=timerDisplayEl?timerDisplayEl.querySelector(".time-main"):null;timerDecimalsEl=timerDisplayEl?timerDisplayEl.querySelector('.time-decimals'):null;lastTimerMain=timerMainEl?timerMainEl.textContent:'';lastTimerDecimals=timerDecimalsEl?timerDecimalsEl.textContent:'';document.documentElement.appendChild(timerOverlay);applyCustomBackground(timerOverlay,storedCustomBackground);applyThemeToTimer();makeDraggable(timerOverlay);makeResizable(timerOverlay);loadSettings()}
function initializeOverlays(){createTimerOverlay();createFpsOverlay()}
if(document.readyState==="loading"){document.addEventListener('DOMContentLoaded',initializeOverlays)}else{initializeOverlays()}
function loadSettings(){chrome.runtime.sendMessage({'action':"getTimerSettings"},_0x2a3e2a=>{if(_0x2a3e2a&&_0x2a3e2a.settings){const _0x392ab7=_0x2a3e2a.settings;if(_0x392ab7.visible){if(!timerOverlay)createTimerOverlay();timerOverlay.style.left=_0x392ab7.position.x+'px';timerOverlay.style.top=_0x392ab7.position.y+'px';timerOverlay.style.width=_0x392ab7.size.width+'px';timerOverlay.style.height=_0x392ab7.size.height+'px';updateFontSize(_0x392ab7.size.width,_0x392ab7.size.height);isVisible=!0;timerOverlay.style.display="block"}}})}
function createThrottledInvoker(_0x4361c0,_0x58d326=0xb4){let _0x3ae6c3=null;return{'trigger'(){if(_0x3ae6c3!==null){return}
_0x3ae6c3=setTimeout(()=>{_0x3ae6c3=null;_0x4361c0()},_0x58d326)},'flush'(){if(_0x3ae6c3!==null){clearTimeout(_0x3ae6c3);_0x3ae6c3=null}
_0x4361c0()}}}
function makeDraggable(_0x2de955,_0x52ae3d={}){let _0x37da2d=0x0;let _0x5bb844=0x0;let _0x792d4d=0x0;let _0x219d1f=0x0;let _0x327eeb=!1;const _0x5ec8c3=typeof _0x52ae3d.onChange==="function"?_0x52ae3d.onChange:saveTimerSettings;const _0x3d9c49=createThrottledInvoker(_0x5ec8c3);_0x2de955.addEventListener("mousedown",_0x39e140);function _0x39e140(_0xe20437){if(_0xe20437.target.classList.contains("resize-handle")){return}
_0xe20437.preventDefault();_0x327eeb=!0;_0x792d4d=_0xe20437.clientX;_0x219d1f=_0xe20437.clientY;document.addEventListener("mousemove",_0x5d6490);document.addEventListener("mouseup",_0x81e50e)}
function _0x5d6490(_0x5aa04a){if(!_0x327eeb){return}
_0x5aa04a.preventDefault();_0x37da2d=_0x792d4d-_0x5aa04a.clientX;_0x5bb844=_0x219d1f-_0x5aa04a.clientY;_0x792d4d=_0x5aa04a.clientX;_0x219d1f=_0x5aa04a.clientY;const _0x3effd1=Math.max(0x0,Math.min((_0x2de955.offsetLeft||0x0)-_0x37da2d,window.innerWidth-_0x2de955.offsetWidth));const _0x41180f=Math.max(0x0,Math.min((_0x2de955.offsetTop||0x0)-_0x5bb844,window.innerHeight-_0x2de955.offsetHeight));_0x2de955.style.left=_0x3effd1+'px';_0x2de955.style.top=_0x41180f+'px';_0x3d9c49.trigger()}
function _0x81e50e(){_0x327eeb=!1;document.removeEventListener("mousemove",_0x5d6490);document.removeEventListener("mouseup",_0x81e50e);_0x3d9c49.flush()}}
function makeResizable(_0x59d0f9){const _0x207d1f=_0x59d0f9.querySelectorAll(".resize-handle");const _0x14f677=_0x59d0f9.querySelector('.size-indicator');let _0x48c843=!1;let _0x29f3a9='';let _0x54f7ff=0x0;let _0x590331=0x0;let _0x4f51ab=0x0;let _0x548243=0x0;let _0x38c6df=0x0;let _0xb24c26=0x0;_0x207d1f.forEach(_0x10bf0d=>_0x10bf0d.addEventListener("mousedown",_0x2e1220));function _0x2e1220(_0x19ccb8){_0x19ccb8.preventDefault();_0x19ccb8.stopPropagation();_0x48c843=!0;_0x29f3a9=_0x19ccb8.target.dataset.direction;_0x54f7ff=_0x19ccb8.clientX;_0x590331=_0x19ccb8.clientY;const _0x4918b4=_0x59d0f9.getBoundingClientRect();_0x4f51ab=_0x4918b4.width;_0x548243=_0x4918b4.height;_0x38c6df=_0x4918b4.left;_0xb24c26=_0x4918b4.top;_0x59d0f9.classList.add('resizing');document.addEventListener("mousemove",_0x46a4c1);document.addEventListener("mouseup",_0x21612e)}
function _0x46a4c1(_0x3b0802){if(!_0x48c843){return}
_0x3b0802.preventDefault();const _0x268f6c=_0x3b0802.clientX-_0x54f7ff;const _0x35abea=_0x3b0802.clientY-_0x590331;let _0x4e0923=_0x4f51ab;let _0x934ad3=_0x548243;let _0x2f9168=_0x38c6df;let _0x1b5a15=_0xb24c26;if(_0x29f3a9.includes('e')){_0x4e0923=Math.max(0xb4,Math.min(0x320,_0x4f51ab+_0x268f6c))}
if(_0x29f3a9.includes('w')){_0x4e0923=Math.max(0xb4,Math.min(0x320,_0x4f51ab-_0x268f6c));_0x2f9168=_0x38c6df+(_0x4f51ab-_0x4e0923)}
if(_0x29f3a9.includes('s')){_0x934ad3=Math.max(0x28,Math.min(0xc8,_0x548243+_0x35abea))}
if(_0x29f3a9.includes('n')){_0x934ad3=Math.max(0x28,Math.min(0xc8,_0x548243-_0x35abea));_0x1b5a15=_0xb24c26+(_0x548243-_0x934ad3)}
_0x59d0f9.style.width=_0x4e0923+'px';_0x59d0f9.style.height=_0x934ad3+'px';_0x59d0f9.style.left=_0x2f9168+'px';_0x59d0f9.style.top=_0x1b5a15+'px';updateFontSize(_0x4e0923,_0x934ad3);_0x14f677.textContent=Math.round(_0x4e0923)+"px × "+Math.round(_0x934ad3)+'px';_0x14f677.style.opacity='1'}
function _0x21612e(){if(!_0x48c843){return}
_0x48c843=!1;document.removeEventListener("mousemove",_0x46a4c1);document.removeEventListener("mouseup",_0x21612e);_0x59d0f9.classList.remove("resizing");_0x14f677.style.opacity='0';saveTimerSettings()}}
function updateFpsFontSize(width,height){if(!fpsOverlay)return;const valueElement=fpsOverlay.querySelector(".fps-value");const labelElement=fpsOverlay.querySelector(".fps-label");if(!valueElement||!labelElement)return;const baseWidth=120;const baseHeight=70;const widthRatio=width/baseWidth;const heightRatio=height/baseHeight;const scale=Math.min(widthRatio,heightRatio);const baseValueSize=36;const baseLabelSize=10;valueElement.style.fontSize=`${Math.max(12, baseValueSize * scale)}px`;labelElement.style.fontSize=`${Math.max(6, baseLabelSize * scale)}px`}
function makeFpsResizable(element){const handles=element.querySelectorAll(".resize-handle");const sizeIndicator=element.querySelector('.size-indicator');let isResizing=!1;let resizeDirection='';let startX=0,startY=0;let startWidth=0,startHeight=0;let startLeft=0,startTop=0;handles.forEach(handle=>handle.addEventListener("mousedown",startResize));function startResize(e){e.preventDefault();e.stopPropagation();isResizing=!0;resizeDirection=e.target.dataset.direction;startX=e.clientX;startY=e.clientY;const rect=element.getBoundingClientRect();startWidth=rect.width;startHeight=rect.height;startLeft=rect.left;startTop=rect.top;element.classList.add('resizing');document.addEventListener("mousemove",performResize);document.addEventListener("mouseup",stopResize)}
function performResize(e){if(!isResizing)return;e.preventDefault();const deltaX=e.clientX-startX;const deltaY=e.clientY-startY;let newWidth=startWidth;let newHeight=startHeight;let newLeft=startLeft;let newTop=startTop;if(resizeDirection.includes('e'))newWidth=Math.max(100,startWidth+deltaX);if(resizeDirection.includes('w')){newWidth=Math.max(100,startWidth-deltaX);newLeft=startLeft+(startWidth-newWidth)}
if(resizeDirection.includes('s'))newHeight=Math.max(50,startHeight+deltaY);if(resizeDirection.includes('n')){newHeight=Math.max(50,startHeight-deltaY);newTop=startTop+(startHeight-newHeight)}
element.style.width=`${newWidth}px`;element.style.height=`${newHeight}px`;element.style.left=`${newLeft}px`;element.style.top=`${newTop}px`;updateFpsFontSize(newWidth,newHeight);if(sizeIndicator){sizeIndicator.textContent=`${Math.round(newWidth)}px × ${Math.round(newHeight)}px`;sizeIndicator.style.opacity='1'}}
function stopResize(){if(!isResizing)return;isResizing=!1;document.removeEventListener("mousemove",performResize);document.removeEventListener("mouseup",stopResize);element.classList.remove("resizing");if(sizeIndicator)sizeIndicator.style.opacity='0';saveFpsSettings()}}
function updateFontSize(width,height){if(!timerDisplayEl){return}
const widthRatio=width/225;const heightRatio=height/50;const scale=Math.min(widthRatio,heightRatio);const fontSize=Math.max(18,Math.min(120,43*scale));timerDisplayEl.style.fontSize=fontSize+'px';timerDisplayEl.style.letterSpacing="0px";timerDisplayEl.style.lineHeight='1';timerDisplayEl.style.padding="8px 12px";timerDisplayEl.style.textAlign="right";if(timerDecimalsEl){timerDecimalsEl.style.fontSize='0.7em'}}
function saveTimerSettings(){if(!timerOverlay){return}
const rect=timerOverlay.getBoundingClientRect();chrome.runtime.sendMessage({action:"saveTimerSettings",position:{x:Math.round(rect.left),y:Math.round(rect.top)},size:{width:Math.round(rect.width),height:Math.round(rect.height)},visible:isVisible})}
function applyCustomBackground(element,imageDataUrl){if(!element)return;if(element.id==='key-display-overlay'){const keys=element.querySelectorAll('.key');if(imageDataUrl){keys.forEach(key=>{key.style.setProperty('background-image',`url(${imageDataUrl})`);key.style.setProperty('background-size','100% 100%');key.style.setProperty('background-color','transparent','important');key.style.setProperty('border','1px solid rgba(255, 255, 255, 0.3)')});element.style.setProperty('background','transparent','important')}else{keys.forEach(key=>{key.style.removeProperty('background-image');key.style.removeProperty('background-attachment');key.style.removeProperty('background-size');key.style.removeProperty('background-color');key.style.removeProperty('border')})}
return}
if(imageDataUrl){element.style.setProperty('background-image',`url(${imageDataUrl})`,'important');element.style.setProperty('background-size','100% 100%','important');element.style.setProperty('background-position','center','important');element.style.setProperty('background-repeat','no-repeat','important');element.style.setProperty('background-color','rgba(0,0,0,0.7)','important')}else{element.style.removeProperty('background-image');element.style.removeProperty('background-size');element.style.removeProperty('background-position');element.style.removeProperty('background-repeat');if(element.id==='fps-monitor-overlay'){element.style.setProperty('background-color','rgba(0, 0, 0, 1.0)','important')}else if(element.id==='speedrun-timer-overlay'){element.style.setProperty('background','#000')}else{element.style.removeProperty('background-color')}}}(async()=>{const{customBackground}=await chrome.storage.local.get('customBackground');if(customBackground){storedCustomBackground=customBackground;if(timerOverlay)applyCustomBackground(timerOverlay,storedCustomBackground);if(fpsOverlay)applyCustomBackground(fpsOverlay,storedCustomBackground);if(keypressOverlay)applyCustomBackground(keypressOverlay,storedCustomBackground);}})();function setTimerText(mainPart,decimalPart){if(!timerMainEl||!timerDecimalsEl){return}
if(lastTimerMain!==mainPart){timerMainEl.textContent=mainPart;lastTimerMain=mainPart}
if(lastTimerDecimals!==decimalPart){timerDecimalsEl.textContent=decimalPart;lastTimerDecimals=decimalPart}}
function formatTime(ms){const totalSeconds=Math.floor(ms/1000);const hours=Math.floor(totalSeconds/3600);const minutes=Math.floor((totalSeconds%3600)/60);const seconds=totalSeconds%60;const centiseconds=Math.floor((ms%1000)/10);const decimalPart=centiseconds.toString().padStart(2,'0');const mainPart=hours>0?`${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`:minutes>0?`${minutes}:${seconds.toString().padStart(2, '0')}`:`${seconds}`;return{mainPart,decimalPart}}
const rankTiers = [
    { name: "Interstellar", minTime: 90 * 60 * 1000 },
    { name: "Suprême", minTime: 73 * 60 * 1000 },
    { name: "Grand Champion", minTime: 55 * 60 * 1000 },
    { name: "Champion", minTime: 47 * 60 * 1000 },
    { name: "Grand Master", minTime: 41 * 60 * 1000 },
    { name: "Master +", minTime: 35 * 60 * 1000 },
    { name: "Master", minTime: 28 * 60 * 1000 },
    { name: "Élite", minTime: (23 * 60 * 1000) + 1000 },
    { name: "Diamant 3", minTime: 23 * 60 * 1000 },
    { name: "Diamant 2", minTime: 19 * 60 * 1000 },
    { name: "Diamant 1", minTime: (15 * 60 * 1000) + 1000 },
    { name: "Platine 3", minTime: 15 * 60 * 1000 },
    { name: "Platine 2", minTime: 12 * 60 * 1000 },
    { name: "Platine 1", minTime: (9 * 60 * 1000) + 1000 },
    { name: "Gold 3", minTime: 9 * 60 * 1000 },
    { name: "Gold 2", minTime: 7 * 60 * 1000 },
    { name: "Gold 1", minTime: 5 * 60 * 1000 },
    { name: "Argent 3", minTime: 4 * 60 * 1000 },
    { name: "Argent 2", minTime: 3 * 60 * 1000 },
    { name: "Argent 1", minTime: 2 * 60 * 1000 },
    { name: "Bronze 3", minTime: 90 * 1000 },
    { name: "Bronze 2", minTime: 60 * 1000 },
    { name: "Bronze 1", minTime: 30 * 1000 },
    { name: "Unranked", minTime: 0 }
].sort((a,b)=>b.minTime-a.minTime);
function updateRank(time){if(!timerOverlay)return;let rankDisplay=timerOverlay.querySelector("#rank-display");if(!rankDisplay){rankDisplay=document.createElement("div");rankDisplay.id="rank-display";Object.assign(rankDisplay.style,{color:"#fff",fontSize:"16px",fontWeight:"bold",position:"absolute",top:"-20px",left:"0px",textShadow:"1px 1px 2px rgba(0,0,0,0.7)",zIndex:"1"});const timerContent=timerOverlay.querySelector("#timer-content");if(timerContent)timerContent.insertBefore(rankDisplay,timerContent.firstChild)}if(!rankDisplay)return;const currentRank=rankTiers.find(rank=>time>=rank.minTime);rankDisplay.textContent=currentRank?currentRank.name:""}
function updateTimer(){if(!timerOverlay||!isVisible||timerState!=="running"){return}
if(!timerMainEl||!timerDecimalsEl){return}
currentTime=performance.now()-startTime;updateRank(currentTime);const{mainPart,decimalPart}=formatTime(currentTime);setTimerText(mainPart,'.'+decimalPart)}
function controlTimer(){if(!isVisible||!timerDisplayEl){return}
if(timerState==="stopped"){startTime=performance.now();currentTime=0;timerState="running";timerDisplayEl.className="timer-running";applyTimerColor();setTimerText('0',".00");const update=()=>{if(timerState==="running"){updateTimer();timerInterval=requestAnimationFrame(update)}};timerInterval=requestAnimationFrame(update)}else if(timerState==='running'){cancelAnimationFrame(timerInterval);timerInterval=null;currentTime=performance.now()-startTime;timerState="paused";timerDisplayEl.className="timer-paused";applyTimerColor();const{mainPart,decimalPart}=formatTime(currentTime);setTimerText(mainPart,'.'+decimalPart)}else{cancelAnimationFrame(timerInterval);timerInterval=null;timerState="stopped";currentTime=0;timerDisplayEl.className="timer-stopped";applyTimerColor();setTimerText('0',".00")}}
function toggleTimerVisibility(){if(!timerOverlay){createTimerOverlay()}
isVisible=!isVisible;timerOverlay.style.display=isVisible?'block':"none";if(isVisible){if(timerState==='running'){updateTimer()}else{const time=timerState==='paused'?currentTime:0;const{mainPart,decimalPart}=formatTime(time);setTimerText(mainPart,'.'+decimalPart)}}
saveTimerSettings()}
function ensureFpsStyles(){let styleSheet=document.getElementById("fps-monitor-styles");if(!styleSheet){styleSheet=document.createElement("style");styleSheet.id="fps-monitor-styles";document.head.appendChild(styleSheet)}
const newContent=`
        #fps-monitor-overlay {
            position: fixed !important;
            top: 100px;
            left: 20px;
            min-width: 120px;
            padding: 12px 16px;
            z-index: 2147483647 !important;
            display: none;
            flex-direction: column;
            gap: 4px;
            cursor: move !important;
            user-select: none;
            transition: none;
            background-color: rgba(0, 0, 0, 1.0) !important;
            border: none;
            box-shadow: none;
            color: #dc2626;
            border-radius: 4px;
            overflow: hidden;
        }
        #fps-monitor-overlay:active {
            cursor: grabbing !important;
        }
        #fps-monitor-overlay .fps-label {
            text-transform: uppercase;
            font-size: 10px;
            font-weight: 700;
            letter-spacing: 1.5px;
            color: #CCCCCC;
            opacity: 0.8;
            pointer-events: none;
        }
        #fps-monitor-overlay .fps-value {
            font-size: 36px;
            font-weight: 900;
            line-height: 1;
            transition: color 0.2s ease;
            pointer-events: none;
        }
        #fps-monitor-overlay .fps-value.high { color: #dc2626; }
        #fps-monitor-overlay .fps-value.medium { color: #DDDDDD; }
        #fps-monitor-overlay .fps-value.low { 
            color: #BBBBBB;
        }
        .resize-handle{position:absolute;background:transparent;z-index:2147483648;opacity:0;transition:opacity .2s}
        #fps-monitor-overlay:hover .resize-handle{opacity:.3;background:rgba(255,255,255,.1)}
        .resize-handle:hover{opacity:.6!important;background:rgba(255,255,255,.2)!important}
        .resize-nw{top:0;left:0;width:12px;height:12px;cursor:nw-resize}
        .resize-ne{top:0;right:0;width:12px;height:12px;cursor:ne-resize}
        .resize-sw{bottom:0;left:0;width:12px;height:12px;cursor:sw-resize}
        .resize-se{bottom:0;right:0;width:12px;height:12px;cursor:se-resize}
        .resize-n{top:0;left:12px;right:12px;height:8px;cursor:n-resize}
        .resize-s{bottom:0;left:12px;right:12px;height:8px;cursor:s-resize}
        .resize-w{left:0;top:12px;bottom:12px;width:8px;cursor:w-resize}
        .resize-e{right:0;top:12px;bottom:12px;width:8px;cursor:e-resize}
        .size-indicator{position:absolute;bottom:calc(100% + 5px);left:50%;transform:translateX(-50%);background:rgba(0,0,0,.7);color:#fff;padding:4px 8px;border-radius:4px;font-size:12px;white-space:nowrap;opacity:0;transition:opacity .2s;pointer-events:none;z-index:2147483649}
        #fps-monitor-overlay.resizing .size-indicator{opacity:1}
    `;if(styleSheet.textContent!==newContent){styleSheet.textContent=newContent}}
function createFpsOverlay(){if(fpsOverlay){return}
ensureFpsStyles();fpsOverlay=document.createElement("div");fpsOverlay.id="fps-monitor-overlay";fpsOverlay.innerHTML=`
        <div class="fps-label">Frames per second</div>
        <div class="fps-value">--</div>
        <div class="resize-handle resize-nw" data-direction="nw"></div>
        <div class="resize-handle resize-ne" data-direction="ne"></div>
        <div class="resize-handle resize-sw" data-direction="sw"></div>
        <div class="resize-handle resize-se" data-direction="se"></div>
        <div class="resize-handle resize-n" data-direction="n"></div>
        <div class="resize-handle resize-s" data-direction="s"></div>
        <div class="resize-handle resize-w" data-direction="w"></div>
        <div class="resize-handle resize-e" data-direction="e"></div>
        <div class="size-indicator"></div>
    `;document.documentElement.appendChild(fpsOverlay);chrome.storage.local.get('customBackground',({customBackground})=>{if(customBackground){storedCustomBackground=customBackground;applyCustomBackground(fpsOverlay,customBackground)}});makeDraggable(fpsOverlay,{onChange:saveFpsSettings});makeFpsResizable(fpsOverlay);applyFpsSettings()}
function applyFpsSettings(){if(!fpsOverlay){return}
const position=fpsSettings.position||{x:20,y:100};fpsOverlay.style.left=(typeof position.x==='number'?position.x:20)+'px';fpsOverlay.style.top=(typeof position.y==='number'?position.y:100)+'px';fpsOverlay.style.display=fpsVisible?"flex":"none";if(fpsVisible){startFpsLoop()}else{stopFpsLoop();updateFpsDisplay(null)}}
function toggleFpsOverlay(){if(!fpsOverlay){createFpsOverlay()}
fpsVisible=!fpsVisible;fpsSettings.visible=fpsVisible;fpsOverlay.style.display=fpsVisible?'flex':'none';if(fpsVisible){startFpsLoop()}else{stopFpsLoop();updateFpsDisplay(null)}
saveFpsSettings();return fpsVisible}
function startFpsLoop(){if(fpsAnimationId){return}
fpsLastTimestamp=null;fpsSamples=[];let frameCount=0;const loop=(timestamp)=>{if(!fpsVisible){fpsAnimationId=null;return}
if(fpsLastTimestamp!==null){const deltaTime=timestamp-fpsLastTimestamp;if(deltaTime>0){const fps=1000/deltaTime;fpsSamples.push(fps);if(fpsSamples.length>30){fpsSamples.shift()}
frameCount++;if(frameCount%5===0){const sum=fpsSamples.reduce((a,b)=>a+b,0);const avg=sum/fpsSamples.length;updateFpsDisplay(avg)}}}
fpsLastTimestamp=timestamp;fpsAnimationId=requestAnimationFrame(loop)};fpsAnimationId=requestAnimationFrame(loop)}
function stopFpsLoop(){if(fpsAnimationId){cancelAnimationFrame(fpsAnimationId);fpsAnimationId=null}
fpsLastTimestamp=null;fpsSamples=[]}
function updateFpsDisplay(fps){if(!fpsOverlay){return}
const valueElement=fpsOverlay.querySelector(".fps-value");if(!valueElement){return}
valueElement.classList.remove("low","medium","high");if(typeof fps!=="number"||!isFinite(fps)){valueElement.textContent='--';valueElement.classList.add("medium");return}
const roundedFps=Math.max(0,Math.round(fps));valueElement.textContent=roundedFps.toString();if(roundedFps>=55){valueElement.classList.add("high")}else if(roundedFps>=30){valueElement.classList.add("medium")}else{valueElement.classList.add("low")}}
function saveFpsSettings(){if(!fpsOverlay){return}
if(fpsOverlay.style.display!=='none'){const rect=fpsOverlay.getBoundingClientRect();fpsSettings.position={x:Math.round(rect.left),y:Math.round(rect.top)};fpsSettings.size={width:Math.round(rect.width),height:Math.round(rect.height)}}
chrome.runtime.sendMessage({action:"saveFpsSettings",position:fpsSettings.position,size:fpsSettings.size,visible:fpsVisible},()=>{})}
const KEY_LAYOUTS={'arrows':{'rows':[[{'id':'key-up','label':'↑','matches':["arrowup"]}],[{'id':'key-left','label':'←','matches':["arrowleft"]},{'id':'key-down','label':'↓','matches':['arrowdown']},{'id':"key-right",'label':'→','matches':["arrowright"]}]]},'wasd':{'rows':[[{'id':"key-up",'label':'W','matches':['w',"keyw",'z',"keyz","arrowup"]}],[{'id':"key-left",'label':'A','matches':['a',"keya",'q',"keyq","arrowleft"]},{'id':"key-down",'label':'S','matches':['s','keys',"arrowdown"]},{'id':'key-right','label':'D','matches':['d',"keyd","arrowright"]}]]},'zqsd':{'rows':[[{'id':"key-up",'label':'Z','matches':['z',"keyz",'w','keyw',"arrowup"]}],[{'id':"key-left",'label':'Q','matches':['q',"keyq",'a',"keya",'arrowleft']},{'id':"key-down",'label':'S','matches':['s',"keys","arrowdown"]},{'id':"key-right",'label':'D','matches':['d',"keyd","arrowright"]}]]}};const KEY_THEMES={'default':{'label':"Default"},'classic':{'label':"Classique"},'minimal':{'label':"Minimal Verre"},'block':{'label':"Bloc Mécanique"},'block-white':{'label':"Bloc Blanc"},'retro':{'label':"Retro Terminal"}};const LEGACY_THEME_MAP={'neon':"block",'ocean':'classic','sunset':"retro",'frost':"minimal",'carbon':'block','cyber':'classic','pastel':"minimal",'circular':"classic",'capsule':"classic",'holo':'classic','split':"classic"};function resolveThemeKey(theme){if(!theme){return"default"}
const themeKey=typeof theme==="string"?theme.toLowerCase():"default";if(Object.prototype.hasOwnProperty.call(KEY_THEMES,themeKey)){return themeKey}
const mappedTheme=LEGACY_THEME_MAP[themeKey];if(mappedTheme&&Object.prototype.hasOwnProperty.call(KEY_THEMES,mappedTheme)){return mappedTheme}
return"default"}
function normalizeKeyValue(value){if(!value){return''}
return value.toLowerCase()}
function clampKeypressScale(scale){const numScale=typeof scale==='number'?scale:parseFloat(scale);if(Number.isNaN(numScale)){return 1}
return Math.min(1.6,Math.max(0.6,numScale))}
function getKeypressSizePercent(scale=keypressSettings.size){const numScale=typeof scale==="number"?scale:keypressSettings.size;return Math.round(Math.min(1.6,Math.max(0.6,numScale))*100)}
function updateKeypressSizeIndicator(scale){if(!keySizeIndicator){return}
keySizeIndicator.textContent=getKeypressSizePercent(scale)+'%'}
function persistKeypressSettings(newSettings={}){const validLayouts=Object.keys(KEY_LAYOUTS);const layout=typeof newSettings.layout==="string"?newSettings.layout.toLowerCase():keypressSettings.layout;let newLayout=validLayouts.includes(layout)?layout:keypressSettings.layout;const newSize=typeof newSettings.size==="number"?clampKeypressScale(newSettings.size):keypressSettings.size;const newVisibility=typeof newSettings.visible==="boolean"?newSettings.visible:keypressSettings.visible;const theme=typeof newSettings.theme==="string"?newSettings.theme:keypressSettings.theme;const newTheme=resolveThemeKey(theme);let newPosition=keypressSettings.position;if(newSettings.position&&typeof newSettings.position==='object'){const x=Number(newSettings.position.x);const y=Number(newSettings.position.y);if(Number.isFinite(x)&&Number.isFinite(y)){newPosition={x:Math.round(x),y:Math.round(y)}}}
const settingsToSave={action:'saveKeypressSettings',visible:newVisibility,size:newSize,layout:newLayout,theme:newTheme,position:newPosition?{x:newPosition.x,y:newPosition.y}:null};const positionsAreEqual=(pos1,pos2)=>{if(!pos1&&!pos2){return!0}
if(!pos1||!pos2){return!1}
return pos1.x===pos2.x&&pos1.y===pos2.y};if(lastSavedKeypressSettings.visible===settingsToSave.visible&&lastSavedKeypressSettings.size===settingsToSave.size&&lastSavedKeypressSettings.layout===settingsToSave.layout&&lastSavedKeypressSettings.theme===settingsToSave.theme&&positionsAreEqual(lastSavedKeypressSettings.position,settingsToSave.position)){return}
lastSavedKeypressSettings={visible:settingsToSave.visible,size:settingsToSave.size,layout:settingsToSave.layout,theme:settingsToSave.theme,position:settingsToSave.position?{x:settingsToSave.position.x,y:settingsToSave.position.y}:null};keypressSettings.visible=settingsToSave.visible;keypressSettings.size=settingsToSave.size;keypressSettings.layout=settingsToSave.layout;keypressSettings.theme=settingsToSave.theme;keypressSettings.position=settingsToSave.position?{x:settingsToSave.position.x,y:settingsToSave.position.y}:null;chrome.runtime.sendMessage(settingsToSave,()=>{})}
function ensureKeypressResizeElements(){if(!keypressOverlay){return}
if(!keyResizeHandle){keyResizeHandle=document.createElement("div");keyResizeHandle.className='key-resize-handle';keypressOverlay.appendChild(keyResizeHandle)}
if(!keySizeIndicator){keySizeIndicator=document.createElement('div');keySizeIndicator.className="key-size-indicator";keypressOverlay.appendChild(keySizeIndicator)}
updateKeypressSizeIndicator();if(!keyResizeHandle.dataset.bound){keyResizeHandle.addEventListener("mousedown",startKeyResize);keyResizeHandle.dataset.bound='true'}}
function getKeypressOverlayRect(){if(!keypressOverlay){return{left:0,top:0,right:0,bottom:0,width:0,height:0}}
const styles=window.getComputedStyle(keypressOverlay);let restoreStyles=null;if(styles.display==="none"){const originalDisplay=keypressOverlay.style.display;const originalVisibility=keypressOverlay.style.visibility;keypressOverlay.style.visibility="hidden";keypressOverlay.style.display="block";restoreStyles=()=>{keypressOverlay.style.display=originalDisplay;keypressOverlay.style.visibility=originalVisibility}}
const rect=keypressOverlay.getBoundingClientRect();if(restoreStyles){restoreStyles()}
return rect}
function computeDefaultKeypressPosition(rect){const overlayRect=rect||getKeypressOverlayRect();const overlayWidth=overlayRect.width||180;const overlayHeight=overlayRect.height||180;const x=Math.max(10,Math.round(window.innerWidth-overlayWidth-30));const y=Math.max(10,Math.round(window.innerHeight-overlayHeight-30));return{x,y}}
function applyKeypressPosition(position){if(!keypressOverlay){return}
const rect=getKeypressOverlayRect();const overlayWidth=rect.width||keypressOverlay.offsetWidth||0;const overlayHeight=rect.height||keypressOverlay.offsetHeight||0;const winWidth=window.innerWidth;const winHeight=window.innerHeight;let newPos=null;if(position&&Number.isFinite(position.x)&&Number.isFinite(position.y)){newPos={x:position.x,y:position.y}}else{newPos=computeDefaultKeypressPosition(rect)}
const finalPos={x:Math.max(0,Math.min(winWidth-overlayWidth,newPos.x)),y:Math.max(0,Math.min(winHeight-overlayHeight,newPos.y))};keypressOverlay.style.left=Math.round(finalPos.x)+'px';keypressOverlay.style.top=Math.round(finalPos.y)+'px';keypressOverlay.style.right="auto";keypressOverlay.style.bottom='auto';keypressOverlay.style.transform='none';keypressSettings.position={...finalPos}}
function saveKeypressPosition(){if(!keypressOverlay){return}
let x=parseFloat(keypressOverlay.style.left);let y=parseFloat(keypressOverlay.style.top);if(!Number.isFinite(x)||!Number.isFinite(y)){const rect=getKeypressOverlayRect();if(!Number.isFinite(x)){x=rect.left}
if(!Number.isFinite(y)){y=rect.top}}
if(!Number.isFinite(x)||!Number.isFinite(y)){return}
const position={x:Math.max(0,Math.round(x)),y:Math.max(0,Math.round(y))};keypressSettings.position={...position};persistKeypressSettings({position})}
function applyKeypressTheme(theme){if(!keypressOverlay){return}
const themeKey=resolveThemeKey(theme);Object.keys(KEY_THEMES).forEach(key=>{keypressOverlay.classList.toggle("key-theme-"+key,key===themeKey)});keypressOverlay.dataset.theme=themeKey}
function setKeypressTheme(theme,options={}){const newTheme=resolveThemeKey(theme);const changed=keypressSettings.theme!==newTheme;keypressSettings.theme=newTheme;if(keypressOverlay){applyKeypressTheme(newTheme)}
if(options.persist&&changed){persistKeypressSettings({theme:newTheme})}
return newTheme}
function startKeyResize(_0x5d8143){if(!keypressOverlay){return}
_0x5d8143.preventDefault();_0x5d8143.stopPropagation();const _0x1153c6=keypressOverlay.getBoundingClientRect();keyResizeState={'startX':_0x5d8143.clientX,'startY':_0x5d8143.clientY,'width':_0x1153c6.width,'height':_0x1153c6.height,'diagonal':Math.hypot(_0x1153c6.width,_0x1153c6.height)||0x1,'scale':keypressSettings.size};isKeyResizeActive=!0;keypressOverlay.classList.add("resizing");updateKeypressSizeIndicator(keyResizeState.scale);document.addEventListener("mousemove",performKeyResize);document.addEventListener("mouseup",stopKeyResize)}
function performKeyResize(_0x8e8e37){if(!isKeyResizeActive||!keyResizeState){return}
_0x8e8e37.preventDefault();const _0x12e32d=_0x8e8e37.clientX-keyResizeState.startX;const _0x219e9b=_0x8e8e37.clientY-keyResizeState.startY;const _0x3f1707=Math.max(0x1e,keyResizeState.width+_0x12e32d);const _0x3068ce=Math.max(0x1e,keyResizeState.height+_0x219e9b);const _0x370d34=Math.hypot(_0x3f1707,_0x3068ce);const _0x14f901=_0x370d34/keyResizeState.diagonal;const _0x2c7f14=clampKeypressScale(keyResizeState.scale*_0x14f901);applyKeypressSize(_0x2c7f14);updateKeypressSizeIndicator(_0x2c7f14)}
function stopKeyResize(){if(!isKeyResizeActive){return}
document.removeEventListener('mousemove',performKeyResize);document.removeEventListener("mouseup",stopKeyResize);isKeyResizeActive=!1;if(keypressOverlay){keypressOverlay.classList.remove("resizing")}
updateKeypressSizeIndicator();persistKeypressSettings({'size':keypressSettings.size});keyResizeState=null}
function resetKeypressActiveState(){keypressActiveKeys.clear();for(const _0x3aeb0f in keypressElementMap){if(Object.prototype.hasOwnProperty.call(keypressElementMap,_0x3aeb0f)){const _0x5c1129=keypressElementMap[_0x3aeb0f];if(_0x5c1129){_0x5c1129.classList.remove("active")}}}}
function renderKeypressLayout(_0x163ef5){if(!keypressOverlay){return}
const _0x9ae2fa=keypressOverlay.querySelector(".key-container");if(!_0x9ae2fa){return}
const _0x122470=KEY_LAYOUTS[_0x163ef5]||KEY_LAYOUTS.arrows;keypressKeyMap={};keypressElementMap=Object.create(null);keypressActiveKeys.clear();_0x9ae2fa.innerHTML='';_0x122470.rows.forEach(_0x28272f=>{const _0x2d8233=document.createElement("div");_0x2d8233.className='key-row';_0x28272f.forEach(_0x44035d=>{const _0x3b817a=document.createElement("div");_0x3b817a.className="key";_0x3b817a.id=_0x44035d.id;const _0x4eb2a4=document.createElement("span");_0x4eb2a4.textContent=_0x44035d.label;_0x3b817a.appendChild(_0x4eb2a4);const _0x3475f8=_0x44035d.matches.map(_0x30f79c=>_0x30f79c.toLowerCase());_0x3b817a.dataset.matches=_0x3475f8.join(',');_0x3475f8.forEach(_0x41f126=>{keypressKeyMap[_0x41f126]=_0x44035d.id});keypressElementMap[_0x44035d.id]=_0x3b817a;_0x2d8233.appendChild(_0x3b817a)});_0x9ae2fa.appendChild(_0x2d8233)});keypressOverlay.dataset.layout=_0x163ef5;resetKeypressActiveState()}
function applyKeypressSize(_0x3c3c5b){const _0x2bc1d7=clampKeypressScale(_0x3c3c5b);keypressSettings.size=_0x2bc1d7;if(keypressOverlay){keypressOverlay.style.setProperty("--key-scale",String(_0x2bc1d7));if(keypressVisible){scheduleKeypressBoundsCheck()}}
updateKeypressSizeIndicator(_0x2bc1d7)}
function setKeypressLayout(_0x450b1f){const _0x16fd97=typeof _0x450b1f==="string"?_0x450b1f.toLowerCase():"arrows";const _0x7d8f89=_0x16fd97;const _0x4a08cc=KEY_LAYOUTS[_0x7d8f89]?_0x7d8f89:"arrows";const _0x36628d=keypressSettings.layout!==_0x4a08cc;keypressSettings.layout=_0x4a08cc;if(keypressOverlay&&(_0x36628d||keypressOverlay.dataset.layout!==_0x4a08cc)){renderKeypressLayout(_0x4a08cc);if(keypressVisible){scheduleKeypressBoundsCheck()}}}
function handleKeydown(_0x3742d2){if(!keypressVisible||!keypressOverlay){return}
const _0x343915=normalizeKeyValue(_0x3742d2.key);const _0x23f342=_0x3742d2.code?normalizeKeyValue(_0x3742d2.code):null;let _0x5bc161=keypressKeyMap[_0x343915];if(!_0x5bc161&&_0x23f342){_0x5bc161=keypressKeyMap[_0x23f342]}
if(!_0x5bc161){return}
if(keypressActiveKeys.has(_0x5bc161)){return}
const _0x4b1556=keypressElementMap[_0x5bc161];if(!_0x4b1556){return}
keypressActiveKeys.add(_0x5bc161);_0x4b1556.classList.add('active');if(storedCustomBackgroundActive){_0x4b1556.style.setProperty('background-image',`url(${storedCustomBackgroundActive})`)}}
function handleKeyup(_0x9e283c){if(!keypressVisible||!keypressOverlay){return}
let _0x4abc8d=keypressKeyMap[normalizeKeyValue(_0x9e283c.key)];if(!_0x4abc8d&&_0x9e283c.code){_0x4abc8d=keypressKeyMap[normalizeKeyValue(_0x9e283c.code)]}
if(!_0x4abc8d){return}
keypressActiveKeys['delete'](_0x4abc8d);const _0x10d66b=keypressElementMap[_0x4abc8d];if(_0x10d66b){_0x10d66b.classList.remove('active');if(storedCustomBackground){_0x10d66b.style.setProperty('background-image',`url(${storedCustomBackground})`)}else{_0x10d66b.style.removeProperty('background-image')}}}
function createKeypressOverlay(){if(keypressOverlay){return keypressOverlay}
keypressOverlay=document.createElement("div");keypressOverlay.id="key-display-overlay";keypressOverlay.style.setProperty("--key-scale",String(clampKeypressScale(keypressSettings.size)));const _0x5dc46f=document.createElement("div");_0x5dc46f.className='key-container';keypressOverlay.appendChild(_0x5dc46f);let _0x21947e=document.getElementById('key-display-overlay-style');if(!_0x21947e){_0x21947e=document.createElement("style");_0x21947e.id="key-display-overlay-style";_0x21947e.textContent="\n        #key-display-overlay {\n            position: fixed;\n            bottom: 30px;\n            right: 30px;\n            z-index: 2147483647 !important;\n            user-select: none;\n            cursor: move;\n            display: none;\n            padding: 0;\n            margin: 0;\n            border-radius: 0;\n            background: transparent !important;\n            border: none !important;\n            box-shadow: none !important;\n            outline: none !important;\n            overflow: visible;\n            animation: keyOverlayFadeIn 0.3s ease;\n            --key-scale: 1;\n            --key-base-size: 60px;\n            --key-gap: 10px;\n            --key-border-width: calc(2px * var(--key-scale));\n            --key-radius: calc(12px * var(--key-scale));\n            --key-bg: linear-gradient(145deg, #2b2b2b, #191919);\n            --key-border: #dc2626;\n            --key-hover-bg: linear-gradient(145deg, #323232, #1f1f1f);\n            --key-active-bg: linear-gradient(145deg, #4bc277, #328f56);\n            --key-active-border: #6fe49d;\n            --key-shadow: 0 calc(6px * var(--key-scale)) calc(18px * var(--key-scale)) rgba(0, 0, 0, 0.55),\n                          inset 0 calc(1px * var(--key-scale)) calc(3px * var(--key-scale)) rgba(255, 255, 255, 0.12);\n            --key-hover-shadow: 0 calc(7px * var(--key-scale)) calc(20px * var(--key-scale)) rgba(0, 0, 0, 0.55);\n            --key-active-shadow: 0 calc(5px * var(--key-scale)) calc(22px * var(--key-scale)) rgba(73, 194, 119, 0.55),\n                                 inset 0 0 calc(18px * var(--key-scale)) rgba(73, 194, 119, 0.45);\n            --key-color: #dc2626;\n            --key-font: 'Segoe UI', Arial, sans-serif;\n            --key-letter: 0;\n            --key-text-shadow: 0 calc(2px * var(--key-scale)) calc(4px * var(--key-scale)) rgba(0, 0, 0, 0.8);\n            --resize-bg: linear-gradient(135deg, rgba(255, 255, 255, 0.3), rgba(255, 255, 255, 0));\n            --resize-border: rgba(255, 255, 255, 0.25);\n            --resize-shadow: inset 0 0 calc(4px * var(--key-scale)) rgba(0, 0, 0, 0.3);\n        }\n        #key-display-overlay::before,\n        #key-display-overlay::after {\n            display: none !important;\n        }\n        #key-display-overlay .key-container {\n            display: flex;\n            flex-direction: column;\n            align-items: center;\n            justify-content: center;\n            gap: calc(var(--key-gap) * var(--key-scale));\n            padding: 0;\n            margin: 0;\n            border: none;\n            background: transparent;\n            box-shadow: none;\n        }\n        #key-display-overlay .key-row {\n            display: flex;\n            gap: calc(var(--key-gap) * var(--key-scale));\n            align-items: stretch;\n            justify-content: center;\n        }\n        #key-display-overlay .key {\n            position: relative;\n            width: calc(var(--key-base-size) * var(--key-scale));\n            height: calc(var(--key-base-size) * var(--key-scale));\n            display: flex;\n            align-items: center;\n            justify-content: center;\n            border-radius: var(--key-radius);\n            background: var(--key-bg);\n            border: var(--key-border-width) solid var(--key-border);\n            box-shadow: var(--key-shadow);\n            color: var(--key-color);\n            font-family: var(--key-font);\n            letter-spacing: var(--key-letter);\n            text-transform: none;\n            transition: transform 0.12s ease, box-shadow 0.12s ease, background 0.12s ease, border-color 0.12s ease;\n            transform: var(--key-transform, translate3d(0, 0, 0));\n        }\n        #key-display-overlay .key span {\n            font-size: calc(22px * var(--key-scale));\n            font-weight: 600;\n            text-shadow: var(--key-text-shadow);\n            pointer-events: none;\n        }\n        #key-display-overlay .key:hover {\n            box-shadow: var(--key-hover-shadow);\n            background: var(--key-hover-bg);\n        }\n        #key-display-overlay .key.active {\n            box-shadow: var(--key-active-shadow);\n            background: var(--key-active-bg);\n            border-color: var(--key-active-border);\n        }\n        #key-display-overlay .key-resize-handle {\n            position: absolute;\n            bottom: calc(-8px * var(--key-scale));\n            right: calc(-8px * var(--key-scale));\n            width: calc(18px * var(--key-scale));\n            height: calc(18px * var(--key-scale));\n            border-radius: 4px;\n            border: none;\n            background: transparent;\n            box-shadow: none;\n            cursor: nwse-resize;\n            opacity: 0;\n            transition: opacity 0.2s ease;\n        }\n        #key-display-overlay:hover .key-resize-handle {\n            opacity: 0.4;\n        }\n        #key-display-overlay .key-resize-handle:hover {\n            opacity: 0.7 !important;\n        }\n        #key-display-overlay .key-resize-handle::after {\n            content: '';\n            position: absolute;\n            inset: 6px;\n            border-radius: 3px;\n            border: 1px solid rgba(255, 255, 255, 0.3);\n        }\n        #key-display-overlay .key-size-indicator {\n            position: absolute;\n            bottom: calc(100% + 10px);\n            right: 0;\n            padding: 6px 10px;\n            border-radius: 4px;\n            pointer-events: none;\n            opacity: 0;\n            transition: opacity 0.2s ease;\n            box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);\n            background: rgba(0, 0, 0, 0.7);\n            color: #ffffff;\n            font-size: 12px;\n            font-weight: 600;\n        }\n        #key-display-overlay.resizing .key-size-indicator {\n            opacity: 1;\n        }\n        #key-display-overlay.key-theme-classic {\n            --key-base-size: 60px;\n            --key-gap: 10px;\n            --key-border-width: calc(2px * var(--key-scale));\n            --key-radius: calc(14px * var(--key-scale));\n            --key-bg: linear-gradient(145deg, #2c2c2c, #151515);\n            --key-border: #3f3f3f;\n            --key-hover-bg: linear-gradient(145deg, #353535, #1d1d1d);\n            --key-active-bg: linear-gradient(145deg, #47bf74, #2f8f52);\n            --key-active-border: #6ce099;\n            --key-shadow: 0 calc(6px * var(--key-scale)) calc(20px * var(--key-scale)) rgba(0, 0, 0, 0.6),\n                          inset 0 calc(1px * var(--key-scale)) calc(3px * var(--key-scale)) rgba(255, 255, 255, 0.12);\n            --key-hover-shadow: 0 calc(7px * var(--key-scale)) calc(22px * var(--key-scale)) rgba(0, 0, 0, 0.6);\n            --key-active-shadow: 0 calc(5px * var(--key-scale)) calc(24px * var(--key-scale)) rgba(73, 194, 119, 0.55),\n                                 inset 0 0 calc(18px * var(--key-scale)) rgba(73, 194, 119, 0.42);\n        }\n        #key-display-overlay.key-theme-classic::before,\n        #key-display-overlay.key-theme-classic::after {\n            opacity: 0;\n            background: none;\n            border: none;\n        }\n        #key-display-overlay.key-theme-minimal {\n            padding: 0;\n            --key-base-size: 58px;\n            --key-gap: 14px;\n            --key-border-width: calc(1.4px * var(--key-scale));\n            --key-radius: calc(6px * var(--key-scale));\n            --key-bg: #000000;\n            --key-border: rgba(255, 255, 255, 0.45);\n            --key-hover-bg: rgba(255, 255, 255, 0.18);\n            --key-active-bg: #ffffff;\n            --key-active-border: rgba(255, 255, 255, 0.9);\n            --key-shadow: none;\n            --key-hover-shadow: none;\n            --key-active-shadow: none;\n            --key-color: #f7f7f7;\n            --key-text-shadow: none;\n            --resize-bg: rgba(255, 255, 255, 0.35);\n            --resize-border: rgba(255, 255, 255, 0.5);\n        }\n        #key-display-overlay.key-theme-minimal .key {\n            background: var(--key-bg) !important;\n        }\n        #key-display-overlay.key-theme-minimal .key.active {\n            background: #ffffff !important;\n            color: #000000 !important;\n        }\n        #key-display-overlay.key-theme-minimal .key.active span {\n            color: #000000 !important;\n        }\n        #key-display-overlay.key-theme-minimal::before,\n        #key-display-overlay.key-theme-minimal::after {\n            opacity: 0;\n            background: none;\n            border: none;\n            transform: none;\n        }\n        #key-display-overlay.key-theme-minimal .key-container {\n            display: grid;\n            grid-template-columns: repeat(3, minmax(calc(42px * var(--key-scale)), 1fr));\n            grid-template-rows: repeat(2, minmax(calc(42px * var(--key-scale)), 1fr));\n            grid-template-areas:\n                \". up .\"\n                \"left down right\";\n            align-items: center;\n            justify-items: center;\n            gap: calc(16px * var(--key-scale));\n            width: calc(220px * var(--key-scale));\n            padding: 0;\n            border: none;\n            background: transparent;\n            box-shadow: none;\n        }\n        #key-display-overlay.key-theme-minimal .key-row {\n            display: contents;\n        }\n        #key-display-overlay.key-theme-minimal .key {\n            border-radius: calc(8px * var(--key-scale));\n        }\n        #key-display-overlay.key-theme-minimal #key-up { grid-area: up; }\n        #key-display-overlay.key-theme-minimal #key-down { grid-area: down; }\n        #key-display-overlay.key-theme-minimal #key-left { grid-area: left; }\n        #key-display-overlay.key-theme-minimal #key-right { grid-area: right; }\n        #key-display-overlay.key-theme-block {\n            padding: 0;\n            --key-base-size: 58px;\n            --key-gap: 8px;\n            --key-border-width: calc(3px * var(--key-scale));\n            --key-radius: calc(4px * var(--key-scale));\n            --key-bg: linear-gradient(160deg, #303030 0%, #1b1b1b 60%, #050505 100%);\n            --key-border: #050505;\n            --key-hover-bg: linear-gradient(160deg, #3a3a3a, #1f1f1f, #090909);\n            --key-active-bg: linear-gradient(160deg, #ffb347, #ffcc33);\n            --key-active-border: #ffe066;\n            --key-color: #fff7d1;\n            --key-shadow: 0 calc(6px * var(--key-scale)) calc(14px * var(--key-scale)) rgba(8, 8, 8, 0.85);\n            --key-hover-shadow: 0 calc(7px * var(--key-scale)) calc(18px * var(--key-scale)) rgba(0, 0, 0, 0.9);\n            --key-active-shadow: 0 calc(6px * var(--key-scale)) calc(22px * var(--key-scale)) rgba(255, 204, 51, 0.45);\n            --key-text-shadow: 0 calc(2px * var(--key-scale)) calc(4px * var(--key-scale)) rgba(0, 0, 0, 0.9);\n        }\n        #key-display-overlay.key-theme-block::before,\n        #key-display-overlay.key-theme-block::after {\n            opacity: 0;\n            background: none;\n            border: none;\n        }\n        #key-display-overlay.key-theme-block .key-container {\n            padding: 0;\n            border: none;\n            border-radius: calc(12px * var(--key-scale));\n            background: transparent;\n            box-shadow: none;\n        }\n        #key-display-overlay.key-theme-block .key span {\n            font-weight: 800;\n        }\n        #key-display-overlay.key-theme-block-white {\n            padding: 0;\n            --key-base-size: 58px;\n            --key-gap: 8px;\n            --key-border-width: calc(3px * var(--key-scale));\n            --key-radius: calc(4px * var(--key-scale));\n            --key-bg: #000000;\n            --key-border: transparent;\n            --key-hover-bg: #000000;\n            --key-active-bg: #ffffff;\n            --key-active-border: #ffffff;\n            --key-color: #ffffff;\n            --key-shadow: none;\n            --key-hover-shadow: none;\n            --key-active-shadow: 0 0 0 rgba(0,0,0,0);\n            --key-text-shadow: none;\n        }\n        #key-display-overlay.key-theme-block-white::before,\n        #key-display-overlay.key-theme-block-white::after {\n            opacity: 0;\n            background: none;\n            border: none;\n        }\n        #key-display-overlay.key-theme-block-white .key-container {\n            padding: 0;\n            border: none;\n            border-radius: calc(12px * var(--key-scale));\n            background: transparent;\n            box-shadow: none;\n        }\n        #key-display-overlay.key-theme-block-white .key span {\n            font-weight: 800;\n        }\n        #key-display-overlay.key-theme-block-white .key.active {\n            color: #0b0b0b;\n        }\n        #key-display-overlay.key-theme-block-white .key.active span {\n            color: #0b0b0b;\n        }\n        #key-display-overlay.key-theme-retro {\n            padding: 0;\n            --key-base-size: 58px;\n            --key-gap: 8px;\n            --key-border-width: calc(2px * var(--key-scale));\n            --key-radius: 0;\n            --key-bg: repeating-linear-gradient(45deg, #333, #333 8px, #2a2a2a 8px, #2a2a2a 16px);\n            --key-border: #00ff7f;\n            --key-hover-bg: repeating-linear-gradient(45deg, #3f3f3f, #3f3f3f 8px, #333 8px, #333 16px);\n            --key-active-bg: #00ff7f;\n            --key-active-border: #111111;\n            --key-color: #00ff7f;\n            --key-shadow: 0 calc(2px * var(--key-scale)) 0 rgba(0, 0, 0, 0.9);\n            --key-hover-shadow: 0 calc(3px * var(--key-scale)) 0 rgba(0, 0, 0, 0.9);\n            --key-active-shadow: 0 calc(4px * var(--key-scale)) 0 rgba(0, 0, 0, 0.95);\n            --key-font: 'Courier New', monospace;\n            --key-letter: 0.08em;\n            --key-text-shadow: none;\n        }\n        #key-display-overlay.key-theme-retro::before,\n        #key-display-overlay.key-theme-retro::after {\n            opacity: 0;\n            background: none;\n            border: none;\n        }\n        #key-display-overlay.key-theme-retro {\n            border-radius: calc(6px * var(--key-scale));\n        }\n        #key-display-overlay.key-theme-retro .key-container {\n            border: none;\n            padding: 0;\n            background: transparent;\n            box-shadow: none;\n        }\n        #key-display-overlay.key-theme-retro .key {\n            border-top: calc(4px * var(--key-scale)) solid #111111;\n        }\n        #key-display-overlay.key-theme-retro .key span {\n            text-transform: uppercase;\n            font-weight: 700;\n        }\n        #key-display-overlay.key-theme-split {\n            padding: 0;\n            --key-base-size: 54px;\n            --key-gap: 12px;\n            --key-radius: calc(10px * var(--key-scale));\n            --key-bg: linear-gradient(145deg, #1f1f1f, #101010);\n            --key-border: rgba(255, 255, 255, 0.18);\n            --key-hover-bg: linear-gradient(145deg, #282828, #141414);\n            --key-active-bg: linear-gradient(145deg, #42b0ff, #2d7de2);\n            --key-active-border: #66c7ff;\n            --key-shadow: 0 calc(6px * var(--key-scale)) calc(12px * var(--key-scale)) rgba(0, 0, 0, 0.5);\n            --key-hover-shadow: 0 calc(8px * var(--key-scale)) calc(18px * var(--key-scale)) rgba(0, 0, 0, 0.55);\n            --key-active-shadow: 0 calc(8px * var(--key-scale)) calc(22px * var(--key-scale)) rgba(66, 176, 255, 0.45);\n        }\n        #key-display-overlay.key-theme-split::before,\n        #key-display-overlay.key-theme-split::after {\n            opacity: 0;\n            background: none;\n            border: none;\n        }\n        #key-display-overlay.key-theme-split .key-container {\n            display: grid;\n            grid-template-columns: repeat(2, minmax(calc(58px * var(--key-scale)), 1fr));\n            grid-template-rows: repeat(2, minmax(calc(58px * var(--key-scale)), 1fr));\n            grid-template-areas:\n                \"up right\"\n                \"left down\";\n            gap: calc(18px * var(--key-scale));\n            align-items: stretch;\n            justify-items: stretch;\n            padding: 0;\n            background: transparent;\n            border-radius: calc(18px * var(--key-scale));\n            box-shadow: none;\n        }\n        #key-display-overlay.key-theme-split .key-row {\n            display: contents;\n        }\n        #key-display-overlay.key-theme-split #key-up {\n            grid-area: up;\n            align-self: end;\n            justify-self: start;\n            --key-transform: rotate(-6deg);\n        }\n        #key-display-overlay.key-theme-split #key-right {\n            grid-area: right;\n            align-self: start;\n            justify-self: end;\n            --key-transform: rotate(8deg);\n        }\n        #key-display-overlay.key-theme-split #key-left {\n            grid-area: left;\n            align-self: start;\n            justify-self: start;\n            --key-transform: rotate(-10deg);\n        }\n        #key-display-overlay.key-theme-split .key.active {\n            --key-active-bg: linear-gradient(135deg, #52c0ff 0%, #3b8de8 100%);\n            --key-active-border: #88d4ff;\n        }\n        #key-display-overlay.key-theme-default {\n            --key-bg: #000000;\n            --key-border: #dc2626;\n            --key-radius: 0;\n            --key-active-bg: #FFFFFF;\n            --key-active-border: #FFFFFF;\n            --key-color: #dc2626;\n            --key-active-color: #000000;\n            --key-shadow: none;\n            --key-active-shadow: none;\n        }\n        #key-display-overlay.key-theme-default .key.active > span {\n            color: #000000 !important;\n        }\n        #key-display-overlay.key-theme-default .key {\n            transition: background 0.1s ease, border-color 0.1s ease;\n        }\n        #key-display-overlay.key-theme-default .key.active {\n            transition-duration: 0.05s;\n        }\n        @keyframes keyOverlayFadeIn {\n            from { opacity: 0; transform: translateY(15px) scale(0.98); }\n            to { opacity: 1; transform: translateY(0) scale(1); }\n        }\n        ";document.head.appendChild(_0x21947e)}
document.documentElement.appendChild(keypressOverlay);chrome.storage.local.get(['customBackground','customBackgroundActive'],_0x181a2f=>{if(_0x181a2f.customBackground){storedCustomBackground=_0x181a2f.customBackground;applyCustomBackground(keypressOverlay,_0x181a2f.customBackground)}
if(_0x181a2f.customBackgroundActive){storedCustomBackgroundActive=_0x181a2f.customBackgroundActive}});applyKeypressTheme(keypressSettings.theme||"default");setKeypressLayout(keypressSettings.layout||"arrows");applyKeypressSize(keypressSettings.size||0x1);ensureKeypressResizeElements();applyKeypressPosition(keypressSettings.position);makeDraggable(keypressOverlay,{'onChange':saveKeypressPosition});scheduleKeypressBoundsCheck();return keypressOverlay}
function keepOverlayInBounds(){if(!keypressOverlay){return}
const _0x4f8c10=getKeypressOverlayRect();const _0x1c7aab=window.innerWidth;const _0x1e87f7=window.innerHeight;let _0x3b2564=_0x4f8c10.left;let _0x415510=_0x4f8c10.top;let _0xc08179=!1;if(_0x4f8c10.right>_0x1c7aab){_0x3b2564=Math.max(0x0,_0x1c7aab-_0x4f8c10.width-0xa);_0xc08179=!0}
if(_0x4f8c10.left<0x0){_0x3b2564=0xa;_0xc08179=!0}
if(_0x4f8c10.bottom>_0x1e87f7){_0x415510=Math.max(0x0,_0x1e87f7-_0x4f8c10.height-0xa);_0xc08179=!0}
if(_0x4f8c10.top<0x0){_0x415510=0xa;_0xc08179=!0}
if(_0xc08179){keypressOverlay.style.left=Math.round(_0x3b2564)+'px';keypressOverlay.style.top=Math.round(_0x415510)+'px';keypressOverlay.style.right='auto';keypressOverlay.style.bottom="auto";keypressOverlay.style.transform="none";keypressSettings.position={'x':Math.round(_0x3b2564),'y':Math.round(_0x415510)};persistKeypressSettings({'position':keypressSettings.position})}}
function scheduleKeypressBoundsCheck(){if(!keypressOverlay){return}
if(keypressBoundsHandle!==null){return}
keypressBoundsHandle=requestAnimationFrame(()=>{keypressBoundsHandle=null;keepOverlayInBounds()})}
function toggleKeypressDisplay(){if(!keypressOverlay){createKeypressOverlay()}
keypressVisible=!keypressVisible;keypressSettings.visible=keypressVisible;log("Keypress display toggled:",keypressVisible);if(keypressVisible){applyKeypressTheme(keypressSettings.theme);setKeypressLayout(keypressSettings.layout);applyKeypressSize(keypressSettings.size);keypressOverlay.style.display="block";applyKeypressPosition(keypressSettings.position);scheduleKeypressBoundsCheck();ensureKeypressResizeElements();updateKeypressSizeIndicator();resetKeypressActiveState();log("Keypress display is now active using layout "+keypressSettings.layout+'.')}else{keypressOverlay.style.display="none";resetKeypressActiveState()}
persistKeypressSettings({'visible':keypressVisible,'size':keypressSettings.size,'layout':keypressSettings.layout,'theme':keypressSettings.theme,'position':keypressSettings.position});return keypressVisible}
window.addEventListener("resize",()=>{if(keypressOverlay){scheduleKeypressBoundsCheck()}});document.addEventListener("fullscreenchange",()=>{if(keypressOverlay){scheduleKeypressBoundsCheck()}});chrome.runtime.sendMessage({'action':"getKeypressSettings"},_0x18252a=>{if(chrome.runtime.lastError){return}
if(_0x18252a&&_0x18252a.settings){keypressVisible=!!_0x18252a.settings.visible;keypressSettings.visible=keypressVisible;keypressSettings.size=clampKeypressScale(_0x18252a.settings.size??0x1);keypressSettings.layout=typeof _0x18252a.settings.layout==="string"?KEY_LAYOUTS[_0x18252a.settings.layout.toLowerCase()]?_0x18252a.settings.layout.toLowerCase():'arrows':"arrows";if(keypressVisible){createKeypressOverlay();setKeypressLayout(keypressSettings.layout);applyKeypressSize(keypressSettings.size);keypressOverlay.style.display="block";setTimeout(()=>keepOverlayInBounds(),0x64)}}});chrome.runtime.onMessage.addListener((_0x4b84e5,_0x797bbd,_0x14454)=>{switch(_0x4b84e5.action){case "toggleTimer":toggleTimerVisibility();_0x14454({'success':!0});break;case 'toggleFpsMonitor':const _0x47db29=toggleFpsOverlay();_0x14454({'success':!0,'visible':_0x47db29});break;case "toggleKeypressDisplay":const _0x4fc725=toggleKeypressDisplay();_0x14454({'success':!0,'visible':_0x4fc725});break;case "updateKeypressLayout":setKeypressLayout(_0x4b84e5.layout);ensureKeypressResizeElements();if(keypressOverlay){renderKeypressLayout(keypressSettings.layout)}
if(window.wasdZqsdHandler){deactivateZqsd();activateZqsdDirectly()}
_0x14454({'success':!0,'layout':keypressSettings.layout});break;case "updateKeypressTheme":const _0x9f8edc=setKeypressTheme(_0x4b84e5.theme);ensureKeypressResizeElements();if(_0x4fc725){scheduleKeypressBoundsCheck()}
_0x14454({'success':!0,'theme':_0x9f8edc});break;case "updateHotkey":currentHotkey=_0x4b84e5.hotkey;_0x14454({'success':!0});break;case "updateTimerColors":timerColors=_0x4b84e5.colors;applyTimerColor();_0x14454({'success':!0});break;case "activateZqsd":activateZqsdDirectly();chrome.runtime.sendMessage({'action':"saveZqsdState",'active':!0});_0x14454({'success':!0});break;case "deactivateZqsd":if(window.wasdZqsdHandler){document.removeEventListener('keydown',window.wasdZqsdHandler,!0);document.removeEventListener("keyup",window.wasdZqsdHandler,!0);window.wasdZqsdHandler=null;zqsdHandler=null}
chrome.runtime.sendMessage({'action':"saveZqsdState",'active':!1});_0x14454({'success':!0});break;case 'updateZqsdKeys':if(window.wasdZqsdHandler){document.removeEventListener('keydown',window.wasdZqsdHandler,!0);document.removeEventListener('keyup',window.wasdZqsdHandler,!0);window.wasdZqsdHandler=null;zqsdHandler=null}
activateZqsdDirectly();_0x14454({'success':!0});break;case "toggleResolution":const _0x2f48d6=_0x4b84e5.blackBarsEnabled!==!1;const _0x3c5feb=(typeof _0x4b84e5.mode==='string'&&(RESOLUTION_CONFIGS[_0x4b84e5.mode]||/^\d{2,4}x\d{2,4}$/i.test(_0x4b84e5.mode)))?_0x4b84e5.mode:"608x1080";const _barsColor=typeof _0x4b84e5.barsColor==='string'&&_0x4b84e5.barsColor?_0x4b84e5.barsColor:'#000000';let _0x2663f0=!1;if(_0x4b84e5.activate===!1){if(isResolutionForced){restoreNormalResolution();_0x2663f0=!0}}else{const _0x5a0e9a=isResolutionForced&&currentResolutionMode&&currentResolutionMode!==_0x3c5feb;applyForcedResolution(_0x3c5feb,_0x2f48d6,_barsColor);_0x2663f0=_0x5a0e9a}
_0x14454({'success':!0,'enabled':isResolutionForced,'mode':currentResolutionMode,'reloaded':_0x2663f0});if(_0x2663f0){setTimeout(()=>window.location.reload(),0x64)}
break;case "setGlobalVolume":if(typeof _0x4b84e5.volume==="number"&&!Number.isNaN(_0x4b84e5.volume)){const _0x383f42=Math.min(0x1,Math.max(0x0,_0x4b84e5.volume));currentGlobalVolume=_0x383f42;chrome.storage.local.set({globalVolumeLevel:_0x383f42},()=>{sendVolumeToPage("EXT_SET_VOLUME",{'volume':_0x383f42});_0x14454({'success':!0,'volume':_0x383f42})})}else{_0x14454({'success':!1})}
return!0;case "updateTripleClick":tripleClickActive=_0x4b84e5.active;break;case "updateTripleClickKey":tripleClickKey=_0x4b84e5.key;break;case 'applyAdvancedStyle':
    if (_0x4b84e5.settings) {
        const s = _0x4b84e5.settings;
        const timerWasVisible = timerOverlay ? timerOverlay.style.display : 'none';
        const fpsWasVisible = fpsOverlay ? fpsOverlay.style.display : 'none';
        const keysWasVisible = keypressOverlay ? keypressOverlay.style.display : 'none';
        
        if (timerOverlay) {
            timerOverlay.style.borderRadius = s.borderRadius || '0px';
            timerOverlay.style.opacity = s.bgOpacity !== undefined ? s.bgOpacity : 1;
            timerOverlay.style.display = timerWasVisible;
            if (timerDisplayEl) {
                timerDisplayEl.style.color = s.textColor || '#dc2626';
                if (s.fontFamily) timerDisplayEl.style.fontFamily = s.fontFamily;
                const baseSize = 43;
                const rect = timerOverlay.getBoundingClientRect();
                const widthRatio = rect.width / 225;
                const heightRatio = rect.height / 50;
                const scale = Math.min(widthRatio, heightRatio);
                const calculatedSize = Math.max(18, Math.min(120, baseSize * scale));
                const finalSize = calculatedSize * (s.fontScale || 1);
                timerDisplayEl.style.fontSize = `${finalSize}px`;
            }
        }
        if (fpsOverlay) {
            fpsOverlay.style.borderRadius = s.borderRadius || '4px';
            fpsOverlay.style.opacity = s.bgOpacity !== undefined ? s.bgOpacity : 1;
            fpsOverlay.style.display = fpsWasVisible; // Restaurer display
            const valueEl = fpsOverlay.querySelector('.fps-value');
            if (valueEl) {
                valueEl.style.color = s.textColor || '#dc2626';
                if (s.fontFamily) valueEl.style.fontFamily = s.fontFamily;
            }
        }
        if (keypressOverlay) {
            keypressOverlay.style.setProperty('--key-radius', s.borderRadius || '12px');
            keypressOverlay.style.setProperty('--key-color', s.textColor || '#dc2626');
            keypressOverlay.style.opacity = s.bgOpacity !== undefined ? s.bgOpacity : 1;
            keypressOverlay.style.display = keysWasVisible; // Restaurer display
            if (s.fontFamily) keypressOverlay.style.setProperty('--key-font', s.fontFamily);
        }
    }
    _0x14454({success: true});
    break;
case 'resetAllCustomization':
    if (timerOverlay) { 
        const wasVisible = timerOverlay.style.display;
        const pos = { left: timerOverlay.style.left, top: timerOverlay.style.top };
        const size = { width: timerOverlay.style.width, height: timerOverlay.style.height };
        applyThemeToTimer();
        timerOverlay.style.display = wasVisible;
        timerOverlay.style.left = pos.left;
        timerOverlay.style.top = pos.top;
        timerOverlay.style.width = size.width;
        timerOverlay.style.height = size.height;
    }
    if (fpsOverlay) { 
        const wasVisible = fpsOverlay.style.display;
        const pos = { left: fpsOverlay.style.left, top: fpsOverlay.style.top };
        ensureFpsStyles();
        fpsOverlay.style.display = wasVisible;
        fpsOverlay.style.left = pos.left;
        fpsOverlay.style.top = pos.top;
    }
    if (keypressOverlay) { 
        const wasVisible = keypressOverlay.style.display;
        const pos = { left: keypressOverlay.style.left, top: keypressOverlay.style.top };
        applyKeypressTheme('default');
        keypressOverlay.style.display = wasVisible;
        keypressOverlay.style.left = pos.left;
        keypressOverlay.style.top = pos.top;
    }
    _0x14454({success: true});
    break;
case "updateBackground":storedCustomBackground=_0x4b84e5.background;applyCustomBackground(timerOverlay,storedCustomBackground);applyCustomBackground(fpsOverlay,storedCustomBackground);applyCustomBackground(keypressOverlay,storedCustomBackground);_0x14454({success:!0});break;case "updateBackgroundActive":storedCustomBackgroundActive=_0x4b84e5.background;_0x14454({success:!0});break;case "resetSpecificBackground":{
    const target = _0x4b84e5.targetType;
    if (target === 'timer' && timerOverlay) { applyCustomBackground(timerOverlay, null); }
    if (target === 'fps' && fpsOverlay) { applyCustomBackground(fpsOverlay, null); }
    if (target === 'keys' && keypressOverlay) { applyCustomBackground(keypressOverlay, null); storedCustomBackgroundActive = null; }
    _0x14454({success: true});
    break;
}
case "updateSpecificBackground":{
    const target = _0x4b84e5.targetType;
    const bg = _0x4b84e5.background;
    if (target === 'timer' && timerOverlay) { applyCustomBackground(timerOverlay, bg); }
    if (target === 'fps' && fpsOverlay) { applyCustomBackground(fpsOverlay, bg); }
    if (target === 'keys' && keypressOverlay) { applyCustomBackground(keypressOverlay, bg); }
    if (target === 'keysActive') { storedCustomBackgroundActive = bg; }
    _0x14454({success: true});
    break;
}
case 'applyAdvancedStyleV2':
    if (_0x4b84e5.settings) {
        const s = _0x4b84e5.settings;
        
        if (s.timer && timerOverlay) {
            const ts = s.timer;
            timerOverlay.style.backgroundColor = ts.bgColor || '#000000';
            timerOverlay.style.borderRadius = ts.borderRadius || '0px';
            timerOverlay.style.opacity = ts.opacity !== undefined ? ts.opacity : 1;
            timerOverlay.style.borderWidth = ts.borderWidth || '0px';
            timerOverlay.style.borderColor = ts.borderColor || '#dc2626';
            timerOverlay.style.borderStyle = parseInt(ts.borderWidth) > 0 ? 'solid' : 'none';
            timerOverlay.style.boxShadow = parseInt(ts.shadow) > 0 ? `0 0 ${ts.shadow} rgba(0,0,0,0.5)` : 'none';
            if (timerDisplayEl) {
                timerDisplayEl.style.color = ts.textColor || '#dc2626';
                if (ts.fontFamily) timerDisplayEl.style.fontFamily = ts.fontFamily;
                const baseSize = 43;
                const rect = timerOverlay.getBoundingClientRect();
                const widthRatio = rect.width / 225;
                const heightRatio = rect.height / 50;
                const scale = Math.min(widthRatio, heightRatio);
                const calculatedSize = Math.max(18, Math.min(120, baseSize * scale));
                const finalSize = calculatedSize * (ts.fontScale || 1);
                timerDisplayEl.style.fontSize = `${finalSize}px`;
            }
        }
        if (s.fps && fpsOverlay) {
            const fs = s.fps;
            fpsOverlay.style.backgroundColor = fs.bgColor || '#000000';
            fpsOverlay.style.borderRadius = fs.borderRadius || '4px';
            fpsOverlay.style.opacity = fs.opacity !== undefined ? fs.opacity : 1;
            fpsOverlay.style.borderWidth = fs.borderWidth || '0px';
            fpsOverlay.style.borderColor = fs.borderColor || '#dc2626';
            fpsOverlay.style.borderStyle = parseInt(fs.borderWidth) > 0 ? 'solid' : 'none';
            fpsOverlay.style.boxShadow = parseInt(fs.shadow) > 0 ? `0 0 ${fs.shadow} rgba(0,0,0,0.5)` : 'none';
            const valueEl = fpsOverlay.querySelector('.fps-value');
            if (valueEl) {
                valueEl.style.color = fs.textColor || '#dc2626';
                if (fs.fontFamily) valueEl.style.fontFamily = fs.fontFamily;
                const baseFps = 14;
                const finalFpsSize = baseFps * (fs.fontScale || 1);
                valueEl.style.fontSize = `${finalFpsSize}px`;
            }
        }
        
        if (s.keys && keypressOverlay) {
            const ks = s.keys;
            keypressOverlay.style.setProperty('--key-bg', ks.bgColor || '#000000');
            keypressOverlay.style.setProperty('--key-color', ks.textColor || '#dc2626');
            keypressOverlay.style.setProperty('--key-border', ks.borderColor || '#dc2626');
            keypressOverlay.style.setProperty('--key-active-bg', ks.activeColor || '#4bc277');
            keypressOverlay.style.setProperty('--key-active-border', ks.activeColor || '#4bc277');
            keypressOverlay.style.setProperty('--key-radius', ks.borderRadius || '12px');
            keypressOverlay.style.setProperty('--key-border-width', ks.borderWidth || '2px');
            keypressOverlay.style.setProperty('--key-gap', ks.gap || '10px');
            keypressOverlay.style.setProperty('--key-base-size', '60px');
            const shadowPx = parseInt(ks.shadow) || 0;
            if (shadowPx > 0) {
                keypressOverlay.style.setProperty('--key-shadow', `0 ${shadowPx}px ${shadowPx*2}px rgba(0,0,0,0.3)`);
                keypressOverlay.style.setProperty('--key-active-shadow', `0 ${shadowPx}px ${shadowPx*2}px rgba(75,194,119,0.4)`);
            } else {
                keypressOverlay.style.setProperty('--key-shadow', 'none');
                keypressOverlay.style.setProperty('--key-active-shadow', 'none');
            }
            keypressOverlay.style.opacity = ks.opacity !== undefined ? ks.opacity : 1;
            const sizeScale = ks.sizeScale || 1;
            keypressOverlay.style.setProperty('--key-scale', String(sizeScale));
            const keys = keypressOverlay.querySelectorAll('.key');
            const keyContainer = keypressOverlay.querySelector('.key-container');
            if (keyContainer) {
                keyContainer.style.gap = `calc(${ks.gap || '10px'} * ${sizeScale})`;
            }
            keys.forEach(key => {
                key.style.background = ks.bgColor || '#000000';
                key.style.borderColor = ks.borderColor || '#dc2626';
                key.style.borderRadius = ks.borderRadius || '12px';
                key.style.borderWidth = ks.borderWidth || '2px';
                key.style.borderStyle = 'solid';
                if (shadowPx > 0) {
                    key.style.boxShadow = `0 ${shadowPx}px ${shadowPx*2}px rgba(0,0,0,0.3)`;
                } else {
                    key.style.boxShadow = 'none';
                }
                const span = key.querySelector('span');
                if (span) span.style.color = ks.textColor || '#dc2626';
            });
        }
    }
    _0x14454({success: true});
    break;
default:_0x14454({'success':!1,'error':"Unknown action"});break}
return!0});document.addEventListener("keydown",_0xf3f8b2=>{if(_0xf3f8b2.repeat){return}
if(tripleClickActive&&_0xf3f8b2.code===tripleClickKey){doTripleClick()}
let _0x3cf96b=!1;if(currentHotkey==='Space'){if(_0xf3f8b2.key===" "||_0xf3f8b2.code==="Space"||_0xf3f8b2.keyCode===0x20){if(!_0xf3f8b2.ctrlKey&&!_0xf3f8b2.altKey&&!_0xf3f8b2.metaKey&&!_0xf3f8b2.shiftKey){_0x3cf96b=!0}else{if(_0xf3f8b2.shiftKey&&!_0xf3f8b2.ctrlKey&&!_0xf3f8b2.altKey&&!_0xf3f8b2.metaKey){}}}}else{if(currentHotkey==="Control"&&_0xf3f8b2.ctrlKey&&!_0xf3f8b2.altKey&&!_0xf3f8b2.metaKey&&!_0xf3f8b2.shiftKey){_0x3cf96b=!0}else{if(currentHotkey==="Shift"&&_0xf3f8b2.shiftKey&&!_0xf3f8b2.ctrlKey&&!_0xf3f8b2.altKey&&!_0xf3f8b2.metaKey){_0x3cf96b=!0}else{if(currentHotkey==='Alt'&&_0xf3f8b2.altKey&&!_0xf3f8b2.ctrlKey&&!_0xf3f8b2.metaKey&&!_0xf3f8b2.shiftKey){_0x3cf96b=!0}else{if(currentHotkey==="Meta"&&_0xf3f8b2.metaKey&&!_0xf3f8b2.ctrlKey&&!_0xf3f8b2.altKey&&!_0xf3f8b2.shiftKey){_0x3cf96b=!0}else{if(currentHotkey===_0xf3f8b2.code&&!_0xf3f8b2.ctrlKey&&!_0xf3f8b2.altKey&&!_0xf3f8b2.metaKey&&!_0xf3f8b2.shiftKey){_0x3cf96b=!0}}}}}}
if(_0x3cf96b){_0xf3f8b2.preventDefault();_0xf3f8b2.stopPropagation();_0xf3f8b2.stopImmediatePropagation();const _0x210fc1=["Shift","Control","Alt","Meta"].includes(currentHotkey);if(_0x210fc1||!_0xf3f8b2.shiftKey){controlTimer()}}
let _0x4650bb=!1;if(currentHotkey==='Space'&&(_0xf3f8b2.key===" "||_0xf3f8b2.code==="Space"||_0xf3f8b2.keyCode===0x20)&&_0xf3f8b2.shiftKey&&!_0xf3f8b2.ctrlKey&&!_0xf3f8b2.altKey&&!_0xf3f8b2.metaKey){_0x4650bb=!0}else if(!['Shift','Control',"Alt","Meta"].includes(currentHotkey)&&currentHotkey===_0xf3f8b2.code&&_0xf3f8b2.shiftKey&&!_0xf3f8b2.ctrlKey&&!_0xf3f8b2.altKey&&!_0xf3f8b2.metaKey){_0x4650bb=!0}
if(_0x4650bb){_0xf3f8b2.preventDefault();_0xf3f8b2.stopPropagation();_0xf3f8b2.stopImmediatePropagation();toggleTimerVisibility()}},!0);log("Gaming Tools Suite Complete - Content script prêt")


