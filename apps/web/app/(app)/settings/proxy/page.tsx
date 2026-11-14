import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { can } from '../../../../server/authz.ts';
import { parseTrustedList, isBroadEntry } from '../../../../server/ip.ts';
import { PROXY_SECRET_HEADER, clientInfo } from '../../../../server/proxy.ts';
import { loadSettingsView } from '../../../../server/services/settings.ts';
import { environmentDefaults } from '../../../../server/settings.ts';
import { Banner, Csrf, flatWithFlash, requireSession, type SearchParams } from '../../../components/ui.tsx';
import { ConfirmPassword, SettingsTabs, savedMessage } from '../../../components/settings.tsx';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Reverse proxy · TallyMed' };

const show = (v: string | null | undefined) => (v ? v : 'not provided');

export default async function ProxyPage({ searchParams }: { searchParams: SearchParams }) {
  const { ctx, actor, csrf } = await requireSession();
  if (!can(actor, 'settings:manage')) notFound();
  const q = await flatWithFlash(searchParams, '/settings/proxy');
  const v = await loadSettingsView(ctx.pool, ctx.config, actor);
  const h = await headers();
  const info = clientInfo(h, ctx.config);
  const stored = v.proxy.value.trustedProxies;
  const envList = environmentDefaults(ctx.config).trustedProxies;
  const text = q.trustedProxies ?? (Array.isArray(stored) ? stored.join('\n') : envList.join('\n'));
  const broad = parseTrustedList(ctx.config.trustedProxies).ok.filter(isBroadEntry).map((e) => e.entry);
  const saved = savedMessage(q.saved);
  const scheme = info.trustedProxy ? (h.get('x-forwarded-proto')?.split(',').at(-1)?.trim() ?? null) : null;
  return <main id="main" className="wide">
    <h1>Reverse proxy</h1>
    <p>If TallyMed runs behind a reverse proxy (nginx, Caddy, Traefik, Nginx Proxy Manager and similar), every request reaches the app from the proxy's address. Tell the app which addresses are your proxies so it can believe the real client address and the https scheme they forward. Without this the app trusts nothing: every forwarded header is ignored, and the sign-in lockout counts all visitors together instead of each client.</p>
    <SettingsTabs current="/settings/proxy" />
    <Banner code={q.error} />
    {saved && <p role="status" className="card">{saved}</p>}

    {broad.length > 0 && <p role="alert" className="error">Warning: the trusted list currently contains very broad ranges ({broad.join(', ')}). Any machine in those ranges that can reach TallyMed directly can forge client addresses and so evade or aim the per-address sign-in lockout. List only your proxy's own address if you can.</p>}

    <div className="card">
      <h2>What the app sees for this request</h2>
      <table className="stack"><tbody>
        <tr><th scope="row">Connection address (the nearest hop)</th><td data-label="Value">{info.peer ?? 'unknown (the server could not read it)'}</td></tr>
        <tr><th scope="row">Trusted proxy?</th><td data-label="Value">{info.trustedProxy
          ? <span className="pill">Yes, by {info.trustedBy === 'address' ? 'address list' : 'shared secret'}</span>
          : <span className="pill warn">No: forwarded headers are ignored</span>}</td></tr>
        <tr><th scope="row">Client address used for lockouts</th><td data-label="Value">{info.trustedProxy ? show(info.ip) : 'none (not behind a trusted proxy)'}</td></tr>
        <tr><th scope="row">Scheme reported by the proxy</th><td data-label="Value">{info.trustedProxy ? show(scheme) : 'ignored'}</td></tr>
        <tr><th scope="row">Host header</th><td data-label="Value">{show(h.get('host'))} (the app always uses the public address {ctx.config.canonicalOrigin}, never this)</td></tr>
        <tr><th scope="row">X-Forwarded-For received</th><td data-label="Value">{show(h.get('x-forwarded-for'))}</td></tr>
        <tr><th scope="row">Shared-secret header received</th><td data-label="Value">{h.get(PROXY_SECRET_HEADER) ? 'yes (value not shown)' : 'no'}</td></tr>
      </tbody></table>
      {!info.trustedProxy && info.peer && <p role="note" className="card">This request is not coming from a trusted proxy. If you opened this page through your reverse proxy, add <strong>{info.peer}</strong> below, save, and reload this page. If you opened it directly (without the proxy), that is expected.</p>}
      {info.trustedProxy && !info.ip && <p role="note" className="card">The request is trusted but carries no usable X-Forwarded-For header, so the client address is unknown. Make your proxy send X-Forwarded-For.</p>}
      {info.trustedProxy && info.ip && ctx.config.secureCookies && scheme !== 'https' && <p role="alert" className="error">The proxy did not report https. Set X-Forwarded-Proto to https in your proxy, or sign-ins will be refused.</p>}
    </div>

    <form className="card" method="post" action="/api/settings/proxy">
      <h2>Trusted proxy addresses</h2><Csrf token={csrf} /><input type="hidden" name="version" value={v.proxy.version} />
      <label htmlFor="trustedProxies">IP addresses or CIDR ranges, one per line</label>
      <textarea id="trustedProxies" name="trustedProxies" rows={4} maxLength={2000} defaultValue={text} placeholder={'192.168.1.10\n172.18.0.0/16\n2001:db8::10'} />
      <p className="muted">Use the address your proxy connects from, as shown above as the connection address. Behind Docker this is often the bridge gateway (for example 172.18.0.1) or the proxy container's address. List the narrowest range that works. Ranges shorter than /8 (IPv4) or /32 (IPv6) are refused outright. Anything wider than /16 (IPv4) or /48 (IPv6), or a public range wider than /24 or /64, needs the confirmation box below, and a warning stays on this page while one is in force. Leave empty to trust nothing.</p>
      <p className="muted">Notes: only the proxy nearest to the app is checked against this list, then the app reads X-Forwarded-For from the right, skipping any listed proxies, so list every proxy in a chain (a CDN edge you do not list is reported as the client). A port after the address (203.0.113.9:443) is ignored. IPv6 clients count per full address. A trusted proxy must send X-Forwarded-Proto: https or sign-ins are refused.</p>
      <label><input type="checkbox" name="confirmBroad" value="yes" /> I understand that a broad range lets any machine in it forge client addresses</label>
      {ctx.config.trustedProxies.length > 0 && !Array.isArray(stored) && <p className="muted">Currently from TALLYMED_TRUSTED_PROXIES: {envList.join(', ')}.</p>}
      <label><input type="checkbox" name="useEnvironment" value="yes" defaultChecked={q.error === undefined && !Array.isArray(stored) && envList.length > 0} /> Use the value from TALLYMED_TRUSTED_PROXIES instead of this list</label>
      <ConfirmPassword id="proxy-pw" />
      <button type="submit">Save trusted proxies</button>
    </form>

    <div className="card">
      <h2>How to set up your proxy</h2>
      <ol>
        <li>Serve TallyMed over https at the public address in the environment (TALLYMED_CANONICAL_ORIGIN) and forward to the app.</li>
        <li>Make the proxy <strong>replace</strong> X-Forwarded-For with the real client address (nginx: <code>proxy_set_header X-Forwarded-For $remote_addr;</code>; Caddy and Traefik do this for a direct client) and set X-Forwarded-Proto to https. Do not pass along these headers from the client.</li>
        <li>Add the proxy's connection address above, save, then reload this page through the proxy: it should say "Yes, by address list" and show your own address as the client address.</li>
        <li>Never publish the app's own port to the internet. Only the proxy should be able to reach it; the address list does not help if others can connect directly from a listed range.</li>
      </ol>
      <p className="muted">Alternative: the shared-secret method (TALLYMED_PROXY_SECRET sent in an X-Tallymed-Proxy-Secret header) still works and is accepted in addition to the address list.</p>
    </div>
  </main>;
}
