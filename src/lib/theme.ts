/**
 * The theme bootstrap that runs before first paint.
 *
 * It lives in one module because two places need the exact same string: the
 * inline <script> in the root layout (which must carry the request's CSP nonce)
 * and the tests that assert it is present.
 */
export const THEME_BOOTSTRAP = `(function(){try{var t=localStorage.getItem('bizpilot-theme');var m=window.matchMedia('(prefers-color-scheme: dark)').matches;if(t==='dark'||(!t&&m)){document.documentElement.classList.add('dark');}}catch(e){}})();`;
