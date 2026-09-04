/**
 * Sets the theme class before first paint.
 *
 * Inline and synchronous on purpose: applied from React after hydration, a
 * dark-mode user gets a white flash on every navigation, which at 6am in a
 * truck cab is the difference between usable and not.
 */
const SCRIPT = `(function(){try{
var stored=localStorage.getItem('theme');
var dark=stored?stored==='dark':window.matchMedia('(prefers-color-scheme: dark)').matches;
if(dark)document.documentElement.classList.add('dark');
var present=localStorage.getItem('present');
if(present==='true')document.documentElement.setAttribute('data-present','true');
}catch(e){}})();`;

export function ThemeScript() {
  return <script dangerouslySetInnerHTML={{ __html: SCRIPT }} />;
}
